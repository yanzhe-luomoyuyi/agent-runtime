/**
 * Runtime — the durable orchestrator.
 *
 * Executes a workflow phase-by-phase, appending an event for every action.
 * State is always re-derived from the log via the reducer (never mutated in
 * place), which makes every run resumable: on `resume` we replay the log to
 * rebuild state and continue from the first incomplete step. Tool calls are
 * idempotent across resumes because each call has a deterministic id whose
 * result is cached in the log.
 */

import { randomUUID } from 'node:crypto';

import { ConflictError, EventLog, listRunIds, runDir } from './eventlog.js';
import type { ModelProvider } from './model/provider.js';
import { DEFAULT_PRICING, type ModelPricing } from './pricing.js';
import { applyEvent, reduce } from './reducer.js';
import type { ToolRegistry } from './tools/registry.js';
import { buildTrace, type Trace } from './trace.js';
import type { AgentEvent, RunState } from './types.js';
import type { StepContext, WorkflowDef } from './workflow.js';

export interface RuntimeOptions {
  baseDir: string;
  model: ModelProvider;
  tools: ToolRegistry;
  workflow: WorkflowDef;
  /** Inject a crash immediately after this stepId's side effects (demo/tests). */
  crashAfter?: string;
  /** Observability seam — invoked for every appended event (D4 tracing hooks here). */
  onEvent?: (event: AgentEvent) => void;
  /** Token cost model. Defaults to DEFAULT_PRICING; the CLI loads it from agent.config.json. */
  pricing?: ModelPricing;
}

export class Runtime {
  constructor(private readonly opts: RuntimeOptions) {}

  async run(issue: string): Promise<RunState> {
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const log = new EventLog(runDir(this.opts.baseDir, runId));
    return this.drive(runId, log, { type: 'RunStarted', runId, input: { issue }, workflow: this.opts.workflow.name, ts: now() });
  }

  async resume(runId: string): Promise<RunState> {
    const log = new EventLog(runDir(this.opts.baseDir, runId));
    if (log.length === 0) throw new Error(`No run log found for ${runId}`);
    return this.drive(runId, log);
  }

  status(runId: string): RunState {
    const log = new EventLog(runDir(this.opts.baseDir, runId));
    if (log.length === 0) throw new Error(`Run not found: ${runId}`);
    return reduce(log.all(), runId);
  }

  /** Build an observability trace (spans + token/cost/latency totals) from a run's log. */
  trace(runId: string): Trace {
    const log = new EventLog(runDir(this.opts.baseDir, runId));
    if (log.length === 0) throw new Error(`Run not found: ${runId}`);
    return buildTrace(log.all());
  }

  /**
   * Find every interrupted run (status still "running") under baseDir and resume
   * it. If another worker is concurrently driving a run, our append loses the
   * optimistic-concurrency race (ConflictError) and we skip it rather than
   * corrupt its log. This is the crash-recovery supervisor.
   */
  async recover(): Promise<Array<{ runId: string; state?: RunState; conflict?: boolean }>> {
    const results: Array<{ runId: string; state?: RunState; conflict?: boolean }> = [];
    for (const runId of listRunIds(this.opts.baseDir)) {
      const log = new EventLog(runDir(this.opts.baseDir, runId));
      if (log.length === 0) continue; // stray/empty directory — not a real run
      if (reduce(log.all(), runId).status !== 'running') continue; // only interrupted runs
      try {
        results.push({ runId, state: await this.resume(runId) });
      } catch (e) {
        if (e instanceof ConflictError) results.push({ runId, conflict: true });
        else throw e;
      }
    }
    return results;
  }

  private async drive(runId: string, log: EventLog, initialEvent?: AgentEvent): Promise<RunState> {
    let state = reduce(log.all(), runId);

    // Single funnel for every event: persist to the log, notify observers, AND
    // fold it into the in-memory state — so `state` always equals `reduce(log)`.
    // (Skipping the fold for some events is what previously let state drift.)
    const record = (event: AgentEvent): void => {
      log.append(event);
      this.opts.onEvent?.(event);
      state = applyEvent(state, event);
    };

    if (initialEvent) record(initialEvent);
    if (state.status === 'completed' || state.status === 'failed') return state;

    const issue = state.input!.issue;

    try {
      for (const phase of this.opts.workflow.phases) {
        const existing = state.phases[phase.name];
        if (existing?.status === 'COMPLETED' || existing?.status === 'SKIPPED') continue;

        if (existing?.status !== 'IN_PROGRESS') {
          record({ type: 'PhaseStarted', phase: phase.name, ts: now() });
        }

        for (const step of phase.steps) {
          const stepNum = stepNumber(step.id);
          if (state.phases[phase.name]?.stepsCompleted.includes(stepNum)) continue;

          record({ type: 'StepStarted', phase: phase.name, step: stepNum, stepId: step.id, ts: now() });

          const output = await step.run(this.makeContext(runId, record, () => state, issue));

          if (this.opts.crashAfter === step.id) {
            // Crash AFTER side effects but BEFORE StepCompleted is recorded, to
            // prove that resume re-runs only the incomplete step and reuses the
            // tool results that already succeeded.
            throw new Error(`__CRASH__ injected after ${step.id}`);
          }

          record({ type: 'StepCompleted', phase: phase.name, step: stepNum, stepId: step.id, output, ts: now() });
        }

        record({ type: 'PhaseCompleted', phase: phase.name, ts: now() });
      }

      record({ type: 'RunCompleted', summary: buildSummary(state), ts: now() });
      return state;
    } catch (err) {
      if (err instanceof ConflictError) throw err; // another writer owns this run — don't clobber its log
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('__CRASH__')) throw err; // leave the log resumable — no RunFailed

      record({ type: 'RunFailed', error: message, ts: now() });
      return state;
    }
  }

  private makeContext(
    runId: string,
    record: (event: AgentEvent) => void,
    getState: () => RunState,
    issue: string,
  ): StepContext {
    return {
      runId,
      input: { issue },
      get state() {
        return getState();
      },
      tools: this.opts.tools,
      getStepOutput: <R>(stepId: string): R | undefined => getState().stepOutputs[stepId] as R | undefined,
      callModel: async (prompt: string): Promise<string> => {
        const state = getState();
        const callId = `${state.currentPhase}.${state.currentStep}:model`;
        // Idempotency: a completed model call is replayed from the log, never re-issued.
        if (callId in state.modelResults) return state.modelResults[callId]!;

        const startedAt = Date.now();
        const { text, promptTokens, completionTokens, cached } = await this.opts.model.complete(prompt);
        const pricing = this.opts.pricing ?? DEFAULT_PRICING;
        const costUsd = promptTokens * pricing.promptUsdPerToken + completionTokens * pricing.completionUsdPerToken;
        record({
          type: 'ModelCalled',
          callId,
          phase: state.currentPhase!,
          step: state.currentStep!,
          prompt,
          response: text,
          promptTokens,
          completionTokens,
          costUsd,
          latencyMs: Date.now() - startedAt,
          cached: cached ?? false,
          ts: now(),
        });
        return text;
      },
      callTool: async <R>(tool: string, args: unknown): Promise<R> => {
        const state = getState();
        const callId = `${state.currentPhase}.${state.currentStep}:${tool}`;
        // Idempotency: a completed tool call is replayed from the log, never re-run.
        if (callId in state.toolResults) return state.toolResults[callId] as R;

        record({ type: 'ToolCallRequested', callId, tool, args, ts: now() });
        try {
          const result = await this.opts.tools.get(tool).run(args);
          record({ type: 'ToolCallSucceeded', callId, tool, result, ts: now() });
          return result as R;
        } catch (e) {
          record({ type: 'ToolCallFailed', callId, tool, error: e instanceof Error ? e.message : String(e), ts: now() });
          throw e;
        }
      },
    };
  }
}

function now(): string {
  return new Date().toISOString();
}

function stepNumber(stepId: string): number {
  return Number(stepId.split('.').pop());
}

function buildSummary(state: RunState): { proposal?: string; files?: string[] } {
  const out = state.stepOutputs['propose.1'] as { proposal?: string; files?: string[] } | undefined;
  return { proposal: out?.proposal, files: out?.files };
}

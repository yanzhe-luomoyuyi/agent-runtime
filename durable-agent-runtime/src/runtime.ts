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
import { PolicyEnforcer, PolicyViolationError, type Policy } from './policy.js';
import { applyEvent, reduce } from './reducer.js';
import { readSnapshot, writeSnapshot } from './snapshot.js';
import type { ToolRegistry } from './tools/registry.js';
import { buildTrace, type Trace } from './trace.js';
import type { AgentEvent, RunInput, RunState } from './types.js';
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
  /** Declarative guardrails (tool allow-list / cost budget / PII redaction). Optional. */
  policy?: Policy;
  /**
   * Minimum number of NEW events between snapshots. Snapshots are still taken
   * at phase boundaries, but only if at least this many events have accumulated
   * since the last snapshot. Terminal snapshots (RunCompleted / RunFailed) are
   * always written regardless. Default: 20.
   */
  snapshotInterval?: number;
}

export class Runtime {
  private readonly policy?: PolicyEnforcer;

  constructor(private readonly opts: RuntimeOptions) {
    this.policy = opts.policy ? new PolicyEnforcer(opts.policy) : undefined;
  }

  async run(issue: string, opts?: { conversationHistory?: RunInput['conversationHistory'] }): Promise<RunState> {
    const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const log = new EventLog(runDir(this.opts.baseDir, runId));
    return this.drive(runId, log, { type: 'RunStarted', runId, input: { issue, conversationHistory: opts?.conversationHistory }, workflow: this.opts.workflow.name, ts: now() });
  }

  async resume(runId: string): Promise<RunState> {
    const log = new EventLog(runDir(this.opts.baseDir, runId));
    if (log.length === 0) throw new Error(`No run log found for ${runId}`);
    return this.drive(runId, log);
  }

  status(runId: string): RunState {
    const log = new EventLog(runDir(this.opts.baseDir, runId));
    if (log.length === 0) throw new Error(`Run not found: ${runId}`);

    // Fast path: replay only the tail beyond the latest snapshot.
    const snap = readSnapshot(log.dir, log.version);
    if (snap) {
      const tail = log.all().slice(snap.version);
      return reduce(tail, runId, snap.state);
    }
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
    // ── Fast resume via snapshot ──────────────────────────────────────────
    // If a snapshot exists, we start from its pre-reduced state and only
    // replay events appended after it. Without a snapshot (or if it's
    // invalid), we fall back to a full log replay — the safe default.
    const allEvents = log.all();
    const snap = readSnapshot(log.dir, log.version);
    let state: RunState;
    let spentUsd: number;

    if (snap) {
      // Start from the snapshot; replay only events after snap.version.
      state = snap.state;
      spentUsd = snap.spentUsd;
      const tail = allEvents.slice(snap.version);
      for (const e of tail) {
        state = applyEvent(state, e);
        if (e.type === 'ModelCalled') spentUsd += e.costUsd;
      }
    } else {
      state = reduce(allEvents, runId);
      spentUsd = allEvents.reduce((sum, e) => (e.type === 'ModelCalled' ? sum + e.costUsd : sum), 0);
    }

    // Track the last snapshot version so we only write a new one when enough
    // new events have accumulated (avoids thrashing the filesystem on tiny
    // phases). Terminal snapshots still flush unconditionally.
    let lastSnapVersion = snap?.version ?? 0;

    // Single funnel for every event: persist to the log, notify observers, AND
    // fold it into the in-memory state — so `state` always equals `reduce(log)`.
    // (Skipping the fold for some events is what previously let state drift.)
    const record = (event: AgentEvent): void => {
      log.append(event);
      this.opts.onEvent?.(event);
      state = applyEvent(state, event);
      if (event.type === 'ModelCalled') spentUsd += event.costUsd;

      // Auto-checkpoint: throttle via snapshotInterval; phases/steps no longer
      // gate snapshot timing — every N events trigger a write regardless of
      // workflow structure.  Terminal snapshots still flush unconditionally.
      lastSnapVersion = this.checkpoint(log.dir, log.version, state, spentUsd, lastSnapVersion);
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

          const output = await step.run(this.makeContext(runId, record, () => state, () => spentUsd, issue));

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

      const summary = this.opts.workflow.summarize ? this.opts.workflow.summarize(state) : buildSummary(state);
      record({ type: 'RunCompleted', summary, ts: now() });
      this.checkpoint(log.dir, log.version, state, spentUsd, lastSnapVersion, true);
      return state;
    } catch (err) {
      if (err instanceof ConflictError) throw err; // another writer owns this run — don't clobber its log
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('__CRASH__')) throw err; // leave the log resumable — no RunFailed

      record({ type: 'RunFailed', error: message, ts: now() });
      this.checkpoint(log.dir, log.version, state, spentUsd, lastSnapVersion, true);
      return state;
    }
  }

  /**
   * Write a snapshot at the current log version so future resumes can skip
   * full-log replay. Best-effort: a write failure is silently ignored because
   * the log is still the authoritative source of truth.
   *
   * Snapshot are throttled by `snapshotInterval`: we skip the write unless at
   * least that many new events have accumulated since the last snapshot.
   * Terminal snapshots (force=true) always flush regardless.
   *
   * Returns the updated lastSnapshotVersion (== version if written, or the
   * old value if skipped).
   *
   * Concurrency note: only the runtime that owns this run (has won every
   * optimistic-concurrency append) calls this — there is no writer–writer race.
   * The atomic tmp+rename in writeSnapshot guards against crash-mid-write.
   */
  private checkpoint(
    runDir: string,
    version: number,
    state: RunState,
    spentUsd: number,
    lastVersion: number,
    force = false,
  ): number {
    const interval = this.opts.snapshotInterval ?? 20;
    if (!force && version - lastVersion < interval) return lastVersion;
    writeSnapshot(runDir, { version, state, spentUsd });
    return version;
  }

  private makeContext(
    runId: string,
    record: (event: AgentEvent) => void,
    getState: () => RunState,
    getSpentUsd: () => number,
    issue: string,
  ): StepContext {
    return {
      runId,
      input: { issue, conversationHistory: getState().input?.conversationHistory },
      get state() {
        return getState();
      },
      tools: this.opts.tools,
      getStepOutput: <R>(stepId: string): R | undefined => getState().stepOutputs[stepId] as R | undefined,
      callModel: async (prompt: string, opts?: { key?: string }): Promise<string> => {
        const state = getState();
        const callId = `${state.currentPhase}.${state.currentStep}:${opts?.key ? `${opts.key}:` : ''}model`;
        // Idempotency: a completed model call is replayed from the log, never re-issued.
        if (callId in state.modelResults) return state.modelResults[callId]!;

        // Policy funnel: enforce the cost budget, then redact PII before the prompt
        // ever leaves the runtime — the model sees, and the log stores, only the
        // redacted text.
        this.enforceBudget(getSpentUsd(), callId, record);

        // Pre-model content safety: detect prompt injection & harmful content
        // BEFORE the prompt is sent. The raw (pre-redaction) prompt is checked
        // so that injection attacks can't hide behind PII redaction markers.
        if (this.policy) {
          await this.enforceContentSafety(this.policy, prompt, callId, record);
        }

        const outbound = this.policy ? this.policy.redact(prompt).text : prompt;

        const startedAt = Date.now();
        const { text, promptTokens, completionTokens, cached } = await this.opts.model.complete(outbound);
        const pricing = this.opts.pricing ?? DEFAULT_PRICING;
        const costUsd = promptTokens * pricing.promptUsdPerToken + completionTokens * pricing.completionUsdPerToken;

        // Post-model content safety: check the model's response for harmful or
        // ungrounded output before it flows back into the workflow.
        if (this.policy) {
          await this.enforceOutputSafety(this.policy, text, callId, record);
        }

        record({
          type: 'ModelCalled',
          callId,
          phase: state.currentPhase!,
          step: state.currentStep!,
          prompt: outbound,
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
      callTool: async <R>(tool: string, args: unknown, opts?: { key?: string }): Promise<R> => {
        const state = getState();
        const callId = `${state.currentPhase}.${state.currentStep}:${opts?.key ? `${opts.key}:` : ''}${tool}`;
        // Idempotency: a completed tool call is replayed from the log, never re-run.
        if (callId in state.toolResults) return state.toolResults[callId] as R;

        // Policy funnel: refuse any tool that is not on the allow-list.
        this.enforceToolAllowed(tool, record);

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

  /** Deny a tool that is not on the policy allow-list (records the denial first). */
  private enforceToolAllowed(tool: string, record: (event: AgentEvent) => void): void {
    if (!this.policy) return;
    try {
      this.policy.checkTool(tool);
    } catch (e) {
      if (e instanceof PolicyViolationError) {
        record({ type: 'PolicyDenied', scope: 'tool', target: tool, code: e.code, reason: e.message, ts: now() });
      }
      throw e;
    }
  }

  /** Deny a model call once the cumulative cost budget is exhausted. */
  private enforceBudget(spentUsd: number, callId: string, record: (event: AgentEvent) => void): void {
    if (!this.policy) return;
    try {
      this.policy.checkBudget(spentUsd, callId);
    } catch (e) {
      if (e instanceof PolicyViolationError) {
        record({ type: 'PolicyDenied', scope: 'model', target: callId, code: e.code, reason: e.message, ts: now() });
      }
      throw e;
    }
  }

  /**
   * Pre-model guard: run jailbreak + content checks on the raw prompt.
   * Records a PolicyDenied event on violation so every blocked call is audit-
   * able and surfaced in traces / evals.
   */
  private async enforceContentSafety(
    policy: PolicyEnforcer,
    prompt: string,
    callId: string,
    record: (event: AgentEvent) => void,
  ): Promise<void> {
    // Jailbreak check (prompt injection / DAN / system-override attempts).
    const jb = await policy.checkJailbreak(prompt);
    if (!jb.safe) {
      record({
        type: 'PolicyDenied',
        scope: 'model',
        target: callId,
        code: 'jailbreak',
        reason: `${jb.attackType ?? 'prompt_injection'}: ${jb.reason ?? 'jailbreak detected'}`,
        ts: now(),
      });
      throw new PolicyViolationError('jailbreak', 'model', callId, jb.reason ?? 'Prompt injection detected');
    }

    // Harmful content check (violence, hate, self-harm, sexual, etc.).
    const cc = await policy.checkContent(prompt);
    if (!cc.safe) {
      record({
        type: 'PolicyDenied',
        scope: 'model',
        target: callId,
        code: 'content_safety',
        reason: `${cc.category ?? 'unsafe'}(severity=${cc.severity ?? '?'}): ${cc.reason ?? 'harmful content'}`,
        ts: now(),
      });
      throw new PolicyViolationError('content_safety', 'model', callId, cc.reason ?? 'Harmful content detected');
    }
  }

  /**
   * Post-model guard: check the model's response for harmful/ungrounded output
   * before it is returned to the workflow.
   */
  private async enforceOutputSafety(
    policy: PolicyEnforcer,
    response: string,
    callId: string,
    record: (event: AgentEvent) => void,
  ): Promise<void> {
    const oc = await policy.checkOutput(response);
    if (!oc.safe) {
      record({
        type: 'PolicyDenied',
        scope: 'model',
        target: callId,
        code: 'output_safety',
        reason: `${oc.category ?? 'unsafe'}: ${oc.reason ?? 'harmful output'}`,
        ts: now(),
      });
      throw new PolicyViolationError('output_safety', 'model', callId, oc.reason ?? 'Harmful model output detected');
    }
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

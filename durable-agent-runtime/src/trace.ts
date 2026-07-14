/**
 * Observability: derive a trace (a timeline of spans + token/cost/latency totals)
 * from a run's event log. Every event carries a `ts`, so the trace is computed
 * purely from the durable log — it works for completed, failed, or resumed runs,
 * with no separate telemetry pipeline.
 */

import type { AgentEvent } from './types.js';

export type SpanKind = 'run' | 'phase' | 'step' | 'tool' | 'model';

export interface Span {
  name: string;
  kind: SpanKind;
  startMs: number; // milliseconds since run start
  durationMs: number;
  depth: number; // nesting level for indentation
  /** True if this span represents a failed call (tool spans only). */
  error?: boolean;
  /** Structured, span-specific data (tool name/call id, model tokens/cost) — consumed by exporters like OTel. */
  attributes?: Record<string, string | number | boolean>;
}

export interface PhaseCost {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface TraceTotals {
  wallMs: number;
  modelMs: number;
  toolMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  /** Tool/model calls refused by the declarative policy layer. */
  policyDenials: number;
  /** Calls served from the log on resume instead of re-executed. */
  replayedCalls: number;
  /** replayedCalls / (executed + replayed) — work saved by durable replay. */
  replayHitRate: number;
  /** Model calls served by the content cache (CachingModelProvider). */
  cachedModelCalls: number;
  /** List-price cost of cached model calls — money saved by the content cache. */
  costSavedUsd: number;
}

export interface Trace {
  runId: string;
  /** Epoch-ms of the first event — the anchor `Span.startMs` offsets are relative to. */
  startedAtMs: number;
  spans: Span[];
  totals: TraceTotals;
  /** Token/cost breakdown per phase (model usage). */
  byPhase: Record<string, PhaseCost>;
}

function ms(ts: string): number {
  return Date.parse(ts);
}

function stepIdOf(callId: string): string {
  // callId is `<phase>.<step>:<tool|model>` — the prefix before ':' is the stepId.
  return callId.split(':')[0] ?? callId;
}

/** Fold an event log into a timeline of spans and aggregate totals. */
export function buildTrace(events: AgentEvent[]): Trace {
  const started = events.find((e): e is Extract<AgentEvent, { type: 'RunStarted' }> => e.type === 'RunStarted');
  const runId = started?.runId ?? 'unknown';

  const firstEv = events[0];
  const lastEv = events[events.length - 1];
  const first = firstEv ? ms(firstEv.ts) : 0;
  let runEnd = lastEv ? ms(lastEv.ts) : first;

  const phaseStart = new Map<string, number>();
  const phaseEnd = new Map<string, number>();
  const stepStart = new Map<string, number>();
  const stepEnd = new Map<string, number>();
  const toolStart = new Map<string, number>();
  const toolEnd = new Map<string, number>();
  const toolNameByCallId = new Map<string, string>();
  const failedCallIds = new Set<string>();
  const modelSpans: Span[] = [];

  // Durable-replay accounting, derived purely from the existing log:
  //  - a step re-entered on resume shows up as MULTIPLE StepStarted events;
  //  - its calls appear once (replays emit no event), and callId encodes the stepId.
  const stepEntries = new Map<string, number>();
  const stepExecutedCalls = new Map<string, number>();
  const byPhase: Record<string, PhaseCost> = {};

  const totals: TraceTotals = {
    wallMs: 0,
    modelMs: 0,
    toolMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    modelCalls: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    policyDenials: 0,
    replayedCalls: 0,
    replayHitRate: 0,
    cachedModelCalls: 0,
    costSavedUsd: 0,
  };

  for (const e of events) {
    const t = ms(e.ts);
    switch (e.type) {
      case 'PhaseStarted':
        if (!phaseStart.has(e.phase)) phaseStart.set(e.phase, t);
        break;
      case 'PhaseCompleted':
        phaseEnd.set(e.phase, t);
        break;
      case 'StepStarted':
        if (!stepStart.has(e.stepId)) stepStart.set(e.stepId, t);
        stepEntries.set(e.stepId, (stepEntries.get(e.stepId) ?? 0) + 1);
        break;
      case 'StepCompleted':
        stepEnd.set(e.stepId, t);
        break;
      case 'ToolCallRequested':
        if (!toolStart.has(e.callId)) toolStart.set(e.callId, t);
        toolNameByCallId.set(e.callId, e.tool);
        break;
      case 'ToolCallSucceeded': {
        toolEnd.set(e.callId, t);
        totals.toolCalls++;
        const sid = stepIdOf(e.callId);
        stepExecutedCalls.set(sid, (stepExecutedCalls.get(sid) ?? 0) + 1);
        break;
      }
      case 'ToolCallFailed':
        toolEnd.set(e.callId, t);
        totals.failedToolCalls++;
        failedCallIds.add(e.callId);
        break;
      case 'ModelCalled': {
        totals.modelCalls++;
        totals.promptTokens += e.promptTokens;
        totals.completionTokens += e.completionTokens;
        totals.costUsd += e.costUsd;
        totals.modelMs += e.latencyMs;
        if (e.cached) {
          totals.cachedModelCalls++;
          totals.costSavedUsd += e.costUsd;
        }
        const sid = stepIdOf(e.callId);
        stepExecutedCalls.set(sid, (stepExecutedCalls.get(sid) ?? 0) + 1);
        let pc = byPhase[e.phase];
        if (!pc) {
          pc = { promptTokens: 0, completionTokens: 0, costUsd: 0 };
          byPhase[e.phase] = pc;
        }
        pc.promptTokens += e.promptTokens;
        pc.completionTokens += e.completionTokens;
        pc.costUsd += e.costUsd;
        modelSpans.push({
          name: 'model',
          kind: 'model',
          startMs: t - e.latencyMs - first,
          durationMs: e.latencyMs,
          depth: 3,
          attributes: {
            'gen_ai.usage.prompt_tokens': e.promptTokens,
            'gen_ai.usage.completion_tokens': e.completionTokens,
            'agent.cost_usd': e.costUsd,
            'agent.cached': Boolean(e.cached),
          },
        });
        break;
      }
      case 'PolicyDenied':
        totals.policyDenials++;
        break;
      case 'RunCompleted':
      case 'RunFailed':
        runEnd = t;
        break;
      default:
        break;
    }
  }

  const spans: Span[] = [{ name: 'run', kind: 'run', startMs: 0, durationMs: runEnd - first, depth: 0 }];

  for (const [phase, start] of phaseStart) {
    spans.push({ name: `phase:${phase}`, kind: 'phase', startMs: start - first, durationMs: (phaseEnd.get(phase) ?? runEnd) - start, depth: 1 });
  }
  for (const [stepId, start] of stepStart) {
    spans.push({ name: `step:${stepId}`, kind: 'step', startMs: start - first, durationMs: (stepEnd.get(stepId) ?? runEnd) - start, depth: 2 });
  }
  for (const [callId, start] of toolStart) {
    const end = toolEnd.get(callId) ?? start;
    const toolName = toolNameByCallId.get(callId) ?? callId.split(':').pop() ?? callId;
    spans.push({
      name: `tool:${toolName}`,
      kind: 'tool',
      startMs: start - first,
      durationMs: end - start,
      depth: 3,
      error: failedCallIds.has(callId),
      attributes: { 'agent.tool.name': toolName, 'agent.tool.call_id': callId },
    });
    totals.toolMs += end - start;
  }
  spans.push(...modelSpans);
  spans.sort((a, b) => a.startMs - b.startMs || a.depth - b.depth);

  // A step entered N times executed its calls once and replayed them (N-1) times.
  let replayedCalls = 0;
  for (const [stepId, entries] of stepEntries) {
    if (entries > 1) replayedCalls += (stepExecutedCalls.get(stepId) ?? 0) * (entries - 1);
  }
  const executed = totals.toolCalls + totals.modelCalls;
  totals.replayedCalls = replayedCalls;
  totals.replayHitRate = executed + replayedCalls > 0 ? replayedCalls / (executed + replayedCalls) : 0;

  totals.wallMs = runEnd - first;
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6; // tidy floating-point drift
  totals.costSavedUsd = Math.round(totals.costSavedUsd * 1e6) / 1e6;

  return { runId, startedAtMs: first, spans, totals, byPhase };
}

/** Render a trace as an indented timeline plus a totals summary. */
export function renderTimeline(trace: Trace): string {
  const lines = trace.spans.map((s) => {
    const indent = '  '.repeat(s.depth);
    return `${indent}${s.name.padEnd(Math.max(1, 28 - indent.length))} ${String(s.durationMs).padStart(6)}ms  @+${s.startMs}ms`;
  });
  const t = trace.totals;
  lines.push('');
  lines.push(
    `Totals: wall ${t.wallMs}ms | model ${t.modelMs}ms (${t.modelCalls} calls) | ` +
      `tools ${t.toolMs}ms (${t.toolCalls} calls, ${t.failedToolCalls} failed) | ` +
      `tokens ${t.promptTokens}+${t.completionTokens} | $${t.costUsd.toFixed(6)}`,
  );
  lines.push(`Replay: ${t.replayedCalls} calls replayed from log (hit rate ${(t.replayHitRate * 100).toFixed(0)}%)`);
  lines.push(`Cache:  ${t.cachedModelCalls}/${t.modelCalls} model calls served from cache (saved $${t.costSavedUsd.toFixed(6)})`);
  if (t.policyDenials > 0) lines.push(`Policy: ${t.policyDenials} call(s) denied by guardrails`);
  const phases = Object.keys(trace.byPhase);
  if (phases.length > 0) {
    lines.push('By phase (model tokens / cost):');
    for (const phase of phases) {
      const c = trace.byPhase[phase]!;
      lines.push(`  ${phase.padEnd(12)} ${c.promptTokens}+${c.completionTokens} tok  $${c.costUsd.toFixed(6)}`);
    }
  }
  return lines.join('\n');
}

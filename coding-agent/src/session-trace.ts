/**
 * Persist / reload Workbench harness traces and aggregate them at session scope
 * for historical load + A/B compare in the UI.
 *
 * Runtime traces stay event-sourced (`Runtime.trace`). Harness `AgentTrace` is
 * only available in-process during a live run, so we write a sidecar JSON next
 * to the run's event log when a run finishes.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareTraces, type AgentTrace } from '@agent/harness';
import { runDir, type Runtime, type SessionState, type Trace, type TraceTotals } from 'durable-agent-runtime';

const HARNESS_TRACE_FILE = 'harness-trace.json';

export function harnessTracePath(runsDir: string, runId: string): string {
  return join(runDir(runsDir, runId), HARNESS_TRACE_FILE);
}

export function saveHarnessTrace(runsDir: string, runId: string, trace: AgentTrace): void {
  writeFileSync(harnessTracePath(runsDir, runId), JSON.stringify(trace, null, 2));
}

export function loadHarnessTrace(runsDir: string, runId: string): AgentTrace | null {
  const path = harnessTracePath(runsDir, runId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentTrace;
  } catch {
    return null;
  }
}

export interface RunTraceBundle {
  runId: string;
  status: string;
  answer: string;
  turns: number;
  toolsUsed: string[];
  runtimeTrace: Trace | null;
  harnessTrace: AgentTrace | null;
}

export interface SessionTraceBundle {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  runs: RunTraceBundle[];
  /** Summed runtime totals across readable runs. */
  runtimeTotals: TraceTotals | null;
  /** Summed harness metrics when at least one run has a sidecar. */
  harnessAggregate: AgentTrace | null;
}

export interface MetricDelta {
  metric: string;
  label: string;
  baseline: number;
  candidate: number;
  /** Percent change vs baseline; null when baseline is 0. */
  pct: number | null;
}

export interface SessionCompareResult {
  baseline: SessionTraceBundle;
  candidate: SessionTraceBundle;
  deltas: MetricDelta[];
  /** Text report from harness `compareTraces` when both sides have harness data. */
  harnessReport: string | null;
}

export function loadSessionTraceBundle(
  runsDir: string,
  rt: Runtime,
  state: SessionState,
): SessionTraceBundle {
  const runs: RunTraceBundle[] = state.runs.map((r) => {
    let runtimeTrace: Trace | null = null;
    try {
      runtimeTrace = rt.trace(r.runId);
    } catch {
      runtimeTrace = null;
    }
    return {
      runId: r.runId,
      status: r.status,
      answer: r.answer,
      turns: r.turns,
      toolsUsed: r.toolsUsed,
      runtimeTrace,
      harnessTrace: loadHarnessTrace(runsDir, r.runId),
    };
  });

  return {
    sessionId: state.manifest.sessionId,
    title: state.manifest.title,
    createdAt: state.manifest.createdAt,
    updatedAt: state.manifest.updatedAt,
    runCount: runs.length,
    runs,
    runtimeTotals: aggregateRuntimeTotals(runs.map((r) => r.runtimeTrace).filter(Boolean) as Trace[]),
    harnessAggregate: aggregateHarnessTraces(
      runs.map((r) => r.harnessTrace).filter((t): t is AgentTrace => t != null),
    ),
  };
}

export function compareSessionTraces(
  baseline: SessionTraceBundle,
  candidate: SessionTraceBundle,
): SessionCompareResult {
  const deltas = buildDeltas(baseline, candidate);
  let harnessReport: string | null = null;
  if (baseline.harnessAggregate && candidate.harnessAggregate) {
    harnessReport = compareTraces(baseline.harnessAggregate, candidate.harnessAggregate);
  }
  return { baseline, candidate, deltas, harnessReport };
}

function emptyTotals(): TraceTotals {
  return {
    wallMs: 0,
    modelMs: 0,
    toolMs: 0,
    writeFileMs: 0,
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
}

function aggregateRuntimeTotals(traces: Trace[]): TraceTotals | null {
  if (!traces.length) return null;
  const t = emptyTotals();
  let replayDenom = 0;
  for (const tr of traces) {
    const x = tr.totals;
    t.wallMs += x.wallMs;
    t.modelMs += x.modelMs;
    t.toolMs += x.toolMs;
    t.writeFileMs += x.writeFileMs;
    t.promptTokens += x.promptTokens;
    t.completionTokens += x.completionTokens;
    t.costUsd += x.costUsd;
    t.modelCalls += x.modelCalls;
    t.toolCalls += x.toolCalls;
    t.failedToolCalls += x.failedToolCalls;
    t.policyDenials += x.policyDenials;
    t.replayedCalls += x.replayedCalls;
    t.cachedModelCalls += x.cachedModelCalls;
    t.costSavedUsd += x.costSavedUsd;
    // Reconstruct executed+replayed denominator from hit rate when possible.
    if (x.replayHitRate > 0 && x.replayedCalls > 0) {
      replayDenom += x.replayedCalls / x.replayHitRate;
    } else {
      replayDenom += x.replayedCalls;
    }
  }
  t.replayHitRate = replayDenom > 0 ? t.replayedCalls / replayDenom : 0;
  return t;
}

function aggregateHarnessTraces(traces: AgentTrace[]): AgentTrace | null {
  if (!traces.length) return null;
  const first = traces[0]!;
  let totalToolCalls = 0;
  let toolOk = 0;
  let toolFail = 0;
  let totalTurns = 0;
  let totalRetries = 0;
  let runDurationMs = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCachedPromptTokens = 0;
  let estimatedCostUsd = 0;
  const turns = [];

  for (const tr of traces) {
    totalToolCalls += tr.totalToolCalls;
    toolOk += tr.toolOk;
    toolFail += tr.toolFail;
    totalTurns += tr.totalTurns;
    totalRetries += tr.totalRetries;
    runDurationMs += tr.runDurationMs;
    totalPromptTokens += tr.totalPromptTokens;
    totalCompletionTokens += tr.totalCompletionTokens;
    totalCachedPromptTokens += tr.totalCachedPromptTokens;
    estimatedCostUsd += tr.estimatedCostUsd;
    turns.push(...tr.turns);
  }

  return {
    runDurationMs,
    totalTurns,
    totalRetries,
    totalToolCalls,
    toolOk,
    toolFail,
    toolSuccessRate: totalToolCalls > 0 ? toolOk / totalToolCalls : 1,
    totalPromptTokens,
    totalCompletionTokens,
    totalCachedPromptTokens,
    estimatedCostUsd,
    pricingModel: { ...first.pricingModel },
    turns,
  };
}

function buildDeltas(baseline: SessionTraceBundle, candidate: SessionTraceBundle): MetricDelta[] {
  const pairs: Array<{ metric: string; label: string; a: number; b: number }> = [];

  const bt = baseline.runtimeTotals;
  const ct = candidate.runtimeTotals;
  if (bt && ct) {
    pairs.push(
      { metric: 'wallMs', label: 'Wall time (ms)', a: bt.wallMs, b: ct.wallMs },
      { metric: 'costUsd', label: 'Cost (USD)', a: bt.costUsd, b: ct.costUsd },
      { metric: 'promptTokens', label: 'Prompt tokens', a: bt.promptTokens, b: ct.promptTokens },
      { metric: 'completionTokens', label: 'Completion tokens', a: bt.completionTokens, b: ct.completionTokens },
      { metric: 'modelCalls', label: 'Model calls', a: bt.modelCalls, b: ct.modelCalls },
      { metric: 'toolCalls', label: 'Tool calls', a: bt.toolCalls, b: ct.toolCalls },
      { metric: 'writeFileMs', label: 'write_file time (ms)', a: bt.writeFileMs, b: ct.writeFileMs },
      { metric: 'failedToolCalls', label: 'Failed tools', a: bt.failedToolCalls, b: ct.failedToolCalls },
      { metric: 'cachedModelCalls', label: 'Cached model calls', a: bt.cachedModelCalls, b: ct.cachedModelCalls },
    );
  }

  const bh = baseline.harnessAggregate;
  const ch = candidate.harnessAggregate;
  if (bh && ch) {
    pairs.push(
      { metric: 'harnessTurns', label: 'Harness turns', a: bh.totalTurns, b: ch.totalTurns },
      { metric: 'harnessRetries', label: 'Harness retries', a: bh.totalRetries, b: ch.totalRetries },
      { metric: 'harnessCostUsd', label: 'Harness cost (USD)', a: bh.estimatedCostUsd, b: ch.estimatedCostUsd },
      { metric: 'harnessDurationMs', label: 'Harness duration (ms)', a: bh.runDurationMs, b: ch.runDurationMs },
    );
  }

  pairs.push(
    { metric: 'runCount', label: 'Runs', a: baseline.runCount, b: candidate.runCount },
  );

  return pairs.map(({ metric, label, a, b }) => ({
    metric,
    label,
    baseline: a,
    candidate: b,
    pct: a === 0 ? null : ((b - a) / a) * 100,
  }));
}

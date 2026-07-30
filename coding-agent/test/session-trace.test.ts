import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentTrace } from '@agent/harness';
import type { Trace } from 'durable-agent-runtime';

import {
  compareSessionTraces,
  loadHarnessTrace,
  saveHarnessTrace,
  type SessionTraceBundle,
} from '../src/session-trace.js';

function harness(partial: Partial<AgentTrace> = {}): AgentTrace {
  return {
    runDurationMs: 1000,
    totalTurns: 2,
    totalRetries: 0,
    totalToolCalls: 1,
    toolOk: 1,
    toolFail: 0,
    toolSuccessRate: 1,
    totalPromptTokens: 100,
    totalCompletionTokens: 50,
    totalCachedPromptTokens: 0,
    estimatedCostUsd: 0.01,
    pricingModel: { promptUsdPerToken: 1e-6, completionUsdPerToken: 2e-6 },
    turns: [],
    ...partial,
  };
}

function runtimeTotals(overrides: Partial<Trace['totals']> = {}): Trace {
  return {
    runId: 'run-x',
    startedAtMs: 0,
    spans: [],
    byPhase: {},
    totals: {
      wallMs: 1000,
      modelMs: 500,
      toolMs: 200,
      writeFileMs: 80,
      durableWrites: 4,
      promptTokens: 100,
      completionTokens: 50,
      cachedPromptTokens: 0,
      costUsd: 0.01,
      modelCalls: 2,
      toolCalls: 1,
      failedToolCalls: 0,
      policyDenials: 0,
      replayedCalls: 0,
      replayHitRate: 0,
      cachedModelCalls: 0,
      costSavedUsd: 0,
      ...overrides,
    },
  };
}

function bundle(
  id: string,
  title: string,
  totals: Trace['totals'],
  harnessAgg: AgentTrace | null,
): SessionTraceBundle {
  return {
    sessionId: id,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runCount: 1,
    runs: [],
    runtimeTotals: totals,
    harnessAggregate: harnessAgg,
  };
}

describe('session-trace store', () => {
  it('persists and reloads harness traces', () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'ht-'));
    mkdirSync(join(runsDir, 'run-1'), { recursive: true });
    const t = harness({ totalTurns: 3 });
    saveHarnessTrace(runsDir, 'run-1', t);
    expect(loadHarnessTrace(runsDir, 'run-1')?.totalTurns).toBe(3);
    expect(loadHarnessTrace(runsDir, 'missing')).toBeNull();
  });

  it('compares two session bundles', () => {
    const a = bundle('sess-a', 'A', runtimeTotals({ costUsd: 0.01, wallMs: 1000 }).totals, harness());
    const b = bundle(
      'sess-b',
      'B',
      runtimeTotals({ costUsd: 0.02, wallMs: 2000 }).totals,
      harness({ estimatedCostUsd: 0.02, runDurationMs: 2000, totalTurns: 4 }),
    );
    const cmp = compareSessionTraces(a, b);
    const cost = cmp.deltas.find((d) => d.metric === 'costUsd');
    expect(cost?.pct).toBeCloseTo(100);
    expect(cmp.harnessReport).toContain('Trace Comparison');
  });
});

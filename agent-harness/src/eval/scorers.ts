/**
 * Composable scorers for harness L2 eval. Each grades one property of
 * `AgentRunResult` and/or `AgentTrace` (assemble / compact / recall / tools).
 */

import type { ApprovalStats } from '@agent/contracts';

import type { AgentStopReason } from '../control/loop.js';
import type { AssembleDecision, CompactDecision } from '../context/manager.js';
import type { AgentTrace } from '../tracing/collector.js';
import type { CheckResult, Scorer } from './types.js';

function assembleDecisions(trace: AgentTrace): AssembleDecision[] {
  return trace.turns.map((t) => t.context?.assemble).filter((d): d is AssembleDecision => d != null);
}

function compactDecisions(trace: AgentTrace): CompactDecision[] {
  return trace.turns.map((t) => t.context?.compact).filter((d): d is CompactDecision => d != null);
}

// ── Outcome / stop reason ───────────────────────────────────────────

export const runFinished = (): Scorer => (ctx) => ({
  name: 'run finished',
  passed: ctx.result.finished && ctx.result.stopReason === 'finished',
  detail: `finished=${ctx.result.finished} stopReason=${ctx.result.stopReason}`,
});

export const stopReasonIs = (reason: AgentStopReason): Scorer => (ctx) => ({
  name: `stopReason === ${reason}`,
  passed: ctx.result.stopReason === reason,
  detail: `stopReason=${ctx.result.stopReason}`,
});

export const answerContains = (substr: string): Scorer => (ctx) => ({
  name: `answer contains "${substr}"`,
  passed: ctx.result.answer.toLowerCase().includes(substr.toLowerCase()),
  detail: ctx.result.answer.slice(0, 80) || '(empty)',
});

export const turnsUnder = (max: number): Scorer => (ctx) => ({
  name: `turns ≤ ${max}`,
  passed: ctx.result.turns <= max,
  detail: `${ctx.result.turns} turns`,
});

export const toolsUsedEquals = (expected: string[]): Scorer => (ctx) => {
  const actual = ctx.result.toolsUsed;
  const ok =
    actual.length === expected.length && actual.every((t, i) => t === expected[i]);
  return {
    name: `toolsUsed === [${expected.join(' → ')}]`,
    passed: ok,
    detail: actual.join(' → ') || '(none)',
  };
};

export const toolsUsedIncludes = (...names: string[]): Scorer => (ctx) => {
  const missing = names.filter((n) => !ctx.result.toolsUsed.includes(n));
  return {
    name: `toolsUsed includes ${names.join(', ')}`,
    passed: missing.length === 0,
    detail: missing.length ? `missing: ${missing.join(', ')}` : ctx.result.toolsUsed.join(' → '),
  };
};

// ── Cost / tool reliability (AgentTrace totals) ─────────────────────

export const noToolFailures = (): Scorer => (ctx) => ({
  name: 'no tool failures',
  passed: ctx.trace.toolFail === 0,
  detail: `${ctx.trace.toolFail} failed / ${ctx.trace.totalToolCalls} total`,
});

export const toolSuccessRate = (min: number): Scorer => (ctx) => {
  const rate = ctx.trace.toolSuccessRate;
  return {
    name: `tool success rate ≥ ${(min * 100).toFixed(0)}%`,
    passed: rate >= min,
    detail: `${(rate * 100).toFixed(0)}% (${ctx.trace.toolOk}/${ctx.trace.totalToolCalls})`,
  };
};

export const costUnderUsd = (max: number): Scorer => (ctx) => ({
  name: `cost < $${max}`,
  passed: ctx.trace.estimatedCostUsd <= max,
  detail: `$${ctx.trace.estimatedCostUsd.toFixed(6)}`,
});

// ── Context / assemble / compact ────────────────────────────────────

/**
 * Budget gate: under-budget turns stay passthrough; over-budget turns must
 * assemble (not silently ignore pressure). Does NOT assert output ≤ budget —
 * mandatory pins + summary notices can leave outputTokens above availableBudget
 * on tiny fixtures; that is intentional.
 */
export const assembleRespectsBudgetGate = (): Scorer => (ctx) => {
  const decisions = assembleDecisions(ctx.trace);
  if (decisions.length === 0) {
    return { name: 'assemble respects budget gate', passed: false, detail: '(no assemble decisions)' };
  }
  const problems: string[] = [];
  for (const d of decisions) {
    if (d.inputTokens <= d.availableBudget) {
      if (d.outcome !== 'passthrough') {
        problems.push(`under-budget but ${d.outcome} (${d.inputTokens}≤${d.availableBudget})`);
      }
    } else if (d.outcome !== 'assembled') {
      problems.push(`over-budget but ${d.outcome} (${d.inputTokens}>${d.availableBudget})`);
    }
  }
  return {
    name: 'assemble respects budget gate',
    passed: problems.length === 0,
    detail: problems.length === 0 ? `${decisions.length} assemble(s) ok` : problems[0],
  };
};

/** @deprecated Alias — prefer `assembleRespectsBudgetGate`. */
export const assembleBudgetRespected = assembleRespectsBudgetGate;
/** @deprecated Alias — prefer `assembleRespectsBudgetGate`. */
export const assembleShrinksWhenOverBudget = assembleRespectsBudgetGate;

/** At least one assemble ran (not only passthrough) — useful for ablation fixtures. */
export const assembleTriggered = (): Scorer => (ctx) => {
  const decisions = assembleDecisions(ctx.trace);
  const hit = decisions.some((d) => d.outcome === 'assembled');
  return {
    name: 'assemble triggered',
    passed: hit,
    detail: hit
      ? `assembled in ${decisions.filter((d) => d.outcome === 'assembled').length}/${decisions.length}`
      : decisions.length === 0
        ? '(no assemble decisions)'
        : 'all passthrough',
  };
};

/** Pin path fired on at least one assemble (reasons include `pinned_recent`). */
export const pinnedRecentSurvives = (): Scorer => (ctx) => {
  const decisions = assembleDecisions(ctx.trace).filter((d) => d.outcome === 'assembled');
  if (decisions.length === 0) {
    return { name: 'pinned recent survives', passed: false, detail: '(no assembled turns)' };
  }
  const ok = decisions.every((d) => d.reasons.includes('pinned_recent') && d.pinnedUnits >= 1);
  return {
    name: 'pinned recent survives',
    passed: ok,
    detail: ok
      ? `${decisions.length} assembled turn(s) pinned`
      : 'missing pinned_recent / pinnedUnits on an assembled turn',
  };
};

export const importanceScoringIs = (enabled: boolean): Scorer => (ctx) => {
  const decisions = assembleDecisions(ctx.trace);
  if (decisions.length === 0) {
    return {
      name: `importanceScoring === ${enabled}`,
      passed: false,
      detail: '(no assemble decisions)',
    };
  }
  const ok = decisions.every((d) => d.importanceScoring === enabled);
  return {
    name: `importanceScoring === ${enabled}`,
    passed: ok,
    detail: decisions.map((d) => String(d.importanceScoring)).join(', '),
  };
};

/**
 * After assemble, at least one afterMessages snapshot still contains a tool
 * result for `toolCallId` (ablation: importance keeps ERROR unit).
 */
export const afterAssembleKeepsToolCallId = (toolCallId: string): Scorer => (ctx) => {
  const assembled = assembleDecisions(ctx.trace).filter((d) => d.outcome === 'assembled');
  if (assembled.length === 0) {
    return {
      name: `after assemble keeps toolCallId=${toolCallId}`,
      passed: false,
      detail: '(no assembled turns)',
    };
  }
  const last = assembled[assembled.length - 1]!;
  const kept = (last.afterMessages ?? []).some((m) => m.toolCallId === toolCallId);
  return {
    name: `after assemble keeps toolCallId=${toolCallId}`,
    passed: kept,
    detail: kept ? 'kept' : `dropped (after=${last.afterMessages?.length ?? 0} msgs)`,
  };
};

export const afterAssembleDropsToolCallId = (toolCallId: string): Scorer => (ctx) => {
  const assembled = assembleDecisions(ctx.trace).filter((d) => d.outcome === 'assembled');
  if (assembled.length === 0) {
    return {
      name: `after assemble drops toolCallId=${toolCallId}`,
      passed: false,
      detail: '(no assembled turns)',
    };
  }
  const last = assembled[assembled.length - 1]!;
  const present = (last.afterMessages ?? []).some((m) => m.toolCallId === toolCallId);
  return {
    name: `after assemble drops toolCallId=${toolCallId}`,
    passed: !present,
    detail: present ? 'still present' : 'dropped',
  };
};

/** Every tool-role message in the durable transcript is marked untrusted. */
export const toolResultsUntrusted = (): Scorer => (ctx) => {
  const tools = ctx.result.messages.filter((m) => m.role === 'tool');
  if (tools.length === 0) {
    return { name: 'tool results untrusted', passed: false, detail: '(no tool messages)' };
  }
  const bad = tools.filter((m) => !m.untrusted);
  return {
    name: 'tool results untrusted',
    passed: bad.length === 0,
    detail: bad.length === 0 ? `${tools.length} tool msg(s) untrusted` : `${bad.length} missing untrusted`,
  };
};

/** Model re-called at least `min` tools whose results were previously evicted. */
export const recalledAfterEviction = (min = 1): Scorer => (ctx) => {
  const recalled = ctx.trace.turns.flatMap((t) => t.recalledTools ?? []);
  return {
    name: `recalled after eviction ≥ ${min}`,
    passed: recalled.length >= min,
    detail:
      recalled.length === 0
        ? '(none)'
        : recalled.map((r) => `${r.tool}@t${r.turn}←${r.evictedBy}`).join(', '),
  };
};

/** At least one retrieval-kind message remains untrusted (injection defence). */
export const retrievalStaysUntrusted = (): Scorer => (ctx) => {
  const retrieval = ctx.result.messages.filter((m) => m.kind === 'retrieval');
  if (retrieval.length === 0) {
    return { name: 'retrieval stays untrusted', passed: false, detail: '(no retrieval messages)' };
  }
  const bad = retrieval.filter((m) => !m.untrusted);
  return {
    name: 'retrieval stays untrusted',
    passed: bad.length === 0,
    detail: bad.length === 0 ? `${retrieval.length} retrieval msg(s)` : `${bad.length} trusted (bad)`,
  };
};

export const retrievalMessageCountIs = (n: number): Scorer => (ctx) => {
  const count = ctx.result.messages.filter((m) => m.kind === 'retrieval').length;
  return {
    name: `retrieval message count === ${n}`,
    passed: count === n,
    detail: `${count}`,
  };
};

/** Any transcript message content contains `substr` (case-sensitive). */
export const messageContentIncludes = (substr: string): Scorer => (ctx) => {
  const hit = ctx.result.messages.some((m) => (m.content ?? '').includes(substr));
  return {
    name: `message content includes "${substr.slice(0, 40)}"`,
    passed: hit,
    detail: hit ? 'found' : 'missing',
  };
};

export const noMessageContentIncludes = (substr: string): Scorer => (ctx) => {
  const hit = ctx.result.messages.some((m) => (m.content ?? '').includes(substr));
  return {
    name: `no message content includes "${substr.slice(0, 40)}"`,
    passed: !hit,
    detail: hit ? 'found (unexpected)' : 'absent',
  };
};

/** Scratchpad offload pointer present in a tool observation. */
export const scratchpadOffloaded = (): Scorer => (ctx) => {
  const hit = ctx.result.messages.some(
    (m) => m.role === 'tool' && (m.content ?? '').includes('[Offloaded'),
  );
  return {
    name: 'scratchpad offloaded',
    passed: hit,
    detail: hit ? 'saw [Offloaded …]' : '(no offload pointer)',
  };
};

export const scratchpadNotOffloaded = (): Scorer => (ctx) => {
  const hit = ctx.result.messages.some(
    (m) => m.role === 'tool' && (m.content ?? '').includes('[Offloaded'),
  );
  return {
    name: 'scratchpad not offloaded',
    passed: !hit,
    detail: hit ? 'saw unexpected offload' : 'inline result',
  };
};

// ── Compact decisions ───────────────────────────────────────────────

export const compactOutcomeIs = (outcome: CompactDecision['outcome']): Scorer => (ctx) => {
  const decisions = compactDecisions(ctx.trace);
  if (decisions.length === 0) {
    return { name: `compact outcome === ${outcome}`, passed: false, detail: '(no compact decisions)' };
  }
  const last = decisions[decisions.length - 1]!;
  return {
    name: `compact outcome === ${outcome}`,
    passed: last.outcome === outcome,
    detail: `${last.outcome}/${last.reason}`,
  };
};

export const compactReasonIs = (reason: CompactDecision['reason']): Scorer => (ctx) => {
  const decisions = compactDecisions(ctx.trace);
  if (decisions.length === 0) {
    return { name: `compact reason === ${reason}`, passed: false, detail: '(no compact decisions)' };
  }
  const last = decisions[decisions.length - 1]!;
  return {
    name: `compact reason === ${reason}`,
    passed: last.reason === reason,
    detail: last.reason,
  };
};

export const compactProtectedUnitsAtLeast = (min: number): Scorer => (ctx) => {
  const compacted = compactDecisions(ctx.trace).filter((d) => d.outcome === 'compacted');
  if (compacted.length === 0) {
    return { name: `compact protectedUnits ≥ ${min}`, passed: false, detail: '(no compacted turns)' };
  }
  const last = compacted[compacted.length - 1]!;
  return {
    name: `compact protectedUnits ≥ ${min}`,
    passed: last.protectedUnits >= min,
    detail: `${last.protectedUnits}`,
  };
};

export const afterCompactKeepsToolCallId = (toolCallId: string): Scorer => (ctx) => {
  const compacted = compactDecisions(ctx.trace).filter((d) => d.outcome === 'compacted');
  if (compacted.length === 0) {
    return {
      name: `after compact keeps toolCallId=${toolCallId}`,
      passed: false,
      detail: '(no compacted turns)',
    };
  }
  const last = compacted[compacted.length - 1]!;
  const kept =
    (last.afterMessages ?? []).some((m) => m.toolCallId === toolCallId) ||
    ctx.result.messages.some((m) => m.toolCallId === toolCallId);
  return {
    name: `after compact keeps toolCallId=${toolCallId}`,
    passed: kept,
    detail: kept ? 'kept' : 'dropped',
  };
};

export const afterCompactDropsToolCallId = (toolCallId: string): Scorer => (ctx) => {
  const compacted = compactDecisions(ctx.trace).filter((d) => d.outcome === 'compacted');
  if (compacted.length === 0) {
    return {
      name: `after compact drops toolCallId=${toolCallId}`,
      passed: false,
      detail: '(no compacted turns)',
    };
  }
  const last = compacted[compacted.length - 1]!;
  const present =
    (last.afterMessages ?? []).some((m) => m.toolCallId === toolCallId) ||
    ctx.result.messages.some((m) => m.role !== 'system' && m.toolCallId === toolCallId);
  return {
    name: `after compact drops toolCallId=${toolCallId}`,
    passed: !present,
    detail: present ? 'still present' : 'dropped',
  };
};

export const compactRemovedToolResultsAtLeast = (min: number): Scorer => (ctx) => {
  const compacted = compactDecisions(ctx.trace).filter((d) => d.outcome === 'compacted');
  if (compacted.length === 0) {
    return {
      name: `compact removedToolResults ≥ ${min}`,
      passed: false,
      detail: '(no compacted turns)',
    };
  }
  const n = compacted[compacted.length - 1]!.removedToolResults?.length ?? 0;
  return {
    name: `compact removedToolResults ≥ ${min}`,
    passed: n >= min,
    detail: `${n}`,
  };
};

// ── HITL / approver (close over live ApprovalStats) ─────────────────

export const humanInterventionsUnder = (stats: ApprovalStats, max: number): Scorer => () => ({
  name: `human interventions ≤ ${max}`,
  passed: stats.requested <= max,
  detail: `${stats.requested} request(s) (${stats.approved} approved, ${stats.denied} denied)`,
});

export const humanInterventionRequested = (stats: ApprovalStats, min = 1): Scorer => () => ({
  name: `human intervention requested ≥ ${min}`,
  passed: stats.requested >= min,
  detail: `${stats.requested} request(s) (${stats.approved} approved, ${stats.denied} denied)`,
});

/** Helper for custom checks without importing types in call sites. */
export const check = (name: string, fn: (ctx: Parameters<Scorer>[0]) => boolean | CheckResult): Scorer =>
  (ctx) => {
    const out = fn(ctx);
    if (typeof out === 'boolean') return { name, passed: out };
    return out;
  };

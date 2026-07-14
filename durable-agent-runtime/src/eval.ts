/**
 * Eval harness: run the agent over scenario fixtures, score each outcome, and
 * produce a pass/fail report.
 *
 * Scoring reads the SAME durable artifacts as everything else — the final
 * RunState and the trace — so an eval is just another projection of a real run,
 * not a separate code path. With the deterministic mock model this runs in CI
 * and catches regressions when a prompt / model / config changes.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApprovalStats, Approver } from '@agent/harness';

import type { ModelProvider } from './model/provider.js';
import type { Policy } from './policy.js';
import type { Runtime } from './runtime.js';
import type { Trace } from './trace.js';
import type { RunState } from './types.js';

export interface ScoreContext {
  state: RunState;
  trace: Trace;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export type Scorer = (ctx: ScoreContext) => CheckResult | Promise<CheckResult>;

export interface Scenario {
  name: string;
  issue: string;
  checks: Scorer[];
  /** Optional per-scenario policy override — used by guardrail-regression scenarios. */
  policy?: Policy;
  /**
   * Drive this scenario through the @agent/harness model-driven loop instead of
   * the fixed demo workflow. Required for scorers that read turn/tool-sequence
   * data the fixed workflow doesn't produce (`turnsUnder`, `trajectoryJudge`).
   * Implied `true` when `approver` is set.
   */
  harness?: boolean;
  /**
   * Optional human-in-the-loop approver. Implies `harness: true`. When set,
   * the eval runner wires this approver into the harness loop, so scorers
   * reading an `ApprovalStats` object (`humanInterventionsUnder` /
   * `humanInterventionRequested`) can assert on how often it was consulted.
   */
  approver?: Approver;
}

// --- Scorers (composable; each grades one property of the run) --------------

export const runCompleted = (): Scorer => (ctx) => ({
  name: 'run completed',
  passed: ctx.state.status === 'completed',
  detail: `status=${ctx.state.status}`,
});

export const proposalContains = (substr: string): Scorer => (ctx) => {
  const proposal = (ctx.state.summary as { proposal?: string } | undefined)?.proposal ?? '';
  return {
    name: `proposal mentions "${substr}"`,
    passed: proposal.toLowerCase().includes(substr.toLowerCase()),
    detail: proposal.slice(0, 60) || '(empty)',
  };
};

export const touchedFile = (path: string): Scorer => (ctx) => {
  const files = (ctx.state.summary as { files?: string[] } | undefined)?.files ?? [];
  return { name: `touches ${path}`, passed: files.includes(path), detail: files.join(', ') || '(none)' };
};

export const costUnderUsd = (max: number): Scorer => (ctx) => ({
  name: `cost < $${max}`,
  passed: ctx.trace.totals.costUsd <= max,
  detail: `$${ctx.trace.totals.costUsd.toFixed(6)}`,
});

export const noToolFailures = (): Scorer => (ctx) => ({
  name: 'no tool failures',
  passed: ctx.trace.totals.failedToolCalls === 0,
  detail: `${ctx.trace.totals.failedToolCalls} failed`,
});

/**
 * Continuous tool-reliability metric (vs. `noToolFailures`'s zero-tolerance
 * check): the fraction of tool calls that succeeded must meet `min` (0–1).
 */
export const toolSuccessRate = (min: number): Scorer => (ctx) => {
  const { toolCalls, failedToolCalls } = ctx.trace.totals;
  const total = toolCalls + failedToolCalls;
  const rate = total === 0 ? 1 : (total - failedToolCalls) / total;
  return {
    name: `tool success rate \u2265 ${(min * 100).toFixed(0)}%`,
    passed: rate >= min,
    detail: `${(rate * 100).toFixed(0)}% (${total - failedToolCalls}/${total})`,
  };
};

/**
 * Efficiency: the model-driven harness loop must reach a final answer within
 * `max` turns. Harness runs only — reads `summary.turns` (absent for the
 * fixed demo workflow, which has no turn concept).
 */
export const turnsUnder = (max: number): Scorer => (ctx) => {
  const turns = (ctx.state.summary as { turns?: number } | undefined)?.turns;
  return {
    name: `turns \u2264 ${max}`,
    passed: turns != null && turns <= max,
    detail: turns != null ? `${turns} turns` : '(no turns \u2014 not a harness run)',
  };
};

// --- Human-in-the-loop scorers (read an `ApprovalStats` from `countingApprover`) ---

/**
 * Human intervention rate, upper bound: a healthy unattended run should need
 * at most `max` human approval decisions. Pass the live `stats` object
 * returned by `countingApprover` — it is populated by the run this scenario
 * triggers, so read it AFTER `runEval` executes (scorers run after the run
 * completes).
 */
export const humanInterventionsUnder = (stats: ApprovalStats, max: number): Scorer => () => ({
  name: `human interventions \u2264 ${max}`,
  passed: stats.requested <= max,
  detail: `${stats.requested} approval request(s) (${stats.approved} approved, ${stats.denied} denied)`,
});

/** Assert the approval gate actually fired at least `min` time(s) — proves a sensitive-tool gate isn't silently bypassed. */
export const humanInterventionRequested = (stats: ApprovalStats, min = 1): Scorer => () => ({
  name: `human intervention requested \u2265 ${min}`,
  passed: stats.requested >= min,
  detail: `${stats.requested} approval request(s) (${stats.approved} approved, ${stats.denied} denied)`,
});

// --- Policy scorers (grade the declarative guardrail layer) -----------------

/** Assert the run tripped no guardrails (a good run under an active policy). */
export const noPolicyViolations = (): Scorer => (ctx) => ({
  name: 'no policy violations',
  passed: ctx.trace.totals.policyDenials === 0,
  detail: `${ctx.trace.totals.policyDenials} denied`,
});

/** Assert the policy layer actively DENIED at least `min` call(s). */
export const policyDenied = (min = 1): Scorer => (ctx) => ({
  name: `policy denied \u2265${min} call(s)`,
  passed: ctx.trace.totals.policyDenials >= min,
  detail: `${ctx.trace.totals.policyDenials} denied`,
});

/** Assert the run failed and its error mentions `substr` (e.g. "budget"). */
export const runFailedWith = (substr: string): Scorer => (ctx) => {
  const error = ctx.state.error ?? '';
  return {
    name: `run failed with "${substr}"`,
    passed: ctx.state.status === 'failed' && error.toLowerCase().includes(substr.toLowerCase()),
    detail: `status=${ctx.state.status}${error ? ` \u2014 ${error.slice(0, 40)}` : ''}`,
  };
};

/**
 * LLM-as-judge scorer: ask a model to grade the proposal against a criterion.
 * The judge is injected (any `ModelProvider`), so swapping the deterministic
 * demo judge for a real LLM is a one-line change — the harness is unchanged.
 * A real judge is non-deterministic; mitigate with low temperature, structured
 * output, and/or majority vote over samples.
 */
export const llmJudge = (judge: ModelProvider, criterion: string): Scorer => async (ctx) => {
  const issue = ctx.state.input?.issue ?? '';
  const proposal = (ctx.state.summary as { proposal?: string } | undefined)?.proposal ?? '';
  const prompt =
    `[judge] Criterion: ${criterion}\nIssue: ${issue}\n` +
    `Answer PASS or FAIL with a short reason, judging only the proposal below.\nProposal: ${proposal}`;
  const { text } = await judge.complete(prompt);
  return { name: `judge: ${criterion}`, passed: /^\s*pass\b/i.test(text), detail: text.slice(0, 60) };
};

/**
 * Deterministic stand-in for an LLM judge — approves a proposal only if it names
 * a concrete fix AND cites a source file. Swap for a real model in production.
 */
export const heuristicJudge: ModelProvider = {
  name: 'heuristic-judge',
  async complete(prompt: string) {
    const proposal = (prompt.split('Proposal:')[1] ?? '').trim();
    const namesFix = /guard|handle|null|fix|check/i.test(proposal);
    const citesFile = /\.(ts|tsx|js)\b/i.test(proposal);
    const text =
      namesFix && citesFile ? 'PASS — names a concrete fix and cites a file.' : 'FAIL — vague or missing fix.';
    return { text, promptTokens: 1, completionTokens: 1 };
  },
};

/**
 * Trajectory/process scorer: an LLM judge grades the SEQUENCE of tool calls
 * (not just the final answer) — catches redundant, irrelevant, or out-of-order
 * tool use that a purely outcome-based scorer (e.g. `llmJudge`) would miss.
 * Reads `summary.toolsUsed` (present on both the fixed workflow and harness runs).
 */
export const trajectoryJudge = (judge: ModelProvider, criterion: string): Scorer => async (ctx) => {
  const issue = ctx.state.input?.issue ?? '';
  const toolsUsed = (ctx.state.summary as { toolsUsed?: string[] } | undefined)?.toolsUsed ?? [];
  const prompt =
    `[judge] Criterion: ${criterion}\nIssue: ${issue}\n` +
    'Answer PASS or FAIL with a short reason, judging only the tool-call sequence below.\n' +
    `Tool calls (in order): ${toolsUsed.join(' \u2192 ') || '(none)'}`;
  const { text } = await judge.complete(prompt);
  return { name: `trajectory judge: ${criterion}`, passed: /^\s*pass\b/i.test(text), detail: text.slice(0, 60) };
};

/**
 * Deterministic stand-in for an LLM trajectory judge — approves a sequence
 * only if it fetched the issue before searching code and never repeated the
 * same tool back-to-back (a cheap proxy for "no obviously wasted work").
 */
export const heuristicTrajectoryJudge: ModelProvider = {
  name: 'heuristic-trajectory-judge',
  async complete(prompt: string) {
    const line = (prompt.split('Tool calls (in order):')[1] ?? '').trim();
    const sequence = line === '(none)' || !line ? [] : line.split('\u2192').map((s) => s.trim());
    const fetchesBeforeSearch = sequence.indexOf('getIssue') === -1 || sequence.indexOf('searchCode') === -1
      || sequence.indexOf('getIssue') < sequence.indexOf('searchCode');
    const noImmediateRepeat = sequence.every((tool, i) => i === 0 || sequence[i - 1] !== tool);
    const text = fetchesBeforeSearch && noImmediateRepeat
      ? 'PASS — sensible order, no redundant repeats.'
      : 'FAIL — out-of-order or redundant tool calls.';
    return { text, promptTokens: 1, completionTokens: 1 };
  },
};

// --- Runner -----------------------------------------------------------------

export interface ScenarioResult {
  scenario: string;
  passed: boolean;
  checks: CheckResult[];
}

export interface EvalReport {
  results: ScenarioResult[];
  passed: number;
  failed: number;
  total: number;
  allPassed: boolean;
}

export async function runEval(
  scenarios: Scenario[],
  buildRuntime: (baseDir: string, scenario: Scenario) => Runtime | Promise<Runtime>,
): Promise<EvalReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    try {
      const runtime = await buildRuntime(mkdtempSync(join(tmpdir(), 'agent-eval-')), scenario);
      const state = await runtime.run(scenario.issue);
      const trace = runtime.trace(state.runId);
      const checks = await Promise.all(scenario.checks.map((check) => check({ state, trace })));
      results.push({ scenario: scenario.name, passed: checks.every((c) => c.passed), checks });
    } catch (err) {
      results.push({
        scenario: scenario.name,
        passed: false,
        checks: [{ name: 'run threw', passed: false, detail: err instanceof Error ? err.message : String(err) }],
      });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  return { results, passed, failed: results.length - passed, total: results.length, allPassed: passed === results.length };
}

export function renderReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    lines.push(`${r.passed ? 'PASS' : 'FAIL'}  ${r.scenario}`);
    for (const c of r.checks) {
      lines.push(`   ${c.passed ? '\u2713' : '\u2717'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
    }
  }
  lines.push('');
  lines.push(`${report.passed}/${report.total} scenarios passed${report.allPassed ? '' : '  \u2014 REGRESSION'}`);
  return lines.join('\n');
}

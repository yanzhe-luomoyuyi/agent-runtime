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

import type { ModelProvider } from './model/provider.js';
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
  buildRuntime: (baseDir: string) => Runtime,
): Promise<EvalReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    try {
      const runtime = buildRuntime(mkdtempSync(join(tmpdir(), 'agent-eval-')));
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

/**
 * Coding-agent scorecard: run eval scenarios and collect pass + process
 * metrics (turns / cost / tool failures) into a storable table.
 *
 * Same durable artifacts as platform `runEval` — this runner additionally
 * projects Trace + summary into scorecard rows for baseline comparison.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EvalReport, Runtime, Scenario, ScenarioResult } from 'durable-agent-runtime';

import { bugCases, type BugDifficulty } from './fixtures.js';
import { GUARDRAIL_SCENARIO_NAME } from './scenarios.js';

export type ScorecardDifficulty = BugDifficulty | 'guardrail';

export interface ScorecardRow {
  scenario: string;
  difficulty: ScorecardDifficulty;
  passed: boolean;
  turns: number | null;
  costUsd: number;
  toolFail: number;
  toolCalls: number;
}

export interface CodingEvalResult {
  report: EvalReport;
  scorecard: ScorecardRow[];
}

export interface ScorecardBaseline {
  version: 1;
  mode: 'scripted' | 'live' | 'regress';
  generatedAt: string;
  rows: ScorecardRow[];
}

function difficultyFor(scenarioName: string): ScorecardDifficulty {
  if (scenarioName === GUARDRAIL_SCENARIO_NAME) return 'guardrail';
  return bugCases.find((b) => b.name === scenarioName)?.difficulty ?? 'easy';
}

/** Run scenarios and build both the pass/fail report and a metrics scorecard. */
export async function runCodingEval(
  scenarios: Scenario[],
  buildRuntime: (baseDir: string, scenario: Scenario) => Runtime | Promise<Runtime>,
): Promise<CodingEvalResult> {
  const results: ScenarioResult[] = [];
  const scorecard: ScorecardRow[] = [];

  for (const scenario of scenarios) {
    try {
      const runtime = await buildRuntime(mkdtempSync(join(tmpdir(), 'agent-eval-')), scenario);
      const state = await runtime.run(scenario.issue);
      const trace = runtime.trace(state.runId);
      const checks = await Promise.all(scenario.checks.map((check) => check({ state, trace })));
      const passed = checks.every((c) => c.passed);
      results.push({ scenario: scenario.name, passed, checks });
      const summary = state.summary as { turns?: number } | undefined;
      scorecard.push({
        scenario: scenario.name,
        difficulty: difficultyFor(scenario.name),
        passed,
        turns: summary?.turns ?? null,
        costUsd: trace.totals.costUsd,
        toolFail: trace.totals.failedToolCalls,
        toolCalls: trace.totals.toolCalls + trace.totals.failedToolCalls,
      });
    } catch (err) {
      results.push({
        scenario: scenario.name,
        passed: false,
        checks: [{ name: 'run threw', passed: false, detail: err instanceof Error ? err.message : String(err) }],
      });
      scorecard.push({
        scenario: scenario.name,
        difficulty: difficultyFor(scenario.name),
        passed: false,
        turns: null,
        costUsd: 0,
        toolFail: 0,
        toolCalls: 0,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const report: EvalReport = {
    results,
    passed,
    failed: results.length - passed,
    total: results.length,
    allPassed: passed === results.length,
  };
  return { report, scorecard };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

/** Human-readable scorecard table for CLI / interview demos. */
export function renderScorecard(rows: ScorecardRow[]): string {
  const lines: string[] = [
    `${pad('PASS', 4)}  ${pad('DIFF', 9)}  ${pad('TURNS', 5)}  ${pad('COST', 10)}  ${pad('TFAIL', 5)}  SCENARIO`,
    `${'-'.repeat(4)}  ${'-'.repeat(9)}  ${'-'.repeat(5)}  ${'-'.repeat(10)}  ${'-'.repeat(5)}  ${'-'.repeat(24)}`,
  ];
  for (const r of rows) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    const turns = r.turns == null ? '-' : String(r.turns);
    const cost = `$${r.costUsd.toFixed(6)}`;
    lines.push(
      `${pad(mark, 4)}  ${pad(r.difficulty, 9)}  ${pad(turns, 5)}  ${pad(cost, 10)}  ${pad(String(r.toolFail), 5)}  ${r.scenario}`,
    );
  }
  const byDiff = (d: ScorecardDifficulty) => rows.filter((r) => r.difficulty === d);
  const summary = (['easy', 'medium', 'hard', 'guardrail'] as ScorecardDifficulty[])
    .map((d) => {
      const rs = byDiff(d);
      if (rs.length === 0) return null;
      const ok = rs.filter((r) => r.passed).length;
      return `${d} ${ok}/${rs.length}`;
    })
    .filter(Boolean)
    .join('  ·  ');
  lines.push('');
  lines.push(`scorecard: ${rows.filter((r) => r.passed).length}/${rows.length} passed  (${summary})`);
  return lines.join('\n');
}

export function defaultBaselinePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'baseline.scripted.json');
}

export function loadBaseline(path = defaultBaselinePath()): ScorecardBaseline | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ScorecardBaseline;
  } catch {
    return null;
  }
}

export function writeBaseline(
  rows: ScorecardRow[],
  opts: { path?: string; mode?: ScorecardBaseline['mode'] } = {},
): string {
  const path = opts.path ?? defaultBaselinePath();
  const baseline: ScorecardBaseline = {
    version: 1,
    mode: opts.mode ?? 'scripted',
    generatedAt: new Date().toISOString(),
    rows,
  };
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return path;
}

export interface BaselineDiff {
  scenario: string;
  issues: string[];
}

/** Compare current scorecard to a committed baseline (scripted mode). */
export function diffAgainstBaseline(rows: ScorecardRow[], baseline: ScorecardBaseline): BaselineDiff[] {
  const diffs: BaselineDiff[] = [];
  const byName = new Map(baseline.rows.map((r) => [r.scenario, r]));
  for (const row of rows) {
    const prev = byName.get(row.scenario);
    const issues: string[] = [];
    if (!prev) {
      issues.push('new scenario (not in baseline)');
    } else {
      if (prev.passed !== row.passed) issues.push(`passed ${prev.passed} → ${row.passed}`);
      if (prev.turns != null && row.turns != null && row.turns > prev.turns) {
        issues.push(`turns ${prev.turns} → ${row.turns}`);
      }
      if (row.toolFail > prev.toolFail) issues.push(`toolFail ${prev.toolFail} → ${row.toolFail}`);
      if (row.costUsd > prev.costUsd + 1e-9) {
        issues.push(`cost $${prev.costUsd.toFixed(6)} → $${row.costUsd.toFixed(6)}`);
      }
    }
    if (issues.length) diffs.push({ scenario: row.scenario, issues });
  }
  for (const prev of baseline.rows) {
    if (!rows.some((r) => r.scenario === prev.scenario)) {
      diffs.push({ scenario: prev.scenario, issues: ['missing from current run'] });
    }
  }
  return diffs;
}

export function renderBaselineDiff(diffs: BaselineDiff[]): string {
  if (diffs.length === 0) return 'baseline: OK (no regressions vs committed scorecard)';
  const lines = ['baseline: DRIFT'];
  for (const d of diffs) lines.push(`  · ${d.scenario}: ${d.issues.join('; ')}`);
  return lines.join('\n');
}

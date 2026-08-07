/**
 * coding-agent eval — scores the harness-hosted loop against real bug
 * fixtures whose `npm test` must actually go red -> green; a regressed
 * script (edits without reading the file first) must be caught.
 */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { applyBugFixes, bugCases, createFixtureWorkspace } from '../src/eval/fixtures.js';
import { makeEvalRuntimeBuilder } from '../src/eval/runtime.js';
import { codingScenarios, GUARDRAIL_SCENARIO_NAME } from '../src/eval/scenarios.js';
import {
  diffAgainstBaseline,
  loadBaseline,
  renderScorecard,
  runCodingEval,
} from '../src/eval/scorecard.js';

function npmTest(cwd: string): { ok: boolean; status: number | null } {
  const r = spawnSync('npm', ['test', '--silent'], { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { ok: r.status === 0, status: r.status };
}

describe('coding-agent eval fixtures', () => {
  it('each bug case is red before the fix and green after', () => {
    for (const bug of bugCases) {
      const dir = createFixtureWorkspace(bug);
      expect(npmTest(dir).ok, `${bug.name} should fail before fix`).toBe(false);
      applyBugFixes(dir, bug);
      expect(npmTest(dir).ok, `${bug.name} should pass after fix`).toBe(true);
    }
  }, 60_000);
});

describe('coding-agent eval', () => {
  it('passes every scenario with a good scripted model', async () => {
    const { report, scorecard } = await runCodingEval(codingScenarios, makeEvalRuntimeBuilder());
    expect(report.allPassed).toBe(true);
    expect(report.failed).toBe(0);
    expect(scorecard).toHaveLength(codingScenarios.length);
    expect(scorecard.filter((r) => r.difficulty === 'easy').length).toBeGreaterThanOrEqual(3);
    expect(scorecard.filter((r) => r.difficulty === 'medium').length).toBeGreaterThanOrEqual(3);
    expect(scorecard.filter((r) => r.difficulty === 'hard').length).toBeGreaterThanOrEqual(3);
    // smoke: table renders
    expect(renderScorecard(scorecard)).toMatch(/scorecard:/);
  }, 120_000);

  it('the objective run_tests check passes on every bug fixture', async () => {
    const { report } = await runCodingEval(codingScenarios, makeEvalRuntimeBuilder());
    for (const bug of bugCases) {
      const result = report.results.find((r) => r.scenario === bug.name)!;
      const testsCheck = result.checks.find((c) => /run_tests passes/i.test(c.name))!;
      expect(testsCheck.passed, bug.name).toBe(true);
      expect(testsCheck.detail).toContain('exitCode=0');
    }
  }, 120_000);

  it('catches a regression that edits the file without reading it first', async () => {
    const { report } = await runCodingEval(codingScenarios, makeEvalRuntimeBuilder({ regressed: true }));
    expect(report.allPassed).toBe(false);
    for (const bug of bugCases) {
      const result = report.results.find((r) => r.scenario === bug.name)!;
      expect(result.passed, bug.name).toBe(false);
      expect(result.checks.some((c) => !c.passed && /tool failure/i.test(c.name))).toBe(true);
      expect(result.checks.some((c) => !c.passed && /run_tests passes/i.test(c.name))).toBe(true);
    }
    // Guardrail scenario is orthogonal to the regressed edit script — not asserted here.
    expect(report.results.some((r) => r.scenario === GUARDRAIL_SCENARIO_NAME)).toBe(true);
  }, 120_000);

  it('committed scripted baseline matches a fresh good run', async () => {
    const baseline = loadBaseline();
    expect(baseline, 'baseline.scripted.json should exist').toBeTruthy();
    const { scorecard } = await runCodingEval(codingScenarios, makeEvalRuntimeBuilder());
    const diffs = diffAgainstBaseline(scorecard, baseline!);
    expect(diffs, JSON.stringify(diffs, null, 2)).toEqual([]);
  }, 120_000);
});

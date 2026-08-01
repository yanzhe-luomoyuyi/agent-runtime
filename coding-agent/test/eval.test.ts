/**
 * coding-agent eval — scores the harness-hosted loop against real bug
 * fixtures whose `npm test` must actually go red -> green; a regressed
 * script (edits without reading the file first) must be caught.
 */

import { runEval } from 'durable-agent-runtime';
import { describe, expect, it } from 'vitest';

import { codingScenarios } from '../src/eval/scenarios.js';
import { makeEvalRuntimeBuilder } from '../src/eval/runtime.js';
import { GREETER_BUG, SUM_BUG } from '../src/eval/fixtures.js';

describe('coding-agent eval', () => {
  it('passes every scenario with a good scripted model', async () => {
    const report = await runEval(codingScenarios, makeEvalRuntimeBuilder());
    expect(report.allPassed).toBe(true);
    expect(report.failed).toBe(0);
  }, 30_000);

  it('the objective run_tests check actually exercises both fixtures', async () => {
    const report = await runEval(codingScenarios, makeEvalRuntimeBuilder());
    for (const bugName of [GREETER_BUG.name, SUM_BUG.name]) {
      const result = report.results.find((r) => r.scenario === bugName)!;
      const testsCheck = result.checks.find((c) => /run_tests passes/i.test(c.name))!;
      expect(testsCheck.passed).toBe(true);
      expect(testsCheck.detail).toContain('exitCode=0');
    }
  }, 30_000);

  it('catches a regression that edits the file without reading it first', async () => {
    const report = await runEval(codingScenarios, makeEvalRuntimeBuilder({ regressed: true }));
    expect(report.allPassed).toBe(false);
    for (const bugName of [GREETER_BUG.name, SUM_BUG.name]) {
      const result = report.results.find((r) => r.scenario === bugName)!;
      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => !c.passed && /tool failure/i.test(c.name))).toBe(true);
      expect(result.checks.some((c) => !c.passed && /run_tests passes/i.test(c.name))).toBe(true);
    }
  }, 30_000);
});


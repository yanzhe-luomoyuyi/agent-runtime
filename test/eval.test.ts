import { describe, expect, it } from 'vitest';

import { issueWorkflow } from '../src/app/issue-workflow.js';
import { demoScenarios } from '../src/app/scenarios.js';
import { getIssue, searchCode } from '../src/app/tools.js';
import { runEval, type Scenario } from '../src/eval.js';
import { MockModelProvider } from '../src/model/provider.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry } from '../src/tools/registry.js';

function buildRuntimeFactory(canned: Record<string, string>) {
  return (baseDir: string, scenario: Scenario): Runtime =>
    new Runtime({
      baseDir,
      model: new MockModelProvider(canned),
      tools: new ToolRegistry().register(getIssue).register(searchCode),
      workflow: issueWorkflow,
      policy: scenario.policy,
    });
}

const goodModel = {
  'analyze.summary': 'Null session on login.',
  'propose.fix': 'Guard the null session in src/auth/login.ts before reading user.token.',
};

// Simulates a prompt/model change that degrades the output (drops the fix + file).
const regressedModel = {
  'analyze.summary': 'Null session on login.',
  'propose.fix': 'Try turning it off and on again.',
};

describe('eval harness', () => {
  it('passes every scenario on a good model config', async () => {
    const report = await runEval(demoScenarios, buildRuntimeFactory(goodModel));
    expect(report.allPassed).toBe(true);
    expect(report.failed).toBe(0);
  });

  it('catches a regression when the prompt/model degrades', async () => {
    const report = await runEval(demoScenarios, buildRuntimeFactory(regressedModel));

    expect(report.allPassed).toBe(false);
    const login = report.results.find((r) => r.scenario.includes('login'))!;
    expect(login.passed).toBe(false);
    // The failing check is a content/quality check on the proposal.
    expect(login.checks.some((c) => !c.passed && /proposal/i.test(c.name))).toBe(true);
  });

  it('supports an LLM-as-judge scorer: passes a good proposal, fails a degraded one', async () => {
    const good = await runEval(demoScenarios, buildRuntimeFactory(goodModel));
    const goodLogin = good.results.find((r) => r.scenario.includes('login'))!;
    expect(goodLogin.checks.find((c) => /judge/i.test(c.name))!.passed).toBe(true);

    const bad = await runEval(demoScenarios, buildRuntimeFactory(regressedModel));
    const badLogin = bad.results.find((r) => r.scenario.includes('login'))!;
    expect(badLogin.checks.find((c) => /judge/i.test(c.name))!.passed).toBe(false);
  });
});

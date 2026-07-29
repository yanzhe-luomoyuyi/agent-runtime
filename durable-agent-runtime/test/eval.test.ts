import { describe, expect, it } from 'vitest';

import { DEMO_PROPOSALS, cannedResponses } from '../src/app/demo-fixtures.js';
import { createDemoRuntime } from '../src/app/demo-runtime.js';
import { demoScenarios } from '../src/app/scenarios.js';
import { runEval, type Scenario } from '../src/eval.js';
import { MockModelProvider } from '../src/model/provider.js';
import type { Runtime } from '../src/runtime.js';

function buildRuntimeFactory(canned: Record<string, string>) {
  return (baseDir: string, scenario: Scenario): Promise<Runtime> =>
    createDemoRuntime({
      baseDir,
      harness: Boolean(scenario.harness || scenario.approver),
      quiet: true,
      model: scenario.harness || scenario.approver ? undefined : new MockModelProvider(canned),
      policy: scenario.policy,
      approver: scenario.approver,
    });
}

const goodModel = cannedResponses();
const regressedModel = cannedResponses({ regress: true });

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
    expect(DEMO_PROPOSALS.regressed).toContain('turning it off');
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

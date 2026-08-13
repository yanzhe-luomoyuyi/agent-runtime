/**
 * L2 harness eval: default suite + scorer/runner smoke checks.
 */
import { describe, expect, it } from 'vitest';

import {
  defaultHarnessScenarios,
  renderHarnessReport,
  runFinished,
  runHarnessEval,
  stopReasonIs,
} from '../src/eval/index.js';
import {
  MockToolInvoker,
  RuleChatModel,
  finalResponse,
  toolCall,
  toolCallResponse,
} from '../src/testkit/index.js';
import { demoGetIssue } from '../src/eval/fixtures.js';

describe('runHarnessEval', () => {
  it('passes the default L2 suite (loop + assemble ablation)', async () => {
    const report = await runHarnessEval(defaultHarnessScenarios());
    if (!report.allPassed) {
      // Surface which checks failed before asserting — helps CI diffs.
      console.error(renderHarnessReport(report));
    }
    expect(report.allPassed).toBe(true);
    expect(report.total).toBe(defaultHarnessScenarios().length);
    expect(report.passed).toBe(report.total);
  });

  it('records a thrown setup/run as a failed scenario (does not abort the suite)', async () => {
    const report = await runHarnessEval([
      {
        name: 'throws',
        setup: () => {
          throw new Error('boom');
        },
        checks: [runFinished()],
      },
      {
        name: 'still-runs',
        setup: () => ({
          goal: 'x',
          model: new RuleChatModel(() => finalResponse('ok')),
          tools: new MockToolInvoker([demoGetIssue]),
        }),
        checks: [runFinished()],
      },
    ]);
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.results[0]!.passed).toBe(false);
    expect(report.results[0]!.checks[0]!.name).toBe('run threw');
    expect(report.results[1]!.passed).toBe(true);
  });

  it('renderHarnessReport marks REGRESSION when any scenario fails', async () => {
    const report = await runHarnessEval([
      {
        name: 'expect-loop',
        setup: () => ({
          goal: 'x',
          model: new RuleChatModel(() => finalResponse('done')),
          tools: new MockToolInvoker([demoGetIssue]),
        }),
        checks: [stopReasonIs('loop_detected')],
      },
    ]);
    const text = renderHarnessReport(report);
    expect(text).toContain('FAIL');
    expect(text).toContain('REGRESSION');
  });

  it('grades tool trajectory from a custom loop scenario', async () => {
    const report = await runHarnessEval([
      {
        name: 'single-tool',
        setup: () => {
          const tools = new MockToolInvoker([demoGetIssue]);
          const model = new RuleChatModel((req) => {
            const called = req.messages.some((m) => m.role === 'tool' && m.name === 'getIssue');
            if (!called) return toolCallResponse([toolCall('c1', 'getIssue', { issue: 'x' })]);
            return finalResponse('done');
          });
          return { goal: 'x', model, tools };
        },
        checks: [runFinished(), stopReasonIs('finished')],
      },
    ]);
    expect(report.allPassed).toBe(true);
  });
});

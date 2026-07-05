import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { issueWorkflow } from '../src/app/issue-workflow.js';
import { MockModelProvider, type ModelProvider, type ModelResult } from '../src/model/provider.js';
import { BUILTIN_REDACTIONS, PolicyEnforcer, PolicyViolationError } from '../src/policy.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';

function makeModel(): MockModelProvider {
  return new MockModelProvider({
    'analyze.summary': 'Crash on login due to a null session.',
    'propose.fix': 'Guard the null session in src/auth/login.ts before reading user.token.',
  });
}

function makeTools(): ToolRegistry {
  const getIssue: ToolDef<{ issue: string }> = {
    name: 'getIssue',
    description: '',
    inputSchema: {},
    run: (a) => ({ title: a.issue.slice(0, 40), body: a.issue, labels: ['bug'] }),
  };
  const searchCode: ToolDef = {
    name: 'searchCode',
    description: '',
    inputSchema: {},
    run: () => ({ files: ['src/auth/login.ts'] }),
  };
  return new ToolRegistry().register(getIssue).register(searchCode);
}

describe('PolicyEnforcer (unit)', () => {
  it('allows tools on the allow-list and rejects the rest', () => {
    const p = new PolicyEnforcer({ allowedTools: ['getIssue'] });
    expect(() => p.checkTool('getIssue')).not.toThrow();
    expect(() => p.checkTool('searchCode')).toThrow(PolicyViolationError);
  });

  it('treats an absent allow-list as "allow all"', () => {
    const p = new PolicyEnforcer({});
    expect(() => p.checkTool('anything')).not.toThrow();
  });

  it('enforces a cost budget once cumulative spend reaches the ceiling', () => {
    const p = new PolicyEnforcer({ maxCostUsd: 0.01 });
    expect(() => p.checkBudget(0.009, 'x')).not.toThrow();
    expect(() => p.checkBudget(0.01, 'x')).toThrow(PolicyViolationError);
    expect(() => p.checkBudget(0.02, 'x')).toThrow(/budget/i);
  });

  it('redacts configured PII patterns and reports which fired', () => {
    const p = new PolicyEnforcer({
      redactions: [BUILTIN_REDACTIONS.email!, BUILTIN_REDACTIONS.phone!, BUILTIN_REDACTIONS.secret!],
    });
    const { text, applied } = p.redact('mail jane.doe@example.com call +1 (415) 555-2671 key sk-ABCDxyzKLMNOpqrsTUV');
    expect(text).not.toMatch(/jane\.doe@example\.com/);
    expect(text).not.toMatch(/555-2671/);
    expect(text).not.toMatch(/sk-ABCDxyzKLMNOpqrsTUV/);
    expect(text).toContain('[REDACTED:email]');
    expect(applied).toEqual(expect.arrayContaining(['email', 'phone', 'secret']));
  });

  it('leaves clean text (and workflow markers) untouched', () => {
    const p = new PolicyEnforcer({ redactions: [BUILTIN_REDACTIONS.email!] });
    const { text, applied } = p.redact('[analyze.summary] Login page crashes with a null session');
    expect(text).toBe('[analyze.summary] Login page crashes with a null session');
    expect(applied).toEqual([]);
  });
});

describe('policy layer on the runtime funnel', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-policy-'));
  });

  it('a permissive policy lets a good run complete with zero denials', async () => {
    const rt = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      policy: { allowedTools: ['getIssue', 'searchCode'], maxCostUsd: 1 },
    });
    const state = await rt.run('Login page crashes with a null session');
    expect(state.status).toBe('completed');
    expect(rt.trace(state.runId).totals.policyDenials).toBe(0);
  });

  it('denies a tool that is not on the allow-list and fails the run (durably recorded)', async () => {
    const rt = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      policy: { allowedTools: ['getIssue'] }, // searchCode is deliberately NOT allowed
    });
    const state = await rt.run('Login page crashes with a null session');

    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/allow-list/i);
    expect(rt.trace(state.runId).totals.policyDenials).toBe(1);
    // analyze (getIssue + model) got through; locate (searchCode) was blocked.
    expect(state.phases['analyze']?.status).toBe('COMPLETED');
    expect(state.phases['locate']?.status).not.toBe('COMPLETED');
  });

  it('stops the run once the cumulative cost budget is exhausted', async () => {
    // Measure the analyze-phase model cost with no budget in play.
    const probeDir = mkdtempSync(join(tmpdir(), 'agent-policy-probe-'));
    const probe = new Runtime({ baseDir: probeDir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const probeState = await probe.run('Login page crashes with a null session');
    const analyzeCost = probe.trace(probeState.runId).byPhase['analyze']!.costUsd;
    expect(analyzeCost).toBeGreaterThan(0);

    // A budget equal to the analyze cost admits analyze.2 but blocks propose.1.
    const rt = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      policy: { maxCostUsd: analyzeCost },
    });
    const state = await rt.run('Login page crashes with a null session');

    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/budget/i);
    expect(rt.trace(state.runId).totals.policyDenials).toBe(1);
    expect(state.phases['analyze']?.status).toBe('COMPLETED');
    expect(state.phases['propose']?.status).not.toBe('COMPLETED');
  });

  it('redacts PII before the prompt ever reaches the model', async () => {
    const seen: string[] = [];
    const spy: ModelProvider = {
      name: 'spy',
      async complete(prompt: string): Promise<ModelResult> {
        seen.push(prompt);
        const key = prompt.match(/^\[([^\]]+)\]/)?.[1];
        const text = key === 'analyze.summary' ? 'summary' : 'Guard the null session in src/auth/login.ts.';
        return { text, promptTokens: 1, completionTokens: 1 };
      },
    };
    const rt = new Runtime({
      baseDir: dir,
      model: spy,
      tools: makeTools(),
      workflow: issueWorkflow,
      policy: { redactions: [BUILTIN_REDACTIONS.email!] },
    });
    await rt.run('Login crashes for user jane@corp.com after signout');

    expect(seen.join('\n')).not.toMatch(/jane@corp\.com/); // the model never saw the raw PII
    expect(seen.some((p) => p.includes('[REDACTED:email]'))).toBe(true);
  });
});

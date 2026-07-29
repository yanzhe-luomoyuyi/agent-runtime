import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { issueWorkflow } from '../src/app/issue-workflow.js';
import { MockModelProvider, type ModelProvider, type ModelResult } from '../src/model/provider.js';
import { BUILTIN_REDACTIONS, PolicyEnforcer, PolicyViolationError } from '../src/policy.js';
import { Runtime } from '../src/runtime.js';
import { makeModel, makeTools } from './helpers/demo.js';


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

  it('rate limit: allows a burst up to capacity, then rejects until refill (injectable clock)', () => {
    let clock = 0;
    const p = new PolicyEnforcer({ rateLimits: { searchCode: { capacity: 2, refillPerSec: 1 } } }, undefined, () => clock);

    // Burst: 2 calls consume the full bucket immediately.
    expect(() => p.checkRateLimit('searchCode')).not.toThrow();
    expect(() => p.checkRateLimit('searchCode')).not.toThrow();
    // 3rd call with no elapsed time exhausts the bucket.
    expect(() => p.checkRateLimit('searchCode')).toThrow(PolicyViolationError);
    expect(() => p.checkRateLimit('searchCode')).toThrow(/rate limit/i);

    // Advance the clock by 1s => refillPerSec=1 adds exactly one token back.
    clock += 1000;
    expect(() => p.checkRateLimit('searchCode')).not.toThrow();
    expect(() => p.checkRateLimit('searchCode')).toThrow(PolicyViolationError);
  });

  it('rate limit: a tool with no configured rule is unlimited', () => {
    const p = new PolicyEnforcer({ rateLimits: { searchCode: { capacity: 1, refillPerSec: 1 } } });
    for (let i = 0; i < 50; i++) expect(() => p.checkRateLimit('getIssue')).not.toThrow();
  });

  it('rate limit: each tool gets an independent bucket', () => {
    const p = new PolicyEnforcer({
      rateLimits: {
        searchCode: { capacity: 1, refillPerSec: 0.001 },
        getIssue: { capacity: 1, refillPerSec: 0.001 },
      },
    });
    expect(() => p.checkRateLimit('searchCode')).not.toThrow();
    expect(() => p.checkRateLimit('searchCode')).toThrow(PolicyViolationError);
    // getIssue's bucket is untouched by searchCode's exhaustion.
    expect(() => p.checkRateLimit('getIssue')).not.toThrow();
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

  it('denies a tool call once its rate limit is exhausted and fails the run (durably recorded)', async () => {
    const rt = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      // capacity 0 => the very first searchCode call is rejected.
      policy: { rateLimits: { searchCode: { capacity: 0, refillPerSec: 0.001 } } },
    });
    const state = await rt.run('Login page crashes with a null session');

    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/rate limit/i);
    expect(rt.trace(state.runId).totals.policyDenials).toBe(1);
    // analyze (getIssue + model) got through; locate (searchCode) was rate-limited.
    expect(state.phases['analyze']?.status).toBe('COMPLETED');
    expect(state.phases['locate']?.status).not.toBe('COMPLETED');
  });

  it('replaying an idempotent (already-succeeded) tool call does NOT re-consume its rate limit', async () => {
    // crashAfter fires AFTER locate.1's searchCode call succeeds (recorded in
    // toolResults) but BEFORE StepCompleted — so on resume, locate.1 re-runs
    // and calls ctx.callTool('searchCode', ...) again with the SAME callId.
    const crashing = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      crashAfter: 'locate.1',
      policy: { rateLimits: { searchCode: { capacity: 1, refillPerSec: 0 } } },
    });
    await expect(crashing.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');
    const runId = readdirSync(dir)[0]!;

    // Resume with a FRESH Runtime whose searchCode bucket starts at capacity
    // 0 — if the cached/replayed call were wrongly re-enforced, this would
    // deny it immediately. It isn't: `callTool`'s idempotency check
    // (`callId in state.toolResults`) short-circuits BEFORE enforceRateLimit
    // ever runs, so a replayed call can't touch the bucket at all.
    const resumer = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      policy: { rateLimits: { searchCode: { capacity: 0, refillPerSec: 0 } } },
    });
    const resumed = await resumer.resume(runId);

    expect(resumed.status).toBe('completed');
    expect(resumer.trace(runId).totals.policyDenials).toBe(0); // the cached replay never touched the bucket
  });

  it('KNOWN LIMITATION: the token bucket is in-memory per Runtime instance, so it resets across a process restart', async () => {
    // Rate limiting is deliberately NOT event-sourced (see policy.ts's module
    // doc comment): it paces real live traffic, and replaying history
    // should never re-enforce it. The flip side of that design choice is that
    // bucket state has nowhere durable to live — a fresh process (a new
    // Runtime instance, exactly what a real crash-recovery restart looks
    // like) gets a FRESH bucket, even for a tool whose budget was already
    // exhausted moments earlier. This test documents that trade-off rather
    // than silently relying on it.
    const policy = { rateLimits: { searchCode: { capacity: 1, refillPerSec: 0 } } };

    // "Process A": one Runtime instance drives two runs back-to-back — the
    // bucket IS shared across runs on the SAME instance (a real, useful
    // "global budget for this tool" behaviour), so the second run's
    // searchCode call is denied.
    const processA = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow, policy });
    const run1 = await processA.run('first issue');
    const run2 = await processA.run('second issue');
    expect(run1.status).toBe('completed');
    expect(run2.status).toBe('failed');
    expect(run2.error).toMatch(/rate limit/i);

    // "Process B": simulates a restart (a brand-new Runtime + PolicyEnforcer,
    // same baseDir/policy). Its bucket starts full again, so the SAME kind of
    // call that was just denied on processA now succeeds immediately.
    const processB = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow, policy });
    const run3 = await processB.run('third issue');
    expect(run3.status).toBe('completed'); // bucket reset — no memory of processA's exhausted budget
  });
});

import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { issueWorkflow } from '../src/app/issue-workflow.js';
import { MockModelProvider, type ModelProvider, type ModelResult } from '../src/model/provider.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';

function makeModel(): MockModelProvider {
  return new MockModelProvider({
    'analyze.summary': 'Crash on login due to a null session.',
    'propose.fix': 'Guard the null session in src/auth/login.ts.',
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

/** A model that counts how many times it is actually invoked (to prove idempotency). */
class CountingModel implements ModelProvider {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly inner: MockModelProvider) {}
  async complete(prompt: string): Promise<ModelResult> {
    this.calls++;
    return this.inner.complete(prompt);
  }
}

describe('observability trace', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-trace-'));
  });

  it('builds a timeline with spans and token/cost totals', async () => {
    const rt = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const state = await rt.run('Login page crashes with a null session');

    const trace = rt.trace(state.runId);

    // 1 run + 3 phases + 4 steps + 2 tools + 2 models = 12 spans
    expect(trace.spans.filter((s) => s.kind === 'run')).toHaveLength(1);
    expect(trace.spans.filter((s) => s.kind === 'phase')).toHaveLength(3);
    expect(trace.spans.filter((s) => s.kind === 'step')).toHaveLength(4);
    expect(trace.spans.filter((s) => s.kind === 'tool')).toHaveLength(2);
    expect(trace.spans.filter((s) => s.kind === 'model')).toHaveLength(2);

    expect(trace.totals.modelCalls).toBe(2);
    expect(trace.totals.toolCalls).toBe(2);
    expect(trace.totals.promptTokens).toBeGreaterThan(0);
    expect(trace.totals.completionTokens).toBeGreaterThan(0);
    expect(trace.totals.costUsd).toBeGreaterThan(0);
    expect(trace.totals.wallMs).toBeGreaterThanOrEqual(0);
  });

  it('model calls are idempotent across a crash + resume (recorded as events)', async () => {
    const model = new CountingModel(makeModel());

    // Crash right after the first model step (analyze.2), before it is marked complete.
    const crashing = new Runtime({ baseDir: dir, model, tools: makeTools(), workflow: issueWorkflow, crashAfter: 'analyze.2' });
    await expect(crashing.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');
    expect(model.calls).toBe(1); // analyze.2 issued exactly one model call

    const runId = readdirSync(dir)[0]!;
    const resumed = new Runtime({ baseDir: dir, model, tools: makeTools(), workflow: issueWorkflow });
    const state = await resumed.resume(runId);

    expect(state.status).toBe('completed');
    // analyze.2 re-runs on resume but its model call is REPLAYED from the log (not re-issued);
    // only propose.1 issues a genuinely new call → total 2, not 3.
    expect(model.calls).toBe(2);
  });

  it('cost is computed from injected pricing (configurable, not hardcoded)', async () => {
    // $1 per token makes the expected cost equal the total token count.
    const pricing = { promptUsdPerToken: 1, completionUsdPerToken: 1 };
    const rt = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow, pricing });
    const state = await rt.run('Login page crashes with a null session');
    const trace = rt.trace(state.runId);
    expect(trace.totals.costUsd).toBe(trace.totals.promptTokens + trace.totals.completionTokens);
  });

  it('reports a durable-replay hit rate: 0 on a clean run, >0 after resume', async () => {
    // Clean run — nothing is replayed.
    const cleanDir = mkdtempSync(join(tmpdir(), 'agent-trace-clean-'));
    const clean = new Runtime({ baseDir: cleanDir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const cleanState = await clean.run('Login page crashes with a null session');
    expect(clean.trace(cleanState.runId).totals.replayedCalls).toBe(0);

    // Crash after analyze.2 (a model step), then resume — that model call is replayed once.
    const crashing = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow, crashAfter: 'analyze.2' });
    await expect(crashing.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');
    const runId = readdirSync(dir)[0]!;
    const resumed = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    await resumed.resume(runId);

    const totals = resumed.trace(runId).totals;
    expect(totals.replayedCalls).toBe(1);
    expect(totals.replayHitRate).toBeGreaterThan(0);
  });
});

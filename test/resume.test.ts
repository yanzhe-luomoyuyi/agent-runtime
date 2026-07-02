import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { MockModelProvider } from '../src/model/provider.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';
import { issueWorkflow } from '../src/workflow.js';

function makeModel(): MockModelProvider {
  return new MockModelProvider({
    'analyze.summary': 'Crash on login due to a null session. Keywords: login, auth, session, null.',
    'propose.fix': 'Guard the null session in src/auth/login.ts before reading user.token.',
  });
}

/** Tools that count how many times they actually execute — used to prove idempotency. */
function makeCountingTools(): { tools: ToolRegistry; calls: Record<string, number> } {
  const calls = { getIssue: 0, searchCode: 0 };
  const getIssue: ToolDef<{ issue: string }> = {
    name: 'getIssue',
    description: '',
    inputSchema: {},
    run: (args) => {
      calls.getIssue++;
      return { title: args.issue.slice(0, 40), body: args.issue, labels: ['bug'] };
    },
  };
  const searchCode: ToolDef = {
    name: 'searchCode',
    description: '',
    inputSchema: {},
    run: () => {
      calls.searchCode++;
      return { files: ['src/auth/login.ts', 'src/auth/session.ts'] };
    },
  };
  return { tools: new ToolRegistry().register(getIssue).register(searchCode), calls };
}

describe('durable agent runtime', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-runtime-'));
  });

  it('completes a clean run end to end', async () => {
    const { tools, calls } = makeCountingTools();
    const runtime = new Runtime({ baseDir: dir, model: makeModel(), tools, workflow: issueWorkflow });

    const state = await runtime.run('Login page crashes with a null session');

    expect(state.status).toBe('completed');
    expect((state.summary as { proposal: string }).proposal).toContain('Guard');
    expect(calls).toEqual({ getIssue: 1, searchCode: 1 });
  });

  it('keeps in-memory state equal to reduce(log) — the event-sourcing invariant', async () => {
    const { tools } = makeCountingTools();
    const runtime = new Runtime({ baseDir: dir, model: makeModel(), tools, workflow: issueWorkflow });

    const state = await runtime.run('Login page crashes with a null session');

    // The state the incremental driver returns must equal a full replay of the log.
    expect(state).toEqual(runtime.status(state.runId));
  });

  it('resumes after a mid-run crash without re-executing completed tool calls', async () => {
    const { tools, calls } = makeCountingTools();

    // First attempt crashes right after locate.1 — searchCode has already run.
    const crashing = new Runtime({ baseDir: dir, model: makeModel(), tools, workflow: issueWorkflow, crashAfter: 'locate.1' });
    await expect(crashing.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');
    expect(calls).toEqual({ getIssue: 1, searchCode: 1 });

    const runId = readdirSync(dir)
      .find((file) => file.endsWith('.jsonl'))!
      .replace('.jsonl', '');

    // Resume with a fresh runtime instance (a new process would behave the same).
    const resumed = new Runtime({ baseDir: dir, model: makeModel(), tools, workflow: issueWorkflow });
    const state = await resumed.resume(runId);

    expect(state.status).toBe('completed');
    // Idempotency guarantee: neither tool runs again — both results are replayed
    // from the event log, even though locate.1 itself was re-entered.
    expect(calls).toEqual({ getIssue: 1, searchCode: 1 });
    expect((state.summary as { proposal: string }).proposal).toContain('Guard');
  });

  it('is deterministic: a resumed run yields the same final state as a clean run', async () => {
    const clean = new Runtime({ baseDir: mkdtempSync(join(tmpdir(), 'agent-clean-')), model: makeModel(), tools: makeCountingTools().tools, workflow: issueWorkflow });
    const cleanState = await clean.run('Login page crashes with a null session');

    const crashDir = mkdtempSync(join(tmpdir(), 'agent-crash-'));
    const crashing = new Runtime({ baseDir: crashDir, model: makeModel(), tools: makeCountingTools().tools, workflow: issueWorkflow, crashAfter: 'analyze.2' });
    await expect(crashing.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');
    const runId = readdirSync(crashDir).find((file) => file.endsWith('.jsonl'))!.replace('.jsonl', '');
    const resumed = new Runtime({ baseDir: crashDir, model: makeModel(), tools: makeCountingTools().tools, workflow: issueWorkflow });
    const resumedState = await resumed.resume(runId);

    expect(resumedState.status).toBe(cleanState.status);
    expect(resumedState.phases).toEqual(cleanState.phases);
    expect(resumedState.stepOutputs).toEqual(cleanState.stepOutputs);
    expect(resumedState.summary).toEqual(cleanState.summary);
  });
});

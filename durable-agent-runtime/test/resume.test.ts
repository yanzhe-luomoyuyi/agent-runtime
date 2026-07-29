import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { issueWorkflow } from '../src/app/issue-workflow.js';
import { Runtime } from '../src/runtime.js';
import { LOGIN_ISSUE, makeCountingTools, makeModel } from './helpers/demo.js';

describe('durable agent runtime', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-runtime-'));
  });

  it('completes a clean run end to end', async () => {
    const { tools, calls } = makeCountingTools();
    const runtime = new Runtime({ baseDir: dir, model: makeModel(), tools, workflow: issueWorkflow });

    const state = await runtime.run(LOGIN_ISSUE);

    expect(state.status).toBe('completed');
    expect((state.summary as { proposal: string }).proposal).toContain('Guard');
    expect(calls).toEqual({ getIssue: 1, searchCode: 1 });
  });

  it('keeps in-memory state equal to reduce(log) — the event-sourcing invariant', async () => {
    const { tools } = makeCountingTools();
    const runtime = new Runtime({ baseDir: dir, model: makeModel(), tools, workflow: issueWorkflow });

    const state = await runtime.run(LOGIN_ISSUE);

    // The state the incremental driver returns must equal a full replay of the log.
    expect(state).toEqual(runtime.status(state.runId));
  });

  it('resumes after a mid-run crash without re-executing completed tool calls', async () => {
    const { tools, calls } = makeCountingTools();

    // First attempt crashes right after locate.1 — searchCode has already run.
    const crashing = new Runtime({ baseDir: dir, model: makeModel(), tools, workflow: issueWorkflow, crashAfter: 'locate.1' });
    await expect(crashing.run(LOGIN_ISSUE)).rejects.toThrow('__CRASH__');
    expect(calls).toEqual({ getIssue: 1, searchCode: 1 });

    const runId = readdirSync(dir)[0]!;

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
    const cleanState = await clean.run(LOGIN_ISSUE);

    const crashDir = mkdtempSync(join(tmpdir(), 'agent-crash-'));
    const crashing = new Runtime({ baseDir: crashDir, model: makeModel(), tools: makeCountingTools().tools, workflow: issueWorkflow, crashAfter: 'analyze.2' });
    await expect(crashing.run(LOGIN_ISSUE)).rejects.toThrow('__CRASH__');
    const runId = readdirSync(crashDir)[0]!;
    const resumed = new Runtime({ baseDir: crashDir, model: makeModel(), tools: makeCountingTools().tools, workflow: issueWorkflow });
    const resumedState = await resumed.resume(runId);

    expect(resumedState.status).toBe(cleanState.status);
    expect(resumedState.phases).toEqual(cleanState.phases);
    expect(resumedState.stepOutputs).toEqual(cleanState.stepOutputs);
    expect(resumedState.summary).toEqual(cleanState.summary);
  });
});

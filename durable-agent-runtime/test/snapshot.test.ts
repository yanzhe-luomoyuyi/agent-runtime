/**
 * Snapshot tests: verify that checkpoints are written and used correctly,
 * and that the event-sourcing invariant (state == reduce(log)) always holds.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { EventLog, runDir } from '../src/eventlog.js';
import { MockModelProvider } from '../src/model/provider.js';
import { reduce } from '../src/reducer.js';
import { Runtime } from '../src/runtime.js';
import { readSnapshot } from '../src/snapshot.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';
import { issueWorkflow } from '../src/app/issue-workflow.js';

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
    run: (args) => ({ title: args.issue.slice(0, 40), body: args.issue, labels: ['bug'] }),
  };
  const searchCode: ToolDef = {
    name: 'searchCode',
    description: '',
    inputSchema: {},
    run: () => ({ files: ['src/auth/login.ts'] }),
  };
  return new ToolRegistry().register(getIssue).register(searchCode);
}

describe('snapshot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-snapshot-'));
  });

  it('writes a terminal snapshot at run completion (forced, regardless of interval)', async () => {
    const runtime = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const state = await runtime.run('Login page crashes with a null session');
    expect(state.status).toBe('completed');

    const runId = readdirSync(dir)[0]!;
    const log = new EventLog(runDir(dir, runId));

    // The terminal snapshot (RunCompleted) is always forced — it must exist.
    const snap = readSnapshot(log.dir, log.version);
    expect(snap).toBeDefined();
    expect(snap!.version).toBe(log.version); // final snapshot covers the whole log
    expect(snap!.state.status).toBe('completed');

    // The snapshot state must equal a full log replay (invariant).
    expect(snap!.state).toEqual(reduce(log.all(), runId));
  });

  it('writes intermediate snapshots when interval is met', async () => {
    // snapshotInterval=1 forces a checkpoint after every phase.
    const runtime = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      snapshotInterval: 1,
      crashAfter: 'locate.1', // second phase, first step — first phase already snapshotted
    });
    await expect(runtime.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');

    const runId = readdirSync(dir)[0]!;
    const log = new EventLog(runDir(dir, runId));

    // Intermediate snapshot from the first phase must exist.
    const snap = readSnapshot(log.dir, log.version);
    expect(snap).toBeDefined();
    expect(snap!.version).toBeLessThanOrEqual(log.version); // snapshot can now catch up
    expect(snap!.state.phases['analyze']?.status).toBe('COMPLETED');
  });

  it('uses snapshot on resume so the second resume is a no-op replay', async () => {
    // Complete a clean run (snapshot is written at the end).
    const runtime1 = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const state1 = await runtime1.run('Login page crashes with a null session');
    expect(state1.status).toBe('completed');

    const runId = readdirSync(dir)[0]!;

    // Resume a completed run — the snapshot covers the entire log, so drive()
    // should start from the snapshot and immediately see status==='completed'.
    const runtime2 = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const state2 = await runtime2.resume(runId);
    expect(state2.status).toBe('completed');
    expect(state2).toEqual(state1);
  });

  it('snapshot survives a mid-run crash and accelerates the resume', async () => {
    // snapshotInterval=1 so the first phase triggers a checkpoint.
    const crashing = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      snapshotInterval: 1,
      crashAfter: 'locate.1', // first step of second phase — first phase already snapshotted
    });
    await expect(crashing.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');

    const runId = readdirSync(dir)[0]!;
    const log = new EventLog(runDir(dir, runId));

    // A snapshot should exist (written after the first phase completed).
    const snap = readSnapshot(log.dir, log.version);
    expect(snap).toBeDefined();
    expect(snap!.version).toBeLessThanOrEqual(log.version); // snapshot can now catch up

    // Resuming should succeed and produce the same result as a clean run.
    const resumed = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const state = await resumed.resume(runId);
    expect(state.status).toBe('completed');

    // The final state must equal a full replay of the COMPLETE log (including
    // events added by resume). Create a fresh EventLog to pick up all events.
    const fullLog = new EventLog(runDir(dir, runId));
    expect(state).toEqual(reduce(fullLog.all(), runId));

    // After a successful resume, a final snapshot covering the whole log exists.
    const finalSnap = readSnapshot(fullLog.dir, fullLog.version);
    expect(finalSnap).toBeDefined();
    expect(finalSnap!.version).toBe(fullLog.version);
    expect(finalSnap!.state.status).toBe('completed');
  });

  it('status() uses snapshot for fast state lookup', async () => {
    const runtime = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const state = await runtime.run('Login page crashes with a null session');
    const runId = state.runId;

    // status() should return the same state as the in-memory state.
    const fromStatus = runtime.status(runId);
    expect(fromStatus).toEqual(state);
  });

  it('snapshot is absent for a fresh run (no phases completed yet)', async () => {
    // Crash BEFORE any phase completes — no snapshot should exist.
    const crashing = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      crashAfter: 'analyze.1', // first step, first phase — no PhaseCompleted yet
    });
    await expect(crashing.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');

    const runId = readdirSync(dir)[0]!;
    const log = new EventLog(runDir(dir, runId));
    const snap = readSnapshot(log.dir, log.version);
    expect(snap).toBeUndefined(); // no PhaseCompleted → no snapshot

    // Resume still works (full replay fallback).
    const resumed = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const state = await resumed.resume(runId);
    expect(state.status).toBe('completed');
  });
});

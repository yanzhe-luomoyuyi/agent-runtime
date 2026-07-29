import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { issueWorkflow } from '../src/app/issue-workflow.js';
import { ConflictError, EventLog, runDir } from '../src/eventlog.js';
import { Runtime } from '../src/runtime.js';
import type { AgentEvent } from '../src/types.js';
import { makeModel, makeTools } from './helpers/demo.js';


describe('concurrency & recovery', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-conc-'));
  });

  it('rejects a second writer that claims an already-taken version (optimistic concurrency)', () => {
    const runId = 'run-occ';
    const now = new Date().toISOString();

    // Seed the run with one event so both views open at the same version (1).
    const seed = new EventLog(runDir(dir, runId));
    seed.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'issue-fix', ts: now });

    const a = new EventLog(runDir(dir, runId)); // version 1
    const b = new EventLog(runDir(dir, runId)); // version 1 (stale the moment `a` writes)
    // Must be a CRITICAL event — relaxed events (e.g. PhaseStarted) are buffered
    // in memory and never touch disk synchronously, so they wouldn't exercise
    // the exclusive-create collision path this test is checking.
    const criticalEvent: AgentEvent = { type: 'ToolCallSucceeded', callId: 'c1', tool: 'getIssue', result: {}, ts: now };

    a.append(criticalEvent); // claims version 1
    // b still thinks the next version is 1 — but `a` already took it.
    expect(() => b.append(criticalEvent)).toThrow(ConflictError);
  });

  it('recover() finds an interrupted run and drives it to completion', async () => {
    // Interrupt a run mid-flight.
    const crashing = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow, crashAfter: 'locate.1' });
    await expect(crashing.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');

    // A supervisor discovers and resumes it.
    const supervisor = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const recovered = await supervisor.recover();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.state?.status).toBe('completed');

    // A second pass has nothing left to do.
    expect(await supervisor.recover()).toHaveLength(0);
  });

  it('status() on an unknown run throws and creates nothing (reads are side-effect-free)', () => {
    const runtime = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    expect(() => runtime.status('run-does-not-exist')).toThrow(/not found/i);
    expect(existsSync(join(dir, 'run-does-not-exist'))).toBe(false);
  });

  it('recover() ignores stray empty directories', async () => {
    mkdirSync(join(dir, 'run-empty'), { recursive: true });
    const runtime = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    expect(await runtime.recover()).toHaveLength(0);
  });
});

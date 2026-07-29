import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
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

  it('single-file mode writes one events.json and reloads the full sequence', () => {
    const runId = 'run-single';
    const now = new Date().toISOString();
    const opts = { optimisticConcurrency: false as const };
    const log = new EventLog(runDir(dir, runId), opts);
    expect(log.optimisticConcurrency).toBe(false);

    log.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'issue-fix', ts: now });
    log.append({ type: 'ToolCallRequested', callId: 'c1', tool: 'getIssue', args: {}, ts: now });
    log.append({ type: 'ToolCallSucceeded', callId: 'c1', tool: 'getIssue', result: { ok: true }, ts: now });
    log.append({ type: 'RunCompleted', summary: 'done', ts: now });

    const files = readdirSync(runDir(dir, runId)).filter((f) => f.endsWith('.json'));
    expect(files).toEqual(['events.json']);

    const reloaded = new EventLog(runDir(dir, runId)); // default options — still reads events.json
    expect(reloaded.optimisticConcurrency).toBe(false); // layout locked to existing file
    expect(reloaded.all().map((e) => e.type)).toEqual([
      'RunStarted',
      'ToolCallRequested',
      'ToolCallSucceeded',
      'RunCompleted',
    ]);
  });

  it('single-file mode does not raise ConflictError for concurrent appends', () => {
    const runId = 'run-no-cas';
    const now = new Date().toISOString();
    const opts = { optimisticConcurrency: false as const };

    const seed = new EventLog(runDir(dir, runId), opts);
    seed.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'issue-fix', ts: now });

    const a = new EventLog(runDir(dir, runId), opts);
    const b = new EventLog(runDir(dir, runId), opts);
    const critical: AgentEvent = { type: 'ToolCallSucceeded', callId: 'c1', tool: 'getIssue', result: {}, ts: now };

    expect(() => a.append(critical)).not.toThrow();
    expect(() => b.append(critical)).not.toThrow(); // last writer wins — no CAS
  });

  it('Runtime with eventLog.optimisticConcurrency:false completes and resumes from events.json', async () => {
    const eventLog = { optimisticConcurrency: false };
    const crashing = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      crashAfter: 'locate.1',
      eventLog,
    });
    await expect(crashing.run('Login page crashes with a null session')).rejects.toThrow('__CRASH__');

    const runId = readdirSync(dir)[0]!;
    expect(readdirSync(runDir(dir, runId)).filter((f) => /^\d{12}\.json$/.test(f))).toEqual([]);
    expect(existsSync(join(runDir(dir, runId), 'events.json'))).toBe(true);

    const resumed = new Runtime({
      baseDir: dir,
      model: makeModel(),
      tools: makeTools(),
      workflow: issueWorkflow,
      eventLog,
    });
    const state = await resumed.resume(runId);
    expect(state.status).toBe('completed');
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

/**
 * Tiered durability tests: verify the critical/relaxed split in eventlog.ts
 * (see the module doc comment there), a crash-safety chaos scenario for the
 * buffered relaxed tier, and a replay-cost benchmark that quantifies why
 * snapshots matter for long-running workflows.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { issueWorkflow } from '../src/app/issue-workflow.js';
import { EventLog, eventDurability, runDir } from '../src/eventlog.js';
import { MockModelProvider } from '../src/model/provider.js';
import { reduce } from '../src/reducer.js';
import { Runtime } from '../src/runtime.js';
import { readSnapshot, writeSnapshot } from '../src/snapshot.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';
import type { AgentEvent } from '../src/types.js';
import type { WorkflowDef } from '../src/workflow.js';

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

const now = () => new Date().toISOString();

describe('eventDurability classification', () => {
  it('relaxed: no state transition at all (reducer.ts default branch)', () => {
    expect(eventDurability('ToolCallRequested')).toBe('relaxed');
    expect(eventDurability('ToolCallFailed')).toBe('relaxed');
    expect(eventDurability('PolicyDenied')).toBe('relaxed');
  });

  it('relaxed: DOES cause a state transition, but a cheap drift-free recompute from the static WorkflowDef', () => {
    // currentPhase/currentStep are set from phase.name / stepNumber(step.id) —
    // pure functions of the (unchanging) workflow definition, never of event
    // history. Losing one costs a diagnostic-precision gap on status() during
    // the unflushed window, never a wrong replay: resume re-enters the same
    // step and re-emits an IDENTICAL event.
    expect(eventDurability('PhaseStarted')).toBe('relaxed');
    expect(eventDurability('StepStarted')).toBe('relaxed');
  });

  it('critical: losing it would make resume WRONG, not just less precise', () => {
    // Idempotency-cache sources — re-deriving these means re-paying for (or
    // re-running) an external side effect that may not be free/idempotent.
    expect(eventDurability('ToolCallSucceeded')).toBe('critical');
    expect(eventDurability('ModelCalled')).toBe('critical');
    // Completion/terminal boundaries other logic (or an external poller)
    // depends on to avoid redoing finished work or to know the run is done.
    expect(eventDurability('StepCompleted')).toBe('critical');
    expect(eventDurability('PhaseCompleted')).toBe('critical');
    expect(eventDurability('PhaseSkipped')).toBe('critical');
    expect(eventDurability('RunCompleted')).toBe('critical');
    expect(eventDurability('RunFailed')).toBe('critical');
    // Defines the run's identity.
    expect(eventDurability('RunStarted')).toBe('critical');
  });
});

describe('EventLog tiered buffering', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-durability-'));
  });

  it('buffers relaxed events in memory instead of writing a file per event', () => {
    const runId = 'run-buffer';
    const log = new EventLog(runDir(dir, runId), { maxBufferedRelaxed: 10 });
    log.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'issue-fix', ts: now() });

    log.append({ type: 'ToolCallRequested', callId: 'c1', tool: 'searchCode', args: {}, ts: now() });
    log.append({ type: 'ToolCallFailed', callId: 'c1', tool: 'searchCode', error: 'boom', ts: now() });

    // In-process view already reflects both relaxed events…
    expect(log.version).toBe(3);
    expect(log.pendingCount).toBe(2);
    // …but only the critical RunStarted has actually hit disk so far.
    const filesOnDisk = readdirSync(runDir(dir, runId)).filter((f) => f.endsWith('.json'));
    expect(filesOnDisk).toHaveLength(1);
  });

  it('combines buffered relaxed events with the next critical event into ONE write (no sequence gaps)', () => {
    const runId = 'run-flush-before-critical';
    const log = new EventLog(runDir(dir, runId));
    log.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'issue-fix', ts: now() });
    log.append({ type: 'ToolCallRequested', callId: 'c1', tool: 'searchCode', args: {}, ts: now() });
    expect(log.pendingCount).toBe(1);

    // The critical event is written TOGETHER with the buffered relaxed event, as one file.
    log.append({ type: 'ToolCallSucceeded', callId: 'c1', tool: 'searchCode', result: {}, ts: now() });
    expect(log.pendingCount).toBe(0);

    const filesOnDisk = readdirSync(runDir(dir, runId)).filter((f) => f.endsWith('.json'));
    // RunStarted alone (1 file) + [ToolCallRequested, ToolCallSucceeded] combined (1 file) = 2 files,
    // not 3 — this is the actual write-count reduction (see the module doc comment on WHY
    // separately flushing before the critical write, an earlier design, achieved nothing here).
    expect(filesOnDisk).toHaveLength(2);

    // A fresh EventLog instance reloads the exact same 3 LOGICAL events from disk
    // (one of the 2 files expands into 2 events).
    const reloaded = new EventLog(runDir(dir, runId));
    expect(reloaded.all()).toEqual(log.all());
    expect(reloaded.length).toBe(3);
  });

  it('flushes automatically once maxBufferedRelaxed is reached, as a single combined write', () => {
    const runId = 'run-auto-flush';
    const log = new EventLog(runDir(dir, runId), { maxBufferedRelaxed: 3 });
    log.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'issue-fix', ts: now() });

    for (let i = 0; i < 2; i++) {
      log.append({ type: 'ToolCallRequested', callId: `c${i}`, tool: 'searchCode', args: {}, ts: now() });
    }
    expect(log.pendingCount).toBe(2);
    expect(readdirSync(runDir(dir, runId)).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    // The 3rd relaxed event crosses the threshold and triggers an automatic flush —
    // all 3 buffered relaxed events land in ONE additional file (no critical event involved here).
    log.append({ type: 'ToolCallFailed', callId: 'c2', tool: 'searchCode', error: 'x', ts: now() });
    expect(log.pendingCount).toBe(0);
    expect(readdirSync(runDir(dir, runId)).filter((f) => f.endsWith('.json'))).toHaveLength(2);
    expect(new EventLog(runDir(dir, runId)).length).toBe(4); // RunStarted + 3 relaxed events, reloaded from 2 files
  });

  it('CHAOS: a crash before flush loses only buffered relaxed events, never a critical one', () => {
    const runId = 'run-chaos';
    const log = new EventLog(runDir(dir, runId), { maxBufferedRelaxed: 100 }); // never auto-flush
    log.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'issue-fix', ts: now() });
    log.append({ type: 'ToolCallSucceeded', callId: 'c1', tool: 'getIssue', result: { ok: true }, ts: now() });
    // Simulate a burst of observability-only events that never get flushed —
    // the "crash" is simply abandoning this EventLog instance without calling flush().
    log.append({ type: 'ToolCallRequested', callId: 'c2', tool: 'searchCode', args: {}, ts: now() });
    log.append({ type: 'PolicyDenied', scope: 'tool', target: 'searchCode', code: 'tool_not_allowed', reason: 'nope', ts: now() });
    expect(log.pendingCount).toBe(2);

    // Reload from disk as a fresh process would after the crash.
    const recovered = new EventLog(runDir(dir, runId));
    expect(recovered.length).toBe(2); // RunStarted + ToolCallSucceeded only — the 2 buffered events are gone
    expect(recovered.all().map((e) => e.type)).toEqual(['RunStarted', 'ToolCallSucceeded']);

    // Critically: the recovered log is still a fully valid, replayable prefix —
    // reduce() never depended on the lost events (they fall through `default`).
    const state = reduce(recovered.all(), runId);
    expect(state.toolResults['c1']).toEqual({ ok: true });
    expect(state.status).toBe('running');
  });

  it('CHAOS: a snapshot taken while relaxed events were still buffered self-invalidates after a crash', () => {
    const runId = 'run-chaos-snapshot';
    const log = new EventLog(runDir(dir, runId), { maxBufferedRelaxed: 100 });
    log.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'issue-fix', ts: now() });
    log.append({ type: 'ToolCallSucceeded', callId: 'c1', tool: 'getIssue', result: { ok: true }, ts: now() });
    // Buffer 2 relaxed events and (as if a background checkpoint fired) snapshot at the
    // in-memory version, which COUNTS the still-unflushed events.
    log.append({ type: 'ToolCallRequested', callId: 'c2', tool: 'searchCode', args: {}, ts: now() });
    log.append({ type: 'ToolCallFailed', callId: 'c2', tool: 'searchCode', error: 'boom', ts: now() });
    const state = reduce(log.all(), runId);
    writeSnapshot(log.dir, { version: log.version, state, spentUsd: 0 }); // version=4, but only 2 events are on disk

    // Crash: reload without ever flushing.
    const recovered = new EventLog(runDir(dir, runId));
    expect(recovered.length).toBe(2);

    // The stale snapshot (version 4) exceeds the reloaded log (version 2) and must be discarded —
    // this is the existing snapshot.ts guard, no new code needed to make tiered durability safe.
    const snap = readSnapshot(recovered.dir, recovered.version);
    expect(snap).toBeUndefined();
  });
});

describe('rate-limited runtime + tiered durability integration', () => {
  it('a normal run through the runtime still replays to an identical state with tiering on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-durability-e2e-'));
    const runtime = new Runtime({ baseDir: dir, model: makeModel(), tools: makeTools(), workflow: issueWorkflow });
    const state = await runtime.run('Login page crashes with a null session');
    expect(state.status).toBe('completed');

    const runId = readdirSync(dir)[0]!;
    const log = new EventLog(runDir(dir, runId));
    expect(log.pendingCount).toBe(0); // RunCompleted (critical) flushes everything before the run returns
    expect(state).toEqual(reduce(log.all(), runId));
  });
});

describe('benchmark: replay cost, full log vs. snapshot-assisted resume', () => {
  it('quantifies why snapshots matter: snapshot-assisted resume touches O(tail) events, not O(log)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-benchmark-'));
    const runId = 'run-bench';
    const log = new EventLog(runDir(dir, runId));
    const EVENT_COUNT = 2000;

    log.append({ type: 'RunStarted', runId, input: { issue: 'bench' }, workflow: 'bench', ts: now() });
    for (let i = 0; i < EVENT_COUNT; i++) {
      log.append({ type: 'ToolCallSucceeded', callId: `c${i}`, tool: 'noop', result: i, ts: now() });
    }

    // Snapshot at the midpoint, as a long-running workflow would checkpoint periodically.
    const midpoint = log.version - 200;
    const midState = reduce(log.all().slice(0, midpoint), runId);
    writeSnapshot(log.dir, { version: midpoint, state: midState, spentUsd: 0 });

    const allEvents = log.all();

    const fullReplayStart = performance.now();
    const fullState = reduce(allEvents, runId);
    const fullReplayMs = performance.now() - fullReplayStart;

    const snap = readSnapshot(log.dir, log.version)!;
    const tail = allEvents.slice(snap.version);
    const snapshotReplayStart = performance.now();
    let snapshotState = snap.state;
    for (const e of tail) snapshotState = reduce([e], runId, snapshotState);
    const snapshotReplayMs = performance.now() - snapshotReplayStart;

    // Correctness: both paths must agree exactly (the event-sourcing invariant).
    expect(snapshotState).toEqual(fullState);
    // Snapshot-assisted resume replays a strict tail (200 events), not the full log (2001).
    expect(tail.length).toBe(200);
    expect(tail.length).toBeLessThan(allEvents.length);

    // eslint-disable-next-line no-console
    console.log(
      `[benchmark] replay ${EVENT_COUNT} events: full=${fullReplayMs.toFixed(2)}ms, ` +
        `snapshot-assisted (${tail.length}-event tail)=${snapshotReplayMs.toFixed(2)}ms`,
    );
  });

  it('BEST CASE (synthetic burst, no critical events interleaved): batching cuts durable-flush points from O(N) to O(N/batchSize)', () => {
    // NOTE: this is deliberately the easiest case for batching — a pure run of
    // relaxed events with nothing critical interleaved. It demonstrates the
    // count-threshold mechanism works, but see the benchmark below
    // ("REALISTIC workflow") for what batching actually buys in this
    // codebase's real call pattern, which is far less favourable than this.
    //
    // Wall-clock deltas for a handful of writes to a local SSD/tmpfs are too
    // noisy to be a convincing benchmark (fs writes there are already
    // sub-millisecond) — the honest, machine-independent metric is HOW MANY
    // TIMES the log actually touches disk, since each one is a syscall (and,
    // on a real production filesystem or network-backed volume, a potential
    // fsync/replication round-trip). That count is what batching structurally
    // reduces, regardless of how fast any particular disk happens to be.
    const dir = mkdtempSync(join(tmpdir(), 'agent-benchmark-write-'));
    const runId = 'run-bench-write';
    const N = 500;
    const fixedTs = now(); // deterministic — this test compares content, not wall-clock timing
    const relaxedEvent = (i: number): AgentEvent => ({ type: 'ToolCallRequested', callId: `c${i}`, tool: 'noop', args: {}, ts: fixedTs });

    const unbatched = new EventLog(runDir(dir, `${runId}-sync`), { maxBufferedRelaxed: 1 });
    unbatched.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'bench', ts: fixedTs });
    let unbatchedFlushPoints = 0;
    for (let i = 0; i < N; i++) {
      unbatched.append(relaxedEvent(i));
      if (unbatched.pendingCount === 0) unbatchedFlushPoints++; // every append is its own durable write
    }

    const batched = new EventLog(runDir(dir, `${runId}-batched`), { maxBufferedRelaxed: 50 });
    batched.append({ type: 'RunStarted', runId, input: { issue: 'x' }, workflow: 'bench', ts: fixedTs });
    let batchedFlushPoints = 0;
    for (let i = 0; i < N; i++) {
      batched.append(relaxedEvent(i));
      if (batched.pendingCount === 0) batchedFlushPoints++; // only every 50th append triggers a flush
    }
    batched.flush(); // drain the final partial batch, as a graceful shutdown would

    expect(unbatchedFlushPoints).toBe(N); // one durable write per event with batching effectively off (buffer=1)
    expect(batchedFlushPoints).toBe(Math.floor(N / 50)); // 10 batches of 50, not 500 individual writes

    // Both logs converge to byte-identical durable content once fully flushed —
    // batching only changes how events are PACKED into files, never what ends up on disk.
    expect(new EventLog(runDir(dir, `${runId}-batched`)).all()).toEqual(new EventLog(runDir(dir, `${runId}-sync`)).all());

    // eslint-disable-next-line no-console
    console.log(
      `[benchmark:best-case] ${N} relaxed events, no critical interleaving: unbatched=${unbatchedFlushPoints} durable writes, ` +
        `batched(buffer=50)=${batchedFlushPoints} durable writes (${((1 - batchedFlushPoints / unbatchedFlushPoints) * 100).toFixed(0)}% fewer)`,
    );
  });

  it('REALISTIC workflow (1 tool call per step, matching the actual runtime.ts call pattern): quantifies the real write-count reduction', async () => {
    // This directly answers the concern that prompted the redesign: in this
    // codebase's ACTUAL call pattern, ToolCallRequested (relaxed) is almost
    // always immediately followed by ToolCallSucceeded (critical) — the
    // buffer rarely if ever accumulates past 1 event before something forces
    // it out, so the count threshold above is nearly irrelevant in practice.
    // Driving a real multi-step workflow through the real Runtime (not a
    // synthetic burst) is what actually validates the fix: combining the
    // buffered relaxed event WITH the triggering critical event into one write.
    const STEP_COUNT = 50;
    const model = new MockModelProvider({});
    const tools = new ToolRegistry().register({
      name: 'noop',
      description: '',
      inputSchema: {},
      run: () => ({ ok: true }),
    });
    const syntheticWorkflow: WorkflowDef = {
      name: 'synthetic-bench',
      phases: [
        {
          name: 'work',
          skippable: false,
          steps: Array.from({ length: STEP_COUNT }, (_, i) => ({
            id: `work.${i + 1}`,
            name: `step ${i + 1}`,
            run: (ctx) => ctx.callTool('noop', {}),
          })),
        },
      ],
    };

    const dir = mkdtempSync(join(tmpdir(), 'agent-benchmark-realistic-'));
    const runtime = new Runtime({ baseDir: dir, model, tools, workflow: syntheticWorkflow });
    const state = await runtime.run('bench');
    expect(state.status).toBe('completed');

    const runId = readdirSync(dir)[0]!;
    const runPath = runDir(dir, runId);
    const log = new EventLog(runPath);
    const totalEvents = log.length;
    const filesOnDisk = readdirSync(runPath).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp.json')).length;

    // The honest baseline this compares against: the ORIGINAL, pre-tiered-durability
    // design (every event = its own file, zero batching) would have written
    // exactly `totalEvents` files — one per logical event, no exceptions.
    const reduction = 1 - filesOnDisk / totalEvents;

    // eslint-disable-next-line no-console
    console.log(
      `[benchmark:realistic] ${STEP_COUNT}-step workflow (1 tool call/step): ${totalEvents} logical events -> ` +
        `${filesOnDisk} files on disk (${(reduction * 100).toFixed(0)}% fewer writes than one-file-per-event)`,
    );

    // Real, modest, honestly-measured reduction — NOT the 98% the synthetic
    // burst benchmark above shows, because critical events interleave tightly
    // with relaxed ones here. Still a genuine, non-zero win: every step's
    // ToolCallRequested+ToolCallSucceeded pair collapses from 2 writes to 1.
    expect(filesOnDisk).toBeLessThan(totalEvents);
    expect(reduction).toBeGreaterThan(0.15); // ballpark ~N/(4N+4) for this workflow shape, see PR discussion

    // Correctness is never traded away for the write-count win.
    expect(state).toEqual(reduce(log.all(), runId));
  });
});

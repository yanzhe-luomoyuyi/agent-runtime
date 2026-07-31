import { describe, expect, it } from 'vitest';

import {
  beginActiveRun,
  bindRunId,
  controlAbort,
  controlContinue,
  controlPause,
  controlSteer,
  endActiveRun,
  getActiveByRunId,
  hasDrivingRun,
  resolveApproval,
  sseInterrupter,
  tryBeginActiveRun,
} from '../src/workbench-runs.js';

describe('workbench-runs', () => {
  it('tracks per-run busy and rebinds pending key to runId', () => {
    expect(hasDrivingRun()).toBe(false);
    const { key, run } = beginActiveRun({ workspace: '/tmp/ws' });
    expect(hasDrivingRun()).toBe(true);
    expect(run.runId).toBeNull();

    bindRunId(key, 'run-abc');
    expect(getActiveByRunId('run-abc')).toBe(run);
    expect(run.phase).toBe('running');

    endActiveRun('run-abc');
    expect(hasDrivingRun()).toBe(false);
  });

  it('tryBeginActiveRun refuses a second concurrent driver', () => {
    const first = tryBeginActiveRun({ workspace: '/tmp/a' });
    expect(first).not.toBeNull();
    expect(tryBeginActiveRun({ workspace: '/tmp/b' })).toBeNull();
    endActiveRun(first!.key);
    const second = tryBeginActiveRun({ workspace: '/tmp/c' });
    expect(second).not.toBeNull();
    endActiveRun(second!.key);
  });

  it('pause blocks interrupter until continue', async () => {
    const { key, run } = beginActiveRun({ workspace: '/tmp/ws', knownRunId: 'run-pause' });
    const events: string[] = [];
    const interrupter = sseInterrupter(run, (event) => events.push(event));

    controlPause('run-pause');
    const pending = interrupter.atTurnBoundary({
      turnsCompleted: 1,
      nextTurn: 2,
      goal: 'g',
      messages: [],
    });

    await Promise.resolve();
    expect(events).toContain('paused');
    expect(run.interrupt.isWaiting()).toBe(true);

    controlContinue('run-pause');
    await expect(pending).resolves.toEqual({ action: 'continue' });
    endActiveRun(key);
  });

  it('steer and abort settle a waiting pause', async () => {
    const { key, run } = beginActiveRun({ workspace: '/tmp/ws', knownRunId: 'run-steer' });
    const interrupter = sseInterrupter(run, () => undefined);
    controlPause('run-steer');
    const pending = interrupter.atTurnBoundary({
      turnsCompleted: 0,
      nextTurn: 1,
      goal: 'g',
      messages: [],
    });
    await Promise.resolve();
    controlSteer('run-steer', { inject: 'focus on tests', reason: 'ui' });
    await expect(pending).resolves.toMatchObject({ action: 'steer', inject: 'focus on tests' });

    controlPause('run-steer');
    const pendingAbort = interrupter.atTurnBoundary({
      turnsCompleted: 1,
      nextTurn: 2,
      goal: 'g',
      messages: [],
    });
    await Promise.resolve();
    controlAbort('run-steer', 'stop');
    await expect(pendingAbort).resolves.toMatchObject({ action: 'abort', reason: 'stop' });
    endActiveRun(key);
  });

  it('resolves pending UI approvals by callId', async () => {
    const { key, run } = beginActiveRun({ workspace: '/tmp/ws', knownRunId: 'run-appr' });
    const decisionPromise = new Promise((resolve) => {
      run.pendingApprovals.set('c1', {
        request: { tool: 'write_file', args: { path: 'a.ts' }, callId: 'c1' },
        resolve,
      });
      run.phase = 'awaiting_approval';
    });

    const ok = resolveApproval('run-appr', 'c1', { approved: true, reason: 'ui yes' });
    expect(ok).toEqual({ ok: true });
    await expect(decisionPromise).resolves.toMatchObject({ approved: true });
    endActiveRun(key);
  });
});

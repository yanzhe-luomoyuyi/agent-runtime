/**
 * In-process registry for Workbench runs: per-run interrupt / approval handles
 * and SSE fan-out. Replaces the global busy lock.
 */

import type { ApprovalDecision, ApprovalRequest } from '@agent/contracts';
import {
  createInterruptHandle,
  type InterruptContext,
  type InterruptHandle,
  type RunInterrupter,
} from '@agent/harness';

import type { UiApprovalPending } from './ui-approver.js';

export type WorkbenchRunPhase =
  | 'starting'
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'crashed'
  | 'completed'
  | 'failed'
  | 'aborted';

export type SseSend = (event: string, data: unknown) => void;

export interface ActiveWorkbenchRun {
  /** Assigned on RunStarted (or known for durable resume). */
  runId: string | null;
  workspace: string;
  sessionId?: string;
  phase: WorkbenchRunPhase;
  interrupt: InterruptHandle;
  pendingApprovals: Map<string, UiApprovalPending>;
  startedAt: number;
}

const active = new Map<string, ActiveWorkbenchRun>();
/** Key used before RunStarted assigns a real runId. */
let nextTempId = 1;

export function listActiveRuns(): Array<{
  key: string;
  runId: string | null;
  workspace: string;
  sessionId?: string;
  phase: WorkbenchRunPhase;
}> {
  return [...active.entries()].map(([key, r]) => ({
    key,
    runId: r.runId,
    workspace: r.workspace,
    sessionId: r.sessionId,
    phase: r.phase,
  }));
}

export function hasDrivingRun(): boolean {
  return [...active.values()].some(
    (r) =>
      r.phase === 'starting' ||
      r.phase === 'running' ||
      r.phase === 'paused' ||
      r.phase === 'awaiting_approval',
  );
}

/** Atomically reserve a driving slot, or return null if one is already active. */
export function tryBeginActiveRun(opts: {
  workspace: string;
  sessionId?: string;
  knownRunId?: string;
}): { key: string; run: ActiveWorkbenchRun } | null {
  if (hasDrivingRun()) return null;
  return beginActiveRun(opts);
}

export function getActiveByRunId(runId: string): ActiveWorkbenchRun | undefined {
  for (const r of active.values()) {
    if (r.runId === runId) return r;
  }
  return undefined;
}

export function beginActiveRun(opts: {
  workspace: string;
  sessionId?: string;
  knownRunId?: string;
}): { key: string; run: ActiveWorkbenchRun } {
  const interrupt = createInterruptHandle();
  const key = opts.knownRunId ?? `pending-${nextTempId++}`;
  const run: ActiveWorkbenchRun = {
    runId: opts.knownRunId ?? null,
    workspace: opts.workspace,
    sessionId: opts.sessionId,
    phase: 'starting',
    interrupt,
    pendingApprovals: new Map(),
    startedAt: Date.now(),
  };
  active.set(key, run);
  return { key, run };
}

/** Re-key the registry entry once RunStarted provides the durable runId. */
export function bindRunId(key: string, runId: string): ActiveWorkbenchRun | undefined {
  const run = active.get(key);
  if (!run) {
    console.warn(`[workbench] bindRunId: active run not found for key=${key}`);
    return undefined;
  }
  run.runId = runId;
  if (key !== runId) {
    active.delete(key);
    active.set(runId, run);
  }
  run.phase = 'running';
  return run;
}

export function setPhase(runIdOrKey: string, phase: WorkbenchRunPhase): void {
  const run = active.get(runIdOrKey) ?? getActiveByRunId(runIdOrKey);
  if (run) run.phase = phase;
}

export function endActiveRun(runIdOrKey: string): void {
  if (active.has(runIdOrKey)) {
    active.delete(runIdOrKey);
    return;
  }
  for (const [key, r] of active) {
    if (r.runId === runIdOrKey) {
      active.delete(key);
      return;
    }
  }
}

/**
 * Wrap the interrupt handle so a pause at a turn boundary emits `paused`
 * (pause itself is in-process; no HumanIntervention event).
 */
export function sseInterrupter(run: ActiveWorkbenchRun, send: SseSend): RunInterrupter {
  const base = run.interrupt.interrupter;
  return {
    atTurnBoundary: async (ctx: InterruptContext) => {
      const decisionPromise = base.atTurnBoundary(ctx);
      await Promise.resolve();
      if (run.interrupt.isWaiting()) {
        run.phase = 'paused';
        send('paused', {
          runId: run.runId,
          turn: ctx.nextTurn,
          turnsCompleted: ctx.turnsCompleted,
          goal: ctx.goal,
        });
      }
      const decision = await decisionPromise;
      if (run.phase === 'paused') run.phase = 'running';
      return decision;
    },
  };
}

export function registerApproval(run: ActiveWorkbenchRun, pending: UiApprovalPending): void {
  run.pendingApprovals.set(pending.request.callId, pending);
  run.phase = 'awaiting_approval';
}

export function clearApproval(run: ActiveWorkbenchRun, callId: string): void {
  run.pendingApprovals.delete(callId);
  if (run.pendingApprovals.size === 0 && run.phase === 'awaiting_approval') {
    run.phase = 'running';
  }
}

export function resolveApproval(
  runId: string,
  callId: string,
  decision: ApprovalDecision,
): { ok: true } | { ok: false; error: string } {
  const run = getActiveByRunId(runId);
  if (!run) return { ok: false, error: `No active run: ${runId}` };
  const pending = run.pendingApprovals.get(callId);
  if (!pending) return { ok: false, error: `No pending approval for callId=${callId}` };
  pending.resolve({ ...decision, decidedAt: decision.decidedAt ?? Date.now() });
  return { ok: true };
}

export function controlPause(runId: string): { ok: true } | { ok: false; error: string } {
  const run = getActiveByRunId(runId);
  if (!run) return { ok: false, error: `No active run: ${runId}` };
  run.interrupt.pause();
  return { ok: true };
}

export function controlContinue(runId: string): { ok: true } | { ok: false; error: string } {
  const run = getActiveByRunId(runId);
  if (!run) return { ok: false, error: `No active run: ${runId}` };
  run.interrupt.resume();
  run.phase = 'running';
  return { ok: true };
}

export function controlSteer(
  runId: string,
  opts: { inject?: string; goal?: string; reason?: string },
): { ok: true } | { ok: false; error: string } {
  const run = getActiveByRunId(runId);
  if (!run) return { ok: false, error: `No active run: ${runId}` };
  run.interrupt.steer(opts);
  run.phase = 'running';
  return { ok: true };
}

export function controlAbort(
  runId: string,
  reason?: string,
): { ok: true } | { ok: false; error: string } {
  const run = getActiveByRunId(runId);
  if (!run) return { ok: false, error: `No active run: ${runId}` };
  run.interrupt.abort(reason);
  return { ok: true };
}

export type { ApprovalRequest };

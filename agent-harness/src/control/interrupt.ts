/**
 * D: mid-run interrupt / steer (run-level HITL).
 *
 * Distinct from tool-level `Approver`: approval gates one tool call; this gate
 * sits on turn boundaries and can pause, inject instructions, rewrite the goal,
 * or abort while still returning the transcript so far (salvage).
 */

import type { Message } from '@agent/contracts';

// ── Types ───────────────────────────────────────────────────────────

/** Snapshot handed to the interrupter at a turn boundary. */
export interface InterruptContext {
  /** Turns already completed (0 before the first turn). */
  turnsCompleted: number;
  /** Next turn about to start (1-based). */
  nextTurn: number;
  /** Current goal (may already have been steered earlier in the run). */
  goal: string;
  /** Read-only transcript snapshot. */
  messages: readonly Message[];
}

/**
 * Decision at a turn boundary.
 * - `continue` — proceed with the next turn as-is
 * - `steer` — optionally inject a user message and/or rewrite the goal, then continue
 * - `abort` — stop the run; transcript up to this point is still returned
 */
export type InterruptDecision =
  | { action: 'continue' }
  | { action: 'steer'; inject?: string; goal?: string; reason?: string }
  | { action: 'abort'; reason?: string };

/** Awaitable gate consulted before each turn starts. */
export interface RunInterrupter {
  atTurnBoundary(ctx: InterruptContext): Promise<InterruptDecision>;
}

// ── Built-ins ───────────────────────────────────────────────────────

/** Never pause — the default for headless runs. */
export const autoContinue: RunInterrupter = {
  atTurnBoundary: async () => ({ action: 'continue' }),
};

/**
 * External pause / resume / steer / abort handle (LangGraph-style interrupt).
 *
 * Call `pause()` while the agent is running; the loop blocks at the next turn
 * boundary until `resume()`, `steer()`, or `abort()`. Calling `steer` / `abort`
 * without an explicit pause queues the decision for the next boundary.
 */
export function createInterruptHandle(): InterruptHandle {
  let pauseRequested = false;
  let queued: InterruptDecision | null = null;
  let waiting: ((d: InterruptDecision) => void) | null = null;

  const settle = (decision: InterruptDecision): void => {
    pauseRequested = false;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(decision);
    } else {
      queued = decision;
    }
  };

  return {
    pause: () => {
      pauseRequested = true;
    },
    resume: () => settle({ action: 'continue' }),
    steer: (opts = {}) => settle({ action: 'steer', ...opts }),
    abort: (reason) => settle({ action: 'abort', reason }),
    isWaiting: () => waiting !== null,
    interrupter: {
      atTurnBoundary: async () => {
        if (queued) {
          const d = queued;
          queued = null;
          pauseRequested = false;
          return d;
        }
        if (!pauseRequested) return { action: 'continue' };
        return new Promise<InterruptDecision>((resolve) => {
          waiting = resolve;
        });
      },
    },
  };
}

export interface InterruptHandle {
  interrupter: RunInterrupter;
  /** Block at the next turn boundary until resume / steer / abort. */
  pause(): void;
  resume(): void;
  steer(opts?: { inject?: string; goal?: string; reason?: string }): void;
  abort(reason?: string): void;
  /** True while the loop is blocked waiting for a human decision. */
  isWaiting(): boolean;
}

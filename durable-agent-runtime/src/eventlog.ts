/**
 * Append-only, sequence-numbered event log with optimistic concurrency control.
 *
 * Each event is stored as its own file `<runDir>/<seq>.json`, written with the
 * `wx` flag (exclusive create). Claiming sequence N is therefore atomic at the
 * OS level: if another writer already wrote N, our write fails with EEXIST and
 * we raise a ConflictError. This gives lock-free, cross-process optimistic
 * concurrency — two workers can never both extend the same run at the same
 * version. A crash mid-write leaves a valid, replayable prefix (a torn trailing
 * file is skipped on load). Zero dependencies — the OS filesystem is the CAS.
 *
 * ## Tiered durability (selective persistence)
 *
 * Writing every single event as its own synchronous file is correct but not
 * free: a workflow with a high tool-call volume pays one filesystem write (and
 * the attendant syscall/fsync cost) per event, most of which carry no state
 * that's actually at risk of corrupting resume. `eventDurability()` classifies
 * each event type into two tiers — NOT simply "does `applyEvent` touch state"
 * (see below for why that first-cut rule wasn't the right line to draw):
 *
 *  - `critical`: losing this event on crash would make resume WRONG, not just
 *    less efficient. Two ways that happens: (a) it's the only durable record
 *    of an external side effect that isn't free/safe to redo — `ToolCallSucceeded`
 *    /`ModelCalled` populate the idempotency caches that prevent re-billing a
 *    model call or re-running a non-idempotent tool; or (b) it's a completion/
 *    terminal signal other logic (or an external poller) depends on to avoid
 *    redoing finished work or to know the run is done at all — `StepCompleted`/
 *    `PhaseCompleted`/`PhaseSkipped`/`RunCompleted`/`RunFailed`/`RunStarted`.
 *    These are always written to disk before `append()` returns — never left
 *    unflushed.
 *  - `relaxed`: losing this event on crash costs AT MOST a bounded diagnostic-
 *    precision gap, never wrong resume behaviour. Two ways an event earns this:
 *    (a) `applyEvent` folds it through `default: return state` — no state
 *    transition at all (`ToolCallRequested`/`ToolCallFailed`/`PolicyDenied`);
 *    or (b) it DOES cause a transition, but that transition is a pure,
 *    stateless recomputation from data that's always fully available —
 *    `PhaseStarted`/`StepStarted` only set `currentPhase`/`currentStep` to
 *    `phase.name` / `stepNumber(step.id)`, values derived purely from the
 *    (static, unchanging) `WorkflowDef`, never from event history. If lost,
 *    resume re-enters the same step and re-emits an IDENTICAL event (same
 *    phase name, same step number) — there is no way for the recomputed value
 *    to drift from the lost one. The only cost: a `status()` call during the
 *    unflushed window sees a stale `currentPhase`/`currentStep` (whatever the
 *    last durably-confirmed one was), not the one truly in flight — a
 *    diagnostic-precision loss, not a correctness one.
 *
 * These are buffered in memory rather than written immediately.
 *
 * ## Why buffering alone doesn't help (and what actually does)
 *
 * An earlier version of this file buffered relaxed events and flushed them
 * with their own dedicated write, SEPARATELY from the next critical event's
 * write. That does nothing for the single most common pattern in this
 * codebase: `ToolCallRequested` (relaxed) is immediately followed by
 * `ToolCallSucceeded` (critical) — the buffer never accumulates past 1 event
 * before something forces it out, so the "batch of up to `maxBufferedRelaxed`"
 * threshold is rarely if ever reached in practice, and two separate writes
 * still happen (one for the flushed relaxed event, one for the critical one).
 *
 * The actual fix: `append()` of a critical event does NOT flush-then-write —
 * it COMBINES whatever relaxed events are currently buffered WITH the
 * critical event into a single atomic write (one JSON array in one file, one
 * `writeFileSync`). For the common "1 relaxed + 1 critical" case that's a
 * real 2-writes-to-1 reduction, not a theoretical one; for a burst of
 * multiple relaxed events (e.g. concurrent tool calls in one step) it's an
 * N-writes-to-1 reduction. `flush()` is still available to drain the buffer
 * on its own (e.g. the count threshold, or an explicit call with nothing
 * critical pending) using the exact same combined-write mechanism.
 *
 * All events in a batch share ONE sequence-number slot (`writtenCount`
 * advances by the batch size, not by 1) and ONE file, named after the slot's
 * starting sequence — a lone event and a batch are indistinguishable at the
 * filename level, so optimistic-concurrency collision detection (below) is
 * exactly as precise as before: two writers racing for the same starting
 * sequence collide via `EEXIST` on the identical filename regardless of how
 * many logical events either side is trying to pack into it.
 *
 * The trade-off this introduces: a crash mid-write of a batch can torn-write
 * the WHOLE batch, not just one event — including the trailing critical event
 * if it was mid-batch. That's not a new category of risk, just a larger blast
 * radius on an already-accepted one (a lone critical event's own write could
 * already be torn on crash); the loader's existing torn-write handling
 * (below) covers it identically either way, and losing an unconfirmed
 * critical event just means the step re-runs on resume, same as always.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentEvent } from './types.js';

export type EventDurability = 'critical' | 'relaxed';

/**
 * Classify an event's durability tier. See the module doc comment above for
 * the full rule (it's no longer a simple "mirrors reducer.ts's default
 * branch" — `PhaseStarted`/`StepStarted` DO cause a state transition but are
 * still `relaxed`, because that transition is a cheap, drift-free
 * recomputation from the static `WorkflowDef`, not from event history).
 */
export function eventDurability(type: AgentEvent['type']): EventDurability {
  switch (type) {
    case 'ToolCallRequested':
    case 'ToolCallFailed':
    case 'PolicyDenied':
    case 'HumanIntervention':
    case 'PhaseStarted':
    case 'StepStarted':
      return 'relaxed';
    default:
      return 'critical';
  }
}

export interface EventLogOptions {
  /**
   * Flush buffered relaxed-tier events once this many have accumulated, even
   * with no critical event to force them out. Default 20. This only bounds
   * the RELAXED-only accumulation path (a burst with no critical event in
   * between) — it does NOT disable the combined-write behaviour: a critical
   * event always writes together with whatever is currently buffered
   * (even a single one), regardless of this setting, since that's what
   * actually reduces write count for this codebase's typical call pattern
   * (see the module doc comment).
   */
  maxBufferedRelaxed?: number;
}

/** Raised when an append loses the optimistic-concurrency race for a version. */
export class ConflictError extends Error {
  constructor(
    readonly runDir: string,
    readonly version: number,
  ) {
    super(`Conflict: version ${version} in ${runDir} was already claimed by another writer`);
    this.name = 'ConflictError';
  }
}

const SEQ_WIDTH = 12; // zero-padded so lexicographic sort === numeric order

function seqFileName(version: number): string {
  return `${String(version).padStart(SEQ_WIDTH, '0')}.json`;
}

export class EventLog {
  private readonly events: AgentEvent[] = [];
  /** Relaxed-tier events accepted but not yet written to disk. FIFO order. */
  private readonly pending: AgentEvent[] = [];
  /** Number of events actually persisted to disk = next sequence file to write. */
  private writtenCount = 0;

  constructor(
    private readonly _dir: string,
    private readonly opts: EventLogOptions = {},
  ) {
    // Reading is side-effect-free: a non-existent run yields zero events and
    // creates nothing on disk. The directory is created lazily on first append.
    if (!existsSync(_dir)) return;
    const seqRe = /^\d{12}\.json$/;
    const files = readdirSync(_dir)
      .filter((f) => seqRe.test(f))
      .sort();
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(_dir, file), 'utf8')) as unknown;
        // A file holds either one event (the common case) or a batch (a JSON
        // array) written by writeBatch() when a critical event was combined
        // with whatever relaxed events were pending at the time.
        if (Array.isArray(raw)) {
          for (const e of raw as AgentEvent[]) this.events.push(e);
        } else {
          this.events.push(raw as AgentEvent);
        }
      } catch {
        break; // torn trailing write — stop at the last valid event (valid prefix)
      }
    }
    this.writtenCount = this.events.length; // everything loaded from disk is already durable
  }

  all(): AgentEvent[] {
    return [...this.events];
  }

  /** Monotonic version = number of events observed (durable + buffered) = the next sequence to claim. */
  get version(): number {
    return this.events.length;
  }

  /** The filesystem directory backing this log (exposed for snapshot). */
  get dir(): string {
    return this._dir;
  }

  get length(): number {
    return this.events.length;
  }

  /** Relaxed-tier events accepted in-memory but not yet durable on disk (observability only). */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Append an event. `relaxed` events are buffered in memory (never written
   * alone); `critical` events are combined with whatever is currently
   * buffered into ONE atomic write before `append()` returns — see the
   * module doc comment for why that (not a separately-flushed buffer) is what
   * actually reduces write count. Throws ConflictError if another writer
   * already claimed the on-disk sequence slot this write needs (optimistic
   * concurrency) — collision detection is unaffected by batching, since a
   * batch and a lone event share the identical filename scheme (see below).
   */
  append(event: AgentEvent): void {
    if (eventDurability(event.type) === 'relaxed') {
      this.events.push(event);
      this.pending.push(event);
      const max = this.opts.maxBufferedRelaxed ?? 20;
      if (this.pending.length >= max) this.flush();
      return;
    }

    // Critical event: written TOGETHER with any buffered relaxed events, as
    // ONE write — not a separate flush() call followed by a separate write.
    // For the common "1 relaxed immediately followed by 1 critical" pattern
    // this halves the write count; for a burst of relaxed events (e.g.
    // concurrent tool calls in one step) it's an N-writes-to-1 reduction.
    const batch = this.pending.splice(0);
    batch.push(event);
    this.writeBatch(batch);
    this.events.push(event);
  }

  /**
   * Force any buffered relaxed-tier events to disk as a single write, even
   * with no critical event to combine them with. No-op if nothing is
   * buffered. Safe to call at any time (e.g. a long-lived host can call this
   * periodically to bound audit-log exposure).
   */
  flush(): void {
    if (this.pending.length === 0) return;
    this.writeBatch(this.pending.splice(0));
  }

  /**
   * Exclusively create the next sequence file, holding either one event or a
   * JSON array of several. All events in `batch` claim ONE sequence slot
   * (`writtenCount` advances by `batch.length`, not by 1) and one filename —
   * a lone event and a batch are indistinguishable at the filename level, so
   * optimistic-concurrency collision detection is exactly as precise as the
   * original one-event-per-file design: any other writer racing for this
   * same starting slot collides via `EEXIST` on the identical filename
   * regardless of how many events either side packs into it.
   */
  private writeBatch(batch: AgentEvent[]): void {
    if (batch.length === 0) return;
    const start = this.writtenCount;
    if (start === 0) mkdirSync(this._dir, { recursive: true }); // create the run dir lazily, on first write
    const payload = batch.length === 1 ? JSON.stringify(batch[0]) : JSON.stringify(batch);
    try {
      writeFileSync(join(this._dir, seqFileName(start)), payload, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConflictError(this._dir, start);
      }
      throw e;
    }
    this.writtenCount += batch.length;
  }
}

/** Directory that holds one run's event files. */
export function runDir(baseDir: string, runId: string): string {
  return join(baseDir, runId);
}

/** List run IDs present under baseDir (each run is a subdirectory). */
export function listRunIds(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

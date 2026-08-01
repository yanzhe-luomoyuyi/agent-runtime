/**
 * Append-only, sequence-numbered event log with optional optimistic concurrency.
 *
 * ## Write layouts
 *
 * **Optimistic (default, `optimisticConcurrency: true`)** — each durable write
 * exclusively creates `<runDir>/<seq>.json` with the `wx` flag. Claiming
 * sequence N is atomic at the OS level: if another writer already wrote N, our
 * write fails with EEXIST and we raise a ConflictError. Lock-free, cross-process
 * CAS — two workers can never both extend the same run at the same version. A
 * crash mid-write leaves a valid, replayable prefix (a torn trailing file is
 * skipped on load).
 *
 * **Single-file (`optimisticConcurrency: false`)** — one `events.json` per run,
 * rewritten atomically (tmp+rename) on each durable flush. Assumes a **single
 * writer** (local debug): no ConflictError, far fewer files under the run dir.
 * Resume still replays the full event order from that one file. Do not flip
 * modes mid-run across writers; load prefers `events.json` when present.
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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentEvent } from './types.js';

/** Single-file layout used when optimistic concurrency is off. */
const EVENTS_FILE = 'events.json';
const EVENTS_TMP = 'events.tmp.json';

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

/**
 * Validate the shape of a parsed event. The loader can't rely on
 * `JSON.parse` alone to detect a torn write: a crash mid-`writeFileSync` can
 * leave a VALID-JSON prefix of the event (e.g. a `ToolCallSucceeded` truncated
 * at a field boundary, missing its trailing `ts`). That would otherwise be
 * replayed as a corrupt event (wrong idempotency cache → duplicate side
 * effect on resume). Every recorder appends `ts` LAST, so requiring `type` +
 * `ts` plus per-type identity fields catches every realistic truncation point
 * without false-positiving on legitimately-`undefined` value fields (`result`,
 * `output`, `summary`, ...) that JSON round-trip drops.
 */
export function isValidEventShape(e: unknown): e is AgentEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  if (typeof o.type !== 'string' || o.type.length === 0 || typeof o.ts !== 'string') return false;
  const id = (...keys: string[]): boolean => keys.every((k) => typeof o[k] === 'string');
  switch (o.type) {
    case 'RunStarted':
      return id('runId', 'workflow');
    case 'PhaseStarted':
      return id('phase');
    case 'StepStarted':
      return id('phase', 'stepId') && typeof o.step === 'number';
    case 'ToolCallRequested':
    case 'ToolCallSucceeded':
      return id('callId', 'tool');
    case 'ToolCallFailed':
      return id('callId', 'tool', 'error');
    case 'PolicyDenied':
      return id('scope', 'target', 'code', 'reason');
    case 'HumanIntervention':
      return id('action') && typeof o.turn === 'number';
    case 'ModelCalled':
      return id('callId', 'phase') && typeof o.step === 'number';
    case 'StepCompleted':
      return id('phase', 'stepId') && typeof o.step === 'number';
    case 'PhaseCompleted':
      return id('phase');
    case 'PhaseSkipped':
      return id('phase', 'reason');
    case 'RunCompleted':
      return true; // summary may be any value
    case 'RunFailed':
      return id('error');
    default:
      return false; // unknown event type is not one of ours
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
  /**
   * When true (default): per-version `wx` sequence files + ConflictError on
   * collision — safe for multi-worker append. When false: one `events.json`
   * per run (atomic rewrite); single-writer only, quieter for local debug.
   */
  optimisticConcurrency?: boolean;
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
  /** After first single-file write, seq-file cleanup has already run. */
  private seqFilesCleared = false;
  /**
   * On-disk layout for writes. Locked to whatever already exists under the run
   * dir so resume with mismatched options cannot split history across formats.
   */
  private writeLayout: 'seq' | 'single';
  /** Cumulative ms spent in durable event-log writes (for RunCompleted/RunFailed). */
  private _writeFileMs = 0;
  private _durableWrites = 0;

  constructor(
    private readonly _dir: string,
    private readonly opts: EventLogOptions = {},
  ) {
    const preferSingle = opts.optimisticConcurrency === false;
    // Reading is side-effect-free: a non-existent run yields zero events and
    // creates nothing on disk. The directory is created lazily on first append.
    if (!existsSync(_dir)) {
      this.writeLayout = preferSingle ? 'single' : 'seq';
      return;
    }

    // Prefer the single-file layout when present so resume works after a run
    // that disabled optimistic concurrency (seq files may be leftover orphans).
    const singlePath = join(_dir, EVENTS_FILE);
    if (existsSync(singlePath)) {
      try {
        const raw = JSON.parse(readFileSync(singlePath, 'utf8')) as unknown;
        if (Array.isArray(raw)) {
          for (const e of raw) {
            // A torn rewrite can be valid JSON with an incomplete event — keep
            // the valid prefix instead of replaying (or discarding) the tail.
            if (!isValidEventShape(e)) break;
            this.events.push(e);
          }
        }
      } catch {
        // torn/corrupt rewrite — treat as empty; caller can fall back to full replay failure
      }
      this.writtenCount = this.events.length;
      this.writeLayout = 'single';
      this.seqFilesCleared = true; // events.json is authoritative; don't scan for seq cleanup
      return;
    }

    const seqRe = /^\d{12}\.json$/;
    const files = readdirSync(_dir)
      .filter((f) => seqRe.test(f))
      .sort();
    for (const file of files) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(_dir, file), 'utf8'));
      } catch {
        break; // torn trailing write — invalid JSON; stop at the last valid event
      }
      // A torn write can also be VALID JSON (an object truncated at a field
      // boundary, e.g. missing its trailing `ts`). Validate the event shape so
      // an incomplete event is treated as torn too, not replayed as corrupt.
      // A file holds either one event (the common case) or a batch (a JSON
      // array) written by writeBatch() when a critical event was combined
      // with whatever relaxed events were pending at the time.
      if (Array.isArray(raw)) {
        if (!raw.every(isValidEventShape)) break;
        for (const e of raw as AgentEvent[]) this.events.push(e);
      } else {
        if (!isValidEventShape(raw)) break;
        this.events.push(raw as AgentEvent);
      }
    }
    this.writtenCount = this.events.length; // everything loaded from disk is already durable
    // Empty dir or seq-only history: honour the constructor option (single-file
    // will migrate off seq files on first write).
    this.writeLayout = preferSingle ? 'single' : 'seq';
  }

  /** Whether this log uses exclusive-create sequence files (default) or single-file. */
  get optimisticConcurrency(): boolean {
    return this.writeLayout === 'seq';
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
   * actually reduces write count. Throws ConflictError (optimistic layout only)
   * if another writer already claimed the on-disk sequence slot this write
   * needs — collision detection is unaffected by batching, since a batch and
   * a lone event share the identical filename scheme (see below). Single-file
   * layout never throws ConflictError (single-writer assumed).
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
    // Stamp terminal events with write totals so far (this write counted after).
    const toAppend =
      event.type === 'RunCompleted' || event.type === 'RunFailed'
        ? { ...event, writeFileMs: this._writeFileMs, durableWrites: this._durableWrites }
        : event;
    batch.push(toAppend);
    this.writeBatch(batch);
    this.events.push(toAppend);
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
   * Persist `batch` to disk. Optimistic mode exclusively creates the next
   * sequence file (CAS via `wx` / ConflictError). Single-file mode rewrites
   * `events.json` atomically — no conflict detection (single-writer assumed).
   *
   * In optimistic mode all events in `batch` claim ONE sequence slot
   * (`writtenCount` advances by `batch.length`) and one filename — a lone
   * event and a batch collide on the same starting slot via `EEXIST`.
   */
  private writeBatch(batch: AgentEvent[]): void {
    if (batch.length === 0) return;
    const t0 = Date.now();
    if (!this.optimisticConcurrency) {
      this.writeSingleFile(batch);
    } else {
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
    this._writeFileMs += Math.max(0, Date.now() - t0);
    this._durableWrites += 1;
  }

  /**
   * Rewrite `events.json` with the durable prefix plus `batch` (tmp+rename).
   * If this run previously used seq files, drop them after the first successful
   * single-file write so the run dir stays a single log + snapshot.
   */
  private writeSingleFile(batch: AgentEvent[]): void {
    mkdirSync(this._dir, { recursive: true });
    const durable = [...this.events.slice(0, this.writtenCount), ...batch];
    const tmp = join(this._dir, EVENTS_TMP);
    const dst = join(this._dir, EVENTS_FILE);
    writeFileSync(tmp, JSON.stringify(durable));
    renameSync(tmp, dst);
    this.writtenCount += batch.length;

    if (this.seqFilesCleared) return;
    this.seqFilesCleared = true;
    const seqRe = /^\d{12}\.json$/;
    for (const f of readdirSync(this._dir)) {
      if (!seqRe.test(f)) continue;
      try {
        unlinkSync(join(this._dir, f));
      } catch {
        /* best-effort cleanup of legacy seq files */
      }
    }
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

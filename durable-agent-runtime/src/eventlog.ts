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
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentEvent } from './types.js';

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

  constructor(private readonly _dir: string) {
    // Reading is side-effect-free: a non-existent run yields zero events and
    // creates nothing on disk. The directory is created lazily on first append.
    if (!existsSync(_dir)) return;
    const seqRe = /^\d{12}\.json$/;
    const files = readdirSync(_dir)
      .filter((f) => seqRe.test(f))
      .sort();
    for (const file of files) {
      try {
        this.events.push(JSON.parse(readFileSync(join(_dir, file), 'utf8')) as AgentEvent);
      } catch {
        break; // torn trailing write — stop at the last valid event (valid prefix)
      }
    }
  }

  all(): AgentEvent[] {
    return [...this.events];
  }

  /** Monotonic version = number of events observed = the next sequence to claim. */
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

  /**
   * Append by exclusively creating the next sequence file. Throws ConflictError
   * if another writer already claimed this version (optimistic concurrency).
   */
  append(event: AgentEvent): void {
    const version = this.events.length;
    if (version === 0) mkdirSync(this._dir, { recursive: true }); // create the run dir lazily, on first write
    try {
      writeFileSync(join(this._dir, seqFileName(version)), JSON.stringify(event), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConflictError(this._dir, version);
      }
      throw e;
    }
    this.events.push(event);
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

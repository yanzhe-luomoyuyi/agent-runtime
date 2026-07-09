/**
 * Snapshot — a periodic checkpoint of RunState for fast resume.
 *
 * Without snapshots, every resume replays the ENTIRE event log from event 0
 * through the reducer. For long-running workflows (hundreds or thousands of
 * events), that linear replay cost can dominate cold-start latency.
 *
 * A snapshot captures the fully reduced state + cumulative model spend at a
 * specific log version. On resume we load the latest snapshot and only replay
 * events that arrived AFTER it — typically zero or a handful.
 *
 * ## Concurrency / consistency
 *
 * The runtime that owns a run (having won the optimistic-concurrency race for
 * every log append) is the sole writer. No other process can append to the
 * same run, so there is no writer–writer race on the snapshot.
 *
 * To guard against torn writes (crash mid-snapshot), the file is written
 * atomically via tmp + rename. On load we validate the shape; a corrupt or
 * missing snapshot is simply ignored and the runtime falls back to full replay.
 *
 * A snapshot whose version exceeds the actual log length (should never happen
 * in practice) is also ignored — the log is always authoritative.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunState } from './types.js';

export interface Snapshot {
  /** The event-log version (number of events folded into this snapshot). */
  version: number;
  /** RunState after applying all events up to `version`. */
  state: RunState;
  /** Cumulative model spend (USD) up to `version`. */
  spentUsd: number;
}

const FILE = 'snapshot.json';
const TMP = 'snapshot.tmp.json';

/** Write a snapshot atomically: tmp → rename. */
export function writeSnapshot(runDir: string, snap: Snapshot): void {
  const tmp = join(runDir, TMP);
  const dst = join(runDir, FILE);
  try {
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, dst);
  } catch {
    // Snapshot is an optimisation — never let a write failure abort the run.
    try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Read the latest snapshot if it exists and passes basic validation.
 * Returns undefined when:
 *  - No snapshot file exists
 *  - The file is malformed / unparseable
 *  - The snapshot version is inconsistent with reality (version > log length
 *    would mean the snapshot references events that don't exist)
 */
export function readSnapshot(runDir: string, logVersion: number): Snapshot | undefined {
  const path = join(runDir, FILE);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    const snap = JSON.parse(raw) as Snapshot;
    if (
      typeof snap.version !== 'number' ||
      snap.version < 0 ||
      snap.version > logVersion || // snapshot ahead of the log → impossible, discard
      !snap.state ||
      typeof snap.state.runId !== 'string' ||
      typeof snap.spentUsd !== 'number'
    ) {
      return undefined;
    }
    return snap;
  } catch {
    // Corrupted snapshot — treat as missing.
    return undefined;
  }
}

/** Remove the snapshot file (e.g. when it's invalidated by a new phase). */
export function deleteSnapshot(runDir: string): void {
  try { unlinkSync(join(runDir, FILE)); } catch { /* ok if missing */ }
}

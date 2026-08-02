/**
 * B: no-progress / loop detection.
 *
 * A model can get stuck re-issuing the same tool call, or cycling through a
 * handful of calls in a repeating pattern (A→B→A→B…).  The detector now uses a
 * **sliding window** (so non-consecutive repeats don't falsely trip) and
 * optionally detects repeating **sequences** of calls in addition to single-call
 * repeats.
 *
 * Per-tool limits let read-only tools (search, grep) be retried more often than
 * write tools (deploy, delete).
 */

export interface LoopDetectorOptions {
  /** How many identical (or sequence) repeats within the window before it trips. Default 3. */
  limit?: number;
  /** Per-tool overrides for `limit` (tool name → limit). */
  toolLimits?: Record<string, number>;
  /** Sliding-window size — only the last N calls count. Default 12. */
  windowSize?: number;
  /** Enable sequence-pattern detection (A→B→A→B cycles). Default true. */
  sequenceDetection?: boolean;
  /** Lengths of sequences to detect. Default [2] (pair cycles). */
  sequenceLengths?: number[];
  /** How many times a sequence must appear to trip. Default 2 (i.e. appears twice). */
  sequenceLimit?: number;
  /**
   * When set, a repeating sequence only counts if at least one of its calls
   * is a tool in this set (typically mutating/write tools). Hosts with
   * legitimate read/verify cycles (grep→read, edit→test) keep sequence
   * detection on without false positives. Pass `[]` to disable sequence
   * detection entirely. Default: unset — every sequence counts.
   */
  sequenceMutatingTools?: string[];
  /**
   * Tool names whose SUCCESSFUL call resets that signature's repeat count.
   * A green verify run (run_tests exit 0) is progress, so identical re-runs
   * stop accumulating suspicion; only repeated FAILURES keep piling up.
   * Default: unset — every call counts regardless of outcome.
   */
  successResets?: string[];
  /**
   * Tools whose trip is ADVISORY rather than a hard refusal: the repeated
   * call is not executed, but instead of aborting the run the host feeds a
   * "you may be stuck — change approach" note back to the model. Read-only /
   * verify tools repeat legitimately, so they get nudged; write tools keep
   * the hard refusal + run abort. Default: unset — every trip is hard.
   */
  advisoryTools?: string[];
}

/** Severity of a loop-detector trip for the call being attempted. */
export type TripSeverity = 'none' | 'advisory' | 'hard';

interface CallEntry {
  name: string;
  sig: string;
}

/** Stable signature for a tool call (argument key order does not matter). */
export function callSignature(name: string, args: unknown): string {
  return `${name}:${stableStringify(args)}`;
}

export class LoopDetector {
  private readonly window: CallEntry[] = [];
  private readonly maxWindow: number;
  private readonly defaultLimit: number;
  private readonly toolLimits: Record<string, number>;
  private readonly seqDetection: boolean;
  private readonly seqLengths: number[];
  private readonly seqLimit: number;
  private readonly seqMutating: Set<string> | undefined;
  private readonly successResets: Set<string> | undefined;
  private readonly advisoryTools: Set<string> | undefined;

  /**
   * @param opts  Either a plain `number` (limit only, backward-compatible) or a
   *              full options object.
   */
  constructor(opts?: number | LoopDetectorOptions) {
    const resolved: LoopDetectorOptions =
      typeof opts === 'number' ? { limit: opts } : (opts ?? {});
    this.defaultLimit = resolved.limit ?? 3;
    this.toolLimits = resolved.toolLimits ?? {};
    this.maxWindow = resolved.windowSize ?? 12;
    this.seqDetection = resolved.sequenceDetection ?? true;
    this.seqLengths = resolved.sequenceLengths ?? [2];
    this.seqLimit = resolved.sequenceLimit ?? 2;
    this.seqMutating = resolved.sequenceMutatingTools
      ? new Set(resolved.sequenceMutatingTools)
      : undefined;
    this.successResets = resolved.successResets ? new Set(resolved.successResets) : undefined;
    this.advisoryTools = resolved.advisoryTools ? new Set(resolved.advisoryTools) : undefined;
  }

  /** Record one tool call. `name` is the tool name, `sig` is `callSignature(name, args)`. */
  record(name: string, sig: string): void {
    this.window.push({ name, sig });
    // Keep only the most recent `maxWindow` entries.
    while (this.window.length > this.maxWindow) this.window.shift();
  }

  /**
   * True when recording this call would trip — either an identical call has
   * appeared `limit` times within the sliding window, or a sequence pattern is
   * repeating. Backward-compatible alias of `tripMode(...) !== 'none'`.
   */
  tripped(name: string, sig: string): boolean {
    return this.wouldTrip(name, sig);
  }

  /**
   * Severity of tripping for the call being attempted:
   * - `'hard'` — refuse the call and stop the run (default; write tools)
   * - `'advisory'` — do not execute the call, but let the host nudge the model
   *   and continue the run (read-only / verify tools)
   * - `'none'` — no trip
   */
  tripMode(name: string, sig: string): TripSeverity {
    return this.wouldTrip(name, sig) ? (this.advisoryTools?.has(name) ? 'advisory' : 'hard') : 'none';
  }

  private wouldTrip(name: string, sig: string): boolean {
    const limit = this.toolLimits[name] ?? this.defaultLimit;

    // (a) Single-call repeat within the sliding window
    let count = 0;
    for (const entry of this.window) {
      if (entry.sig === sig) count++;
    }
    if (count >= limit) return true;

    // (b) Sequence-pattern repeat
    if (this.seqDetection && this.window.length >= 2) {
      for (const len of this.seqLengths) {
        if (this.window.length < len * 2) continue;
        if (sequenceCount(this.window, len, this.seqMutating) >= this.seqLimit) return true;
      }
    }

    return false;
  }

  reset(): void {
    this.window.length = 0;
  }

  /**
   * Record that the most recent call with `sig` succeeded (progress). When the
   * call's tool is in `successResets`, older same-signature entries are cleared
   * so the repeat count starts fresh — a green verify run is progress, not a
   * stuck loop. No-op when the tool is not in `successResets`.
   */
  markSuccess(sig: string): void {
    // Find the most recent recorded entry with this signature (works even
    // under concurrent tool execution, where the latest window entry may be
    // another call's).
    for (let i = this.window.length - 1; i >= 0; i--) {
      if (this.window[i]!.sig !== sig) continue;
      if (!this.successResets?.has(this.window[i]!.name)) return;
      for (let j = i - 1; j >= 0; j--) {
        if (this.window[j]!.sig === sig) this.window.splice(j, 1);
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count how many times the last `len` entries form a sequence that appears
 * (non-overlapping) earlier in the window. Uses string keys for O(n) comparison.
 * When `mutating` is set, only sequences containing at least one mutating tool
 * count — read/verify cycles repeat legitimately in coding agents.
 */
function sequenceCount(window: CallEntry[], len: number, mutating?: Set<string>): number {
  if (window.length < len * 2) return 0;

  // Build the key for the most recent `len` entries.
  const recent = buildSeqKey(window, window.length - len, len);

  if (mutating) {
    let hasMutating = false;
    for (let i = window.length - len; i < window.length; i++) {
      if (mutating.has(window[i]!.name)) {
        hasMutating = true;
        break;
      }
    }
    if (!hasMutating) return 0;
  }

  let count = 1; // the recent sequence itself counts as one occurrence
  // Scan backwards from (length - len - 1) to 0, moving by `len` each time
  // to count non-overlapping occurrences.
  let pos = window.length - len * 2;
  while (pos >= 0) {
    const key = buildSeqKey(window, pos, len);
    if (key === recent) count++;
    pos -= len;
  }
  return count;
}

function buildSeqKey(window: CallEntry[], start: number, len: number): string {
  const parts: string[] = [];
  for (let i = 0; i < len; i++) {
    parts.push(window[start + i]!.sig);
  }
  return parts.join('→');
}

/** JSON with deterministically ordered object keys, so equal args hash equally. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

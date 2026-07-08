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
}

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
  }

  /** Record one tool call. `name` is the tool name, `sig` is `callSignature(name, args)`. */
  record(name: string, sig: string): void {
    this.window.push({ name, sig });
    // Keep only the most recent `maxWindow` entries.
    while (this.window.length > this.maxWindow) this.window.shift();
  }

  /**
   * True when either (a) the exact call signature has appeared `limit` times
   * within the sliding window, or (b) a sequence pattern is repeating.
   */
  tripped(name: string, sig: string): boolean {
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
        if (sequenceCount(this.window, len) >= this.seqLimit) return true;
      }
    }

    return false;
  }

  reset(): void {
    this.window.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count how many times the last `len` entries form a sequence that appears
 * (non-overlapping) earlier in the window. Uses string keys for O(n) comparison.
 */
function sequenceCount(window: CallEntry[], len: number): number {
  if (window.length < len * 2) return 0;

  // Build the key for the most recent `len` entries.
  const recent = buildSeqKey(window, window.length - len, len);

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

/**
 * B: no-progress / loop detection.
 *
 * A model can get stuck re-issuing the same tool call with the same arguments
 * forever (until the turn budget). The detector tracks a stable signature per
 * call and reports when one repeats past a limit, so the loop can stop early
 * with a clear diagnostic instead of burning the whole budget.
 */

/** Stable signature for a tool call (argument key order does not matter). */
export function callSignature(name: string, args: unknown): string {
  return `${name}:${stableStringify(args)}`;
}

export class LoopDetector {
  private readonly counts = new Map<string, number>();

  /** @param limit How many identical calls before it is considered a loop. Default 3. */
  constructor(private readonly limit = 3) {}

  /** Record one occurrence of `signature`; returns the new count. */
  record(signature: string): number {
    const next = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, next);
    return next;
  }

  /** True once `signature` has been seen at least `limit` times. */
  tripped(signature: string): boolean {
    return (this.counts.get(signature) ?? 0) >= this.limit;
  }

  reset(): void {
    this.counts.clear();
  }
}

/** JSON with deterministically ordered object keys, so equal args hash equally. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

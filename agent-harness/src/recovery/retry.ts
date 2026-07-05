/**
 * B: transient-failure recovery.
 *
 * Real model/tool calls fail intermittently (429s, 5xx, timeouts, dropped
 * sockets). `withRetry` retries only failures classified as transient, with
 * exponential backoff, and rethrows everything else immediately (a bad request
 * or a bug should not be retried). The `sleep` seam is injectable so tests run
 * instantly and deterministically.
 */

/** Marker error tests (and callers) can throw to force the "transient" path. */
export class TransientError extends Error {
  constructor(message = 'transient failure') {
    super(message);
    this.name = 'TransientError';
  }
}

export interface RetryOptions {
  /** Max additional attempts after the first. Default 2 (so up to 3 tries). */
  retries?: number;
  /** Classifier for whether an error is worth retrying. Default `isTransientError`. */
  isRetryable?: (err: unknown) => boolean;
  /** Backoff delay for a given attempt (1-based). Default capped exponential. */
  delayMs?: (attempt: number) => number;
  /** Sleep seam — inject a no-op in tests. Default real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook fired before each retry. */
  onRetry?: (err: unknown, attempt: number) => void;
}

/** Run `fn`, retrying transient failures with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const isRetryable = opts.isRetryable ?? isTransientError;
  const delayMs = opts.delayMs ?? ((attempt) => Math.min(2000, 50 * 2 ** (attempt - 1)));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !isRetryable(err)) throw err;
      opts.onRetry?.(err, attempt);
      await sleep(delayMs(attempt));
    }
  }
}

/** Heuristic: is this error the kind that a retry might fix? */
export function isTransientError(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  return /(timeout|timed out|econnreset|econnrefused|socket hang up|rate limit|temporarily unavailable|overloaded)/.test(msg);
}

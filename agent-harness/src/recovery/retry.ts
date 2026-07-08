// Node.js runtime globals — not in ES2022 lib.
declare function setTimeout(fn: () => void, ms: number): unknown;

/**
 * B: transient-failure recovery.
 *
 * Real model/tool calls fail intermittently (429s, 5xx, timeouts, dropped
 * sockets). `withRetry` retries only failures classified as transient, with
 * exponential backoff + jitter, and rethrows everything else immediately (a bad
 * request or a bug should not be retried). The `sleep` seam is injectable so
 * tests run instantly and deterministically.
 *
 * Improvements over the earlier version:
 *  - Full-jitter backoff by default (prevents thundering-herd when multiple
 *    agent instances hit the same rate limit simultaneously).
 *  - Respects `Retry-After` headers on 429 responses so the caller follows the
 *    service's suggested wait rather than guessing.
 *  - Structured error classification: checks HTTP status codes and error type
 *    fields before falling back to regex heuristics.
 */

/** Marker error tests (and callers) can throw to force the "transient" path. */
export class TransientError extends Error {
  constructor(message = 'transient failure') {
    super(message);
    this.name = 'TransientError';
  }
}

/**
 * An error that carries an HTTP status so the retry layer can classify it
 * reliably without regex-matching message strings.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Jitter strategy applied to the computed backoff delay. */
export type JitterStrategy = 'none' | 'full' | 'equal';

export interface RetryOptions {
  /** Max additional attempts after the first. Default 2 (so up to 3 tries). */
  retries?: number;
  /** Classifier for whether an error is worth retrying. Default `isTransientError`. */
  isRetryable?: (err: unknown) => boolean;
  /**
   * Backoff delay for a given attempt (1-based). Default capped exponential with
   * full jitter: `random(0, min(30_000, 100 * 2^(attempt-1)))`.
   */
  delayMs?: (attempt: number) => number;
  /** Sleep seam — inject a no-op in tests. Default real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook fired before each retry. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Jitter strategy. Default 'full' (AWS-recommended for thundering-herd prevention). */
  jitter?: JitterStrategy;
  /**
   * Extract a server-suggested retry delay (ms) from an error. When the
   * extractor returns a positive number that value is used INSTEAD of the
   * computed backoff. Default parses `Retry-After` from `HttpError.headers` or
   * recognises `retryAfterMs` / `retry_after` properties on arbitrary errors.
   */
  extractRetryAfterMs?: (err: unknown) => number | undefined;
}

function defaultDelay(attempt: number): number {
  return Math.min(30_000, 100 * 2 ** (attempt - 1));
}

function applyJitter(delay: number, strategy: JitterStrategy): number {
  switch (strategy) {
    case 'full':
      return Math.random() * delay;
    case 'equal':
      return delay / 2 + Math.random() * (delay / 2);
    default:
      return delay;
  }
}

/** Run `fn`, retrying transient failures with backoff + jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const isRetryable = opts.isRetryable ?? isTransientError;
  const delayFn = opts.delayMs ?? defaultDelay;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitter = opts.jitter ?? 'full';
  const extractRetryAfter = opts.extractRetryAfterMs ?? defaultExtractRetryAfterMs;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries || !isRetryable(err)) throw err;

      // Server-suggested delay takes priority over the computed backoff.
      const serverHint = extractRetryAfter(err);
      const delay = serverHint != null && serverHint > 0
        ? Math.min(serverHint, 60_000) // cap server hints at 60 s
        : applyJitter(delayFn(attempt), jitter);

      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Error classification (layered: status → type field → regex)
// ---------------------------------------------------------------------------

/**
 * Structured classification: check HTTP status codes and error `type` fields
 * before falling back to regex heuristics on the message.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof TransientError) return true;

  // Layer 1: HTTP status code (HttpError or status property on arbitrary objects)
  const status = extractHttpStatus(err);
  if (status != null) {
    // 429 Too Many Requests, 5xx server errors → retryable
    if (status === 429 || (status >= 500 && status < 600)) return true;
    // 4xx client errors (except 429) → not retryable
    if (status >= 400 && status < 500) return false;
  }

  // Layer 2: error type field (many LLM APIs return `{"error":{"type":"..."}}`)
  const type = extractErrorType(err);
  if (type) {
    const retryableTypes = /rate_limit|server_error|service_unavailable|timeout|overloaded/i;
    if (retryableTypes.test(type)) return true;
    const nonRetryable = /invalid_request|authentication|authorization|not_found|bad_request/i;
    if (nonRetryable.test(type)) return false;
  }

  // Layer 3: fallback regex on the error message
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  return /(timeout|timed out|econnreset|econnrefused|socket hang up|rate limit|temporarily unavailable|overloaded)/.test(msg);
}

function extractHttpStatus(err: unknown): number | undefined {
  if (err instanceof HttpError) return err.status;
  const obj = err as Record<string, unknown> | null;
  if (!obj) return undefined;
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const v = obj[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function extractErrorType(err: unknown): string | undefined {
  const obj = err as Record<string, unknown> | null;
  if (!obj) return undefined;
  // Direct type field
  if (typeof obj.type === 'string') return obj.type;
  // Nested: { error: { type: 'rate_limit_exceeded' } } (OpenAI / Anthropic shape)
  const inner = obj.error as Record<string, unknown> | null;
  if (inner && typeof inner.type === 'string') return inner.type;
  return undefined;
}

// ---------------------------------------------------------------------------
// Retry-After extraction
// ---------------------------------------------------------------------------

/**
 * Default extractor: tries `Retry-After` from HttpError headers, then looks for
 * common properties (`retryAfterMs`, `retry_after`, `retryAfter`) on arbitrary
 * error objects.
 */
export function defaultExtractRetryAfterMs(err: unknown): number | undefined {
  // HttpError with Retry-After header
  if (err instanceof HttpError && err.headers) {
    const ra = err.headers['retry-after'] ?? err.headers['Retry-After'];
    if (ra) {
      const seconds = parseRetryAfter(ra);
      if (seconds != null) return seconds * 1000;
    }
    // X-RateLimit-Reset: Unix timestamp
    const reset = err.headers['x-ratelimit-reset'] ?? err.headers['X-RateLimit-Reset'];
    if (reset) {
      const ts = Number(reset);
      if (Number.isFinite(ts)) {
        const waitMs = ts * 1000 - Date.now();
        if (waitMs > 0) return waitMs;
      }
    }
  }

  // Common properties on arbitrary errors
  const obj = err as Record<string, unknown> | null;
  if (obj) {
    for (const key of ['retryAfterMs', 'retry_after_ms', 'retryAfter']) {
      const v = obj[key];
      if (typeof v === 'number' && v > 0) return v;
    }
    if (typeof obj.retry_after === 'number' && obj.retry_after > 0) return obj.retry_after * 1000;
  }
  return undefined;
}

/** Parse an HTTP Retry-After value (seconds or http-date). */
export function parseRetryAfter(value: string): number | undefined {
  // Try seconds (integer)
  const seconds = Number(value);
  if (Number.isFinite(seconds) && /^\d+$/.test(value.trim())) return seconds;
  // Try HTTP-date
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const waitSec = Math.ceil((date - Date.now()) / 1000);
    return waitSec > 0 ? waitSec : undefined;
  }
  return undefined;
}

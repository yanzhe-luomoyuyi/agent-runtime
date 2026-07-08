import { describe, expect, it } from 'vitest';

import { callSignature, LoopDetector } from '../src/recovery/loop-detector.js';
import {
  defaultExtractRetryAfterMs,
  HttpError,
  isTransientError,
  parseRetryAfter,
  TransientError,
  withRetry,
} from '../src/recovery/retry.js';

const noSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------
describe('withRetry', () => {
  it('retries transient failures then succeeds', async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new TransientError();
        return 'ok';
      },
      { retries: 3, sleep: noSleep, jitter: 'none' },
    );
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('gives up after exhausting retries', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new TransientError('always');
        },
        { retries: 2, sleep: noSleep, jitter: 'none' },
      ),
    ).rejects.toThrow('always');
    expect(n).toBe(3); // initial + 2 retries
  });

  it('does not retry non-transient errors', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error('bad request 400');
        },
        { retries: 5, sleep: noSleep, jitter: 'none' },
      ),
    ).rejects.toThrow('bad request');
    expect(n).toBe(1);
  });

  it('applies full jitter by default (delay ≤ computed backoff)', async () => {
    const delays: number[] = [];
    const out = await withRetry(
      async () => {
        if (delays.length < 2) throw new TransientError();
        return 'ok';
      },
      {
        retries: 3,
        sleep: async (ms) => { delays.push(ms); },
        jitter: 'full', // default, but explicit for the test
      },
    );
    expect(out).toBe('ok');
    // Two retries → two delays. Both should be ≤ the raw exponential cap.
    expect(delays.length).toBe(2);
    for (const d of delays) {
      // With full jitter the delay is random(0, capped-exponential).
      // At worst it equals the exponential value; at best it's 0.
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });

  it('allows disabling jitter for deterministic delays', async () => {
    const delays: number[] = [];
    await expect(
      withRetry(
        async () => { throw new TransientError(); },
        {
          retries: 2,
          sleep: async (ms) => { delays.push(ms); },
          jitter: 'none',
        },
      ),
    ).rejects.toThrow();
    // 2 retries → 2 deterministic exponential delays
    expect(delays.length).toBe(2);
    expect(delays[0]).toBe(100);  // 100 * 2^0
    expect(delays[1]).toBe(200);  // 100 * 2^1
  });

  it('respects a custom Retry-After extractor', async () => {
    const delays: number[] = [];
    await expect(
      withRetry(
        async () => { throw new TransientError('boom'); },
        {
          retries: 1,
          sleep: async (ms) => { delays.push(ms); },
          jitter: 'none',
          extractRetryAfterMs: () => 500,
        },
      ),
    ).rejects.toThrow();
    expect(delays[0]).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
describe('isTransientError', () => {
  // Layer 3: regex fallback (original behaviour)
  it('classifies regex-based transient errors', () => {
    expect(isTransientError(new Error('HTTP 429 rate limit'))).toBe(true);
    expect(isTransientError(new Error('503 service unavailable'))).toBe(true);
    expect(isTransientError(new Error('Request timeout'))).toBe(true);
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientError(new Error('nonsense'))).toBe(false);
  });

  // Layer 1: HTTP status codes via HttpError
  it('classifies HttpError by status code', () => {
    expect(isTransientError(new HttpError('rate limited', 429))).toBe(true);
    expect(isTransientError(new HttpError('server error', 500))).toBe(true);
    expect(isTransientError(new HttpError('bad gateway', 502))).toBe(true);
    expect(isTransientError(new HttpError('service unavailable', 503))).toBe(true);
    expect(isTransientError(new HttpError('gateway timeout', 504))).toBe(true);
    // 4xx (except 429) are NOT retryable
    expect(isTransientError(new HttpError('bad request', 400))).toBe(false);
    expect(isTransientError(new HttpError('not found', 404))).toBe(false);
    expect(isTransientError(new HttpError('unauthorized', 401))).toBe(false);
  });

  // Layer 2: error type field
  it('classifies by error type field', () => {
    expect(isTransientError({ type: 'rate_limit_exceeded', message: 'x' })).toBe(true);
    expect(isTransientError({ type: 'server_error', message: 'x' })).toBe(true);
    expect(isTransientError({ type: 'invalid_request_error', message: 'x' })).toBe(false);
    expect(isTransientError({ type: 'authentication_error', message: 'x' })).toBe(false);
  });

  // Layer 2: nested { error: { type: ... } } (OpenAI/Anthropic shape)
  it('classifies by nested error type', () => {
    expect(isTransientError({ error: { type: 'rate_limit' } })).toBe(true);
    expect(isTransientError({ error: { type: 'server_error' } })).toBe(true);
    expect(isTransientError({ error: { type: 'invalid_request_error' } })).toBe(false);
  });

  // TransientError marker always retryable
  it('classifies TransientError instances', () => {
    expect(isTransientError(new TransientError())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retry-After
// ---------------------------------------------------------------------------
describe('Retry-After extraction', () => {
  it('parses Retry-After seconds', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('  5  ')).toBe(5);
  });

  it('rejects non-numeric Retry-After values', () => {
    expect(parseRetryAfter('abc')).toBeUndefined();
  });

  it('extracts from HttpError headers', () => {
    const err = new HttpError('too many', 429, { 'retry-after': '30' });
    expect(defaultExtractRetryAfterMs(err)).toBe(30_000);
  });

  it('extracts from X-RateLimit-Reset (future timestamp only)', () => {
    const future = Math.ceil((Date.now() + 10_000) / 1000);
    const err = new HttpError('rate limit', 429, { 'x-ratelimit-reset': String(future) });
    const ms = defaultExtractRetryAfterMs(err);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(15_000);
  });

  it('extracts from retryAfterMs property', () => {
    const ms = defaultExtractRetryAfterMs({ retryAfterMs: 250 });
    expect(ms).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// LoopDetector — exact single-call repeat (sliding window)
// ---------------------------------------------------------------------------
describe('LoopDetector — single-call repeat', () => {
  it('trips on consecutive repeats within the sliding window', () => {
    const d = new LoopDetector({ limit: 3, windowSize: 12 });
    const sig = callSignature('search', { q: 'x' });
    d.record('search', sig);
    d.record('search', sig);
    expect(d.tripped('search', sig)).toBe(false);
    d.record('search', sig);
    expect(d.tripped('search', sig)).toBe(true);
  });

  it('does NOT trip when repeats are far apart (sliding window)', () => {
    const d = new LoopDetector({ limit: 3, windowSize: 5 });
    const sigA = callSignature('search', { q: 'a' });
    const sigB = callSignature('search', { q: 'b' });

    // Two calls of sigA
    d.record('search', sigA);
    d.record('search', sigA);
    // Fill the window with other calls
    for (let i = 0; i < 5; i++) d.record('search', sigB);
    // sigA has fallen out of the window, so a new sigA should NOT trip
    d.record('search', sigA);
    expect(d.tripped('search', sigA)).toBe(false);
  });

  it('trips when repeats stay within the sliding window', () => {
    const d = new LoopDetector({ limit: 3, windowSize: 8 });
    const sigA = callSignature('search', { q: 'a' });
    const sigB = callSignature('search', { q: 'b' });

    d.record('search', sigA);
    d.record('search', sigA);
    d.record('search', sigB); // 1 other call
    d.record('search', sigA); // 3rd sigA, still within window size 8
    expect(d.tripped('search', sigA)).toBe(true);
  });

  it('respects per-tool limits', () => {
    const d = new LoopDetector({
      limit: 3,
      toolLimits: { search: 5, deploy: 1 },
    });
    // search tool: limit 5
    const searchSig = callSignature('search', { q: 'x' });
    d.record('search', searchSig);
    d.record('search', searchSig);
    d.record('search', searchSig);
    expect(d.tripped('search', searchSig)).toBe(false); // 3 < 5
    d.record('search', searchSig);
    d.record('search', searchSig);
    expect(d.tripped('search', searchSig)).toBe(true);  // 5 = limit

    // deploy tool: limit 1
    const d2 = new LoopDetector({
      limit: 3,
      toolLimits: { deploy: 1 },
    });
    const deploySig = callSignature('deploy', {});
    d2.record('deploy', deploySig);
    expect(d2.tripped('deploy', deploySig)).toBe(true); // 1 = limit
  });

  it('accepts a plain number for backward compat', () => {
    const d = new LoopDetector(4);
    const sig = callSignature('t', {});
    d.record('t', sig);
    d.record('t', sig);
    d.record('t', sig);
    expect(d.tripped('t', sig)).toBe(false);
    d.record('t', sig);
    expect(d.tripped('t', sig)).toBe(true);
  });

  it('resets correctly', () => {
    const d = new LoopDetector({ limit: 2 });
    const sig = callSignature('t', {});
    d.record('t', sig);
    d.record('t', sig);
    expect(d.tripped('t', sig)).toBe(true);
    d.reset();
    d.record('t', sig);
    expect(d.tripped('t', sig)).toBe(false);
  });

  it('produces the same signature regardless of key order', () => {
    expect(callSignature('x', { a: 1, b: 2 })).toBe(callSignature('x', { b: 2, a: 1 }));
  });
});

// ---------------------------------------------------------------------------
// LoopDetector — sequence detection (A→B→A→B cycles)
// ---------------------------------------------------------------------------
describe('LoopDetector — sequence detection', () => {
  it('detects a repeating 2-call sequence (A→B→A→B)', () => {
    const d = new LoopDetector({
      limit: 99,           // never trip on single-call repeats
      sequenceDetection: true,
      sequenceLengths: [2],
      sequenceLimit: 2,    // sequence must appear twice
      windowSize: 12,
    });
    const sigA = callSignature('search', { q: 'a' });
    const sigB = callSignature('grep', { pattern: 'b' });

    // First cycle: A→B (sequence appears once)
    d.record('search', sigA);
    d.record('grep', sigB);
    expect(d.tripped('grep', sigB)).toBe(false); // both individual + sequence check

    // Second cycle: A→B (sequence appears twice → tripped)
    d.record('search', sigA);
    d.record('grep', sigB);
    expect(d.tripped('grep', sigB)).toBe(true);
  });

  it('does not trip when different args break the sequence', () => {
    const d = new LoopDetector({
      limit: 99,
      sequenceDetection: true,
      sequenceLengths: [2],
      sequenceLimit: 2,
    });
    const sigA1 = callSignature('search', { q: 'a' });
    const sigB = callSignature('grep', { pattern: 'b' });
    const sigA2 = callSignature('search', { q: 'different' });

    d.record('search', sigA1);
    d.record('grep', sigB);
    d.record('search', sigA2); // different args → sequence not repeated
    d.record('grep', sigB);
    expect(d.tripped('grep', sigB)).toBe(false);
  });

  it('can disable sequence detection', () => {
    const d = new LoopDetector({
      limit: 99,
      sequenceDetection: false,
      windowSize: 12,
    });
    const sigA = callSignature('search', { q: 'a' });
    const sigB = callSignature('grep', { pattern: 'b' });
    // Cycle twice — should NOT trip with sequence detection off
    d.record('search', sigA);
    d.record('grep', sigB);
    d.record('search', sigA);
    d.record('grep', sigB);
    expect(d.tripped('grep', sigB)).toBe(false);
  });
});

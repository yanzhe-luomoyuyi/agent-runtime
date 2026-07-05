import { describe, expect, it } from 'vitest';

import { callSignature, LoopDetector } from '../src/recovery/loop-detector.js';
import { isTransientError, TransientError, withRetry } from '../src/recovery/retry.js';

const noSleep = () => Promise.resolve();

describe('withRetry', () => {
  it('retries transient failures then succeeds', async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new TransientError();
        return 'ok';
      },
      { retries: 3, sleep: noSleep },
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
        { retries: 2, sleep: noSleep },
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
        { retries: 5, sleep: noSleep },
      ),
    ).rejects.toThrow('bad request');
    expect(n).toBe(1);
  });

  it('classifies transient errors', () => {
    expect(isTransientError(new Error('HTTP 429 rate limit'))).toBe(true);
    expect(isTransientError(new Error('503 service unavailable'))).toBe(true);
    expect(isTransientError(new Error('Request timeout'))).toBe(true);
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientError(new Error('nonsense'))).toBe(false);
  });
});

describe('LoopDetector', () => {
  it('trips once the limit is reached', () => {
    const d = new LoopDetector(3);
    const sig = callSignature('x', { a: 1 });
    d.record(sig);
    d.record(sig);
    expect(d.tripped(sig)).toBe(false);
    d.record(sig);
    expect(d.tripped(sig)).toBe(true);
  });

  it('produces the same signature regardless of key order', () => {
    expect(callSignature('x', { a: 1, b: 2 })).toBe(callSignature('x', { b: 2, a: 1 }));
  });
});

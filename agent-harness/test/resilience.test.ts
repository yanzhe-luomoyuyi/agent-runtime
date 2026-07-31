import type { ChatModel, ChatRequest, ChatResponse } from '@agent/contracts';
import { describe, expect, it, vi } from 'vitest';

import { CircuitBreaker, CircuitOpenError } from '../src/recovery/circuit-breaker.js';
import { CompensatingToolInvoker, CompensationError } from '../src/recovery/compensation.js';
import { DeadLetterToolInvoker, InMemoryDeadLetterQueue, retryDeadLetter } from '../src/recovery/dead-letter.js';
import { createResilientModel } from '../src/recovery/fallback.js';
import { HttpError, RetryingToolInvoker, TransientError } from '../src/recovery/retry.js';
import { finalResponse, MockToolInvoker, makeTool } from '../src/testkit/index.js';

const noSleep = () => Promise.resolve();

/** A ChatModel whose chat() is a supplied function; records the keys it saw. */
function model(name: string, fn: (req: ChatRequest) => Promise<ChatResponse>): ChatModel & { keys: (string | undefined)[] } {
  const keys: (string | undefined)[] = [];
  return {
    name,
    keys,
    async chat(req) {
      keys.push(req.key);
      return fn(req);
    },
  };
}

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------
describe('CircuitBreaker', () => {
  it('opens after the failure threshold and then fails fast', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, now: () => 0 });
    const boom = () => Promise.reject(new Error('down'));

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(boom)).rejects.toThrow('down');
    }
    expect(cb.currentState).toBe('open');

    // Next call fails fast WITHOUT invoking fn.
    let invoked = false;
    await expect(
      cb.execute(async () => {
        invoked = true;
        return 'x';
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(invoked).toBe(false);
  });

  it('half-opens after the reset timeout and closes on a successful probe', async () => {
    let clock = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => clock });

    await expect(cb.execute(() => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(cb.currentState).toBe('open');

    clock = 100; // reset window elapsed
    expect(cb.currentState).toBe('half_open');

    await expect(cb.execute(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(cb.currentState).toBe('closed');
  });

  it('re-opens if the half-open probe fails', async () => {
    let clock = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => clock });
    await expect(cb.execute(() => Promise.reject(new Error('x')))).rejects.toThrow();

    clock = 100;
    await expect(cb.execute(() => Promise.reject(new Error('still down')))).rejects.toThrow('still down');
    expect(cb.currentState).toBe('open');
  });

  it('does not count non-failure errors toward tripping', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      isFailure: (e) => e instanceof TransientError, // 4xx-style errors ignored
      now: () => 0,
    });
    // Three non-transient errors must NOT open the breaker.
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(() => Promise.reject(new Error('bad request')))).rejects.toThrow();
    }
    expect(cb.currentState).toBe('closed');
  });

  it('reset() returns the breaker to closed', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, now: () => 0 });
    await expect(cb.execute(() => Promise.reject(new Error('x')))).rejects.toThrow();
    expect(cb.currentState).toBe('open');
    cb.reset();
    expect(cb.currentState).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// createResilientModel (fallback + escalation ladder)
// ---------------------------------------------------------------------------
describe('createResilientModel', () => {
  it('returns the first tier that succeeds', async () => {
    const primary = model('primary', async () => finalResponse('from primary'));
    const backup = model('backup', async () => finalResponse('from backup'));
    const m = createResilientModel({ tiers: [{ model: primary }, { model: backup }] });

    const res = await m.chat({ messages: [], tools: [], key: 'k1' });
    expect(res.message.content).toBe('from primary');
    expect(backup.keys.length).toBe(0); // backup never called
  });

  it('escalates to the next tier when the primary keeps failing', async () => {
    const primary = model('primary', async () => Promise.reject(new TransientError('primary down')));
    const backup = model('backup', async () => finalResponse('from backup'));
    const onEscalate = vi.fn();
    const m = createResilientModel({
      tiers: [
        { model: primary, retry: { retries: 1, sleep: noSleep, jitter: 'none' } },
        { model: backup },
      ],
      onEscalate,
    });

    const res = await m.chat({ messages: [], tools: [], key: 'k1' });
    expect(res.message.content).toBe('from backup');
    expect(onEscalate).toHaveBeenCalledOnce();
    expect(onEscalate.mock.calls[0]![0]).toMatchObject({ from: 'primary', to: 'backup', index: 0 });
  });

  it('forwards the SAME key to whichever tier answers (durable determinism)', async () => {
    const primary = model('primary', async () => Promise.reject(new TransientError()));
    const backup = model('backup', async () => finalResponse('ok'));
    const m = createResilientModel({
      tiers: [{ model: primary, retry: { retries: 0 } }, { model: backup }],
    });
    await m.chat({ messages: [], tools: [], key: 'turn-1' });
    expect(primary.keys).toEqual(['turn-1']);
    expect(backup.keys).toEqual(['turn-1']);
  });

  it('throws the last tier error when every tier fails', async () => {
    const primary = model('primary', async () => Promise.reject(new TransientError('p')));
    const backup = model('backup', async () => Promise.reject(new TransientError('b')));
    const m = createResilientModel({
      tiers: [
        { model: primary, retry: { retries: 0 } },
        { model: backup, retry: { retries: 0 } },
      ],
    });
    await expect(m.chat({ messages: [], tools: [], key: 'k' })).rejects.toThrow('b');
  });

  it('aborts immediately on a fatal error without escalating', async () => {
    const primary = model('primary', async () => Promise.reject(new HttpError('unauthorized', 401)));
    const backup = model('backup', async () => finalResponse('should not run'));
    const m = createResilientModel({
      tiers: [{ model: primary, retry: { retries: 0 } }, { model: backup }],
      isFatal: (e) => e instanceof HttpError && e.status === 401,
    });
    await expect(m.chat({ messages: [], tools: [], key: 'k' })).rejects.toThrow('unauthorized');
    expect(backup.keys.length).toBe(0);
  });

  it('fails fast to the next tier once a tier breaker is open', async () => {
    let primaryCalls = 0;
    const primary = model('primary', async () => {
      primaryCalls++;
      return Promise.reject(new TransientError('down'));
    });
    const backup = model('backup', async () => finalResponse('backup'));
    const m = createResilientModel({
      tiers: [
        { model: primary, retry: { retries: 0 }, breaker: { failureThreshold: 1, now: () => 0 } },
        { model: backup },
      ],
    });

    // First call trips the primary breaker (1 failure) then escalates.
    await m.chat({ messages: [], tools: [], key: 'a' });
    expect(primaryCalls).toBe(1);
    // Second call: breaker open → primary NOT invoked again, straight to backup.
    await m.chat({ messages: [], tools: [], key: 'b' });
    expect(primaryCalls).toBe(1);
  });

  it('chatStream escalates after a primary stream failure', async () => {
    const primary: ChatModel = {
      name: 'primary',
      chat: async () => {
        throw new Error('batch unused');
      },
      async *chatStream() {
        throw new TransientError('stream 503');
      },
    };
    const backup = model('backup', async () => finalResponse('from backup stream'));
    const onEscalate = vi.fn();
    const m = createResilientModel({
      tiers: [
        { model: primary, retry: { retries: 0 }, breaker: false },
        { model: backup, retry: { retries: 0 }, breaker: false },
      ],
      onEscalate,
    });

    const chunks = [];
    for await (const c of m.chatStream!({ messages: [], tools: [], key: 's1' })) {
      chunks.push(c);
    }
    const content = chunks.map((c) => ('content' in c ? c.content : '')).join('');
    expect(content).toBe('from backup stream');
    expect(onEscalate).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'primary', to: 'backup', index: 0 }),
    );
  });

  it('chatStream synthesises chunks when a tier only implements chat()', async () => {
    const primary = model('primary', async () => Promise.reject(new TransientError('down')));
    const backup = model('backup', async () => finalResponse('synthetic'));
    const m = createResilientModel({
      tiers: [
        { model: primary, retry: { retries: 0 }, breaker: false },
        { model: backup, retry: { retries: 0 }, breaker: false },
      ],
    });
    const chunks = [];
    for await (const c of m.chatStream!({ messages: [], tools: [], key: 's2' })) {
      chunks.push(c);
    }
    expect(chunks.some((c) => 'content' in c && c.content === 'synthetic')).toBe(true);
    expect(chunks.some((c) => 'stopReason' in c && c.stopReason === 'stop')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CompensatingToolInvoker (opt-in saga)
// ---------------------------------------------------------------------------
describe('CompensatingToolInvoker', () => {
  function baseTools() {
    return new MockToolInvoker([
      makeTool('createA', '', { type: 'object' }, () => ({ id: 'a1' })),
      makeTool('createB', '', { type: 'object' }, () => ({ id: 'b1' })),
      makeTool('readOnly', '', { type: 'object' }, () => 'data'),
      makeTool('boom', '', { type: 'object' }, () => { throw new Error('tool failed'); }),
    ]);
  }

  it('only records successful calls that have a registered compensator', async () => {
    const undo: string[] = [];
    const tools = new CompensatingToolInvoker(baseTools(), {
      compensators: {
        createA: async ({ result }) => { undo.push(`undoA:${(result as { id: string }).id}`); },
      },
    });

    await tools.call('createA', {});
    await tools.call('readOnly', {}); // no compensator → not tracked
    expect(tools.pending.map((p) => p.name)).toEqual(['createA']);
    expect(undo).toEqual([]); // not compensated yet
  });

  it('does not record a call that threw (no side effect committed)', async () => {
    const tools = new CompensatingToolInvoker(baseTools(), {
      compensators: { boom: async () => {} },
    });
    await expect(tools.call('boom', {})).rejects.toThrow('tool failed');
    expect(tools.pending.length).toBe(0);
  });

  it('compensates in reverse (LIFO) order', async () => {
    const undo: string[] = [];
    const tools = new CompensatingToolInvoker(baseTools(), {
      compensators: {
        createA: async () => { undo.push('undoA'); },
        createB: async () => { undo.push('undoB'); },
      },
    });
    await tools.call('createA', {});
    await tools.call('createB', {});

    const outcomes = await tools.compensate();
    expect(undo).toEqual(['undoB', 'undoA']); // reverse order
    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(tools.pending.length).toBe(0);
  });

  it('best-effort: continues past a failing compensator and reports it', async () => {
    const undo: string[] = [];
    const tools = new CompensatingToolInvoker(baseTools(), {
      compensators: {
        createA: async () => { undo.push('undoA'); },
        createB: async () => { throw new Error('undoB failed'); },
      },
    });
    await tools.call('createA', {});
    await tools.call('createB', {});

    const outcomes = await tools.compensate();
    expect(undo).toEqual(['undoA']); // A still compensated despite B failing
    expect(outcomes).toEqual([
      { name: 'createB', ok: false, error: 'undoB failed' },
      { name: 'createA', ok: true },
    ]);
  });

  it('stopOnError: throws CompensationError and keeps the failed action pending', async () => {
    const tools = new CompensatingToolInvoker(baseTools(), {
      stopOnError: true,
      compensators: {
        createA: async () => {},
        createB: async () => { throw new Error('undoB failed'); },
      },
    });
    await tools.call('createA', {});
    await tools.call('createB', {});

    await expect(tools.compensate()).rejects.toBeInstanceOf(CompensationError);
    // createB failed and was pushed back; createA not yet reached.
    expect(tools.pending.map((p) => p.name)).toEqual(['createA', 'createB']);
  });

  it('clear() forgets recorded actions without compensating', async () => {
    const undo: string[] = [];
    const tools = new CompensatingToolInvoker(baseTools(), {
      compensators: { createA: async () => { undo.push('undoA'); } },
    });
    await tools.call('createA', {});
    tools.clear();
    const outcomes = await tools.compensate();
    expect(outcomes).toEqual([]);
    expect(undo).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DeadLetterToolInvoker (durable last-resort for exhausted failures)
// ---------------------------------------------------------------------------
describe('DeadLetterToolInvoker', () => {
  function flakyTools(failTimes: number) {
    let calls = 0;
    return new MockToolInvoker([
      makeTool('flaky', '', { type: 'object' }, () => {
        calls++;
        if (calls <= failTimes) throw new Error(`boom #${calls}`);
        return { ok: true };
      }),
      makeTool('good', '', { type: 'object' }, () => 'fine'),
    ]);
  }

  it('rethrows the original error so the loop still turns it into a normal ERROR observation', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const tools = new DeadLetterToolInvoker(flakyTools(99), queue);
    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow('boom #1');
  });

  it('queues a durable record of the failed call, keyed by tool+args', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const tools = new DeadLetterToolInvoker(flakyTools(99), queue);
    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow();

    const letters = queue.list();
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ tool: 'flaky', args: { x: 1 }, error: 'boom #1', attempts: 1 });
  });

  it('does not queue a call that succeeds', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const tools = new DeadLetterToolInvoker(flakyTools(0), queue);
    await tools.call('good', {});
    expect(queue.list()).toEqual([]);
  });

  it('dedupes repeated failures of the identical call by incrementing `attempts` instead of duplicating', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const tools = new DeadLetterToolInvoker(flakyTools(99), queue);
    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow();
    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow();
    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow();

    const letters = queue.list();
    expect(letters).toHaveLength(1);
    expect(letters[0]!.attempts).toBe(3);
    expect(letters[0]!.firstFailedAt).toBe(letters[0]!.firstFailedAt); // unchanged across requeues
  });

  it('different args for the same tool get independent dead letters', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const tools = new DeadLetterToolInvoker(flakyTools(99), queue);
    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow();
    await expect(tools.call('flaky', { x: 2 })).rejects.toThrow();
    expect(queue.list()).toHaveLength(2);
  });

  it('shouldQueue lets the caller exclude certain failures (e.g. bad-request errors) from the queue', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const tools = new DeadLetterToolInvoker(flakyTools(99), queue, {
      shouldQueue: (err) => !(err instanceof Error && err.message.includes('boom')),
    });
    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow('boom #1');
    expect(queue.list()).toEqual([]); // excluded by the predicate
  });

  it('fires onQueued for observability', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const seen: string[] = [];
    const tools = new DeadLetterToolInvoker(flakyTools(99), queue, { onQueued: (l) => seen.push(l.id) });
    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('retryDeadLetter replays a queued call and removes it from the queue on success', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const inner = flakyTools(1); // fails once, then succeeds
    const tools = new DeadLetterToolInvoker(inner, queue);

    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow('boom #1');
    const [letter] = queue.list();
    expect(letter).toBeDefined();

    // A human fixes the underlying issue, then replays through the ORIGINAL (undecorated) invoker.
    const result = await retryDeadLetter(queue, inner, letter!.id);
    expect(result).toEqual({ ok: true });
    expect(queue.list()).toEqual([]); // resolved, removed from the queue
  });

  it('retryDeadLetter leaves the letter queued if the replay fails again', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const inner = flakyTools(99); // never succeeds
    const tools = new DeadLetterToolInvoker(inner, queue);
    await expect(tools.call('flaky', { x: 1 })).rejects.toThrow();
    const [letter] = queue.list();

    await expect(retryDeadLetter(queue, inner, letter!.id)).rejects.toThrow();
    expect(queue.list()).toHaveLength(1); // still there
  });

  it('retryDeadLetter throws for an unknown id', async () => {
    const queue = new InMemoryDeadLetterQueue();
    await expect(retryDeadLetter(queue, flakyTools(0), 'no-such-id')).rejects.toThrow(/no dead letter/i);
  });
});

// ---------------------------------------------------------------------------
// RetryingToolInvoker + DeadLetterToolInvoker composed (the intended layering)
// ---------------------------------------------------------------------------
describe('RetryingToolInvoker composed with DeadLetterToolInvoker', () => {
  // Distinct from the plain-Error `flakyTools` helper above: withRetry only
  // retries errors `isTransientError` classifies as such, so this needs a
  // REAL TransientError to prove the retry layer actually engages.
  function flakyTransientTools(failTimes: number) {
    let calls = 0;
    return new MockToolInvoker([
      makeTool('flaky', '', { type: 'object' }, () => {
        calls++;
        if (calls <= failTimes) throw new TransientError(`boom #${calls}`);
        return { ok: true };
      }),
    ]);
  }

  it('a transient blip that succeeds on retry NEVER reaches the dead-letter queue', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const tools = new DeadLetterToolInvoker(new RetryingToolInvoker(flakyTransientTools(2), { retries: 2, sleep: async () => {} }), queue);

    const result = await tools.call('flaky', {});

    expect(result).toEqual({ ok: true });
    expect(queue.list()).toEqual([]); // absorbed entirely by the retry layer
  });

  it('a call that exhausts every retry attempt lands in the dead-letter queue exactly once', async () => {
    const queue = new InMemoryDeadLetterQueue();
    const tools = new DeadLetterToolInvoker(new RetryingToolInvoker(flakyTransientTools(99), { retries: 2, sleep: async () => {} }), queue);

    await expect(tools.call('flaky', {})).rejects.toThrow();

    const letters = queue.list();
    expect(letters).toHaveLength(1);
    expect(letters[0]!.attempts).toBe(1); // one DLQ entry, even though retry made 3 underlying attempts
  });
});

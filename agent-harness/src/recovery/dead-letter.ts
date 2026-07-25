/**
 * B: dead-letter queue — durable last-resort for calls that exhausted every
 * automated recovery path (retry backoff, circuit breaker, model fallback).
 *
 * `withRetry` / `CircuitBreaker` / `createResilientModel` all answer "how do we
 * keep trying". None of them answer "what happens when we stop trying" — today
 * that's just an `ERROR: ...` observation fed back to the model (correct for
 * the loop's "errors → observations → self-heal" philosophy), and the failure
 * is then gone forever. For a tool call with a real-world side effect that
 * still needs to happen (send the invoice, provision the resource, page
 * on-call), silently giving up is not good enough — a human needs a durable,
 * inspectable record to triage and, once the underlying issue is fixed, replay.
 *
 * `DeadLetterToolInvoker` is a `ToolInvoker` DECORATOR (same pattern as
 * `CompensatingToolInvoker` in compensation.ts): wrap the tool invoker a host
 * already has, and every call that still fails after reaching this wrapper is
 * recorded here AND rethrown — queuing is a side channel for human triage, not
 * a replacement for the loop's existing error-handling contract.
 *
 * Compose OUTSIDE `retry.ts`'s `RetryingToolInvoker` (and any circuit-breaker
 * wrapper), so only a call that has already exhausted every retry attempt gets
 * queued — a lone transient blip is absorbed by the retry layer and never
 * reaches the dead-letter queue at all:
 *
 *   const tools = new DeadLetterToolInvoker(
 *     new RetryingToolInvoker(baseTools, { retries: 2 }),
 *     queue,
 *   );
 *
 * This module only defines the host-agnostic primitive (`DeadLetterQueue`
 * interface + an in-memory default). A durable, disk-backed implementation
 * (matching this same interface) belongs in the host — see
 * `durable-agent-runtime`'s `FileDeadLetterQueue`.
 */

import type { CallOptions, ToolInvoker, ToolSpec } from '@agent/contracts';

/** One durably-recorded failed call, queued for human triage. */
export interface DeadLetter<TArgs = unknown> {
  /** Content-addressed from tool + args, so repeated failures of the SAME call upsert (increment `attempts`) rather than duplicate. */
  id: string;
  tool: string;
  args: TArgs;
  error: string;
  /** How many times this exact tool+args call has landed in the queue. */
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  /** The durable call key in flight when the failure happened, if any (see loop.ts's `t{turn}:{callId}`). */
  key?: string;
}

/** The persistence seam. Implementations may be in-memory (tests, non-durable hosts) or disk/DB-backed. */
export interface DeadLetterQueue<TArgs = unknown> {
  push(letter: DeadLetter<TArgs>): void | Promise<void>;
  get(id: string): DeadLetter<TArgs> | undefined;
  list(): DeadLetter<TArgs>[];
  /** Remove a letter — e.g. after a human resolves or manually replays it. Returns true if one was removed. */
  remove(id: string): boolean;
}

/** Non-persistent queue — for tests and plain (non-durable) hosts. */
export class InMemoryDeadLetterQueue<TArgs = unknown> implements DeadLetterQueue<TArgs> {
  private readonly letters = new Map<string, DeadLetter<TArgs>>();

  push(letter: DeadLetter<TArgs>): void {
    this.letters.set(letter.id, letter);
  }
  get(id: string): DeadLetter<TArgs> | undefined {
    return this.letters.get(id);
  }
  list(): DeadLetter<TArgs>[] {
    return [...this.letters.values()];
  }
  remove(id: string): boolean {
    return this.letters.delete(id);
  }
}

/** FNV-1a — a tiny deterministic string hash (zero-dep), same technique used for content-addressed ids elsewhere in this codebase. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Deterministic id for a (tool, args) pair, so repeated failures of the same call dedupe instead of piling up. */
export function deadLetterId(tool: string, args: unknown): string {
  return `dlq-${fnv1a(`${tool}:${JSON.stringify(args)}`)}`;
}

export interface DeadLetterOptions {
  /** Only queue failures matching this predicate. Default: queue every failure that reaches this wrapper. */
  shouldQueue?: (err: unknown, tool: string, args: unknown) => boolean;
  /** Clock seam (ISO timestamp). Default `() => new Date().toISOString()`. */
  now?: () => string;
  /** Observability hook fired whenever a call is queued (or re-queued with an incremented `attempts`). */
  onQueued?: (letter: DeadLetter) => void;
}

/**
 * Wrap a `ToolInvoker` so calls that still fail after reaching this layer are
 * durably recorded in `queue` before the error is rethrown to the caller (the
 * loop's existing try/catch still turns it into a normal ERROR observation —
 * see `_execOne` in control/loop.ts). Compose OUTSIDE any retry/circuit-breaker
 * wrapper so only truly exhausted failures are queued, not every transient blip.
 */
export class DeadLetterToolInvoker implements ToolInvoker {
  constructor(
    private readonly inner: ToolInvoker,
    private readonly queue: DeadLetterQueue,
    private readonly opts: DeadLetterOptions = {},
  ) {}

  list(): ToolSpec[] {
    return this.inner.list();
  }

  async call(name: string, args: unknown, callOpts?: CallOptions): Promise<unknown> {
    try {
      return await this.inner.call(name, args, callOpts);
    } catch (e) {
      if (this.opts.shouldQueue && !this.opts.shouldQueue(e, name, args)) throw e;

      const id = deadLetterId(name, args);
      const nowIso = this.opts.now?.() ?? new Date().toISOString();
      const prior = this.queue.get(id);
      const letter: DeadLetter = {
        id,
        tool: name,
        args,
        error: e instanceof Error ? e.message : String(e),
        attempts: (prior?.attempts ?? 0) + 1,
        firstFailedAt: prior?.firstFailedAt ?? nowIso,
        lastFailedAt: nowIso,
        key: callOpts?.key,
      };
      await this.queue.push(letter);
      this.opts.onQueued?.(letter);
      throw e;
    }
  }
}

/**
 * Human-triage replay: re-run a queued call through `invoker` and remove it
 * from `queue` on success. On failure the letter is left in place (its
 * `attempts`/`lastFailedAt` are NOT bumped here — that only happens when the
 * call reaches a `DeadLetterToolInvoker` again through the normal path).
 */
export async function retryDeadLetter(queue: DeadLetterQueue, invoker: ToolInvoker, id: string): Promise<unknown> {
  const letter = queue.get(id);
  if (!letter) throw new Error(`No dead letter with id "${id}"`);
  const result = await invoker.call(letter.tool, letter.args, letter.key ? { key: letter.key } : undefined);
  queue.remove(id);
  return result;
}

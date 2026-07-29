/**
 * B: dead-letter queue — durable last-resort for calls that exhausted every
 * automated recovery path (retry backoff, circuit breaker, model fallback).
 *
 * Queue types + `deadLetterId` live in `@agent/contracts` so the durable runtime
 * funnel can share the same letter shape without importing this package.
 * This module keeps the `ToolInvoker` decorator and human-replay helper.
 *
 * Compose OUTSIDE `retry.ts`'s `RetryingToolInvoker` (and any circuit-breaker
 * wrapper), so only a call that has already exhausted every retry attempt gets
 * queued:
 *
 *   const tools = new DeadLetterToolInvoker(
 *     new RetryingToolInvoker(baseTools, { retries: 2 }),
 *     queue,
 *   );
 */

import {
  deadLetterId,
  type CallOptions,
  type DeadLetter,
  type DeadLetterQueue,
  type ToolInvoker,
  type ToolSpec,
} from '@agent/contracts';

export type { DeadLetter, DeadLetterQueue } from '@agent/contracts';
export { InMemoryDeadLetterQueue, deadLetterId } from '@agent/contracts';

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
 * durably recorded in `queue` before the error is rethrown to the caller.
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
 * from `queue` on success.
 */
export async function retryDeadLetter(queue: DeadLetterQueue, invoker: ToolInvoker, id: string): Promise<unknown> {
  const letter = queue.get(id);
  if (!letter) throw new Error(`No dead letter with id "${id}"`);
  const result = await invoker.call(letter.tool, letter.args, letter.key ? { key: letter.key } : undefined);
  queue.remove(id);
  return result;
}

/**
 * B: compensation / saga — opt-in rollback for tools with real side effects.
 *
 * ## Why this lives OUTSIDE the loop
 *
 * The harness's default failure philosophy is "a tool error becomes an
 * observation and the model recovers on its own". That is the right behaviour
 * for read/search tools and most APIs. But some tools have side effects that
 * cannot be reasoned away — creating a resource, charging a card, deploying.
 * When a run ultimately fails, those completed side effects should be UNDONE.
 *
 * That is the saga pattern, and it is deliberately NOT baked into `runAgent`:
 * baking automatic rollback into the loop would clash with the "errors →
 * observations → self-heal" model and force every host to understand
 * business-level undo semantics. Instead this is a `ToolInvoker` DECORATOR:
 *
 *   const tools = new CompensatingToolInvoker(baseTools, {
 *     compensators: {
 *       createResource: ({ result }) => baseTools.call('deleteResource', { id: (result as any).id }),
 *     },
 *   });
 *   const res = await runAgent({ tools, ... });
 *   if (!res.finished) await tools.compensate();   // caller decides when to unwind
 *
 * The core loop never changes; only tools you explicitly wrap participate, and
 * only calls that (a) succeed and (b) have a registered compensator are tracked.
 */

import type { CallOptions, ToolInvoker, ToolSpec } from '@agent/contracts';

/** Context passed to a compensator when unwinding a completed call. */
export interface CompensationContext {
  /** The tool that was executed. */
  name: string;
  /** The arguments it was called with (post-approval, effective args). */
  args: unknown;
  /** Whatever the tool returned — typically holds the id needed to undo it. */
  result: unknown;
  /** The deterministic key the call ran under, if any. */
  key?: string;
}

/** A function that reverses one completed side effect. May throw. */
export type Compensator = (ctx: CompensationContext) => Promise<void>;

/** Outcome of attempting to compensate one recorded action. */
export interface CompensationOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

export interface CompensatingToolInvokerOptions {
  /** Map of tool name → compensator. Only these tools are tracked. */
  compensators: Record<string, Compensator>;
  /**
   * If true, `compensate()` stops at the first compensator that throws and
   * rethrows. Default false — best-effort: try to unwind everything, collect
   * errors, and report them.
   */
  stopOnError?: boolean;
  /** Observability hook fired for each compensation attempt. */
  onCompensate?(outcome: CompensationOutcome): void;
}

/** One tracked, compensable side effect awaiting possible rollback. */
interface Recorded {
  ctx: CompensationContext;
  compensate: Compensator;
}

/**
 * Wraps any `ToolInvoker`, transparently recording successful side-effecting
 * calls that have a registered compensator so they can be unwound later (LIFO).
 */
export class CompensatingToolInvoker implements ToolInvoker {
  private readonly stack: Recorded[] = [];

  constructor(
    private readonly inner: ToolInvoker,
    private readonly opts: CompensatingToolInvokerOptions,
  ) {}

  list(): ToolSpec[] {
    return this.inner.list();
  }

  async call(name: string, args: unknown, opts?: CallOptions): Promise<unknown> {
    // Delegate first — if the tool throws, nothing was committed, so we record
    // nothing (there is no side effect to undo).
    const result = await this.inner.call(name, args, opts);

    const compensate = this.opts.compensators[name];
    if (compensate) {
      this.stack.push({
        ctx: { name, args, result, key: opts?.key },
        compensate,
      });
    }
    return result;
  }

  /** Recorded-but-not-yet-compensated actions, oldest → newest. */
  get pending(): readonly CompensationContext[] {
    return this.stack.map((r) => r.ctx);
  }

  /**
   * Undo all recorded side effects in reverse order (LIFO). Each successfully
   * compensated action is removed from the stack; on best-effort mode, actions
   * that fail to compensate are also removed (they will not be retried) but
   * reported in the returned outcomes. Returns one outcome per attempted action.
   */
  async compensate(): Promise<CompensationOutcome[]> {
    const outcomes: CompensationOutcome[] = [];

    while (this.stack.length > 0) {
      const rec = this.stack.pop()!;
      try {
        await rec.compensate(rec.ctx);
        const outcome: CompensationOutcome = { name: rec.ctx.name, ok: true };
        outcomes.push(outcome);
        this.opts.onCompensate?.(outcome);
      } catch (err) {
        const outcome: CompensationOutcome = {
          name: rec.ctx.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        outcomes.push(outcome);
        this.opts.onCompensate?.(outcome);
        if (this.opts.stopOnError) {
          // Put the failed action back so the caller can inspect/retry it.
          this.stack.push(rec);
          throw new CompensationError(outcomes);
        }
      }
    }
    return outcomes;
  }

  /** Forget all recorded actions without compensating (e.g. on a successful run). */
  clear(): void {
    this.stack.length = 0;
  }
}

/** Raised by `compensate()` in `stopOnError` mode when an unwind step fails. */
export class CompensationError extends Error {
  constructor(readonly outcomes: CompensationOutcome[]) {
    const failed = outcomes.find((o) => !o.ok);
    super(`Compensation failed at "${failed?.name}": ${failed?.error}`);
    this.name = 'CompensationError';
  }
}

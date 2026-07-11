/**
 * B: resilient model — fallback + escalation ladder for the model seam.
 *
 * A single provider can be rate-limited, overloaded, or down. `createResilientModel`
 * wraps an ORDERED list of model tiers and tries them in order until one
 * succeeds. Each tier owns its own resilience:
 *
 *   tier = withRetry( circuitBreaker( model.chat ) )
 *
 * so a tier first retries its own transient blips (backoff+jitter), its breaker
 * fails fast once the provider is clearly unhealthy, and only THEN does control
 * escalate to the next tier. This is the "escalation ladder" (retry → degrade
 * model → …) expressed as a plain `ChatModel`, so it drops straight into
 * `runAgent({ model })` with ZERO loop changes.
 *
 * The last tier can be anything that implements `ChatModel` — including a
 * human-backed model for a true HITL fallback — but that is the caller's choice,
 * not a special mechanism here.
 *
 * ## Determinism / durable replay
 *
 * The resilient model forwards the SAME `key` to whichever tier ends up
 * answering, and returns that tier's response as its own. A durable host records
 * exactly one result under that key, so a replayed run reuses it regardless of
 * which tier originally produced it — determinism is preserved.
 *
 * ## Retry layering note
 *
 * Because each tier already retries, callers using a resilient model should
 * generally pass `retry: { retries: 0 }` at the `runAgent` level (or a thin
 * safety net) to avoid multiplying retries: loop-retry × tier-retry.
 */

import type { ChatModel, ChatRequest, ChatResponse } from '@agent/contracts';

import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import { isTransientError, withRetry, type RetryOptions } from './retry.js';

/** One rung of the escalation ladder. */
export interface ModelTier {
  /** The model to try at this tier. */
  model: ChatModel;
  /**
   * Per-tier retry policy for transient blips before escalating. Default: the
   * standard `withRetry` behaviour. Pass `{ retries: 0 }` to disable retry and
   * escalate immediately.
   */
  retry?: RetryOptions;
  /**
   * Per-tier circuit breaker. Pass options to configure, an existing
   * `CircuitBreaker` to share one, or omit for a fresh breaker with defaults.
   * Pass `false` to disable the breaker for this tier.
   */
  breaker?: CircuitBreaker | CircuitBreakerOptions | false;
}

export interface ResilientModelOptions {
  /** Ordered tiers, tried first → last. Must contain at least one. */
  tiers: ModelTier[];
  /**
   * Fired when one tier is exhausted and control escalates to the next.
   * Useful for logging degraded-mode operation.
   */
  onEscalate?(info: { from: string; to: string; index: number; error: unknown }): void;
  /**
   * Errors for which escalation is pointless and should abort immediately
   * (e.g. auth failures — every tier of the same provider family would reject
   * identically). Default: never fatal (always escalate). A non-transient error
   * still escalates by default, because a *different* provider may accept it.
   */
  isFatal?(err: unknown): boolean;
  /** Display name. Default derived from the tier model names. */
  name?: string;
}

/**
 * Build a `ChatModel` that tries each tier in order, escalating on failure.
 * Throws the LAST tier's error if every tier fails.
 */
export function createResilientModel(opts: ResilientModelOptions): ChatModel {
  if (opts.tiers.length === 0) {
    throw new Error('createResilientModel: at least one tier is required');
  }

  // Resolve each tier's breaker once (so shared/omitted breakers keep state).
  const resolved = opts.tiers.map((tier) => ({
    model: tier.model,
    retry: tier.retry,
    breaker: resolveBreaker(tier.breaker),
  }));

  const name = opts.name ?? `resilient(${resolved.map((t) => t.model.name).join('→')})`;

  return {
    name,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      let lastErr: unknown;

      for (let i = 0; i < resolved.length; i++) {
        const tier = resolved[i]!;
        const run = () => withRetry(() => tier.model.chat(req), tier.retry ?? {});

        try {
          return tier.breaker ? await tier.breaker.execute(run) : await run();
        } catch (err) {
          lastErr = err;
          const isLast = i === resolved.length - 1;
          if (isLast || opts.isFatal?.(err)) throw err;
          opts.onEscalate?.({
            from: tier.model.name,
            to: resolved[i + 1]!.model.name,
            index: i,
            error: err,
          });
        }
      }

      // Unreachable (the last-tier branch always throws), but satisfies the type.
      throw lastErr;
    },
  };
}

/** A breaker whose failures ignore non-transient (e.g. 4xx) errors — they mean
 * "bad request", not "service down", so they should not trip the circuit. */
export function transientOnlyBreaker(opts: CircuitBreakerOptions = {}): CircuitBreaker {
  return new CircuitBreaker({ isFailure: isTransientError, ...opts });
}

function resolveBreaker(
  spec: CircuitBreaker | CircuitBreakerOptions | false | undefined,
): CircuitBreaker | undefined {
  if (spec === false) return undefined;
  if (spec instanceof CircuitBreaker) return spec;
  // Default: a breaker that only counts transient failures, so a stream of bad
  // requests doesn't wrongly open the circuit against a healthy provider.
  return transientOnlyBreaker(spec ?? {});
}

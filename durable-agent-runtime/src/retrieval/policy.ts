/**
 * Resolve retrieval policy defaults and track per-run retrieve budgets.
 *
 * Defaults bias toward predictable cost: `once` + `maxExtra: 0`. Agentic
 * multi-hop is available only when the product opts into `capped_agentic`.
 */

import type { ResolvedRetrievalPolicy, RetrievalPolicy, RetrievalStrategyMode } from './types.js';

/** Fill defaults. `once_rewrite` currently behaves like `once` (rewrite not implemented). */
export function resolveRetrievalPolicy(policy: RetrievalPolicy = {}): ResolvedRetrievalPolicy {
  const mode: RetrievalStrategyMode = policy.mode ?? 'once';
  const maxExtra = policy.maxExtra ?? (mode === 'capped_agentic' ? 2 : 0);
  const defaultMaxRetrieves = mode === 'off' ? 0 : 1 + maxExtra;

  return {
    mode,
    maxRetrieves: policy.maxRetrieves ?? defaultMaxRetrieves,
    maxExtra,
    minScore: policy.minScore ?? 0,
    maxChunks: policy.maxChunks ?? 5,
    maxInjectedChars: policy.maxInjectedChars ?? 8000,
    corpora: policy.corpora,
    rankMode: policy.rankMode ?? 'lexical',
  };
}

/** Whether the strategy performs a system-initiated retrieve before the loop. */
export function wantsSystemRetrieve(policy: ResolvedRetrievalPolicy): boolean {
  return policy.mode === 'once' || policy.mode === 'once_rewrite' || policy.mode === 'capped_agentic';
}

/** Whether the model may see / call document search tools. */
export function exposeRetrievalToolsToModel(policy: ResolvedRetrievalPolicy): boolean {
  return policy.mode === 'capped_agentic' && policy.maxExtra > 0;
}

/** Mutable counter for enforce-maxRetrieves (system + optional agentic). */
export class RetrievalBudget {
  private used = 0;

  constructor(private readonly maxRetrieves: number) {}

  get retrievesUsed(): number {
    return this.used;
  }

  /** Reserve one retrieve slot. Returns false when the budget is exhausted. */
  tryConsume(): boolean {
    if (this.used >= this.maxRetrieves) return false;
    this.used += 1;
    return true;
  }
}

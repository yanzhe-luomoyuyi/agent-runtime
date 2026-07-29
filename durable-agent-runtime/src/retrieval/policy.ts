/**
 * Resolve retrieval policy defaults and track per-run retrieve budgets.
 *
 * Defaults bias toward predictable cost: `once` + `maxExtra: 0`. Agentic
 * multi-hop is available only when the product opts into `capped_agentic`:
 * system may still retrieve once, then the model may call `document_search`
 * up to `maxExtra` more times (hard-capped by `maxRetrieves`).
 */

import type { RunState } from '../types.js';
import type { ResolvedRetrievalPolicy, RetrievalPolicy, RetrievalStrategyMode } from './types.js';

/** Fill defaults. `once_rewrite` uses one retrieve after a keyed query rewrite. */
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

/**
 * Count completed `document_search` results already in derived state.
 * Used so resume does not reset the retrieve budget (replayed calls stay counted).
 * callId shape: `<phase>.<step>:<optional key:>document_search`
 */
export function countDocumentSearchesInState(state: RunState, toolName = 'document_search'): number {
  let n = 0;
  for (const callId of Object.keys(state.toolResults)) {
    if (callId === toolName || callId.endsWith(`:${toolName}`)) n += 1;
  }
  return n;
}

/** Mutable counter for non-durable / direct-retriever paths (no event log). */
export class RetrievalBudget {
  private used = 0;

  constructor(private readonly maxRetrieves: number) {}

  get retrievesUsed(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.maxRetrieves - this.used);
  }

  /** Seed used count (e.g. from already-logged searches on resume). */
  seedUsed(n: number): void {
    this.used = Math.max(0, Math.min(this.maxRetrieves, Math.floor(n)));
  }

  /** Reserve one retrieve slot. Returns false when the budget is exhausted. */
  tryConsume(): boolean {
    if (this.used >= this.maxRetrieves) return false;
    this.used += 1;
    return true;
  }
}

/** Error string returned to the model when agentic search exceeds the hard cap. */
export function documentSearchBudgetExhaustedMessage(used: number, max: number): string {
  return (
    `ERROR: document_search budget exhausted (${used}/${max} retrieves used this run). ` +
    `Do not search again; answer with the evidence you already have.`
  );
}

/**
 * If `document_search` budget is exhausted, return the model-facing error string;
 * otherwise `undefined`. Callers skip this check on replayed tool results.
 */
export function checkDocumentSearchBudget(
  state: RunState,
  max: number,
  toolName = 'document_search',
): string | undefined {
  const used = countDocumentSearchesInState(state, toolName);
  if (used >= max) return documentSearchBudgetExhaustedMessage(used, max);
  return undefined;
}

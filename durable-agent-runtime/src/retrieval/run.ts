/**
 * System-initiated retrieve — the default `once` path for a general engine.
 *
 * Prefer going through `ctx.callTool('document_search', …)` when the tool is
 * registered so the read is event-logged and replay-safe. This module covers the
 * direct Retriever path (unit tests / hosts without a tool registry).
 */

import {
  resolveRetrievalPolicy,
  RetrievalBudget,
  wantsSystemRetrieve,
} from './policy.js';
import type { Retriever } from './retriever.js';
import type { RetrievalHit, RetrievalPolicy, ResolvedRetrievalPolicy } from './types.js';

export interface SystemRetrieveOptions {
  retriever: Retriever;
  policy?: RetrievalPolicy;
  query: string;
  corpusId: string;
  /** Optional shared budget (e.g. when agentic calls share the same counter). */
  budget?: RetrievalBudget;
}

export interface SystemRetrieveResult {
  hits: RetrievalHit[];
  policy: ResolvedRetrievalPolicy;
  retrievesUsed: number;
  /** True when a retrieve was attempted (budget permitting). */
  retrieved: boolean;
  skippedReason?: 'off' | 'corpus_denied' | 'budget_exhausted';
}

/** Run at most one system retrieve under the resolved policy. */
export async function systemRetrieveOnce(opts: SystemRetrieveOptions): Promise<SystemRetrieveResult> {
  const policy = resolveRetrievalPolicy(opts.policy);
  if (!wantsSystemRetrieve(policy)) {
    return { hits: [], policy, retrievesUsed: 0, retrieved: false, skippedReason: 'off' };
  }
  if (policy.corpora && !policy.corpora.includes(opts.corpusId)) {
    return { hits: [], policy, retrievesUsed: 0, retrieved: false, skippedReason: 'corpus_denied' };
  }

  const budget = opts.budget ?? new RetrievalBudget(policy.maxRetrieves);
  if (!budget.tryConsume()) {
    return {
      hits: [],
      policy,
      retrievesUsed: budget.retrievesUsed,
      retrieved: false,
      skippedReason: 'budget_exhausted',
    };
  }

  const hits = await opts.retriever.search({
    corpusId: opts.corpusId,
    query: opts.query,
    limit: policy.maxChunks,
    mode: policy.rankMode,
  });

  return { hits, policy, retrievesUsed: budget.retrievesUsed, retrieved: true };
}

export {
  countDocumentSearchesInState,
  documentSearchBudgetExhaustedMessage,
  exposeRetrievalToolsToModel,
  resolveRetrievalPolicy,
  RetrievalBudget,
  wantsSystemRetrieve,
} from './policy.js';

/**
 * Retrieval policy + request types — the strategy face of document RAG.
 *
 * Default stance for a general engine: `once` (system-initiated single retrieve).
 * `once_rewrite`: keyed model rewrite of the goal, then a single retrieve.
 * `capped_agentic` is opt-in multi-hop with a hard retrieve cap.
 */

/** How retrieval is triggered for a run. */
export type RetrievalStrategyMode = 'off' | 'once' | 'once_rewrite' | 'capped_agentic';

/** Ranking backend for a single search. */
export type RetrievalRankMode = 'lexical' | 'semantic' | 'hybrid';

/**
 * Declarative knobs a product wires onto the engine.
 * Unset fields resolve to engine defaults (see `resolveRetrievalPolicy`).
 *
 * `capped_agentic`: system may retrieve once, then the model may call
 * `document_search` until `maxRetrieves` (default `1 + maxExtra`) is hit;
 * further searches return a budget ERROR without executing.
 * `once_rewrite`: rewrite the goal via keyed callModel, then one search.
 */
export interface RetrievalPolicy {
  /** Default `once` when a retriever/tools are configured. */
  mode?: RetrievalStrategyMode;
  /** Hard cap on total retrieves in the run (system + model). */
  maxRetrieves?: number;
  /** Extra model-initiated retrieves beyond the system pass. Default 0. */
  maxExtra?: number;
  /** Minimum hit score to inject / return. Default 0. */
  minScore?: number;
  /** Max chunks from one search. Default 5. */
  maxChunks?: number;
  /** Soft char budget for injected context. Default 8000. */
  maxInjectedChars?: number;
  /** Allow-list of corpus ids for this run. When set, others are refused. */
  corpora?: string[];
  /** Default ranking mode. Default `lexical`. */
  rankMode?: RetrievalRankMode;
}

/** Fully resolved policy with concrete numbers. */
export interface ResolvedRetrievalPolicy {
  mode: RetrievalStrategyMode;
  maxRetrieves: number;
  maxExtra: number;
  minScore: number;
  maxChunks: number;
  maxInjectedChars: number;
  corpora: string[] | undefined;
  rankMode: RetrievalRankMode;
}

/** One search request against a corpus. */
export interface RetrievalRequest {
  corpusId: string;
  query: string;
  limit: number;
  mode?: RetrievalRankMode;
}

/** Ranked chunk returned by a `Retriever` (matches harness `RetrievalHit`). */
export interface RetrievalHit {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

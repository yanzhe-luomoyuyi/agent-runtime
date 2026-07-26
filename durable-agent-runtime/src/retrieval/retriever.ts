/**
 * Retriever seam — anything that can answer `search(request) → hits`.
 *
 * Products plug in a vector DB, MCP remote search, or the bundled StoreRetriever
 * over an in-process DocumentStore. Policy / injection do not care which.
 */

import type { DocumentStore } from './store.js';
import type { RetrievalHit, RetrievalRequest } from './types.js';

export interface Retriever {
  search(req: RetrievalRequest): Promise<RetrievalHit[]>;
}

/** Adapt a DocumentStore into the Retriever interface. */
export class StoreRetriever implements Retriever {
  constructor(private readonly store: DocumentStore) {}

  async search(req: RetrievalRequest): Promise<RetrievalHit[]> {
    return (await this.store.search(req.corpusId, req.query, { limit: req.limit, mode: req.mode })).map((c) => ({
      id: c.id,
      text: c.text,
      score: c.score,
      metadata: { ...c.metadata, corpusId: req.corpusId },
    }));
  }
}

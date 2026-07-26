/**
 * Document retrieval tools — application surface over a DocumentStore.
 *
 * Same durability rule as memory tools: register on the runtime ToolRegistry so
 * every search/read flows through `ctx.callTool` and is recorded for replay.
 * `corpusId` is bound at registration time (model cannot pick another corpus).
 *
 * Search returns each chunk's stored text by default (optionally truncated via
 * `maxTextChars`). Use `document_read` when you need the full chunk after a
 * truncated search hit.
 */

import type { DocumentStore } from '../retrieval/store.js';
import type { RetrievalRankMode } from '../retrieval/types.js';
import { ToolRegistry, type ToolDef } from '../tools/registry.js';

export const DOCUMENT_SEARCH_TOOL = 'document_search';
export const DOCUMENT_READ_TOOL = 'document_read';

/** Build document tools bound to `store` + `corpusId`. */
export function documentToolDefs(store: DocumentStore, corpusId: string): ToolDef[] {
  return [
    {
      name: DOCUMENT_SEARCH_TOOL,
      description:
        'Search the document corpus by relevance. Returns matching chunk ids, ranking scores, and chunk text (full text unless maxTextChars truncates). Use document_read for the full chunk when truncated.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', description: 'Max results. Default 5.' },
          mode: {
            type: 'string',
            enum: ['lexical', 'semantic', 'hybrid'],
            description:
              'Ranking strategy. Default lexical. hybrid orders by RRF fused rank score (not raw lexical+cosine sum).',
          },
          maxTextChars: {
            type: 'integer',
            description:
              'Optional per-hit text truncation. Omit for full chunk text. Use document_read(id) for the remainder.',
          },
        },
        required: ['query'],
      },
      run: async (args: unknown) => {
        const a = (args ?? {}) as {
          query?: unknown;
          limit?: unknown;
          mode?: unknown;
          maxTextChars?: unknown;
        };
        if (typeof a.query !== 'string') return 'ERROR: document_search requires a string "query".';
        const limit = typeof a.limit === 'number' && a.limit > 0 ? a.limit : 5;
        const mode =
          a.mode === 'lexical' || a.mode === 'semantic' || a.mode === 'hybrid'
            ? (a.mode as RetrievalRankMode)
            : undefined;
        const maxTextChars =
          typeof a.maxTextChars === 'number' && a.maxTextChars > 0 ? a.maxTextChars : undefined;
        return (await store.search(corpusId, a.query, { limit, mode, maxTextChars })).map((h) => ({
          id: h.id,
          text: h.text,
          score: h.score,
          metadata: h.metadata,
        }));
      },
    },
    {
      name: DOCUMENT_READ_TOOL,
      description: 'Read the full text of a document chunk by id (never truncated).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      run: (args: unknown) => {
        const a = (args ?? {}) as { id?: unknown };
        if (typeof a.id !== 'string') return 'ERROR: document_read requires a string "id".';
        const chunk = store.get(corpusId, a.id);
        if (!chunk) return `ERROR: unknown document id "${a.id}".`;
        return { id: chunk.id, text: chunk.text, metadata: chunk.metadata };
      },
    },
  ];
}

/** Register document tools on a registry (chainable). */
export function registerDocumentTools(
  registry: ToolRegistry,
  store: DocumentStore,
  corpusId: string,
): ToolRegistry {
  for (const t of documentToolDefs(store, corpusId)) registry.register(t);
  return registry;
}

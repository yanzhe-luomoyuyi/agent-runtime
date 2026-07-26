/**
 * Document retrieval tools — application surface over a DocumentStore.
 *
 * Same durability rule as memory tools: register on the runtime ToolRegistry so
 * every search/read flows through `ctx.callTool` and is recorded for replay.
 * Corpus binding is host-controlled (model cannot invent ids outside the allow-list).
 *
 * Search returns each chunk's stored text by default (optionally truncated via
 * `maxTextChars`). Use `document_read` for the full chunk after a truncated hit.
 */

import type { DocumentStore } from '../retrieval/store.js';
import type { RetrievalRankMode } from '../retrieval/types.js';
import { ToolRegistry, type ToolDef } from '../tools/registry.js';

export const DOCUMENT_SEARCH_TOOL = 'document_search';
export const DOCUMENT_READ_TOOL = 'document_read';

/** How tools are bound to one or more corpora. */
export type DocumentToolCorpusBinding =
  | string
  | {
      /** Used when the model omits corpusId. */
      defaultCorpusId: string;
      /** When set, model-supplied corpusId must be in this list. Default: [defaultCorpusId]. */
      allowedCorpora?: string[];
    };

function normalizeBinding(binding: DocumentToolCorpusBinding): {
  defaultCorpusId: string;
  allowedCorpora: string[];
} {
  if (typeof binding === 'string') {
    return { defaultCorpusId: binding, allowedCorpora: [binding] };
  }
  const allowed =
    binding.allowedCorpora && binding.allowedCorpora.length > 0
      ? [...binding.allowedCorpora]
      : [binding.defaultCorpusId];
  if (!allowed.includes(binding.defaultCorpusId)) allowed.unshift(binding.defaultCorpusId);
  return { defaultCorpusId: binding.defaultCorpusId, allowedCorpora: allowed };
}

function resolveCorpusId(
  binding: { defaultCorpusId: string; allowedCorpora: string[] },
  requested: unknown,
): string | { error: string } {
  if (requested === undefined || requested === null || requested === '') {
    return binding.defaultCorpusId;
  }
  if (typeof requested !== 'string' || !requested.trim()) {
    return { error: 'ERROR: corpusId must be a non-empty string when provided.' };
  }
  const id = requested.trim();
  if (!binding.allowedCorpora.includes(id)) {
    return {
      error: `ERROR: corpusId "${id}" is not allowed. Allowed: ${binding.allowedCorpora.join(', ')}.`,
    };
  }
  return id;
}

/** Build document tools bound to `store` + corpus allow-list. */
export function documentToolDefs(store: DocumentStore, binding: DocumentToolCorpusBinding): ToolDef[] {
  const b = normalizeBinding(binding);
  const multi = b.allowedCorpora.length > 1;

  return [
    {
      name: DOCUMENT_SEARCH_TOOL,
      description:
        'Search the document corpus by relevance. Returns matching chunk ids, ranking scores, and chunk text (full text unless maxTextChars truncates). Use document_read for the full chunk when truncated.' +
        (multi
          ? ` Optional corpusId (allowed: ${b.allowedCorpora.join(', ')}); default ${b.defaultCorpusId}.`
          : ''),
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
          ...(multi
            ? {
                corpusId: {
                  type: 'string',
                  description: `Corpus to search. Allowed: ${b.allowedCorpora.join(', ')}. Default: ${b.defaultCorpusId}.`,
                },
              }
            : {}),
        },
        required: ['query'],
      },
      run: async (args: unknown) => {
        const a = (args ?? {}) as {
          query?: unknown;
          limit?: unknown;
          mode?: unknown;
          maxTextChars?: unknown;
          corpusId?: unknown;
        };
        if (typeof a.query !== 'string') return 'ERROR: document_search requires a string "query".';
        const corpus = resolveCorpusId(b, a.corpusId);
        if (typeof corpus === 'object') return corpus.error;
        const limit = typeof a.limit === 'number' && a.limit > 0 ? a.limit : 5;
        const mode =
          a.mode === 'lexical' || a.mode === 'semantic' || a.mode === 'hybrid'
            ? (a.mode as RetrievalRankMode)
            : undefined;
        const maxTextChars =
          typeof a.maxTextChars === 'number' && a.maxTextChars > 0 ? a.maxTextChars : undefined;
        return (await store.search(corpus, a.query, { limit, mode, maxTextChars })).map((h) => ({
          id: h.id,
          text: h.text,
          score: h.score,
          metadata: h.metadata,
          corpusId: corpus,
        }));
      },
    },
    {
      name: DOCUMENT_READ_TOOL,
      description:
        'Read the full text of a document chunk by id (never truncated).' +
        (multi ? ` Optional corpusId; default ${b.defaultCorpusId}.` : ''),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ...(multi
            ? {
                corpusId: {
                  type: 'string',
                  description: `Corpus containing the chunk. Allowed: ${b.allowedCorpora.join(', ')}.`,
                },
              }
            : {}),
        },
        required: ['id'],
      },
      run: (args: unknown) => {
        const a = (args ?? {}) as { id?: unknown; corpusId?: unknown };
        if (typeof a.id !== 'string') return 'ERROR: document_read requires a string "id".';
        const corpus = resolveCorpusId(b, a.corpusId);
        if (typeof corpus === 'object') return corpus.error;
        const chunk = store.get(corpus, a.id);
        if (!chunk) return `ERROR: unknown document id "${a.id}" in corpus "${corpus}".`;
        return { id: chunk.id, text: chunk.text, metadata: chunk.metadata, corpusId: corpus };
      },
    },
  ];
}

/** Register document tools on a registry (chainable). */
export function registerDocumentTools(
  registry: ToolRegistry,
  store: DocumentStore,
  binding: DocumentToolCorpusBinding,
): ToolRegistry {
  for (const t of documentToolDefs(store, binding)) registry.register(t);
  return registry;
}

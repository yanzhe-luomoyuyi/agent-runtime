/**
 * Memory tools — durable ToolDefs over a MemoryStore.
 *
 * Registered in the runtime's tool registry; every call flows through
 * `ctx.callTool` and is recorded in the run's event log, so a memory read stays
 * replay-deterministic even if another session later changes the store. The
 * `scope` is bound here (from the run's user/project), so the model never
 * chooses which user's memories it touches.
 *
 * Manual surface: the model explicitly writes and recalls. There is no
 * automatic extraction (a riskier future add-on that needs a human gate).
 */

import { ToolRegistry, type ToolDef } from '../tools/registry.js';
import type { MemoryStore } from './store.js';

/** Build the memory tools bound to `store` + `scope`. */
export function memoryToolDefs(store: MemoryStore, scope: string): ToolDef[] {
  return [
    {
      name: 'memory_write',
      description: 'Persist a durable memory (a fact, preference, or note) that should survive across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The memory content to store.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for later filtering.' },
          kind: { type: 'string', enum: ['semantic', 'episodic', 'procedural'], description: 'Memory kind. Default semantic.' },
        },
        required: ['text'],
      },
      run: (args: unknown) => {
        const a = (args ?? {}) as { text?: unknown; tags?: unknown; kind?: unknown };
        if (typeof a.text !== 'string' || a.text.trim() === '') return 'ERROR: memory_write requires non-empty "text".';
        const rec = store.write(scope, a.text, {
          tags: Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === 'string') : undefined,
          kind: a.kind === 'episodic' || a.kind === 'procedural' ? a.kind : undefined,
        });
        return { id: rec.id, stored: true };
      },
    },
    {
      name: 'memory_search',
      description: 'Search durable memories by relevance to a query. Returns matching memory ids and text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', description: 'Max results. Default 5.' },
          kind: { type: 'string', enum: ['semantic', 'episodic', 'procedural'] },
          tags: { type: 'array', items: { type: 'string' } },
          mode: {
            type: 'string',
            enum: ['lexical', 'semantic', 'hybrid'],
            description:
              'Ranking strategy. "lexical" matches exact terms (default). "semantic" tolerates paraphrasing/reordering via embeddings. "hybrid" combines both. Falls back to lexical if no embedding provider is configured.',
          },
        },
        required: ['query'],
      },
      run: async (args: unknown) => {
        const a = (args ?? {}) as { query?: unknown; limit?: unknown; kind?: unknown; tags?: unknown; mode?: unknown };
        if (typeof a.query !== 'string') return 'ERROR: memory_search requires a string "query".';
        const limit = typeof a.limit === 'number' && a.limit > 0 ? a.limit : 5;
        const kind = a.kind === 'semantic' || a.kind === 'episodic' || a.kind === 'procedural' ? a.kind : undefined;
        const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === 'string') : undefined;
        const mode = a.mode === 'lexical' || a.mode === 'semantic' || a.mode === 'hybrid' ? a.mode : undefined;
        const rows = await store.search(scope, a.query, { limit, kind, tags, mode });
        return rows.map((r) => ({ id: r.id, text: r.text, tags: r.tags, kind: r.kind }));
      },
    },
    {
      name: 'memory_read',
      description: 'Retrieve the full content of a durable memory by its id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: (args: unknown) => {
        const a = (args ?? {}) as { id?: unknown };
        if (typeof a.id !== 'string') return 'ERROR: memory_read requires a string "id".';
        const rec = store.read(scope, a.id);
        return rec ? { id: rec.id, text: rec.text, tags: rec.tags, kind: rec.kind } : `ERROR: no memory with id "${a.id}".`;
      },
    },
  ];
}

/** Register the memory tools into a runtime `ToolRegistry`. */
export function registerMemoryTools(registry: ToolRegistry, store: MemoryStore, scope: string): ToolRegistry {
  for (const tool of memoryToolDefs(store, scope)) registry.register(tool);
  return registry;
}

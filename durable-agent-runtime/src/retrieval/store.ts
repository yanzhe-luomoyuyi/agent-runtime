/**
 * Document chunk store — corpus-scoped persistence for RAG, parallel to MemoryStore.
 *
 * Memories are short curated facts; this store holds document/code chunks that
 * products ingest offline (or via admin tools). Search reuses lexical / embedding
 * ranking from `../memory/` so behaviour stays deterministic under durable replay.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EmbeddingProvider } from '../memory/embedding.js';
import { rankByEmbedding, reciprocalRankFusionScored } from '../memory/embedding.js';
import { rankByRelevance } from '../memory/lexical.js';
import type { RetrievalRankMode } from './types.js';

export interface DocumentChunk {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface DocumentSearchOptions {
  limit?: number;
  mode?: RetrievalRankMode;
  /**
   * When set, truncate each hit's `text` to this many characters.
   * Full text remains available via `document_read` / `get`. Default: no truncate.
   */
  maxTextChars?: number;
}

/** Corpus-scoped chunk persistence + ranked search. */
export interface DocumentStore {
  upsert(corpusId: string, chunks: DocumentChunk[]): void;
  get(corpusId: string, id: string): DocumentChunk | undefined;
  search(
    corpusId: string,
    query: string,
    opts?: DocumentSearchOptions,
  ): Promise<Array<DocumentChunk & { score: number }>>;
  list(corpusId: string): DocumentChunk[];
  delete(corpusId: string, id: string): boolean;
}

function maybeTruncateText(text: string, maxTextChars?: number): string {
  if (maxTextChars === undefined || maxTextChars <= 0 || text.length <= maxTextChars) return text;
  return text.slice(0, maxTextChars);
}

abstract class BaseDocumentStore implements DocumentStore {
  constructor(protected readonly embeddings?: EmbeddingProvider) {}

  protected abstract load(corpusId: string): DocumentChunk[];
  protected abstract persist(corpusId: string, chunks: DocumentChunk[]): void;

  upsert(corpusId: string, chunks: DocumentChunk[]): void {
    const records = this.load(corpusId);
    for (const chunk of chunks) {
      const next: DocumentChunk = {
        id: chunk.id,
        text: chunk.text,
        metadata: chunk.metadata ?? {},
      };
      const idx = records.findIndex((c) => c.id === next.id);
      if (idx >= 0) records[idx] = next;
      else records.push(next);
    }
    this.persist(corpusId, records);
  }

  get(corpusId: string, id: string): DocumentChunk | undefined {
    return this.load(corpusId).find((c) => c.id === id);
  }

  async search(
    corpusId: string,
    query: string,
    opts: DocumentSearchOptions = {},
  ): Promise<Array<DocumentChunk & { score: number }>> {
    const pool = this.load(corpusId);
    const limit = opts.limit ?? 5;
    const textOf = (c: DocumentChunk) => c.text;
    const embeddings = this.embeddings;
    const mode = opts.mode ?? 'lexical';
    const maxTextChars = opts.maxTextChars;

    const project = (hits: Array<{ item: DocumentChunk; score: number }>) =>
      hits.map((s) => ({
        ...s.item,
        text: maybeTruncateText(s.item.text, maxTextChars),
        score: s.score,
      }));

    if (mode === 'lexical' || !embeddings) {
      return project(rankByRelevance(query, pool, textOf, limit));
    }
    if (mode === 'semantic') {
      return project(await rankByEmbedding(query, pool, textOf, limit, embeddings));
    }
    const lexical = rankByRelevance(query, pool, textOf, pool.length).map((s) => s.item);
    const semantic = (await rankByEmbedding(query, pool, textOf, pool.length, embeddings)).map((s) => s.item);
    return project(reciprocalRankFusionScored([lexical, semantic], (c) => c.id, limit));
  }

  list(corpusId: string): DocumentChunk[] {
    return this.load(corpusId);
  }

  delete(corpusId: string, id: string): boolean {
    const records = this.load(corpusId);
    const next = records.filter((c) => c.id !== id);
    if (next.length === records.length) return false;
    this.persist(corpusId, next);
    return true;
  }
}

/** Non-persistent store for tests and in-process engines. */
export class InMemoryDocumentStore extends BaseDocumentStore {
  private readonly corpora = new Map<string, DocumentChunk[]>();

  protected load(corpusId: string): DocumentChunk[] {
    return [...(this.corpora.get(corpusId) ?? [])];
  }

  protected persist(corpusId: string, chunks: DocumentChunk[]): void {
    this.corpora.set(corpusId, chunks);
  }
}

/** Disk-backed store: one JSON file per corpusId, written atomically (tmp + rename). */
export class FileDocumentStore extends BaseDocumentStore {
  constructor(
    private readonly baseDir: string,
    embeddings?: EmbeddingProvider,
  ) {
    super(embeddings);
  }

  private file(corpusId: string): string {
    const safe = corpusId.replace(/[^a-zA-Z0-9_.-]/g, '_') || '_default';
    return join(this.baseDir, `${safe}.json`);
  }

  protected load(corpusId: string): DocumentChunk[] {
    const path = this.file(corpusId);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((c) => {
          const o = c as DocumentChunk;
          return {
            id: String(o.id ?? ''),
            text: String(o.text ?? ''),
            metadata:
              o.metadata && typeof o.metadata === 'object' ? (o.metadata as Record<string, unknown>) : {},
          };
        })
        .filter((c) => c.id);
    } catch {
      return [];
    }
  }

  protected persist(corpusId: string, chunks: DocumentChunk[]): void {
    mkdirSync(this.baseDir, { recursive: true });
    const dst = this.file(corpusId);
    const tmp = `${dst}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(chunks));
      renameSync(tmp, dst);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw e;
    }
  }
}

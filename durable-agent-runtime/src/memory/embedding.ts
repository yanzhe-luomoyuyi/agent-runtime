/**
 * Embedding-backed relevance scoring — the semantic-recall seam for memory
 * and document search, complementing `lexical.ts`'s exact-token scorer.
 *
 * `EmbeddingProvider` is a pluggable interface (same pattern as `ModelProvider`
 * / `ContentSafetyProvider`): stores depend only on the interface. Real embed
 * APIs are network calls, so `embed` is async-first; sync providers
 * (`HashingEmbeddingProvider`) still work via `Promise.resolve`.
 *
 * ## Default vs real models
 *
 * The bundled default, `HashingEmbeddingProvider`, is a classical feature-
 * hashing bag-of-words vectorizer — zero dependencies, no network, fully
 * deterministic. It is NOT a substitute for a learned embedding model (no
 * synonymy). It exists so hybrid/semantic paths are testable offline.
 *
 * To plug in a real model (OpenAI `text-embedding-3-*`, Cohere, Ollama,
 * sentence-transformers, …): implement `EmbeddingProvider` (optionally
 * `embedMany` for batch), wrap with `CachingEmbeddingProvider` if useful,
 * and pass it into `InMemoryStore` / `InMemoryDocumentStore`. Chat/agent
 * mocks stay independent — embedding is a separate seam.
 *
 * See `createHttpEmbeddingProvider` for a minimal HTTP-shaped adapter.
 */

import { tokenize } from './lexical.js';

export interface EmbeddingProvider {
  /**
   * Map text to a fixed-length dense vector.
   * Sync or async — callers always `await` the result.
   */
  embed(text: string): number[] | Promise<number[]>;
  /**
   * Optional batch path. When present, `rankByEmbedding` embeds the query plus
   * all candidate texts in one call (typical remote API shape).
   */
  embedMany?(texts: string[]): number[][] | Promise<number[][]>;
}

const DEFAULT_DIMENSIONS = 256;

/** FNV-1a — the same tiny deterministic string hash used elsewhere in this codebase (store.ts's contentId). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/**
 * Feature-hashing bag-of-words embedding. Each token is hashed into one of
 * `dimensions` buckets and counted (term frequency); the resulting vector is
 * L2-normalized so cosine similarity is comparable across texts of different
 * lengths. Collisions are an accepted trade-off of the hashing trick.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly dimensions: number = DEFAULT_DIMENSIONS) {}

  embed(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenize(text)) {
      const bucket = fnv1a(token) % this.dimensions;
      vec[bucket] = (vec[bucket] ?? 0) + 1;
    }
    return l2Normalize(vec);
  }
}

/**
 * In-process cache over any provider. Useful for remote embeds so repeated
 * chunk texts (and identical queries within a run) do not re-hit the network.
 * Cache is process-local and not durable — durable replay still relies on
 * logged tool results, not on re-embedding.
 */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  private readonly cache = new Map<string, number[]>();

  constructor(private readonly inner: EmbeddingProvider) {}

  async embed(text: string): Promise<number[]> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const vec = await Promise.resolve(this.inner.embed(text));
    this.cache.set(text, vec);
    return vec;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    const missing: string[] = [];
    const missingIdx: number[] = [];
    const out: Array<number[] | undefined> = new Array(texts.length);

    for (let i = 0; i < texts.length; i++) {
      const t = texts[i]!;
      const hit = this.cache.get(t);
      if (hit) out[i] = hit;
      else {
        missing.push(t);
        missingIdx.push(i);
      }
    }

    if (missing.length === 0) return out as number[][];

    let fresh: number[][];
    if (this.inner.embedMany) {
      fresh = await Promise.resolve(this.inner.embedMany(missing));
    } else {
      fresh = await Promise.all(missing.map((t) => Promise.resolve(this.inner.embed(t))));
    }
    if (fresh.length !== missing.length) {
      throw new Error(`embedMany returned ${fresh.length} vectors for ${missing.length} texts`);
    }
    for (let j = 0; j < missing.length; j++) {
      const vec = fresh[j]!;
      this.cache.set(missing[j]!, vec);
      out[missingIdx[j]!] = vec;
    }
    return out as number[][];
  }

  /** Test / observability helper. */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Minimal adapter for HTTP-style embed APIs. Products supply `fetchVectors`
 * (OpenAI, Azure, local gateway, …). Not used by the engine by default.
 *
 * @example
 * ```ts
 * const embeddings = new CachingEmbeddingProvider(
 *   createHttpEmbeddingProvider({
 *     async fetchVectors(texts) {
 *       const res = await fetch('https://api.openai.com/v1/embeddings', {
 *         method: 'POST',
 *         headers: {
 *           Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
 *           'Content-Type': 'application/json',
 *         },
 *         body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
 *       });
 *       const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
 *       return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
 *     },
 *   }),
 * );
 * const store = new InMemoryDocumentStore(embeddings);
 * ```
 */
export function createHttpEmbeddingProvider(opts: {
  fetchVectors: (texts: string[]) => Promise<number[][]>;
}): EmbeddingProvider {
  return {
    async embed(text: string): Promise<number[]> {
      const [vec] = await opts.fetchVectors([text]);
      if (!vec) throw new Error('fetchVectors returned no vector for embed()');
      return vec;
    },
    async embedMany(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const vecs = await opts.fetchVectors(texts);
      if (vecs.length !== texts.length) {
        throw new Error(`fetchVectors returned ${vecs.length} vectors for ${texts.length} texts`);
      }
      return vecs;
    },
  };
}

/** Cosine similarity of two pre-normalized vectors reduces to a plain dot product. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

async function embedAll(
  provider: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (provider.embedMany) {
    const vecs = await Promise.resolve(provider.embedMany(texts));
    if (vecs.length !== texts.length) {
      throw new Error(`embedMany returned ${vecs.length} vectors for ${texts.length} texts`);
    }
    return vecs;
  }
  return Promise.all(texts.map((t) => Promise.resolve(provider.embed(t))));
}

/**
 * Rank `items` by cosine similarity of each item's text embedding to the query.
 * Always async so remote (Promise-returning) providers work; sync hashing
 * providers are fine too.
 */
export async function rankByEmbedding<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  k: number,
  provider: EmbeddingProvider,
): Promise<Array<{ item: T; score: number }>> {
  if (items.length === 0) return [];
  const texts = [query, ...items.map(getText)];
  const [queryVec, ...itemVecs] = await embedAll(provider, texts);
  if (!queryVec) return [];

  const scored = items
    .map((item, i) => ({
      item,
      score: cosineSimilarity(queryVec, itemVecs[i] ?? []),
    }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score); // stable: ties keep original order
  return scored.slice(0, Math.max(0, k));
}

/**
 * Reciprocal Rank Fusion — merge multiple independently-ranked lists (e.g.
 * lexical + semantic) into one, using only each item's RANK in each list, not
 * its raw score. This sidesteps the fact that lexical scores and cosine
 * similarities live on incomparable scales — a standard hybrid-search
 * technique (Elasticsearch, Weaviate, and Azure AI Search all ship a variant
 * of this). `kRrf` (default 60, the value used in the original TREC paper and
 * most production deployments) dampens the influence of any single ranking's
 * top result.
 *
 * The returned `score` IS the fused RRF value (sum of `1/(kRrf+rank+1)` across
 * lists) — use it for gating / display; do not re-attach lexical/cosine scores.
 */
export function reciprocalRankFusionScored<T>(
  rankings: T[][],
  keyOf: (item: T) => string,
  k: number,
  kRrf = 60,
): Array<{ item: T; score: number }> {
  const scores = new Map<string, number>();
  const itemByKey = new Map<string, T>();
  for (const ranking of rankings) {
    ranking.forEach((item, rank) => {
      const key = keyOf(item);
      itemByKey.set(key, item);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (kRrf + rank + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, k))
    .map(([key, score]) => ({ item: itemByKey.get(key)!, score }));
}

/** Same as `reciprocalRankFusionScored` but drops the fused scores (items only). */
export function reciprocalRankFusion<T>(rankings: T[][], keyOf: (item: T) => string, k: number, kRrf = 60): T[] {
  return reciprocalRankFusionScored(rankings, keyOf, k, kRrf).map((s) => s.item);
}

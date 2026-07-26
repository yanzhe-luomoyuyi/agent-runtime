/**
 * Embedding-backed relevance scoring — the semantic-recall seam for memory
 * search, complementing `lexical.ts`'s exact-token scorer.
 *
 * `EmbeddingProvider` is a pluggable interface (same pattern as `ModelProvider`
 * / `ContentSafetyProvider` elsewhere in this runtime): `MemoryStore` depends
 * only on the interface, never on a concrete implementation.
 *
 * The bundled default, `HashingEmbeddingProvider`, is a classical feature-
 * hashing ("hashing trick") bag-of-words vectorizer — zero dependencies, no
 * network call, fully deterministic (same requirements as `lexical.ts`, for
 * the same durable-replay reason). Be precise about what it is NOT: it has no
 * learned notion of synonymy ("car" and "automobile" hash to unrelated
 * buckets) — it is not a substitute for a real embedding model. What it DOES
 * give you for free is a working, testable `EmbeddingProvider` seam end to
 * end (vector math, cosine ranking, hybrid fusion) with nothing to configure.
 * Swap in a real embedding model (OpenAI `text-embedding-3-*`, Cohere embed,
 * a local sentence-transformers model, ...) by implementing this same
 * interface — nothing else in `MemoryStore` needs to change.
 */

import { tokenize } from './lexical.js';

export interface EmbeddingProvider {
  /**
   * Map text to a fixed-length dense vector. Real embedding APIs are
   * network calls (async); the interface is declared async-compatible even
   * though the bundled default is synchronous and local.
   */
  embed(text: string): number[] | Promise<number[]>;
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
 * lengths. Collisions (two different tokens landing in the same bucket) are
 * an accepted, well-understood trade-off of the hashing trick — they add a
 * small amount of noise in exchange for a fixed-size vector with no
 * vocabulary/dictionary to build or store.
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

/** Cosine similarity of two pre-normalized vectors reduces to a plain dot product. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** Rank `items` by cosine similarity of `getText(item)`'s embedding to the query's; top `k` with score > 0. */
export function rankByEmbedding<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  k: number,
  provider: EmbeddingProvider,
): Array<{ item: T; score: number }> {
  const queryVec = provider.embed(query);
  if (queryVec instanceof Promise) {
    throw new Error('rankByEmbedding requires a synchronous EmbeddingProvider — await embed() yourself for async providers.');
  }
  const scored = items
    .map((item) => {
      const vec = provider.embed(getText(item));
      if (vec instanceof Promise) {
        throw new Error('rankByEmbedding requires a synchronous EmbeddingProvider — await embed() yourself for async providers.');
      }
      return { item, score: cosineSimilarity(queryVec, vec) };
    })
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

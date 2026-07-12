/**
 * Lexical relevance scoring — a tiny, zero-dependency, deterministic scorer used
 * by memory search. Deliberately NOT embeddings: no model call, no dependency,
 * identical results every run — which is what a durable, replayable system needs.
 * Swap in an embedding-backed store behind the `MemoryStore` interface when
 * semantic recall matters.
 */

import { isCjkCodepoint } from '@agent/contracts';

/** Split into lowercased alphanumeric tokens plus individual CJK characters. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) tokens.push(m[0]);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isCjkCodepoint(cp)) tokens.push(ch);
  }
  return tokens;
}

/** Score `text` against `query` in [0, ∞). 0 = no overlap. Deterministic. */
export function lexicalScore(query: string, text: string): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const doc = tokenize(text);
  if (doc.length === 0) return 0;

  const docCounts = new Map<string, number>();
  for (const t of doc) docCounts.set(t, (docCounts.get(t) ?? 0) + 1);

  let overlap = 0;
  const seen = new Set<string>();
  for (const t of q) {
    const c = docCounts.get(t);
    if (c) {
      overlap += 1 + Math.log(c); // diminishing term-frequency weight
      seen.add(t);
    }
  }
  const coverage = seen.size / new Set(q).size;
  const substringBonus = query.trim().length > 0 && text.toLowerCase().includes(query.toLowerCase().trim()) ? 0.5 : 0;
  return overlap * (0.5 + 0.5 * coverage) + substringBonus;
}

/** Rank `items` by relevance of `getText(item)` to `query`; top `k` with score > 0. */
export function rankByRelevance<T>(query: string, items: T[], getText: (item: T) => string, k: number): Array<{ item: T; score: number }> {
  const scored = items.map((item) => ({ item, score: lexicalScore(query, getText(item)) })).filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score); // stable: ties keep original order
  return scored.slice(0, Math.max(0, k));
}

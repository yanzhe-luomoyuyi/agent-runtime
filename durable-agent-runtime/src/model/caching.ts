/**
 * Content-addressed response cache for model calls, as a DECORATOR around any
 * ModelProvider (the composition seam from the architecture discussion).
 *
 * Three concerns are decoupled so each can be swapped independently:
 *   1. keying  — how a request becomes a cache key (`CacheKeyFn`, injectable).
 *                The default normalizes whitespace so trivial formatting no
 *                longer busts the cache; swap it for a semantic/embedding
 *                strategy later without touching the decorator.
 *   2. storage — get/set by key (`ResponseCache`). In-memory (LRU-bounded) or
 *                file-backed (LRU + persisted); swap for Redis in production.
 *   3. layer   — this cache is content-keyed & cross-run, distinct from the
 *                runtime's position-keyed, per-run durable replay.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import type { ModelProvider, ModelResult } from './provider.js';

// --- Keying strategy (decoupled, injectable) ------------------------------

export interface CacheKeyInput {
  /** Provider identity — different models must not share cache entries. */
  provider: string;
  /** The prompt. In a fuller system this would also include model params, tools, etc. */
  prompt: string;
}

export type CacheKeyFn = (input: CacheKeyInput) => string;

/** Collapse insignificant whitespace so a stray space/newline doesn't cause a miss. */
function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ');
}

/** Default keying: exact match on the normalized prompt, namespaced by provider. */
export const defaultCacheKey: CacheKeyFn = ({ provider, prompt }) =>
  createHash('sha256').update(`${provider}\n${normalizePrompt(prompt)}`).digest('hex');

// --- Storage (bounded LRU; swap for Redis / a semantic store in prod) ------

export interface ResponseCache {
  get(key: string): ModelResult | undefined;
  set(key: string, value: ModelResult): void;
}

const DEFAULT_MAX_ENTRIES = 1000;

/** In-memory cache with LRU eviction (Map iteration order tracks recency). */
export class InMemoryResponseCache implements ResponseCache {
  protected readonly store = new Map<string, ModelResult>();
  constructor(protected readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  get(key: string): ModelResult | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    this.store.delete(key); // re-insert to mark most-recently-used
    this.store.set(key, value);
    return value;
  }

  set(key: string, value: ModelResult): void {
    this.store.delete(key);
    this.store.set(key, value);
    this.evict();
  }

  protected evict(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

/** LRU cache persisted to a JSON file so hits survive across CLI invocations. */
export class FileResponseCache extends InMemoryResponseCache {
  constructor(
    private readonly filePath: string,
    maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {
    super(maxEntries);
    if (existsSync(filePath)) {
      try {
        const obj = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, ModelResult>;
        for (const [k, v] of Object.entries(obj)) this.store.set(k, v);
        this.evict(); // in case the file grew past the limit
      } catch {
        // corrupt cache file — start empty
      }
    }
  }

  override set(key: string, value: ModelResult): void {
    super.set(key, value);
    writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.store), null, 2));
  }
}

// --- The decorator ---------------------------------------------------------

export class CachingModelProvider implements ModelProvider {
  readonly name: string;
  hits = 0;
  misses = 0;

  constructor(
    private readonly inner: ModelProvider,
    private readonly cache: ResponseCache = new InMemoryResponseCache(),
    private readonly keyOf: CacheKeyFn = defaultCacheKey,
  ) {
    this.name = `caching(${inner.name})`;
  }

  async complete(prompt: string): Promise<ModelResult> {
    const key = this.keyOf({ provider: this.inner.name, prompt });
    const hit = this.cache.get(key);
    if (hit) {
      this.hits++;
      return { ...hit, cached: true };
    }
    this.misses++;
    const result = await this.inner.complete(prompt);
    this.cache.set(key, result);
    return { ...result, cached: false };
  }
}

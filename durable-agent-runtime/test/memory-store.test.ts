import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CachingEmbeddingProvider,
  cosineSimilarity,
  createHttpEmbeddingProvider,
  HashingEmbeddingProvider,
  reciprocalRankFusion,
  reciprocalRankFusionScored,
  type EmbeddingProvider,
} from '../src/memory/embedding.js';
import { FileMemoryStore, InMemoryStore, type MemoryStore } from '../src/memory/store.js';

function stores(): Array<[string, () => MemoryStore]> {
  return [
    ['InMemoryStore', () => new InMemoryStore()],
    ['FileMemoryStore', () => new FileMemoryStore(mkdtempSync(join(tmpdir(), 'mem-store-')))],
  ];
}

for (const [label, make] of stores()) {
  describe(`${label}`, () => {
    it('writes, reads, searches, and lists', async () => {
      const s = make();
      const a = s.write('u', 'user prefers dark mode', { tags: ['pref'] });
      s.write('u', 'the api base url is https://api.example.com', { tags: ['config'] });

      expect(s.read('u', a.id)!.text).toBe('user prefers dark mode');
      expect((await s.search('u', 'dark mode preference'))[0]!.text).toContain('dark mode');
      expect(s.list('u', { tags: ['config'] }).map((r) => r.tags)).toEqual([['config']]);
    });

    it('content-addresses ids so identical writes are idempotent (no duplicate)', () => {
      const s = make();
      const first = s.write('u', 'same text');
      const again = s.write('u', 'same text'); // e.g. a crash-resume re-run
      expect(again.id).toBe(first.id);
      expect(s.list('u').length).toBe(1); // upserted, not duplicated
    });

    it('updates in place when given an explicit id', () => {
      const s = make();
      const rec = s.write('u', 'draft', { id: 'note-1' });
      s.write('u', 'final', { id: 'note-1' });
      expect(s.read('u', rec.id)!.text).toBe('final');
      expect(s.list('u').length).toBe(1);
    });

    it('filters by kind and deletes', () => {
      const s = make();
      s.write('u', 'a fact', { kind: 'semantic' });
      const ep = s.write('u', 'did X last run', { kind: 'episodic' });
      expect(s.list('u', { kind: 'episodic' }).map((r) => r.text)).toEqual(['did X last run']);

      expect(s.delete('u', ep.id)).toBe(true);
      expect(s.delete('u', ep.id)).toBe(false); // already gone
      expect(s.list('u', { kind: 'episodic' })).toEqual([]);
    });

    it('isolates scopes', async () => {
      const s = make();
      s.write('alice', 'alice secret');
      s.write('bob', 'bob secret');
      expect(s.list('alice').length).toBe(1);
      expect(await s.search('bob', 'alice')).toEqual([]);
    });
  });
}

describe('FileMemoryStore persistence', () => {
  it('reloads memories from disk in a fresh instance (cross-session)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-persist-'));
    new FileMemoryStore(dir).write('u', 'persisted memory');
    // A brand-new instance (simulating a later process) sees the same data.
    expect(new FileMemoryStore(dir).list('u').map((r) => r.text)).toEqual(['persisted memory']);
  });

  it('sanitises scope names to avoid path traversal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-safe-'));
    const s = new FileMemoryStore(dir);
    // A malicious scope must not escape the base dir; it just becomes a safe filename.
    expect(() => s.write('../../etc/passwd', 'x')).not.toThrow();
    expect(s.list('../../etc/passwd').length).toBe(1);
  });
});

describe('HashingEmbeddingProvider (deterministic, zero-dependency embedding seam)', () => {
  it('is deterministic: same text always yields the same vector', () => {
    const p = new HashingEmbeddingProvider();
    expect(p.embed('restart the database service')).toEqual(p.embed('restart the database service'));
  });

  it('produces a unit-length (L2-normalized) vector so cosine similarity is a plain dot product', () => {
    const p = new HashingEmbeddingProvider();
    const vec = p.embed('some memory text with several tokens');
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('ranks texts with more token overlap higher via cosine similarity', () => {
    const p = new HashingEmbeddingProvider();
    const query = p.embed('database connection timeout error');
    const close = p.embed('the database connection timed out with an error');
    const far = p.embed('user prefers dark mode in the UI');
    expect(cosineSimilarity(query, close)).toBeGreaterThan(cosineSimilarity(query, far));
  });

  it('is honest about its limits: no learned synonymy, so unrelated wording scores near zero', () => {
    // This is the documented trade-off of feature-hashing vs. a real embedding model —
    // it has no notion that "automobile" and "car" are related.
    const p = new HashingEmbeddingProvider();
    const a = p.embed('automobile');
    const b = p.embed('car');
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('reciprocalRankFusion', () => {
  it('boosts an item ranked highly in multiple lists over one that only appears in one', () => {
    const fused = reciprocalRankFusion([['a', 'b', 'c'], ['b', 'a', 'd']], (x) => x, 4);
    // 'a' and 'b' each appear near the top of both lists; 'c'/'d' only once each.
    expect(fused.slice(0, 2).sort()).toEqual(['a', 'b']);
  });

  it('preserves single-ranking order when only one ranking is given', () => {
    expect(reciprocalRankFusion([['x', 'y', 'z']], (s) => s, 3)).toEqual(['x', 'y', 'z']);
  });

  it('exposes the fused RRF score used for ordering', () => {
    // 'y' ranks in both lists (1st list rank1, 2nd list rank0) → highest RRF.
    const scored = reciprocalRankFusionScored([['x', 'y'], ['y', 'z']], (x) => x, 3);
    expect(scored[0]!.item).toBe('y');
    expect(scored[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 5);
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });
});

describe('MemoryStore semantic / hybrid search modes', () => {
  function makeStoreWithEmbeddings(provider: EmbeddingProvider = new HashingEmbeddingProvider()): MemoryStore {
    return new InMemoryStore(provider);
  }

  it('mode "lexical" (default) is unaffected by an embedding provider being configured', async () => {
    const s = makeStoreWithEmbeddings();
    s.write('u', 'user prefers dark mode');
    s.write('u', 'the api base url is https://api.example.com');
    expect((await s.search('u', 'dark mode preference'))[0]!.text).toContain('dark mode');
  });

  it('mode "semantic" ranks by embedding cosine similarity instead of exact-token overlap', async () => {
    const s = makeStoreWithEmbeddings();
    s.write('u', 'the database connection timed out with an error');
    s.write('u', 'user prefers dark mode in the UI');
    const results = await s.search('u', 'database connection timeout error', { mode: 'semantic' });
    expect(results[0]!.text).toContain('database');
  });

  it('mode "semantic" without a configured embedding provider falls back to lexical (no crash)', async () => {
    const s = new InMemoryStore(); // no provider
    s.write('u', 'user prefers dark mode');
    expect((await s.search('u', 'dark mode', { mode: 'semantic' }))[0]!.text).toContain('dark mode');
  });

  it('mode "hybrid" surfaces a match that only the lexical scorer would find highly relevant', async () => {
    const s = makeStoreWithEmbeddings();
    s.write('u', 'deploy pipeline failed at step 3: docker build error');
    s.write('u', 'remember to water the office plants on Fridays');
    const results = await s.search('u', 'docker build error', { mode: 'hybrid', limit: 1 });
    expect(results[0]!.text).toContain('docker build error');
  });

  it('a custom EmbeddingProvider can be injected (dependency injection over the concrete hashing default)', async () => {
    // A stub provider that makes two specific memories identical in embedding space,
    // proving the store actually delegates ranking to the injected provider.
    const stub: EmbeddingProvider = {
      embed: (text) => (text.includes('MATCH') ? [1, 0] : [0, 1]),
    };
    const s = makeStoreWithEmbeddings(stub);
    s.write('u', 'unrelated MATCH memory');
    s.write('u', 'totally different note');
    const results = await s.search('u', 'MATCH', { mode: 'semantic' });
    expect(results[0]!.text).toContain('MATCH');
  });

  it('accepts an async EmbeddingProvider (remote-API shaped)', async () => {
    let calls = 0;
    const asyncStub: EmbeddingProvider = {
      async embed(text) {
        calls++;
        await Promise.resolve(); // simulate network hop
        return text.includes('MATCH') ? [1, 0] : [0, 1];
      },
    };
    const s = makeStoreWithEmbeddings(asyncStub);
    s.write('u', 'async MATCH memory');
    s.write('u', 'other note');
    const results = await s.search('u', 'MATCH', { mode: 'semantic' });
    expect(results[0]!.text).toContain('MATCH');
    expect(calls).toBeGreaterThan(0);
  });

  it('uses embedMany when provided (one batch instead of N+1 embeds)', async () => {
    let embedCalls = 0;
    let embedManyCalls = 0;
    const batchStub: EmbeddingProvider = {
      embed: () => {
        embedCalls++;
        return [0, 1];
      },
      embedMany: async (texts) => {
        embedManyCalls++;
        await Promise.resolve();
        return texts.map((t) => (t.includes('MATCH') ? [1, 0] : [0, 1]));
      },
    };
    const s = makeStoreWithEmbeddings(batchStub);
    s.write('u', 'MATCH one');
    s.write('u', 'MATCH two');
    s.write('u', 'noise');
    const results = await s.search('u', 'MATCH', { mode: 'semantic' });
    expect(results[0]!.text).toContain('MATCH');
    expect(embedManyCalls).toBe(1);
    expect(embedCalls).toBe(0);
  });
});

describe('CachingEmbeddingProvider + createHttpEmbeddingProvider', () => {
  it('caches vectors so repeated texts do not re-call the inner provider', async () => {
    let calls = 0;
    const inner: EmbeddingProvider = {
      embed: (text) => {
        calls++;
        return text === 'a' ? [1, 0] : [0, 1];
      },
    };
    const cached = new CachingEmbeddingProvider(inner);
    expect(await cached.embed('a')).toEqual([1, 0]);
    expect(await cached.embed('a')).toEqual([1, 0]);
    expect(calls).toBe(1);
    expect(cached.size).toBe(1);
  });

  it('createHttpEmbeddingProvider adapts a batch fetchVectors function', async () => {
    const seen: string[][] = [];
    const provider = createHttpEmbeddingProvider({
      async fetchVectors(texts) {
        seen.push([...texts]);
        return texts.map((t) => (t === 'q' ? [1, 0] : [0, 1]));
      },
    });
    expect(await provider.embed('q')).toEqual([1, 0]);
    expect(await provider.embedMany!(['a', 'b'])).toEqual([
      [0, 1],
      [0, 1],
    ]);
    expect(seen).toEqual([['q'], ['a', 'b']]);
  });
});

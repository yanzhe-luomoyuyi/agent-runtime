import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileMemoryStore, InMemoryStore, type MemoryStore } from '../src/memory/store.js';

function stores(): Array<[string, () => MemoryStore]> {
  return [
    ['InMemoryStore', () => new InMemoryStore()],
    ['FileMemoryStore', () => new FileMemoryStore(mkdtempSync(join(tmpdir(), 'mem-store-')))],
  ];
}

for (const [label, make] of stores()) {
  describe(`${label}`, () => {
    it('writes, reads, searches, and lists', () => {
      const s = make();
      const a = s.write('u', 'user prefers dark mode', { tags: ['pref'] });
      s.write('u', 'the api base url is https://api.example.com', { tags: ['config'] });

      expect(s.read('u', a.id)!.text).toBe('user prefers dark mode');
      expect(s.search('u', 'dark mode preference')[0]!.text).toContain('dark mode');
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

    it('isolates scopes', () => {
      const s = make();
      s.write('alice', 'alice secret');
      s.write('bob', 'bob secret');
      expect(s.list('alice').length).toBe(1);
      expect(s.search('bob', 'alice')).toEqual([]);
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

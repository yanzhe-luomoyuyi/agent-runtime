import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CachingModelProvider, InMemoryResponseCache } from '../src/model/caching.js';
import { MockModelProvider, type ModelProvider, type ModelResult } from '../src/model/provider.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';
import { issueWorkflow } from '../src/workflow.js';

/** Counts how many calls actually reach the underlying model (i.e. cache misses). */
class CountingModel implements ModelProvider {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly inner: ModelProvider) {}
  async complete(prompt: string): Promise<ModelResult> {
    this.calls++;
    return this.inner.complete(prompt);
  }
}

function makeTools(): ToolRegistry {
  const getIssue: ToolDef<{ issue: string }> = {
    name: 'getIssue',
    description: '',
    inputSchema: {},
    run: (a) => ({ title: a.issue.slice(0, 40), body: a.issue, labels: ['bug'] }),
  };
  const searchCode: ToolDef = {
    name: 'searchCode',
    description: '',
    inputSchema: {},
    run: () => ({ files: ['src/auth/login.ts'] }),
  };
  return new ToolRegistry().register(getIssue).register(searchCode);
}

describe('CachingModelProvider', () => {
  it('serves identical prompts from cache; distinct prompts miss', async () => {
    const inner = new CountingModel(new MockModelProvider({}));
    const cached = new CachingModelProvider(inner, new InMemoryResponseCache());

    const a = await cached.complete('hello world');
    const b = await cached.complete('hello world');
    const c = await cached.complete('a different prompt');

    expect(inner.calls).toBe(2); // only the 2 distinct prompts reached the model
    expect(a.cached ?? false).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.text).toBe(a.text);
    expect(c.cached).toBe(false);
    expect(cached.hits).toBe(1);
    expect(cached.misses).toBe(2);
  });

  it('a second run with the same issue serves its model calls from the cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cache-'));
    const inner = new CountingModel(
      new MockModelProvider({ 'analyze.summary': 'summary', 'propose.fix': 'Guard the null session' }),
    );
    const model = new CachingModelProvider(inner); // shared across both runs

    const rt1 = new Runtime({ baseDir: dir, model, tools: makeTools(), workflow: issueWorkflow });
    await rt1.run('Login crashes with a null session');
    expect(inner.calls).toBe(2); // run 1: two cache misses reach the model

    const rt2 = new Runtime({ baseDir: dir, model, tools: makeTools(), workflow: issueWorkflow });
    const s2 = await rt2.run('Login crashes with a null session'); // identical issue → identical prompts
    expect(inner.calls).toBe(2); // run 2 added zero — both model calls hit the cache

    const totals = rt2.trace(s2.runId).totals;
    expect(totals.cachedModelCalls).toBe(2);
    expect(totals.costSavedUsd).toBeGreaterThan(0);
  });

  it('normalizes whitespace so trivial formatting differences still hit', async () => {
    const inner = new CountingModel(new MockModelProvider({}));
    const cached = new CachingModelProvider(inner);
    await cached.complete('hello   world');
    const b = await cached.complete('  hello world  ');
    expect(inner.calls).toBe(1); // second served from cache despite the spacing
    expect(b.cached).toBe(true);
  });

  it('evicts least-recently-used entries when the store is full', () => {
    const cache = new InMemoryResponseCache(2);
    const entry = (text: string): ModelResult => ({ text, promptTokens: 1, completionTokens: 1 });
    cache.set('a', entry('a'));
    cache.set('b', entry('b'));
    cache.get('a'); // touch 'a' → 'b' becomes least-recently-used
    cache.set('c', entry('c')); // over capacity (2) → evict 'b'
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('accepts a custom key function (decoupled keying)', async () => {
    const inner = new CountingModel(new MockModelProvider({}));
    const cached = new CachingModelProvider(inner, new InMemoryResponseCache(), () => 'same-slot');
    await cached.complete('totally different A');
    const b = await cached.complete('totally different B');
    expect(inner.calls).toBe(1); // both map to one key → second is a hit
    expect(b.cached).toBe(true);
  });
});

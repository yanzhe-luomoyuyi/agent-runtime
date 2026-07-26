import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { MockAgentModel } from '../src/app/agent-scenario.js';
import { registerDocumentTools } from '../src/app/document-tools.js';
import { createHarnessWorkflow } from '../src/app/harness-adapter.js';
import { EventLog, runDir } from '../src/eventlog.js';
import {
  InMemoryDocumentStore,
  resolveRetrievalPolicy,
  StoreRetriever,
  systemRetrieveOnce,
} from '../src/retrieval/index.js';
import { HashingEmbeddingProvider } from '../src/memory/embedding.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';

describe('resolveRetrievalPolicy', () => {
  it('defaults to once with no extra agentic retrieves', () => {
    expect(resolveRetrievalPolicy()).toMatchObject({
      mode: 'once',
      maxExtra: 0,
      maxRetrieves: 1,
      maxChunks: 5,
      rankMode: 'lexical',
    });
  });

  it('gives capped_agentic a small extra budget by default', () => {
    expect(resolveRetrievalPolicy({ mode: 'capped_agentic' })).toMatchObject({
      mode: 'capped_agentic',
      maxExtra: 2,
      maxRetrieves: 3,
    });
  });
});

describe('InMemoryDocumentStore + systemRetrieveOnce', () => {
  it('ranks chunks and respects corpus allow-list', async () => {
    const store = new InMemoryDocumentStore();
    store.upsert('docs', [
      { id: '1', text: 'Session null pointer crashes the login page.', metadata: { src: 'a.md' } },
      { id: '2', text: 'Billing invoices are emailed monthly.', metadata: { src: 'b.md' } },
    ]);
    const retriever = new StoreRetriever(store);

    const ok = await systemRetrieveOnce({
      retriever,
      query: 'login crash session',
      corpusId: 'docs',
      policy: { mode: 'once', maxChunks: 2 },
    });
    expect(ok.retrieved).toBe(true);
    expect(ok.hits[0]!.id).toBe('1');
    expect(ok.retrievesUsed).toBe(1);

    const denied = await systemRetrieveOnce({
      retriever,
      query: 'login',
      corpusId: 'docs',
      policy: { mode: 'once', corpora: ['other'] },
    });
    expect(denied.skippedReason).toBe('corpus_denied');
    expect(denied.hits).toEqual([]);
  });

  it('skips when mode is off', async () => {
    const store = new InMemoryDocumentStore();
    store.upsert('docs', [{ id: '1', text: 'hello', metadata: {} }]);
    const result = await systemRetrieveOnce({
      retriever: new StoreRetriever(store),
      query: 'hello',
      corpusId: 'docs',
      policy: { mode: 'off' },
    });
    expect(result.skippedReason).toBe('off');
    expect(result.retrievesUsed).toBe(0);
  });

  it('exposes RRF scores in hybrid mode and truncates search text when asked', async () => {
    const store = new InMemoryDocumentStore(new HashingEmbeddingProvider());
    store.upsert('docs', [
      { id: 'lex-win', text: 'exact token login session crash login session', metadata: {} },
      { id: 'other', text: 'unrelated billing invoice totals', metadata: {} },
    ]);

    const hybrid = await store.search('docs', 'login session crash', { mode: 'hybrid', limit: 2 });
    expect(hybrid.length).toBeGreaterThan(0);
    // Scores must be RRF-scale (~1/61 ≈ 0.016 per list), not lexical overlap counts.
    expect(hybrid[0]!.score).toBeLessThan(1);
    expect(hybrid[0]!.score).toBeGreaterThan(0);
    for (let i = 1; i < hybrid.length; i++) {
      expect(hybrid[i - 1]!.score).toBeGreaterThanOrEqual(hybrid[i]!.score);
    }

    const long = 'abcdefghijklmnopqrstuvwxyz';
    store.upsert('docs', [{ id: 'long', text: long, metadata: {} }]);
    const truncated = await store.search('docs', 'abcdefghijklmnopqrstuvwxyz', {
      mode: 'lexical',
      maxTextChars: 8,
    });
    expect(truncated[0]!.text).toBe('abcdefgh');
    expect(store.get('docs', 'long')!.text).toBe(long); // store keeps full text
  });
});

describe('query-time RAG on harness workflow', () => {
  let baseDir: string;
  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rag-rt-'));
  });

  it('system-retrieves once via document_search; model never calls it in once mode', async () => {
    const store = new InMemoryDocumentStore();
    store.upsert('kb', [
      {
        id: 'login-doc',
        text: 'The login page crashes when session is null. Fix in src/auth/session.ts.',
        metadata: {},
      },
    ]);

    let searchRuns = 0;
    const tools = new ToolRegistry();
    registerDocumentTools(tools, store, 'kb');
    const original = tools.get('document_search');
    tools.register({
      ...original,
      run: (args) => {
        searchRuns++;
        return original.run(args);
      },
    });

    const getIssue: ToolDef<{ issue: string }> = {
      name: 'getIssue',
      description: 'fetch issue',
      inputSchema: { type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'] },
      run: (args) => ({ title: args.issue, body: args.issue, labels: ['bug'] }),
    };
    const searchCode: ToolDef<{ query: string }> = {
      name: 'searchCode',
      description: 'search code',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: () => ({ files: ['src/auth/session.ts'] }),
    };
    tools.register(getIssue).register(searchCode);

    const runtime = new Runtime({
      baseDir,
      model: new MockAgentModel(),
      tools,
      workflow: createHarnessWorkflow({
        retrieval: { corpusId: 'kb', policy: { mode: 'once' } },
      }),
    });

    const state = await runtime.run('Login page crashes with a null session');
    expect(state.status).toBe('completed');
    expect(searchRuns).toBe(1); // system once only
    const summary = state.summary as { toolsUsed?: string[]; proposal?: string };
    expect(summary.toolsUsed).toEqual(['getIssue', 'searchCode']);
    expect(summary.toolsUsed).not.toContain('document_search');
    expect(summary.proposal).toContain('session');

    const events = new EventLog(runDir(baseDir, state.runId)).all();
    const searches = events.filter(
      (e) => e.type === 'ToolCallSucceeded' && (e as { tool?: string }).tool === 'document_search',
    );
    expect(searches.length).toBe(1);
    expect(JSON.stringify((searches[0] as { result: unknown }).result)).toContain('session');
  });
});

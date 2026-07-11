import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createHarnessWorkflow } from '../src/app/harness-adapter.js';
import { registerMemoryTools } from '../src/app/memory-tools.js';
import { EventLog, runDir } from '../src/eventlog.js';
import type { ModelProvider, ModelResult } from '../src/model/provider.js';
import { estimateTokens } from '../src/model/provider.js';
import { FileMemoryStore } from '../src/memory/store.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry } from '../src/tools/registry.js';

/** A scripted brain: writes memory when asked to "Remember:", else searches it. */
class MemoryScriptModel implements ModelProvider {
  readonly name = 'memory-script';
  async complete(prompt: string): Promise<ModelResult> {
    const goal = /Goal:\s*(.+)/.exec(prompt)?.[1]?.trim() ?? '';
    const called = new Set<string>();
    for (const m of prompt.matchAll(/called (\w+)\(/g)) if (m[1]) called.add(m[1]);

    let decision: unknown;
    if (/^Remember:/i.test(goal)) {
      decision = called.has('memory_write')
        ? { action: 'finish', answer: 'stored' }
        : { action: 'call_tool', tool: 'memory_write', args: { text: goal.replace(/^Remember:\s*/i, '') } };
    } else {
      decision = called.has('memory_search')
        ? { action: 'finish', answer: 'recalled preferences' }
        : { action: 'call_tool', tool: 'memory_search', args: { query: goal } };
    }
    const text = JSON.stringify(decision);
    return { text, promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(text) };
  }
}

let baseDir: string;
let memDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'memory-rt-'));
  memDir = mkdtempSync(join(tmpdir(), 'memory-store-'));
});

describe('cross-session memory through the durable seam', () => {
  it('persists a memory in one run and reads it in another, with reads logged', async () => {
    const store = new FileMemoryStore(memDir); // survives across "sessions"
    const scope = 'user-42';
    const tools = new ToolRegistry();
    registerMemoryTools(tools, store, scope);

    const model = new MemoryScriptModel();
    const workflow = createHarnessWorkflow();

    // Session 1: write a durable memory.
    const s1 = await new Runtime({ baseDir, model, tools, workflow }).run('Remember: the user prefers dark mode');
    expect(s1.status).toBe('completed');
    expect(store.list(scope).map((r) => r.text)).toEqual(['the user prefers dark mode']);

    // Session 2 (new run, SAME store): recall it.
    const s2 = await new Runtime({ baseDir, model, tools, workflow }).run('What are the user preferences?');
    expect(s2.status).toBe('completed');

    // The memory_search executed through ctx.callTool → recorded in run 2's log,
    // which is exactly what makes replay deterministic even if the store changes.
    const events = new EventLog(runDir(baseDir, s2.runId)).all();
    const memoryReads = events.filter((e) => e.type === 'ToolCallSucceeded' && String((e as { tool?: string }).tool).startsWith('memory_'));
    expect(memoryReads.length).toBeGreaterThan(0);
    expect(JSON.stringify((memoryReads[0] as { result: unknown }).result)).toContain('dark mode');
  });

  it('keeps memories isolated per scope', () => {
    const store = new FileMemoryStore(memDir);
    store.write('alice', 'alice likes tabs');
    store.write('bob', 'bob likes spaces');
    expect(store.list('alice').map((r) => r.text)).toEqual(['alice likes tabs']);
    expect(store.search('bob', 'tabs')).toEqual([]); // alice's memory never leaks to bob
  });
});

/**
 * Long-term memory: config + cross-run FileMemoryStore via coding-agent factory.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoApprove } from '@agent/harness';
import { EventLog, FileMemoryStore, runDir } from 'durable-agent-runtime';
import { describe, expect, it } from 'vitest';

import {
  CODING_CONFIG_DEFAULTS,
  applyEnvOverrides,
  loadCodingConfig,
} from '../src/config.js';
import {
  MEMORY_TOOL_NAMES,
  withMemoryToolsAllowed,
  workspaceMemoryScope,
} from '../src/memory.js';
import { createCodingRuntime } from '../src/runtime-factory.js';
import { finalTurn, ScriptedChatProvider, toolTurn } from './scripted-chat.js';

describe('long-term memory config', () => {
  it('defaults memory off with a package-local storeDir', () => {
    const cfg = loadCodingConfig({ skipEnv: true });
    expect(cfg.run.memory.enabled).toBe(false);
    expect(cfg.run.memory.storeDir).toBe('.coding-agent-memory');
    expect(CODING_CONFIG_DEFAULTS.run.memory.enabled).toBe(false);
  });

  it('applies AGENT_LONG_TERM_MEMORY / AGENT_MEMORY_DIR env overlays', () => {
    const base = loadCodingConfig({ skipEnv: true });
    const on = applyEnvOverrides(base, {
      AGENT_LONG_TERM_MEMORY: '1',
      AGENT_MEMORY_DIR: '/tmp/mem-store',
    });
    expect(on.run.memory.enabled).toBe(true);
    expect(on.run.memory.storeDir).toBe('/tmp/mem-store');

    const off = applyEnvOverrides(
      { ...base, run: { ...base.run, memory: { ...base.run.memory, enabled: true } } },
      { AGENT_LONG_TERM_MEMORY: '0' },
    );
    expect(off.run.memory.enabled).toBe(false);
  });

  it('merges memory tools into the allow-list', () => {
    expect(withMemoryToolsAllowed(['read_file'])).toEqual([
      'read_file',
      ...MEMORY_TOOL_NAMES,
    ]);
  });

  it('scopes memory per workspace path', () => {
    expect(workspaceMemoryScope('/a/repo')).not.toBe(workspaceMemoryScope('/b/repo'));
    expect(workspaceMemoryScope('/a/repo')).toBe(workspaceMemoryScope('/a/repo'));
  });
});

describe('long-term memory across runs', () => {
  it('persists a write in run 1 and recalls it in run 2 when enabled', async () => {
    const work = mkdtempSync(join(tmpdir(), 'coding-mem-ws-'));
    const runs = mkdtempSync(join(tmpdir(), 'coding-mem-runs-'));
    const memDir = mkdtempSync(join(tmpdir(), 'coding-mem-store-'));
    const scope = workspaceMemoryScope(work);

    const cfg = loadCodingConfig({ skipEnv: true });
    cfg.run.memory = { enabled: true, storeDir: memDir };

    const writer = new ScriptedChatProvider([
      toolTurn([{ name: 'memory_write', arguments: { text: 'prefer tabs over spaces' } }]),
      finalTurn('stored'),
    ]);
    const reader = new ScriptedChatProvider([
      toolTurn([{ name: 'memory_search', arguments: { query: 'tabs spaces preference' } }]),
      finalTurn('recalled'),
    ]);

    try {
      const rt1 = createCodingRuntime({
        baseDir: runs,
        workspaceRoot: work,
        chatModel: writer,
        approver: autoApprove,
        autoApproveWrites: true,
        longTermMemory: true,
        config: cfg,
        maxTurns: 6,
      });
      const s1 = await rt1.run('Remember: prefer tabs over spaces');
      expect(s1.status).toBe('completed');
      expect(new FileMemoryStore(memDir).list(scope).map((r) => r.text)).toEqual([
        'prefer tabs over spaces',
      ]);

      const rt2 = createCodingRuntime({
        baseDir: runs,
        workspaceRoot: work,
        chatModel: reader,
        approver: autoApprove,
        autoApproveWrites: true,
        longTermMemory: true,
        config: cfg,
        maxTurns: 6,
      });
      const s2 = await rt2.run('What indentation does the user prefer?');
      expect(s2.status).toBe('completed');

      const events = new EventLog(runDir(runs, s2.runId)).all();
      const memoryOk = events.filter(
        (e) => e.type === 'ToolCallSucceeded' && String((e as { tool?: string }).tool).startsWith('memory_'),
      );
      expect(memoryOk.length).toBeGreaterThan(0);
      expect(JSON.stringify((memoryOk[0] as { result: unknown }).result)).toContain('tabs');
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
      rmSync(memDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not register memory tools when longTermMemory is false', async () => {
    const work = mkdtempSync(join(tmpdir(), 'coding-mem-off-'));
    const runs = mkdtempSync(join(tmpdir(), 'coding-mem-off-runs-'));
    const memDir = mkdtempSync(join(tmpdir(), 'coding-mem-off-store-'));

    const cfg = loadCodingConfig({ skipEnv: true });
    cfg.run.memory = { enabled: true, storeDir: memDir };

    // Model asks for memory_write; with tools off, call should fail / be denied.
    const chatModel = new ScriptedChatProvider([
      toolTurn([{ name: 'memory_write', arguments: { text: 'should not persist' } }]),
      finalTurn('done without memory'),
    ]);

    try {
      const rt = createCodingRuntime({
        baseDir: runs,
        workspaceRoot: work,
        chatModel,
        approver: autoApprove,
        autoApproveWrites: true,
        longTermMemory: false,
        config: cfg,
        maxTurns: 6,
      });
      const state = await rt.run('Remember something');
      expect(state.status).toBe('completed');
      expect(new FileMemoryStore(memDir).list(workspaceMemoryScope(work))).toEqual([]);
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
      rmSync(memDir, { recursive: true, force: true });
    }
  }, 30_000);
});

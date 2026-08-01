/**
 * Dead-letter queue + policy.rateLimits config wiring via coding-agent factory.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoApprove } from '@agent/harness';
import { FileDeadLetterQueue } from 'durable-agent-runtime';
import { describe, expect, it } from 'vitest';

import { CODING_CONFIG_DEFAULTS, configToPolicy, loadCodingConfig } from '../src/config.js';
import { createCodingRuntime } from '../src/runtime-factory.js';
import { finalTurn, ScriptedChatProvider, toolTurn } from './scripted-chat.js';

describe('dead-letter queue config', () => {
  it('defaults dead-letter recording on with a package-local storeDir', () => {
    const cfg = loadCodingConfig({ skipEnv: true });
    expect(cfg.run.deadLetter.enabled).toBe(true);
    expect(cfg.run.deadLetter.storeDir).toBe('.coding-agent-dead-letters');
    expect(CODING_CONFIG_DEFAULTS.run.deadLetter.enabled).toBe(true);
  });
});

describe('policy.rateLimits config', () => {
  it('defaults to no rate limits', () => {
    const cfg = loadCodingConfig({ skipEnv: true });
    expect(configToPolicy(cfg).rateLimits).toBeUndefined();
  });

  it('flows a configured rate limit through configToPolicy', () => {
    const cfg = loadCodingConfig({ skipEnv: true });
    cfg.policy.rateLimits = { run_tests: { capacity: 3, refillPerSec: 0.5 } };
    expect(configToPolicy(cfg).rateLimits).toEqual({
      run_tests: { capacity: 3, refillPerSec: 0.5 },
    });
  });
});

describe('dead-letter queue across a run', () => {
  it('records a tool call that throws for human triage', async () => {
    const work = mkdtempSync(join(tmpdir(), 'coding-dlq-ws-'));
    const runs = mkdtempSync(join(tmpdir(), 'coding-dlq-runs-'));
    const dlqDir = mkdtempSync(join(tmpdir(), 'coding-dlq-store-'));

    const cfg = loadCodingConfig({ skipEnv: true });
    cfg.run.deadLetter = { enabled: true, storeDir: dlqDir };

    // list_dir on a missing path throws a plain (non-transient) Error — no
    // retry, straight to the dead-letter funnel; the loop still self-heals
    // into an ERROR observation and the run completes normally.
    const chatModel = new ScriptedChatProvider([
      toolTurn([{ name: 'list_dir', arguments: { path: 'does-not-exist' } }]),
      finalTurn('gave up after the missing directory'),
    ]);

    try {
      const rt = createCodingRuntime({
        baseDir: runs,
        workspaceRoot: work,
        chatModel,
        approver: autoApprove,
        autoApproveWrites: true,
        config: cfg,
        maxTurns: 6,
      });
      const state = await rt.run('List does-not-exist');
      expect(state.status).toBe('completed');

      const letters = new FileDeadLetterQueue(join(dlqDir, 'queue.json')).list();
      expect(letters).toHaveLength(1);
      expect(letters[0]?.tool).toBe('list_dir');
      expect(letters[0]?.error).toContain('path not found');
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
      rmSync(dlqDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not record failures when deadLetter is disabled', async () => {
    const work = mkdtempSync(join(tmpdir(), 'coding-dlq-off-ws-'));
    const runs = mkdtempSync(join(tmpdir(), 'coding-dlq-off-runs-'));
    const dlqDir = mkdtempSync(join(tmpdir(), 'coding-dlq-off-store-'));

    const cfg = loadCodingConfig({ skipEnv: true });
    cfg.run.deadLetter = { enabled: true, storeDir: dlqDir };

    const chatModel = new ScriptedChatProvider([
      toolTurn([{ name: 'list_dir', arguments: { path: 'does-not-exist' } }]),
      finalTurn('gave up'),
    ]);

    try {
      const rt = createCodingRuntime({
        baseDir: runs,
        workspaceRoot: work,
        chatModel,
        approver: autoApprove,
        autoApproveWrites: true,
        deadLetter: false, // per-run override wins over cfg.run.deadLetter.enabled
        config: cfg,
        maxTurns: 6,
      });
      const state = await rt.run('List does-not-exist');
      expect(state.status).toBe('completed');
      expect(new FileDeadLetterQueue(join(dlqDir, 'queue.json')).list()).toEqual([]);
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
      rmSync(dlqDir, { recursive: true, force: true });
    }
  }, 30_000);
});

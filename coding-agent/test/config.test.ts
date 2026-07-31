/**
 * Unified agent.config.json loader.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CODING_CONFIG_DEFAULTS,
  applyEnvOverrides,
  loadCodingConfig,
  resolvePackagePath,
} from '../src/config.js';
import { PACKAGE_ROOT } from '../src/paths.js';

describe('loadCodingConfig', () => {
  it('loads package agent.config.json over built-in defaults', () => {
    const cfg = loadCodingConfig({ skipEnv: true });
    expect(cfg.agent.name).toBe('coding-agent');
    expect(cfg.agent.skillLoadMode).toBe('eager');
    expect(cfg.agent.instructions).toContain('sandboxed workspace');
    expect(cfg.model.model).toBe('deepseek-chat');
    expect(cfg.run.maxTurns).toBe(36);
    expect(cfg.policy.allowedTools).toContain('write_file');
    expect(cfg.pricing?.promptUsdPerToken).toBe(0.00000014);
    expect(cfg.tools.runTests.command).toEqual(['npm', 'test']);
    expect(cfg.run.scratchpad.enabled).toBe(true);
    expect(cfg.run.scratchpad.offloadThreshold).toBe(24_000);
    expect(cfg.run.scratchpad.neverOffload).toEqual(['read_file', 'list_dir', 'list_tree', 'grep']);
    expect(cfg.run.memory.enabled).toBe(false);
    expect(cfg.run.memory.storeDir).toBe('.coding-agent-memory');
    expect(cfg.run.loopMode).toBe('agent');
    expect(cfg.run.planner.maxReplans).toBe(2);
    expect(cfg.run.reflection.maxReflections).toBe(1);
    expect(cfg.policy.allowedTools).toContain('list_tree');
  });

  it('merges a partial overlay file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cfg-'));
    const path = join(dir, 'agent.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        agent: { instructions: 'CUSTOM PERSONA' },
        run: { maxTurns: 7, compaction: { softCapTokens: 50_000 } },
        policy: { maxCostUsd: 0.25 },
      }),
    );
    try {
      const cfg = loadCodingConfig({ path, skipEnv: true });
      expect(cfg.agent.instructions).toBe('CUSTOM PERSONA');
      expect(cfg.agent.name).toBe(CODING_CONFIG_DEFAULTS.agent.name);
      expect(cfg.run.maxTurns).toBe(7);
      expect(cfg.run.compaction.softCapTokens).toBe(50_000);
      expect(cfg.run.compaction.threshold).toBe(CODING_CONFIG_DEFAULTS.run.compaction.threshold);
      expect(cfg.policy.maxCostUsd).toBe(0.25);
      expect(cfg.policy.allowedTools).toEqual(CODING_CONFIG_DEFAULTS.policy.allowedTools);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies env overlays after the file', () => {
    const base = loadCodingConfig({ skipEnv: true });
    const cfg = applyEnvOverrides(base, {
      AGENT_MAX_TURNS: '3',
      AGENT_AUTO_APPROVE: '1',
      AGENT_RUNS_DIR: '/tmp/runs',
      AGENT_MAX_PROMPT_TOKENS: '4000',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
    });
    expect(cfg.run.maxTurns).toBe(3);
    expect(cfg.run.autoApproveWrites).toBe(true);
    expect(cfg.run.runsDir).toBe('/tmp/runs');
    expect(cfg.run.compaction.softCapTokens).toBe(4000);
    expect(cfg.model.model).toBe('deepseek-reasoner');
  });

  it('resolves package-relative paths', () => {
    expect(resolvePackagePath('skills/coding-agent/SKILL.md')).toBe(
      join(PACKAGE_ROOT, 'skills', 'coding-agent', 'SKILL.md'),
    );
    expect(resolvePackagePath('/abs/skill.md')).toBe('/abs/skill.md');
  });
});

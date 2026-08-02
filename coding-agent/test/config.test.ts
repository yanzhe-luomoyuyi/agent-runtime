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
    expect(cfg.tools.verify.recipes.test?.command).toEqual(['npm', 'test']);
    expect(cfg.tools.verify.recipes.build?.command).toEqual(['npm', 'run', 'build']);
    expect(cfg.tools.verify.recipes.typecheck?.command).toEqual(['npm', 'run', 'typecheck']);
    expect(cfg.policy.allowedTools).toContain('run_check');
    expect(cfg.tools.verify.timeoutMs).toBe(120_000);
    expect(cfg.run.scratchpad.enabled).toBe(true);
    expect(cfg.run.scratchpad.offloadThreshold).toBe(24_000);
    expect(cfg.run.scratchpad.neverOffload).toEqual(['read_file', 'list_dir', 'list_tree', 'grep']);
    expect(cfg.run.memory.enabled).toBe(false);
    expect(cfg.run.memory.storeDir).toBe('.coding-agent-memory');
    expect(cfg.run.loopMode).toBe('agent');
    expect(cfg.run.loop.windowSize).toBe(16);
    expect(cfg.run.loop.toolLimits?.read_file).toBe(8);
    expect(cfg.run.loop.toolLimits?.run_tests).toBe(6);
    expect(cfg.run.loop.toolLimits?.write_file).toBe(3);
    expect(cfg.run.loop.toolLimits?.delete_file).toBe(2);
    expect(cfg.run.planner.maxReplans).toBe(2);
    expect(cfg.run.reflection.maxReflections).toBe(1);
    expect(cfg.run.toolConcurrency).toBe(8);
    expect(cfg.run.toolRetry).toEqual({ retries: 2 });
    expect(cfg.model.fallbacks).toEqual([]);
    expect(cfg.policy.allowedTools).toContain('list_tree');
    expect(cfg.policy.allowedTools).toContain('extract_top_comments');
  });

  it('merges a partial overlay file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cfg-'));
    const path = join(dir, 'agent.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        agent: { instructions: 'CUSTOM PERSONA' },
        run: { maxTurns: 7, compaction: { softCapTokens: 50_000 }, toolConcurrency: 4 },
        model: {
          fallbacks: [
            {
              baseUrl: 'https://api.openai.com/v1',
              model: 'gpt-4o-mini',
              apiKeyEnv: 'OPENAI_API_KEY',
            },
          ],
        },
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
      expect(cfg.run.toolConcurrency).toBe(4);
      expect(cfg.model.fallbacks).toHaveLength(1);
      expect(cfg.model.fallbacks[0]?.apiKeyEnv).toBe('OPENAI_API_KEY');
      expect(cfg.policy.maxCostUsd).toBe(0.25);
      expect(cfg.policy.allowedTools).toEqual(CODING_CONFIG_DEFAULTS.policy.allowedTools);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can disable toolRetry via overlay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cfg-retry-'));
    const path = join(dir, 'agent.config.json');
    writeFileSync(path, JSON.stringify({ run: { toolRetry: false } }));
    try {
      const cfg = loadCodingConfig({ path, skipEnv: true });
      expect(cfg.run.toolRetry).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges run.loop overlay over coding defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cfg-loop-'));
    const path = join(dir, 'agent.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        run: {
          loop: {
            windowSize: 24,
            toolLimits: { read_file: 12, run_tests: 4 },
          },
        },
      }),
    );
    try {
      const cfg = loadCodingConfig({ path, skipEnv: true });
      expect(cfg.run.loop.windowSize).toBe(24);
      expect(cfg.run.loop.toolLimits?.read_file).toBe(12);
      expect(cfg.run.loop.toolLimits?.run_tests).toBe(4);
      // Untouched entries keep the coding defaults.
      expect(cfg.run.loop.toolLimits?.write_file).toBe(
        CODING_CONFIG_DEFAULTS.run.loop.toolLimits?.write_file,
      );
      expect(cfg.run.loop.toolLimits?.delete_file).toBe(
        CODING_CONFIG_DEFAULTS.run.loop.toolLimits?.delete_file,
      );
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

  it('wires policy.redactions from config names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cfg-redact-'));
    const path = join(dir, 'agent.config.json');
    writeFileSync(path, JSON.stringify({ policy: { redactions: ['email', 'secret'] } }));
    try {
      const cfg = loadCodingConfig({ path, skipEnv: true });
      expect(cfg.policy.redactions?.map((r) => r.name)).toEqual(['email', 'secret']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges legacy tools.runTests into verify.recipes.test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cfg-legacy-test-'));
    const path = join(dir, 'agent.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        tools: {
          runTests: {
            command: ['npm', 'test', '--', 'legacy'],
            timeoutMs: 9_000,
            maxOutputChars: 1_000,
          },
        },
      }),
    );
    try {
      const cfg = loadCodingConfig({ path, skipEnv: true });
      expect(cfg.tools.verify.recipes.test?.command).toEqual(['npm', 'test', '--', 'legacy']);
      expect(cfg.tools.verify.timeoutMs).toBe(9_000);
      expect(cfg.tools.verify.maxOutputChars).toBe(1_000);
      expect(cfg.tools.verify.recipes.build?.command).toEqual(['npm', 'run', 'build']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges verify.recipes overlay (argv shorthand)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cfg-verify-'));
    const path = join(dir, 'agent.config.json');
    writeFileSync(
      path,
      JSON.stringify({
        tools: {
          verify: {
            recipes: {
              lint: ['npm', 'run', 'lint'],
              test: ['pnpm', 'test'],
            },
          },
        },
      }),
    );
    try {
      const cfg = loadCodingConfig({ path, skipEnv: true });
      expect(cfg.tools.verify.recipes.lint?.command).toEqual(['npm', 'run', 'lint']);
      expect(cfg.tools.verify.recipes.test?.command).toEqual(['pnpm', 'test']);
      expect(cfg.tools.verify.recipes.typecheck?.command).toEqual(['npm', 'run', 'typecheck']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Unified coding-agent config — tunable defaults live in agent.config.json;
 * code merges file → env → call-site overrides.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { ModelPricing, Policy } from 'durable-agent-runtime';

import { PACKAGE_ROOT } from './paths.js';

export type SkillLoadMode = 'eager' | 'on_demand';

export interface CodingAgentSection {
  name: string;
  instructions: string;
  /** Relative to package root, or absolute. */
  skillPath: string;
  skillLoadMode: SkillLoadMode;
}

export interface CodingModelSection {
  provider: string;
  baseUrl: string;
  model: string;
  /** Primary env var for the API key. */
  apiKeyEnv: string;
  /** Extra env vars tried after apiKeyEnv. */
  apiKeyEnvFallbacks: string[];
  baseUrlEnv: string;
  modelEnv: string;
}

export interface CodingWorkspaceSection {
  /** Relative to package root, or absolute. */
  defaultRoot: string;
}

export interface CodingToolsSection {
  readFileDefaultLimit: number;
  readFileMaxChars: number;
  grepDefaultMatches: number;
  runTests: {
    command: string[];
    timeoutMs: number;
    maxOutputChars: number;
  };
}

export interface CodingRunSection {
  maxTurns: number;
  runsDir: string;
  /** When true, skip mutating FS tool HITL (write/str_replace/delete/apply_patch; same as AGENT_AUTO_APPROVE=1). */
  autoApproveWrites: boolean;
  compaction: {
    softCapTokens: number;
    threshold: number;
  };
  /**
   * Oversized tool results → scratchpad pointer (no LLM summarize by default).
   * `scratchpad_read` / `scratchpad_list` are advertised to the model when enabled.
   * Prefer `neverOffload` for tools the model already requested in full (read/list/grep).
   */
  scratchpad: {
    enabled: boolean;
    offloadThreshold: number;
    previewChars: number;
    /** Tool names whose results stay inline even above the threshold. */
    neverOffload: string[];
  };
}

export interface CodingConfigFile {
  agent?: Partial<CodingAgentSection>;
  model?: Partial<CodingModelSection> & {
    apiKeyEnvFallbacks?: string[];
  };
  workspace?: Partial<CodingWorkspaceSection>;
  tools?: Partial<Omit<CodingToolsSection, 'runTests'>> & {
    runTests?: Partial<CodingToolsSection['runTests']>;
  };
  run?: Partial<Omit<CodingRunSection, 'compaction' | 'scratchpad'>> & {
    compaction?: Partial<CodingRunSection['compaction']>;
    scratchpad?: Partial<CodingRunSection['scratchpad']>;
  };
  policy?: {
    allowedTools?: string[];
    maxCostUsd?: number;
    redactions?: string[];
  };
  pricing?: Partial<ModelPricing>;
}

export interface CodingConfig {
  agent: CodingAgentSection;
  model: CodingModelSection;
  workspace: CodingWorkspaceSection;
  tools: CodingToolsSection;
  run: CodingRunSection;
  policy: Policy;
  pricing?: ModelPricing;
}

/** Built-in defaults when agent.config.json omits a field. */
export const CODING_CONFIG_DEFAULTS: CodingConfig = {
  agent: {
    name: 'coding-agent',
    instructions:
      'You are a coding agent operating inside a sandboxed workspace. ' +
      'Follow the coding-agent skill. ' +
      'For Q&A / explain goals with no code change: use read tools only and put the full answer in the final reply — do not write ANALYSIS.md or other files unless the user explicitly names an output file. ' +
      'Explore with list_tree (shallow) + grep first; read README/index/entrypoints before deep source; prefer read_file offset/limit slices; avoid listing every subdirectory one-by-one. ' +
      'For fix/implement goals: analyze with targeted grep/read_file slices, edit with apply_patch or str_replace, run_tests, then document as the skill says. ' +
      'Never invent file paths — only use paths you observed from tools.',
    skillPath: 'skills/coding-agent/SKILL.md',
    skillLoadMode: 'eager',
  },
  model: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKeyEnvFallbacks: ['LLM_API_KEY'],
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    modelEnv: 'DEEPSEEK_MODEL',
  },
  workspace: {
    defaultRoot: 'fixtures/coding-sandbox',
  },
  tools: {
    readFileDefaultLimit: 200,
    readFileMaxChars: 80_000,
    grepDefaultMatches: 40,
    runTests: {
      command: ['npm', 'test'],
      timeoutMs: 60_000,
      maxOutputChars: 40_000,
    },
  },
  run: {
    maxTurns: 36,
    runsDir: '.coding-agent-runs',
    autoApproveWrites: false,
    compaction: {
      softCapTokens: 128_000,
      threshold: 0.85,
    },
    scratchpad: {
      enabled: true,
      /** Large enough that typical source reads stay inline; still caps huge run_tests dumps. */
      offloadThreshold: 24_000,
      previewChars: 300,
      neverOffload: ['read_file', 'list_dir', 'list_tree', 'grep'],
    },
  },
  policy: {
    allowedTools: [
      'list_dir',
      'list_tree',
      'grep',
      'read_file',
      'write_file',
      'str_replace',
      'delete_file',
      'apply_patch',
      'run_tests',
    ],
    maxCostUsd: 1.0,
  },
};

function deepMergeConfig(base: CodingConfig, overlay: CodingConfigFile): CodingConfig {
  return {
    agent: { ...base.agent, ...overlay.agent },
    model: {
      ...base.model,
      ...overlay.model,
      apiKeyEnvFallbacks: overlay.model?.apiKeyEnvFallbacks ?? base.model.apiKeyEnvFallbacks,
    },
    workspace: { ...base.workspace, ...overlay.workspace },
    tools: {
      ...base.tools,
      ...overlay.tools,
      runTests: { ...base.tools.runTests, ...overlay.tools?.runTests },
    },
    run: {
      ...base.run,
      ...overlay.run,
      compaction: { ...base.run.compaction, ...overlay.run?.compaction },
      scratchpad: {
        ...base.run.scratchpad,
        ...overlay.run?.scratchpad,
        neverOffload: overlay.run?.scratchpad?.neverOffload ?? base.run.scratchpad.neverOffload,
      },
    },
    policy: {
      allowedTools: overlay.policy?.allowedTools ?? base.policy.allowedTools,
      maxCostUsd: overlay.policy?.maxCostUsd ?? base.policy.maxCostUsd,
    },
    pricing: overlay.pricing
      ? ({ ...(base.pricing ?? {}), ...overlay.pricing } as ModelPricing)
      : base.pricing,
  };
}

/** Apply env overlays on top of a merged config (file + defaults). */
export function applyEnvOverrides(
  cfg: CodingConfig,
  env: NodeJS.ProcessEnv = process.env,
): CodingConfig {
  const maxTurns = numEnv(env, 'AGENT_MAX_TURNS');
  const softCap = numEnv(env, 'AGENT_MAX_PROMPT_TOKENS');
  const autoApprove =
    env.AGENT_AUTO_APPROVE === '1' ? true : env.AGENT_AUTO_APPROVE === '0' ? false : undefined;

  return {
    ...cfg,
    model: {
      ...cfg.model,
      baseUrl: env[cfg.model.baseUrlEnv] ?? env.LLM_BASE_URL ?? cfg.model.baseUrl,
      model: env[cfg.model.modelEnv] ?? env.LLM_MODEL ?? cfg.model.model,
    },
    workspace: {
      ...cfg.workspace,
      defaultRoot: env.AGENT_WORKSPACE ?? cfg.workspace.defaultRoot,
    },
    run: {
      ...cfg.run,
      maxTurns: maxTurns ?? cfg.run.maxTurns,
      runsDir: env.AGENT_RUNS_DIR ?? cfg.run.runsDir,
      autoApproveWrites: autoApprove ?? cfg.run.autoApproveWrites,
      compaction: {
        ...cfg.run.compaction,
        softCapTokens: softCap ?? cfg.run.compaction.softCapTokens,
      },
    },
  };
}

function numEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const v = env[name];
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function readCodingConfigFile(
  path = process.env.AGENT_CONFIG ?? join(PACKAGE_ROOT, 'agent.config.json'),
): CodingConfigFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CodingConfigFile;
  } catch {
    return {};
  }
}

/**
 * Load defaults + agent.config.json (+ optional path), then apply env overlays.
 * Call-site overrides still win in createCodingRuntime / CLI.
 */
export function loadCodingConfig(opts?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
  /** Skip env overlays (tests / explicit opts only). */
  skipEnv?: boolean;
}): CodingConfig {
  const file = readCodingConfigFile(opts?.path);
  const merged = deepMergeConfig(CODING_CONFIG_DEFAULTS, file);
  return opts?.skipEnv ? merged : applyEnvOverrides(merged, opts?.env ?? process.env);
}

/** Resolve a config path that may be relative to the package root. */
export function resolvePackagePath(path: string, packageRoot = PACKAGE_ROOT): string {
  return isAbsolute(path) ? path : join(packageRoot, path);
}

export function configToPolicy(cfg: CodingConfig): Policy {
  return {
    allowedTools: cfg.policy.allowedTools,
    maxCostUsd: cfg.policy.maxCostUsd,
  };
}

/**
 * Unified coding-agent config — tunable defaults live in agent.config.json;
 * code merges file → env → call-site overrides.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  resolveRedactions,
  type ModelPricing,
  type Policy,
  type HarnessLoopMode,
  type RateLimitRule,
} from 'durable-agent-runtime';

import { PACKAGE_ROOT } from './paths.js';
import { MUTATING_FS_TOOLS } from './tools/fs-tools.js';

export type SkillLoadMode = 'eager' | 'on_demand';

export interface CodingAgentSection {
  name: string;
  instructions: string;
  /** Relative to package root, or absolute. */
  skillPath: string;
  skillLoadMode: SkillLoadMode;
}

export interface CodingModelFallback {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  name?: string;
}

export interface CodingModelSection {
  provider: string;
  baseUrl: string;
  model: string;
  /** Primary env var for the API key. */
  apiKeyEnv: string;
  /** Extra env vars tried after apiKeyEnv for the *primary* provider key. */
  apiKeyEnvFallbacks: string[];
  baseUrlEnv: string;
  modelEnv: string;
  /**
   * Ordered backup providers when the primary is down / rate-limited.
   * Wired through `createResilientChatProvider` (harness escalation ladder).
   */
  fallbacks: CodingModelFallback[];
}

export interface CodingWorkspaceSection {
  /** Relative to package root, or absolute. */
  defaultRoot: string;
}

export interface CodingVerifyRecipe {
  command: string[];
}

export interface CodingVerifySection {
  timeoutMs: number;
  maxOutputChars: number;
  /**
   * Named allowlisted commands (cwd = workspace root). Built-in keys:
   * `test`, `build`, `typecheck`; hosts may add e.g. `lint`.
   */
  recipes: Record<string, CodingVerifyRecipe>;
}

export interface CodingToolsSection {
  readFileDefaultLimit: number;
  readFileMaxChars: number;
  grepDefaultMatches: number;
  verify: CodingVerifySection;
}

export interface CodingToolRetrySection {
  /** Max additional attempts after the first. Default 2. */
  retries: number;
}

export interface CodingDeadLetterSection {
  /** Record tool calls that exhaust every retry to a durable queue for human triage. */
  enabled: boolean;
  /** Relative to package root, or absolute. */
  storeDir: string;
}

/**
 * Loop-detector tuning (no-progress / repeat detection). Coding defaults
 * relax the harness defaults: read-only and verify tools repeat legitimately
 * (re-read to check state, re-run tests after each edit), so they get higher
 * per-tool limits; write tools keep a strict limit because repeating the same
 * write is a strong stuck-loop signal. See `@agent/harness`'s `LoopDetector`.
 */
export interface CodingLoopSection {
  /** Identical-call repeats within the window before it trips (harness default 3). */
  limit?: number;
  /** Sliding-window size — only the last N calls count (harness default 12). */
  windowSize?: number;
  /** Per-tool overrides for `limit`. */
  toolLimits?: Record<string, number>;
  /**
   * Sequence repeats (A→B,A→B) only count when at least one call is in this
   * set. Default: the mutating FS tools — keeps `write→test` edit-verify
   * cycles detectable without flagging legitimate `grep→read` exploration.
   */
  sequenceMutatingTools?: string[];
  /**
   * Tool names whose SUCCESSFUL call resets that signature's repeat count.
   * A green verify run is progress — identical re-runs stop accumulating
   * suspicion, while repeated FAILURES still pile up and trip.
   */
  successResets?: string[];
}

export interface CodingRunSection {
  maxTurns: number;
  runsDir: string;
  /** When true, skip mutating FS tool HITL (write/str_replace/delete/apply_patch; same as AGENT_AUTO_APPROVE=1). */
  autoApproveWrites: boolean;
  /**
   * Max concurrent tool calls within one turn. `1` = sequential; `>1` runs
   * independent calls in parallel (DeepSeek multi-tool turns).
   */
  toolConcurrency: number;
  /**
   * Retry transient tool failures (spawn / network blips) via `RetryingToolInvoker`.
   * Pass `false` to disable.
   */
  toolRetry: CodingToolRetrySection | false;
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
  /**
   * Cross-session FileMemoryStore (`memory_write` / `search` / `read`).
   * Default off; Workbench toggle / `longTermMemory` / `AGENT_LONG_TERM_MEMORY` override per run.
   */
  memory: {
    /** Default for CLI and UI checkbox when the request omits an override. */
    enabled: boolean;
    /** Relative to package root, or absolute. One JSON file per workspace scope. */
    storeDir: string;
  };
  /** `FileDeadLetterQueue` wiring — see `RuntimeOptions.deadLetterQueue`. */
  deadLetter: CodingDeadLetterSection;
  /** Loop-detector tuning — see `CodingLoopSection`. */
  loop: CodingLoopSection;
  /** Default harness control-flow mode (`agent` | `planner` | `reflection`). */
  loopMode: HarnessLoopMode;
  planner: {
    maxReplans: number;
    replanOnFailure: boolean;
  };
  reflection: {
    maxReflections: number;
  };
}

export interface CodingConfigFile {
  agent?: Partial<CodingAgentSection>;
  model?: Partial<Omit<CodingModelSection, 'apiKeyEnvFallbacks' | 'fallbacks'>> & {
    apiKeyEnvFallbacks?: string[];
    fallbacks?: CodingModelFallback[];
  };
  workspace?: Partial<CodingWorkspaceSection>;
  tools?: Partial<Omit<CodingToolsSection, 'verify'>> & {
    verify?: Partial<Omit<CodingVerifySection, 'recipes'>> & {
      recipes?: Record<string, CodingVerifyRecipe | string[]>;
    };
    /** Legacy: folds into `verify.recipes.test` (+ timeout / maxOutput). */
    runTests?: Partial<{
      command: string[];
      timeoutMs: number;
      maxOutputChars: number;
    }>;
  };
  run?: Partial<
    Omit<
      CodingRunSection,
      'compaction' | 'scratchpad' | 'memory' | 'planner' | 'reflection' | 'toolRetry' | 'deadLetter' | 'loop'
    >
  > & {
    compaction?: Partial<CodingRunSection['compaction']>;
    scratchpad?: Partial<CodingRunSection['scratchpad']>;
    memory?: Partial<CodingRunSection['memory']>;
    planner?: Partial<CodingRunSection['planner']>;
    reflection?: Partial<CodingRunSection['reflection']>;
    toolRetry?: CodingToolRetrySection | false;
    deadLetter?: Partial<CodingDeadLetterSection>;
    loop?: Partial<CodingLoopSection>;
  };
  policy?: {
    allowedTools?: string[];
    maxCostUsd?: number;
    redactions?: string[];
    rateLimits?: Record<string, RateLimitRule>;
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
      'For fix/implement goals: analyze with targeted grep/read_file slices, edit with apply_patch or str_replace, ' +
      'verify with run_check (typecheck/build) and run_tests (prefer a filter when possible), then document as the skill says. ' +
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
    fallbacks: [],
  },
  workspace: {
    /** Overridden by agent.config.json / AGENT_WORKSPACE; resolve relative to package root. */
    defaultRoot: '.',
  },
  tools: {
    readFileDefaultLimit: 200,
    readFileMaxChars: 80_000,
    grepDefaultMatches: 40,
    verify: {
      timeoutMs: 120_000,
      maxOutputChars: 40_000,
      recipes: {
        test: { command: ['npm', 'test'] },
        build: { command: ['npm', 'run', 'build'] },
        typecheck: { command: ['npm', 'run', 'typecheck'] },
      },
    },
  },
  run: {
    maxTurns: 36,
    runsDir: '.coding-agent-runs',
    autoApproveWrites: true,
    toolConcurrency: 8,
    toolRetry: { retries: 2 },
    compaction: {
      softCapTokens: 80_000,
      threshold: 0.85,
    },
    scratchpad: {
      enabled: true,
      /** Large enough that typical source reads stay inline; still caps huge verify dumps. */
      offloadThreshold: 24_000,
      previewChars: 300,
      neverOffload: ['read_file', 'list_dir', 'list_tree', 'grep'],
    },
    memory: {
      enabled: false,
      storeDir: '.coding-agent-memory',
    },
    deadLetter: {
      enabled: true,
      storeDir: '.coding-agent-dead-letters',
    },
    loop: {
      windowSize: 16,
      // Sequence detection only fires on cycles involving a mutating tool —
      // read/verify cycles (grep→read, test→read) repeat legitimately.
      sequenceMutatingTools: [...MUTATING_FS_TOOLS],
      // A green verify run is progress, so it resets that call's repeat count;
      // only repeated failures accumulate and trip the detector.
      successResets: ['run_tests', 'run_check'],
      toolLimits: {
        // Read-only sensing tools repeat legitimately (re-check state after edits).
        read_file: 8,
        grep: 8,
        list_dir: 8,
        list_tree: 8,
        extract_top_comments: 8,
        // Verify tools repeat after every edit — the core edit-verify cycle.
        run_tests: 6,
        run_check: 6,
        // Write tools: repeating the same write is a strong stuck-loop signal.
        write_file: 3,
        str_replace: 3,
        apply_patch: 3,
        delete_file: 2,
      },
    },
    loopMode: 'agent',
    planner: {
      maxReplans: 2,
      replanOnFailure: true,
    },
    reflection: {
      maxReflections: 1,
    },
  },
  policy: {
    allowedTools: [
      'list_dir',
      'list_tree',
      'grep',
      'read_file',
      'extract_top_comments',
      'write_file',
      'str_replace',
      'delete_file',
      'apply_patch',
      'run_tests',
      'run_check',
    ],
    maxCostUsd: 1.0,
  },
};

function normalizeRecipe(
  value: CodingVerifyRecipe | string[] | undefined,
): CodingVerifyRecipe | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    return value.length ? { command: value } : undefined;
  }
  return value.command?.length ? { command: value.command } : undefined;
}

function mergeVerifySection(
  base: CodingVerifySection,
  overlay?: Partial<Omit<CodingVerifySection, 'recipes'>> & {
    recipes?: Record<string, CodingVerifyRecipe | string[]>;
  },
  legacyRunTests?: Partial<{
    command: string[];
    timeoutMs: number;
    maxOutputChars: number;
  }>,
): CodingVerifySection {
  const recipes: Record<string, CodingVerifyRecipe> = { ...base.recipes };
  if (overlay?.recipes) {
    for (const [name, raw] of Object.entries(overlay.recipes)) {
      const normalized = normalizeRecipe(raw);
      if (normalized) recipes[name] = normalized;
    }
  }
  if (legacyRunTests?.command?.length) {
    recipes.test = { command: legacyRunTests.command };
  }
  return {
    timeoutMs: overlay?.timeoutMs ?? legacyRunTests?.timeoutMs ?? base.timeoutMs,
    maxOutputChars:
      overlay?.maxOutputChars ?? legacyRunTests?.maxOutputChars ?? base.maxOutputChars,
    recipes,
  };
}

function deepMergeConfig(base: CodingConfig, overlay: CodingConfigFile): CodingConfig {
  return {
    agent: { ...base.agent, ...overlay.agent },
    model: {
      ...base.model,
      ...overlay.model,
      apiKeyEnvFallbacks: overlay.model?.apiKeyEnvFallbacks ?? base.model.apiKeyEnvFallbacks,
      fallbacks: overlay.model?.fallbacks ?? base.model.fallbacks,
    },
    workspace: { ...base.workspace, ...overlay.workspace },
    tools: {
      ...base.tools,
      ...overlay.tools,
      verify: mergeVerifySection(base.tools.verify, overlay.tools?.verify, overlay.tools?.runTests),
    },
    run: {
      ...base.run,
      ...overlay.run,
      toolRetry:
        overlay.run?.toolRetry === false
          ? false
          : overlay.run?.toolRetry
            ? {
                ...(base.run.toolRetry === false ? { retries: 2 } : base.run.toolRetry),
                ...overlay.run.toolRetry,
              }
            : base.run.toolRetry,
      compaction: { ...base.run.compaction, ...overlay.run?.compaction },
      scratchpad: {
        ...base.run.scratchpad,
        ...overlay.run?.scratchpad,
        neverOffload: overlay.run?.scratchpad?.neverOffload ?? base.run.scratchpad.neverOffload,
      },
      memory: { ...base.run.memory, ...overlay.run?.memory },
      planner: { ...base.run.planner, ...overlay.run?.planner },
      reflection: { ...base.run.reflection, ...overlay.run?.reflection },
      deadLetter: { ...base.run.deadLetter, ...overlay.run?.deadLetter },
      loop: {
        ...base.run.loop,
        ...overlay.run?.loop,
        toolLimits: { ...base.run.loop.toolLimits, ...overlay.run?.loop?.toolLimits },
      },
    },
    policy: {
      allowedTools: overlay.policy?.allowedTools ?? base.policy.allowedTools,
      maxCostUsd: overlay.policy?.maxCostUsd ?? base.policy.maxCostUsd,
      redactions:
        overlay.policy?.redactions !== undefined
          ? resolveRedactions(overlay.policy.redactions)
          : base.policy.redactions,
      rateLimits: overlay.policy?.rateLimits ?? base.policy.rateLimits,
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
  const longTermMemory =
    env.AGENT_LONG_TERM_MEMORY === '1'
      ? true
      : env.AGENT_LONG_TERM_MEMORY === '0'
        ? false
        : undefined;

  const loopModeRaw = env.AGENT_LOOP_MODE?.trim().toLowerCase();
  const loopMode =
    loopModeRaw === 'agent' || loopModeRaw === 'planner' || loopModeRaw === 'reflection'
      ? loopModeRaw
      : undefined;

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
      loopMode: loopMode ?? cfg.run.loopMode,
      compaction: {
        ...cfg.run.compaction,
        softCapTokens: softCap ?? cfg.run.compaction.softCapTokens,
      },
      memory: {
        ...cfg.run.memory,
        enabled: longTermMemory ?? cfg.run.memory.enabled,
        storeDir: env.AGENT_MEMORY_DIR ?? cfg.run.memory.storeDir,
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[coding-agent] Ignoring invalid config at ${path}: ${msg}`);
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
    redactions: cfg.policy.redactions,
    rateLimits: cfg.policy.rateLimits,
  };
}

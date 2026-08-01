/**
 * Assemble a durable coding Runtime: workspace tools + harness + optional DeepSeek chat.
 */

import { join } from 'node:path';

import type { Approver } from '@agent/contracts';
import {
  loadSkillFile,
  requireApprovalFor,
  autoApprove,
  type RunInterrupter,
  type TraceCollector,
} from '@agent/harness';
import {
  createHarnessWorkflow,
  FileDeadLetterQueue,
  FileMemoryStore,
  registerMemoryTools,
  Runtime,
  ToolRegistry,
  type ChatModelProvider,
  type HarnessLoopMode,
  type Policy,
  type ModelPricing,
} from 'durable-agent-runtime';

import {
  configToPolicy,
  loadCodingConfig,
  resolvePackagePath,
  type CodingConfig,
} from './config.js';
import {
  MEMORY_INSTRUCTIONS,
  withMemoryToolsAllowed,
  workspaceMemoryScope,
} from './memory.js';
import { chatProviderFromEnv } from './model/openai-compatible.js';
import { PACKAGE_ROOT } from './paths.js';
import { resolveCodingMaxPromptTokens, resolveModelIdFromEnv } from './prompt-budget.js';
import { createStdinApprover } from './stdin-approver.js';
import { createFsTools, MUTATING_FS_TOOLS } from './tools/fs-tools.js';
import { createExtractTopCommentsTool } from './tools/extract-top-comments.js';
import { createRunCheckTool, createRunTestsTool } from './tools/verify.js';
import { Workspace } from './workspace.js';

export { PACKAGE_ROOT } from './paths.js';
export {
  loadCodingConfig,
  readCodingConfigFile,
  CODING_CONFIG_DEFAULTS,
  type CodingConfig,
  type CodingConfigFile,
} from './config.js';
export {
  MEMORY_TOOL_NAMES,
  MEMORY_INSTRUCTIONS,
  withMemoryToolsAllowed,
  workspaceMemoryScope,
} from './memory.js';

/** @deprecated Prefer loadCodingConfig(); kept for older call sites. */
export function loadCodingConfigFile(path?: string): { pricing?: ModelPricing; policy?: Policy } {
  const cfg = loadCodingConfig({ path, skipEnv: true });
  return { pricing: cfg.pricing, policy: configToPolicy(cfg) };
}

export function defaultWorkspaceFromConfig(cfg: CodingConfig = loadCodingConfig({ skipEnv: true })): string {
  return resolvePackagePath(cfg.workspace.defaultRoot);
}

/** Default workspace root (resolved from config / package-relative default). */
export const DEFAULT_WORKSPACE = defaultWorkspaceFromConfig();

export interface CodingRuntimeOptions {
  baseDir: string;
  workspaceRoot?: string;
  chatModel?: ChatModelProvider;
  pricing?: ModelPricing;
  policy?: Policy;
  maxTurns?: number;
  crashAfterTurn?: number;
  /** Override context soft cap (else model registry ∩ product soft cap). */
  maxPromptTokens?: number;
  /** Model id for budget lookup when maxPromptTokens omitted. */
  modelId?: string;
  /** Default: approve mutating FS tools via stdin unless config/env auto-approve. */
  approver?: Approver;
  autoApproveWrites?: boolean;
  /**
   * Register cross-session `memory_*` tools for this Runtime.
   * Default: `config.run.memory.enabled` (env `AGENT_LONG_TERM_MEMORY` overlays config).
   */
  longTermMemory?: boolean;
  /**
   * Record tool calls that exhaust every retry to a durable dead-letter queue.
   * Default: `config.run.deadLetter.enabled`.
   */
  deadLetter?: boolean;
  /**
   * Harness control-flow mode. Default: `config.run.loopMode`.
   */
  loopMode?: HarnessLoopMode;
  /** Mid-run pause / steer / abort gate (Workbench / hosts). */
  interrupter?: RunInterrupter;
  onEvent?: ConstructorParameters<typeof Runtime>[0]['onEvent'];
  onStreamEvent?: ConstructorParameters<typeof Runtime>[0]['onStreamEvent'];
  /**
   * Drive harness streamed loops (default true for all loop modes).
   * Set false for batch — no live token notify.
   */
  stream?: boolean;
  /** Optional harness TraceCollector (retries / per-turn usage). */
  harnessTrace?: TraceCollector;
  /** Pre-loaded config; default loads agent.config.json + env. */
  config?: CodingConfig;
}

export function defaultCodingPolicy(cfg?: CodingConfig): Policy {
  return configToPolicy(cfg ?? loadCodingConfig({ skipEnv: true }));
}

export function resolveWorkspaceRoot(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  cfg?: CodingConfig,
): string {
  if (override) return override;
  const resolved = cfg ?? loadCodingConfig({ env });
  if (env.AGENT_WORKSPACE) return env.AGENT_WORKSPACE;
  return resolvePackagePath(resolved.workspace.defaultRoot);
}

export function createCodingRuntime(opts: CodingRuntimeOptions): Runtime {
  const cfg = opts.config ?? loadCodingConfig();
  const root = resolveWorkspaceRoot(opts.workspaceRoot, process.env, cfg);
  const workspace = new Workspace(root);
  const tools = new ToolRegistry();
  for (const t of createFsTools(workspace, {
    readFileDefaultLimit: cfg.tools.readFileDefaultLimit,
    readFileMaxChars: cfg.tools.readFileMaxChars,
    grepDefaultMatches: cfg.tools.grepDefaultMatches,
  })) {
    tools.register(t);
  }
  const verifyOpts = {
    recipes: cfg.tools.verify.recipes,
    timeoutMs: cfg.tools.verify.timeoutMs,
    maxOutputChars: cfg.tools.verify.maxOutputChars,
  };
  tools.register(createRunTestsTool(workspace, verifyOpts));
  tools.register(createRunCheckTool(workspace, verifyOpts));
  tools.register(createExtractTopCommentsTool(workspace));

  const longTermMemory = opts.longTermMemory ?? cfg.run.memory.enabled;
  if (longTermMemory) {
    const store = new FileMemoryStore(resolvePackagePath(cfg.run.memory.storeDir));
    registerMemoryTools(tools, store, workspaceMemoryScope(root));
  }

  const deadLetterEnabled = opts.deadLetter ?? cfg.run.deadLetter.enabled;
  const deadLetterQueue = deadLetterEnabled
    ? new FileDeadLetterQueue(join(resolvePackagePath(cfg.run.deadLetter.storeDir), 'queue.json'))
    : undefined;

  const loopMode = opts.loopMode ?? cfg.run.loopMode;
  const stream = opts.stream ?? true;

  const chatModel =
    opts.chatModel ??
    chatProviderFromEnv(process.env, {
      baseUrl: cfg.model.baseUrl,
      model: cfg.model.model,
      apiKeyEnv: cfg.model.apiKeyEnv,
      apiKeyEnvFallbacks: cfg.model.apiKeyEnvFallbacks,
      baseUrlEnv: cfg.model.baseUrlEnv,
      modelEnv: cfg.model.modelEnv,
      providerName: cfg.model.provider,
      fallbacks: cfg.model.fallbacks,
    });
  if (!chatModel) {
    throw new Error(
      `No chat model: set ${cfg.model.apiKeyEnv} (or pass chatModel). For tests, inject a scripted ChatModelProvider.`,
    );
  }

  const skillPath = resolvePackagePath(cfg.agent.skillPath);
  const skill = loadSkillFile(skillPath);
  const fileScoutSkillPath = resolvePackagePath('skills/file-scout/SKILL.md');
  const fileScoutSkill = loadSkillFile(fileScoutSkillPath);

  const auto = opts.autoApproveWrites ?? cfg.run.autoApproveWrites;
  const approver =
    opts.approver ??
    (auto ? autoApprove : requireApprovalFor([...MUTATING_FS_TOOLS], createStdinApprover()));

  const modelId = opts.modelId ?? resolveModelIdFromEnv(process.env, cfg.model.model);
  const maxPromptTokens =
    opts.maxPromptTokens ??
    resolveCodingMaxPromptTokens({
      model: modelId,
      softCap: cfg.run.compaction.softCapTokens,
    });

  const REFLECTION_QA_INSTRUCTIONS =
    'Reflection mode is for Q&A quality review in a multi-turn session. Prefer read-only tools; ' +
    'do not proactively edit the workspace. For code changes, use Agent or Planner mode instead.';

  let instructions = cfg.agent.instructions;
  if (loopMode === 'reflection') {
    instructions = `${instructions}\n\n${REFLECTION_QA_INSTRUCTIONS}`;
  }
  if (longTermMemory) {
    instructions = `${instructions}\n\n${MEMORY_INSTRUCTIONS}`;
  }

  const basePolicy = opts.policy ?? defaultCodingPolicy(cfg);
  const policy: Policy = longTermMemory
    ? { ...basePolicy, allowedTools: withMemoryToolsAllowed(basePolicy.allowedTools) }
    : basePolicy;

  const hasFallbackTiers =
    (cfg.model.fallbacks?.length ?? 0) > 0 &&
    cfg.model.fallbacks.some((fb) => Boolean(process.env[fb.apiKeyEnv]));

  const workflow = createHarnessWorkflow({
    name: cfg.agent.name,
    maxTurns: opts.maxTurns ?? cfg.run.maxTurns,
    crashAfterTurn: opts.crashAfterTurn,
    approver,
    interrupter: opts.interrupter,
    trace: opts.harnessTrace,
    stream,
    loopMode,
    toolConcurrency: cfg.run.toolConcurrency,
    toolRetry: cfg.run.toolRetry === false ? false : cfg.run.toolRetry,
    // Resilient provider already retries per tier — don't multiply at the loop.
    modelRetry: hasFallbackTiers ? { retries: 0 } : undefined,
    planner: {
      maxReplans: cfg.run.planner.maxReplans,
      replanOnFailure: cfg.run.planner.replanOnFailure,
    },
    reflection: {
      maxReflections: cfg.run.reflection.maxReflections,
    },
    agent: {
      name: cfg.agent.name,
      instructions,
      skills: [skill, fileScoutSkill],
      skillLoadMode: cfg.agent.skillLoadMode,
    },
    modelCompaction: {
      maxPromptTokens,
      threshold: cfg.run.compaction.threshold,
    },
    scratchpad: cfg.run.scratchpad.enabled
      ? {
          offloadThreshold: cfg.run.scratchpad.offloadThreshold,
          previewChars: cfg.run.scratchpad.previewChars,
          neverOffload: cfg.run.scratchpad.neverOffload,
          persistBaseDir: opts.baseDir,
        }
      : false,
  });

  return new Runtime({
    baseDir: opts.baseDir,
    chatModel,
    tools,
    workflow,
    pricing: opts.pricing ?? cfg.pricing,
    policy,
    deadLetterQueue,
    onEvent: opts.onEvent,
    onStreamEvent: opts.onStreamEvent,
  });
}

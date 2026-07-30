/**
 * Assemble a durable coding Runtime: workspace tools + harness + optional DeepSeek chat.
 */

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
  Runtime,
  ToolRegistry,
  type ChatModelProvider,
  type Policy,
  type ModelPricing,
} from 'durable-agent-runtime';

import {
  configToPolicy,
  loadCodingConfig,
  resolvePackagePath,
  type CodingConfig,
} from './config.js';
import { chatProviderFromEnv } from './model/openai-compatible.js';
import { PACKAGE_ROOT } from './paths.js';
import { resolveCodingMaxPromptTokens, resolveModelIdFromEnv } from './prompt-budget.js';
import { createStdinApprover } from './stdin-approver.js';
import { createFsTools, MUTATING_FS_TOOLS } from './tools/fs-tools.js';
import { createRunTestsTool } from './tools/run-tests.js';
import { Workspace } from './workspace.js';

export { PACKAGE_ROOT } from './paths.js';
export {
  loadCodingConfig,
  readCodingConfigFile,
  CODING_CONFIG_DEFAULTS,
  type CodingConfig,
  type CodingConfigFile,
} from './config.js';

/** @deprecated Prefer loadCodingConfig(); kept for older call sites. */
export function loadCodingConfigFile(path?: string): { pricing?: ModelPricing; policy?: Policy } {
  const cfg = loadCodingConfig({ path, skipEnv: true });
  return { pricing: cfg.pricing, policy: configToPolicy(cfg) };
}

export function defaultWorkspaceFromConfig(cfg: CodingConfig = loadCodingConfig({ skipEnv: true })): string {
  return resolvePackagePath(cfg.workspace.defaultRoot);
}

/** Default fixture workspace (resolved from config / built-in default). */
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
  /** Mid-run pause / steer / abort gate (Workbench / hosts). */
  interrupter?: RunInterrupter;
  onEvent?: ConstructorParameters<typeof Runtime>[0]['onEvent'];
  onStreamEvent?: ConstructorParameters<typeof Runtime>[0]['onStreamEvent'];
  /**
   * Drive harness `runAgentStreamed` (default true). Set false for batch
   * `runAgent` — no live token notify.
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
  tools.register(
    createRunTestsTool(workspace, {
      command: cfg.tools.runTests.command,
      timeoutMs: cfg.tools.runTests.timeoutMs,
      maxOutputChars: cfg.tools.runTests.maxOutputChars,
    }),
  );

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
    });
  if (!chatModel) {
    throw new Error(
      `No chat model: set ${cfg.model.apiKeyEnv} (or pass chatModel). For tests, inject a scripted ChatModelProvider.`,
    );
  }

  const skillPath = resolvePackagePath(cfg.agent.skillPath);
  const skill = loadSkillFile(skillPath);

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

  const workflow = createHarnessWorkflow({
    name: cfg.agent.name,
    maxTurns: opts.maxTurns ?? cfg.run.maxTurns,
    crashAfterTurn: opts.crashAfterTurn,
    approver,
    interrupter: opts.interrupter,
    trace: opts.harnessTrace,
    stream: opts.stream ?? true,
    agent: {
      name: cfg.agent.name,
      instructions: cfg.agent.instructions,
      skills: [skill],
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
        }
      : false,
  });

  return new Runtime({
    baseDir: opts.baseDir,
    chatModel,
    tools,
    workflow,
    pricing: opts.pricing ?? cfg.pricing,
    policy: opts.policy ?? defaultCodingPolicy(cfg),
    onEvent: opts.onEvent,
    onStreamEvent: opts.onStreamEvent,
  });
}

/**
 * Assemble a durable coding Runtime: workspace tools + harness + optional DeepSeek chat.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Approver } from '@agent/contracts';
import { loadSkillFile, requireApprovalFor, autoApprove, type TraceCollector } from '@agent/harness';
import {
  createHarnessWorkflow,
  Runtime,
  ToolRegistry,
  type ChatModelProvider,
  type Policy,
  type ModelPricing,
} from 'durable-agent-runtime';

import { chatProviderFromEnv } from './model/openai-compatible.js';
import { resolveCodingMaxPromptTokens, resolveModelIdFromEnv } from './prompt-budget.js';
import { createStdinApprover } from './stdin-approver.js';
import { createFsTools } from './tools/fs-tools.js';
import { createRunTestsTool } from './tools/run-tests.js';
import { Workspace } from './workspace.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Package root (…/coding-agent), whether running from src/ or dist/. */
export const PACKAGE_ROOT = join(HERE, '..');
export const DEFAULT_WORKSPACE = join(PACKAGE_ROOT, 'fixtures', 'coding-sandbox');

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
  /** Default: approve write_file via stdin unless AGENT_AUTO_APPROVE=1. */
  approver?: Approver;
  autoApproveWrites?: boolean;
  onEvent?: ConstructorParameters<typeof Runtime>[0]['onEvent'];
  /** Optional harness TraceCollector (retries / per-turn usage). */
  harnessTrace?: TraceCollector;
}

export function defaultCodingPolicy(): Policy {
  return {
    allowedTools: ['list_dir', 'grep', 'read_file', 'write_file', 'run_tests'],
    maxCostUsd: 1.0,
  };
}

export function resolveWorkspaceRoot(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  return override ?? env.AGENT_WORKSPACE ?? DEFAULT_WORKSPACE;
}

export function createCodingRuntime(opts: CodingRuntimeOptions): Runtime {
  const root = resolveWorkspaceRoot(opts.workspaceRoot);
  const workspace = new Workspace(root);
  const tools = new ToolRegistry();
  for (const t of createFsTools(workspace)) tools.register(t);
  tools.register(createRunTestsTool(workspace));

  const chatModel = opts.chatModel ?? chatProviderFromEnv();
  if (!chatModel) {
    throw new Error(
      'No chat model: set DEEPSEEK_API_KEY (or pass chatModel). For tests, inject a scripted ChatModelProvider.',
    );
  }

  const skillPath = join(PACKAGE_ROOT, 'skills', 'coding-agent', 'SKILL.md');
  const skill = loadSkillFile(skillPath);

  const auto = opts.autoApproveWrites ?? process.env.AGENT_AUTO_APPROVE === '1';
  const approver =
    opts.approver ??
    (auto ? autoApprove : requireApprovalFor(['write_file'], createStdinApprover()));

  const modelId = opts.modelId ?? resolveModelIdFromEnv();
  const maxPromptTokens = opts.maxPromptTokens ?? resolveCodingMaxPromptTokens({ model: modelId });

  const workflow = createHarnessWorkflow({
    name: 'coding-agent',
    maxTurns: opts.maxTurns ?? 24,
    crashAfterTurn: opts.crashAfterTurn,
    approver,
    trace: opts.harnessTrace,
    agent: {
      name: 'coding-agent',
      instructions:
        'You are a coding agent operating inside a sandboxed workspace. ' +
        'Follow the coding-agent skill. ' +
        'For Q&A / explain goals with no code change: use read tools only and put the full answer in the final reply — do not write ANALYSIS.md or other files unless the user explicitly names an output file. ' +
        'For fix/implement goals: analyze, edit with write_file, run_tests, then document as the skill says. ' +
        'Never invent file paths — only use paths you observed from tools.',
      skills: [skill],
      skillLoadMode: 'eager',
    },
    modelCompaction: {
      maxPromptTokens,
      threshold: 0.85,
    },
  });

  return new Runtime({
    baseDir: opts.baseDir,
    chatModel,
    tools,
    workflow,
    pricing: opts.pricing,
    policy: opts.policy ?? defaultCodingPolicy(),
    onEvent: opts.onEvent,
  });
}

/** Load optional coding-agent/agent.config.json pricing overrides. */
export function loadCodingConfigFile(path = join(PACKAGE_ROOT, 'agent.config.json')): {
  pricing?: ModelPricing;
  policy?: Policy;
} {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      pricing?: ModelPricing;
      policy?: Policy;
    };
    return raw;
  } catch {
    return {};
  }
}

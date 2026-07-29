/**
 * Prompt-token budget for coding-agent context compaction.
 *
 * Soft cap = min(model context window, product policy). Switch models via
 * DEEPSEEK_MODEL / LLM_MODEL; override policy with AGENT_MAX_PROMPT_TOKENS
 * or agent.config.json run.compaction.softCapTokens.
 */

import { resolveModelLimit } from '@agent/harness';

/** Product soft cap for coding-agent (even if the model supports 1M). */
export const CODING_PROMPT_SOFT_CAP = 128_000;

export function resolveModelIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  configDefault = 'deepseek-chat',
): string {
  return env.DEEPSEEK_MODEL ?? env.LLM_MODEL ?? configDefault;
}

export function resolveCodingMaxPromptTokens(opts?: {
  model?: string;
  /** Product soft cap; default CODING_PROMPT_SOFT_CAP or AGENT_MAX_PROMPT_TOKENS. */
  softCap?: number;
  env?: NodeJS.ProcessEnv;
}): number {
  const env = opts?.env ?? process.env;
  const model = opts?.model ?? resolveModelIdFromEnv(env);
  const envCap = env.AGENT_MAX_PROMPT_TOKENS ? Number(env.AGENT_MAX_PROMPT_TOKENS) : undefined;
  const softCap =
    opts?.softCap ??
    (Number.isFinite(envCap) && (envCap as number) > 0 ? (envCap as number) : CODING_PROMPT_SOFT_CAP);
  return Math.min(resolveModelLimit(model), softCap);
}

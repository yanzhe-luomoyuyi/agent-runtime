/**
 * C: per-model context-window registry.
 *
 * `ContextManager` needs to know how many tokens a given model can accept so it
 * can size its prompt budget instead of using one hard-coded number for every
 * model. This is a small, dependency-free lookup table keyed by model-name
 * prefix (so `gpt-4o`, `gpt-4o-2024-08-06`, `gpt-4o-mini` all resolve without an
 * exact match). Unknown models fall back to a conservative default.
 *
 * Numbers are the total context window (input + output). `ContextManager`
 * subtracts its own output / tool-def reserves from this.
 */

/** Total context-window sizes (tokens) by model-name prefix. Longest prefix wins. */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_385,
  'o1': 200_000,
  'o3': 200_000,
  'o4-mini': 200_000,
  // Anthropic
  'claude-3-5-sonnet': 200_000,
  'claude-3-7-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-opus-4': 200_000,
  'claude-3-opus': 200_000,
  // Google
  'gemini-1.5-pro': 2_000_000,
  'gemini-1.5-flash': 1_000_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  // DeepSeek / Mistral / Llama
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  'mistral-large': 128_000,
  'llama-3.1': 128_000,
};

/** Conservative fallback for models not in the table. */
export const DEFAULT_CONTEXT_LIMIT = 128_000;

/**
 * Resolve a model's context window by longest-prefix match against the registry.
 * Case-insensitive. Returns `DEFAULT_CONTEXT_LIMIT` for unknown models.
 */
export function resolveModelLimit(modelName: string): number {
  const name = modelName.toLowerCase();
  let best: number | undefined;
  let bestLen = -1;
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (name.startsWith(prefix) && prefix.length > bestLen) {
      best = limit;
      bestLen = prefix.length;
    }
  }
  return best ?? DEFAULT_CONTEXT_LIMIT;
}

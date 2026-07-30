/**
 * Cost model configuration.
 *
 * Token pricing is data, not code — it differs per model and changes over time.
 * The runtime accepts `ModelPricing` via `RuntimeOptions` (dependency injection);
 * the CLI sources it from an optional `agent.config.json`. In production this
 * would be a per-model pricing table, but the injection seam is identical.
 */

export interface ModelPricing {
  /** Cache-miss (and uncached) prompt token rate. */
  promptUsdPerToken: number;
  completionUsdPerToken: number;
  /**
   * Provider prompt-cache hit rate (DeepSeek / Anthropic).
   * When omitted, cached tokens are billed at `promptUsdPerToken`.
   */
  cachedPromptUsdPerToken?: number;
}

export const DEFAULT_PRICING: ModelPricing = {
  promptUsdPerToken: 0.0000005,
  completionUsdPerToken: 0.0000015,
};

/** Cost for one call. `promptTokens` is the full prompt (hit+miss); cached is a subset. */
export function estimateModelCost(
  pricing: ModelPricing,
  promptTokens: number,
  completionTokens: number,
  cachedPromptTokens = 0,
): number {
  const cached = Math.min(Math.max(0, cachedPromptTokens), Math.max(0, promptTokens));
  const miss = Math.max(0, promptTokens - cached);
  const cachedRate = pricing.cachedPromptUsdPerToken ?? pricing.promptUsdPerToken;
  return miss * pricing.promptUsdPerToken
    + cached * cachedRate
    + completionTokens * pricing.completionUsdPerToken;
}

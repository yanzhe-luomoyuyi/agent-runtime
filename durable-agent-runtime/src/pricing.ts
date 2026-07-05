/**
 * Cost model configuration.
 *
 * Token pricing is data, not code — it differs per model and changes over time.
 * The runtime accepts `ModelPricing` via `RuntimeOptions` (dependency injection);
 * the CLI sources it from an optional `agent.config.json`. In production this
 * would be a per-model pricing table, but the injection seam is identical.
 */

export interface ModelPricing {
  promptUsdPerToken: number;
  completionUsdPerToken: number;
}

export const DEFAULT_PRICING: ModelPricing = {
  promptUsdPerToken: 0.0000005,
  completionUsdPerToken: 0.0000015,
};

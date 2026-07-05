/**
 * Model provider abstraction.
 *
 * The runtime depends only on this interface, so the LLM is a swappable
 * component. The mock implementation is fully deterministic, which gives us:
 *   - offline development (no API key, no network),
 *   - reproducible runs (a replayed log yields identical output),
 *   - stable evals (D5 asserts behavior without flaky model calls).
 *
 * A real provider (OpenAI / Azure OpenAI / Anthropic) implements the same
 * `complete()` method and drops in without touching the runtime.
 */

export interface ModelResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** True when served by a CachingModelProvider (no real model call happened). */
  cached?: boolean;
}

export interface ModelProvider {
  readonly name: string;
  complete(prompt: string): Promise<ModelResult>;
}

/** Rough token estimate — ~4 chars per token. Deterministic, good enough for the demo. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockModelProvider implements ModelProvider {
  readonly name = 'mock';

  constructor(private readonly canned: Record<string, string> = {}) {}

  async complete(prompt: string): Promise<ModelResult> {
    // Workflows tag prompts with a leading marker like "[analyze.summary] ..."
    // so the mock can return a canned, deterministic response.
    const key = prompt.match(/^\[([^\]]+)\]/)?.[1];
    const text = key && key in this.canned ? this.canned[key]! : `[mock] ${prompt.slice(0, 80).replace(/\s+/g, ' ').trim()}`;
    return { text, promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(text) };
  }
}

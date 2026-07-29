import { describe, expect, it } from 'vitest';

import { CODING_PROMPT_SOFT_CAP, resolveCodingMaxPromptTokens } from '../src/prompt-budget.js';

describe('resolveCodingMaxPromptTokens', () => {
  it('caps DeepSeek V4 Pro at the product soft cap', () => {
    expect(resolveCodingMaxPromptTokens({ model: 'deepseek-v4-pro', env: {} })).toBe(CODING_PROMPT_SOFT_CAP);
    expect(CODING_PROMPT_SOFT_CAP).toBe(128_000);
  });

  it('uses the smaller model window for deepseek-chat', () => {
    expect(resolveCodingMaxPromptTokens({ model: 'deepseek-chat', env: {} })).toBe(64_000);
  });

  it('honors AGENT_MAX_PROMPT_TOKENS soft-cap override', () => {
    expect(
      resolveCodingMaxPromptTokens({
        model: 'deepseek-v4-pro',
        env: { AGENT_MAX_PROMPT_TOKENS: '64000' },
      }),
    ).toBe(64_000);
  });
});

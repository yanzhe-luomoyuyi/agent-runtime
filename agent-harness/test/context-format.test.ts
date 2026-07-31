import { describe, expect, it } from 'vitest';

import {
  PRIOR_CONVERSATION_MAX_CHARS,
  formatPriorConversation,
  withPriorConversation,
} from '../src/control/context-format.js';

describe('formatPriorConversation', () => {
  it('returns empty for missing or blank history', () => {
    expect(formatPriorConversation(undefined)).toBe('');
    expect(formatPriorConversation([])).toBe('');
    expect(formatPriorConversation([{ role: 'user', content: '  ' }])).toBe('');
  });

  it('renders user/assistant turns', () => {
    const text = formatPriorConversation([
      { role: 'user', content: 'list items' },
      { role: 'assistant', content: '1. a\n2. b' },
    ]);
    expect(text).toContain('User: list items');
    expect(text).toContain('Assistant: 1. a\n2. b');
  });

  it('truncates from the front when over budget', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `turn-${i}-` + 'x'.repeat(200),
    }));
    const text = formatPriorConversation(history, { maxChars: 800 });
    expect(text.length).toBeLessThanOrEqual(800 + 50); // marker overhead
    expect(text).toContain('earlier turns truncated');
    expect(text).not.toContain('turn-0-');
  });

  it('withPriorConversation prepends a labeled block', () => {
    const out = withPriorConversation('Goal: do 1 and 2', [
      { role: 'assistant', content: '1. foo\n2. bar' },
    ]);
    expect(out.startsWith('Prior conversation:')).toBe(true);
    expect(out).toContain('1. foo');
    expect(out).toContain('Goal: do 1 and 2');
  });

  it('exposes the default ~8k budget constant', () => {
    expect(PRIOR_CONVERSATION_MAX_CHARS).toBe(8_000);
  });
});

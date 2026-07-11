/**
 * Tokenizer abstraction — pluggable token counting for context management.
 *
 * `length/4` is a rough heuristic that works for English text but drifts badly
 * with code, JSON, non-Latin scripts, and mixed-language content. A proper
 * tokenizer (tiktoken, Anthropic's Claude tokenizer, HuggingFace tokenizers)
 * gives accurate counts, which means the context manager can safely use more
 * of the available window instead of leaving a wasteful safety margin.
 *
 * This module defines the interface, ships a heuristic fallback (zero deps),
 * and provides factory helpers so callers can plug in real tokenizers when
 * they are available at runtime.
 */

import type { Message } from '@agent/contracts';

// ── Interface ──────────────────────────────────────────────────────

export interface Tokenizer {
  /** Token count for a single string. */
  count(text: string): number;
  /** Token count for a message (role + content + tool_calls + name). */
  countMessage(message: Message): number;
  /** Token count for an array of messages (sum of individual counts). */
  countMessages(messages: Message[]): number;
}

// ── Heuristic fallback ─────────────────────────────────────────────

/**
 * Rough token estimator: ~4 characters per token.
 *
 * This is the legacy default and is always available. It is deliberately kept
 * as a separate object so callers can swap it for a real tokenizer without
 * touching any other code.
 */
export const heuristicTokenizer: Tokenizer = {
  count(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  },

  countMessage(message: Message): number {
    const parts: string[] = [message.role, message.content ?? ''];
    if (message.toolCalls && message.toolCalls.length > 0) parts.push(JSON.stringify(message.toolCalls));
    if (message.name) parts.push(message.name);
    if (message.thinking) parts.push(message.thinking);
    return this.count(parts.join(' '));
  },

  countMessages(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + this.countMessage(m), 0);
  },
};

// ── Factory helpers ─────────────────────────────────────────────────

/**
 * Build a tokenizer from a simple `(text: string) => number` function.
 * Useful for wrapping a tiktoken encoding or Anthropic's `countTokens`.
 *
 * @example
 * ```ts
 * import { encoding_for_model } from 'tiktoken';
 * const enc = encoding_for_model('gpt-4o');
 * const tokenizer = fromCounter((text) => enc.encode(text).length);
 * ```
 */
export function fromCounter(counter: (text: string) => number): Tokenizer {
  return {
    count: counter,
    countMessage(message: Message): number {
      const parts: string[] = [message.role, message.content ?? ''];
      if (message.toolCalls && message.toolCalls.length > 0) parts.push(JSON.stringify(message.toolCalls));
      if (message.name) parts.push(message.name);
      return counter(parts.join(' '));
    },
    countMessages(messages: Message[]): number {
      return messages.reduce((sum, m) => sum + this.countMessage(m), 0);
    },
  };
}

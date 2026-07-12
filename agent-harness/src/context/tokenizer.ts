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
import { isCjkCodepoint } from '@agent/contracts';

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

// ── CJK-aware heuristic (better default) ───────────────────────────

/**
 * True for CJK / full-width codepoints, which real tokenizers encode at roughly
 * one token per character — very different from the ~4 chars/token that Latin
 * text gets. Counting these separately keeps the estimate honest for Chinese,
 * Japanese, and Korean content instead of under-counting it ~4×.
 */
/**
 * A zero-dependency estimator that is meaningfully more accurate than plain
 * `length / 4` on mixed content: CJK characters count as ~1 token each, all
 * other characters at ~4 chars/token. This is still a heuristic (a real BPE
 * tokenizer via `fromCounter` is always more accurate), but it removes the worst
 * failure mode — silently under-counting non-Latin text and blowing the window.
 *
 * This is the default tokenizer for `ContextManager`. The plain `heuristicTokenizer`
 * remains available for callers who want the legacy length/4 behaviour.
 */
export const cjkAwareTokenizer: Tokenizer = {
  count(text: string): number {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (isCjkCodepoint(cp)) cjk++;
      else other++;
    }
    return Math.max(1, cjk + Math.ceil(other / 4));
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

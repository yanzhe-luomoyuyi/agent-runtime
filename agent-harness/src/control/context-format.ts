/**
 * Format prior session turns for planner / critic prompts.
 * Caps keep control-flow model calls from inheriting unbounded history.
 */

import type { Message } from '@agent/contracts';

/** Default char budget for Prior conversation blocks (~8k). */
export const PRIOR_CONVERSATION_MAX_CHARS = 8_000;

/**
 * Render user/assistant (and system) history for planner/critic.
 * Truncates from the front when over `maxChars`.
 */
export function formatPriorConversation(
  history: Message[] | undefined,
  opts: { maxChars?: number } = {},
): string {
  if (!history || history.length === 0) return '';
  const maxChars = opts.maxChars ?? PRIOR_CONVERSATION_MAX_CHARS;

  const lines: string[] = [];
  for (const m of history) {
    const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
    const content = (m.content ?? '').trim();
    if (!content) continue;
    lines.push(`${role}: ${content}`);
  }
  if (lines.length === 0) return '';

  let text = lines.join('\n\n');
  if (text.length <= maxChars) return text;

  // Drop oldest turns until under budget (keep a truncation marker).
  const marker = '[…earlier turns truncated…]\n\n';
  let start = 0;
  while (start < lines.length && marker.length + lines.slice(start).join('\n\n').length > maxChars) {
    start++;
  }
  const kept = lines.slice(start).join('\n\n');
  if (!kept) return text.slice(-maxChars);
  return marker + kept;
}

/** Prepend a "Prior conversation" section when history is non-empty. */
export function withPriorConversation(
  body: string,
  history: Message[] | undefined,
  opts: { maxChars?: number } = {},
): string {
  const prior = formatPriorConversation(history, opts);
  if (!prior) return body;
  return `Prior conversation:\n${prior}\n\n${body}`;
}

/**
 * RunState projections — shared helpers for turning derived state into answers
 * and transcripts (session history, CLI chat, summaries).
 */

import type { RunState } from './types.js';

/** Best-effort final answer from a RunState (summary → step outputs → error). */
export function extractAnswer(state: RunState): string {
  const summary = state.summary as { proposal?: string; answer?: string } | undefined;
  if (summary?.answer) return summary.answer;
  if (summary?.proposal) return summary.proposal;
  const keys = Object.keys(state.stepOutputs);
  for (let i = keys.length - 1; i >= 0; i--) {
    const v = state.stepOutputs[keys[i]!];
    if (v && typeof v === 'object' && 'answer' in v) return (v as { answer: string }).answer;
  }
  return state.error ?? '(no answer)';
}

/**
 * Last assistant `thinking` on the harness step transcript (extended-reasoning
 * models). Empty when the model never emitted reasoning tokens.
 */
export function extractThinking(state: RunState, stepId = 'agent.1'): string | undefined {
  const result = state.stepOutputs[stepId] as {
    messages?: Array<{ role: string; thinking?: string }>;
  } | undefined;
  const msgs = result?.messages;
  if (!msgs?.length) return undefined;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === 'assistant' && m.thinking?.trim()) return m.thinking;
  }
  return undefined;
}

type TranscriptMessage = {
  role: string;
  content?: string | null;
  name?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
};

/**
 * Format a harness-style agent step's message transcript as plain text.
 * Suitable for `SessionManager`'s `extractMessages` when `historyMode` is
 * `'full-summary'`. Returns `undefined` if the step did not produce messages.
 */
export function extractHarnessMessages(state: RunState, stepId = 'agent.1'): string | undefined {
  const result = state.stepOutputs[stepId] as { messages?: TranscriptMessage[] } | undefined;
  if (!result?.messages?.length) return undefined;
  return result.messages
    .map((m) => {
      const role = m.role.toUpperCase();
      const content = m.content ?? '';
      const toolCalls = m.toolCalls?.length
        ? `\n[tool_calls: ${m.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ')}]`
        : '';
      const toolName = m.name ? ` (${m.name})` : '';
      return `[${role}${toolName}] ${content}${toolCalls}`;
    })
    .join('\n\n');
}

/**
 * Ablation fixtures for context assemble policy.
 *
 * Same transcript, two policies (pure recency vs importance+pin). Decisions
 * are asserted via `assembleDetailed` so the comparison is auditable — the
 * point of P1 observability.
 */
import type { Message } from '@agent/contracts';
import { describe, expect, it } from 'vitest';

import { ContextManager } from '../src/context/manager.js';

function messageTextLen(m: Message): number {
  const parts: string[] = [m.role, m.content ?? ''];
  if (m.toolCalls && m.toolCalls.length > 0) parts.push(JSON.stringify(m.toolCalls));
  if (m.name) parts.push(m.name);
  return parts.join(' ').length;
}

const charTokenizer = {
  count: (t: string) => t.length,
  countMessage: (m: Message) => messageTextLen(m),
  countMessages: (ms: Message[]) => ms.reduce((s, m) => s + messageTextLen(m), 0),
};

/**
 * Sized so discounted growth admits ERROR+read into the candidate set, hard-cap
 * trim then drops the mid-tier read unit, and the pinned user always survives.
 * (Same sizing as the atomic-unit hard-cap regression in context.test.ts.)
 */
function ablationFixture(): Message[] {
  return [
    { role: 'system', content: 'S' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'e', name: 'deploy', arguments: {} }],
    },
    {
      role: 'tool',
      name: 'deploy',
      toolCallId: 'e',
      content: 'ERROR: x',
      untrusted: true,
    },
    {
      role: 'assistant',
      toolCalls: [{ id: 'r', name: 'read', arguments: {} }],
    },
    {
      role: 'tool',
      name: 'read',
      toolCallId: 'r',
      content: 'okxxxx',
      untrusted: true,
    },
    { role: 'user', content: 'now' },
  ];
}

function makeCm(importanceScoring: boolean): ContextManager {
  return new ContextManager({
    maxPromptTokens: 100,
    keepRecentMessages: 1,
    outputReserveTokens: 0,
    goalProtected: false,
    importanceScoring,
    tokenizer: charTokenizer,
  });
}

function hasErrorPair(out: Message[]): boolean {
  return (
    out.some((m) => m.role === 'tool' && m.toolCallId === 'e') &&
    out.some((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === 'e'))
  );
}

describe('context assemble ablation', () => {
  it('both policies keep the pinned recent user instruction', () => {
    const msgs = ablationFixture();
    const recency = makeCm(false).assembleDetailed(msgs);
    const importance = makeCm(true).assembleDetailed(msgs);

    for (const result of [recency, importance]) {
      expect(result.messages.some((m) => m.role === 'user' && m.content === 'now')).toBe(true);
      expect(result.decision.outcome).toBe('assembled');
      expect(result.decision.reasons).toContain('pinned_recent');
      expect(result.decision.pinnedUnits).toBeGreaterThanOrEqual(1);
    }
  });

  it('importance+pin keeps the ERROR unit; pure recency drops it', () => {
    const msgs = ablationFixture();
    const recency = makeCm(false).assembleDetailed(msgs);
    const importance = makeCm(true).assembleDetailed(msgs);

    expect(hasErrorPair(importance.messages)).toBe(true);
    expect(importance.decision.importanceScoring).toBe(true);
    expect(importance.decision.hardCapTrimmed).toBe(true);
    expect(importance.decision.reasons).toContain('hard_cap_trim');

    // Pure recency grows without discount; ERROR sits behind the read unit
    // and is folded into the summary rather than kept verbatim.
    expect(hasErrorPair(recency.messages)).toBe(false);
    expect(recency.decision.importanceScoring).toBe(false);
    expect(recency.decision.hardCapTrimmed).toBe(false);
  });

  it('emits auditable keep/summarize counts for ablation dashboards', () => {
    const msgs = ablationFixture();
    const importance = makeCm(true).assembleDetailed(msgs);
    expect(importance.decision.summarizedMessages).toBeGreaterThan(0);
    expect(importance.decision.keptMessages).toBeGreaterThan(0);
    expect(importance.decision.inputTokens).toBeGreaterThan(0);
    expect(importance.decision.availableBudget).toBe(100);
  });
});

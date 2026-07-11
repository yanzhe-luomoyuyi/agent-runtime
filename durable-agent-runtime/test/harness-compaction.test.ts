import { describe, expect, it } from 'vitest';

import { RuntimeChatModel } from '../src/app/harness-adapter.js';
import type { StepContext } from '../src/workflow.js';

/** Minimal StepContext stub exposing only what RuntimeChatModel touches. */
function stubCtx(reply: string): { ctx: StepContext; prompts: string[] } {
  const prompts: string[] = [];
  const ctx = {
    callModel: async (prompt: string) => {
      prompts.push(prompt);
      return reply;
    },
  } as unknown as StepContext;
  return { ctx, prompts };
}

describe('RuntimeChatModel — textCompletion passthrough', () => {
  it('passes a summary request through verbatim and returns raw text', async () => {
    const { ctx, prompts } = stubCtx('Earlier: agent searched code and found the bug.');
    const model = new RuntimeChatModel(ctx);

    const resp = await model.chat({
      messages: [
        { role: 'system', content: 'You summarize.' },
        { role: 'user', content: 'Summarize: turn 1 did X; turn 2 did Y.' },
      ],
      tools: [],
      key: 'compact-t3',
      textCompletion: true,
    });

    // Raw text returned as content — NOT parsed into tool calls.
    expect(resp.message.content).toBe('Earlier: agent searched code and found the bug.');
    expect(resp.message.toolCalls).toBeUndefined();
    expect(resp.stopReason).toBe('stop');
    // The bridge did not reshape the prompt into the agent-decision format.
    expect(prompts[0]).toContain('You summarize.');
    expect(prompts[0]).toContain('Summarize: turn 1 did X');
    expect(prompts[0]).not.toContain('Reply with EXACTLY ONE JSON');
  });

  it('still parses a normal (non-textCompletion) reply as a tool call', async () => {
    const { ctx, prompts } = stubCtx('{"action":"call_tool","tool":"getIssue","args":{"issue":"x"}}');
    const model = new RuntimeChatModel(ctx);

    const resp = await model.chat({
      messages: [{ role: 'user', content: 'Goal: fix it' }],
      tools: [{ name: 'getIssue', description: 'd', inputSchema: { type: 'object' } }],
      key: 't1',
    });

    expect(resp.stopReason).toBe('tool_calls');
    expect(resp.message.toolCalls?.[0]?.name).toBe('getIssue');
    // The agent path DID reshape the prompt into the decision format.
    expect(prompts[0]).toContain('Reply with EXACTLY ONE JSON');
  });
});

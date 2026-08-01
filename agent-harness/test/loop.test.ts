import { describe, expect, it } from 'vitest';

import type { ChatModel } from '@agent/contracts';
import { ContextManager } from '../src/context/manager.js';
import { runAgent, runAgentStreamed, type AgentRunResult } from '../src/control/loop.js';
import { TransientError } from '../src/recovery/retry.js';
import {
  MockToolInvoker,
  RuleChatModel,
  ScriptedChatModel,
  finalResponse,
  makeTool,
  toolCall,
  toolCallResponse,
} from '../src/testkit/index.js';
import { FALLBACK_PRICING, TraceCollector } from '../src/tracing/collector.js';

const getIssue = makeTool(
  'getIssue',
  'Fetch issue details.',
  { type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'] },
  (a) => ({ title: (a as { issue: string }).issue }),
);
const searchCode = makeTool(
  'searchCode',
  'Search the codebase.',
  { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  () => ({ files: ['src/auth/login.ts'] }),
);

describe('agent loop', () => {
  it('lets the model drive getIssue -> searchCode -> finish', async () => {
    const tools = new MockToolInvoker([getIssue, searchCode]);
    const model = new RuleChatModel((req) => {
      const called = new Set(req.messages.filter((m) => m.role === 'tool').map((m) => m.name));
      if (!called.has('getIssue')) return toolCallResponse([toolCall('c1', 'getIssue', { issue: 'x' })]);
      if (!called.has('searchCode')) return toolCallResponse([toolCall('c2', 'searchCode', { query: 'x' })]);
      return finalResponse('fix src/auth/login.ts');
    });
    const res = await runAgent({ goal: 'x', model, tools });
    expect(res.finished).toBe(true);
    expect(res.turns).toBe(3);
    expect(res.toolsUsed).toEqual(['getIssue', 'searchCode']);
    expect(res.answer).toContain('login.ts');
  });

  it('records assemble/compact decisions on the trace collector', async () => {
    const tools = new MockToolInvoker([getIssue]);
    const model = new ScriptedChatModel([finalResponse('done')]);
    const trace = new TraceCollector(FALLBACK_PRICING);
    await runAgent({
      goal: 'x',
      model,
      tools,
      trace,
      // Tiny budget so assemble is forced to do real work (not passthrough).
      context: new ContextManager({
        maxPromptTokens: 40,
        outputReserveTokens: 0,
        keepRecentMessages: 2,
        goalProtected: true,
        importanceScoring: true,
      }),
    });
    const snap = trace.snapshot(1);
    expect(snap.turns.length).toBeGreaterThanOrEqual(1);
    expect(snap.turns[0]!.context?.compact).toBeDefined();
    expect(snap.turns[0]!.context?.assemble).toBeDefined();
    expect(snap.turns[0]!.context?.compact?.reason).toBe('no_summarizer');
  });

  it('passes deterministic durable keys to the model and tools', async () => {
    const tools = new MockToolInvoker([getIssue]);
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'getIssue', { issue: 'x' })]),
      finalResponse('done'),
    ]);
    await runAgent({ goal: 'x', model, tools });
    expect(model.requests.map((r) => r.key)).toEqual(['t:1', 't:2']);
    expect(tools.calls[0]!.key).toBe('t:1:c1');
  });

  it('feeds a thrown tool error back so the model can recover', async () => {
    let n = 0;
    const flaky = makeTool('flaky', 'flaky tool', { type: 'object' }, () => {
      n++;
      if (n === 1) throw new Error('boom');
      return { ok: true };
    });
    const tools = new MockToolInvoker([flaky]);
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'flaky', {})]),
      toolCallResponse([toolCall('c2', 'flaky', {})]),
      finalResponse('recovered'),
    ]);
    const res = await runAgent({ goal: 'x', model, tools });
    expect(res.finished).toBe(true);
    expect(res.messages.some((m) => m.role === 'tool' && m.content?.includes('boom'))).toBe(true);
  });

  it('reports invalid arguments without executing the tool', async () => {
    const tools = new MockToolInvoker([searchCode]);
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'searchCode', {})]),
      finalResponse('ok'),
    ]);
    const res = await runAgent({ goal: 'x', model, tools });
    expect(tools.counts.searchCode ?? 0).toBe(0);
    expect(res.messages.find((m) => m.role === 'tool')?.content).toMatch(/Invalid arguments/);
  });

  it('executes parallel tool calls in one turn with distinct keys', async () => {
    const tools = new MockToolInvoker([getIssue, searchCode]);
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'getIssue', { issue: 'x' }), toolCall('c2', 'searchCode', { query: 'y' })]),
      finalResponse('done'),
    ]);
    const res = await runAgent({ goal: 'x', model, tools });
    expect(res.turns).toBe(2);
    expect(tools.calls.map((c) => c.key)).toEqual(['t:1:c1', 't:1:c2']);
  });

  it('stops at the turn budget', async () => {
    const tools = new MockToolInvoker([getIssue]);
    const model = new RuleChatModel(() => toolCallResponse([toolCall('c', 'getIssue', { issue: 'x' })]));
    const res = await runAgent({ goal: 'x', model, tools, maxTurns: 3, loopLimit: 99 });
    expect(res.finished).toBe(false);
    expect(res.stopReason).toBe('max_turns');
    expect(res.turns).toBe(3);
  });

  it('detects a loop of identical calls', async () => {
    const tools = new MockToolInvoker([getIssue]);
    const model = new RuleChatModel(() => toolCallResponse([toolCall('c', 'getIssue', { issue: 'same' })]));
    const res = await runAgent({ goal: 'x', model, tools, loopLimit: 3, maxTurns: 20 });
    expect(res.stopReason).toBe('loop_detected');
    expect(res.finished).toBe(false);
  });

  it('detects an A→B→A→B sequence loop', async () => {
    const tools = new MockToolInvoker([getIssue, searchCode]);
    // Model alternates getIssue→searchCode→getIssue→searchCode…
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'getIssue', { issue: 'same' })]),
      toolCallResponse([toolCall('c2', 'searchCode', { query: 'same' })]),
      toolCallResponse([toolCall('c3', 'getIssue', { issue: 'same' })]),
      toolCallResponse([toolCall('c4', 'searchCode', { query: 'same' })]),
      finalResponse('unreachable'),
    ]);
    const res = await runAgent({
      goal: 'x', model, tools, maxTurns: 20,
      loopOptions: {
        limit: 99,              // never trip on single-call repeats
        sequenceDetection: true,
        sequenceLengths: [2],
        sequenceLimit: 2,       // 2 occurrences of the pair = loop
      },
    });
    expect(res.stopReason).toBe('loop_detected');
  });

  it('respects per-tool loop limits via loopOptions', async () => {
    // searchCode: limit 2 → first repeat trips (2nd call)
    const tools = new MockToolInvoker([searchCode]);
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'searchCode', { query: 'x' })]),
      toolCallResponse([toolCall('c2', 'searchCode', { query: 'x' })]),
      finalResponse('unreachable'),
    ]);
    const res = await runAgent({
      goal: 'x', model, tools, maxTurns: 10,
      loopOptions: { toolLimits: { searchCode: 2 }, limit: 99 },
    });
    expect(res.stopReason).toBe('loop_detected');
    expect(res.turns).toBe(2);
  });
});

describe('loop termination & error handling', () => {
  const outputSchema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  } as const;

  it('bounds structured-output validation retries by outputRetries, not maxTurns', async () => {
    const tools = new MockToolInvoker([]);
    const model = new RuleChatModel(() => finalResponse('not valid json'));
    const res = await runAgent({
      goal: 'x', model, tools,
      outputSchema,
      outputRetries: 1,
      maxTurns: 10,
    });
    // 1 initial + 1 retry; the next invalid answer hits the (now reachable)
    // invalid_output terminal instead of retrying until maxTurns.
    expect(res.stopReason).toBe('invalid_output');
    expect(res.finished).toBe(false);
    expect(model.calls).toBe(2);
  });

  it('default outputRetries also terminate at invalid_output, not max_turns', async () => {
    const tools = new MockToolInvoker([]);
    const model = new RuleChatModel(() => finalResponse('not valid json'));
    const res = await runAgent({
      goal: 'x', model, tools,
      outputSchema: { type: 'object', properties: {}, required: [] },
      maxTurns: 20,
    });
    expect(res.stopReason).toBe('invalid_output');
    expect(model.calls).toBe(4); // 1 + DEFAULT_OUTPUT_RETRIES (3)
  });

  it('treats a token-truncated answer (stopReason length) as not-final and continues', async () => {
    const tools = new MockToolInvoker([]);
    let calls = 0;
    const model = new RuleChatModel(() => {
      calls++;
      if (calls === 1) {
        return {
          message: { role: 'assistant', content: 'The answer is' },
          stopReason: 'length' as const,
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      }
      return finalResponse('The answer is 42');
    });
    const res = await runAgent({ goal: 'x', model, tools, maxTurns: 5 });
    expect(res.finished).toBe(true);
    expect(res.answer).toBe('The answer is 42');
    expect(calls).toBe(2);
    expect(res.messages.some((m) => m.role === 'user' && m.content?.includes('cut off'))).toBe(true);
  });

  it('streaming: retries a transient mid-stream failure and completes', async () => {
    const tools = new MockToolInvoker([]);
    let attempts = 0;
    const model: ChatModel = {
      name: 'flaky-stream',
      chat: async () => { throw new Error('unused'); },
      async *chatStream() {
        attempts++;
        if (attempts === 1) throw new TransientError('socket drop');
        yield { content: 'recovered answer' };
        yield { stopReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
      },
    };
    let result!: AgentRunResult;
    for await (const ev of runAgentStreamed({
      goal: 'x', model, tools,
      retry: { retries: 2, sleep: async () => {}, delayMs: () => 0 },
    })) {
      if (ev.type === 'done') result = ev.result;
    }
    expect(result.finished).toBe(true);
    expect(result.answer).toBe('recovered answer');
    expect(attempts).toBe(2);
  });

  it('streaming: a truncated stream (stopReason length) is not reported finished', async () => {
    const tools = new MockToolInvoker([]);
    let streamCalls = 0;
    const model: ChatModel = {
      name: 'truncating-stream',
      chat: async () => { throw new Error('unused'); },
      async *chatStream() {
        streamCalls++;
        if (streamCalls === 1) {
          yield { content: 'The answer is' };
          yield { stopReason: 'length', usage: { promptTokens: 1, completionTokens: 1 } };
        } else {
          yield { content: 'The answer is 42' };
          yield { stopReason: 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
        }
      },
    };
    let result!: AgentRunResult;
    for await (const ev of runAgentStreamed({ goal: 'x', model, tools, maxTurns: 5 })) {
      if (ev.type === 'done') result = ev.result;
    }
    expect(result.finished).toBe(true);
    expect(result.answer).toBe('The answer is 42');
    expect(streamCalls).toBe(2);
  });
});

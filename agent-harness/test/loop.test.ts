import { describe, expect, it } from 'vitest';

import { runAgent } from '../src/control/loop.js';
import {
  MockToolInvoker,
  RuleChatModel,
  ScriptedChatModel,
  finalResponse,
  makeTool,
  toolCall,
  toolCallResponse,
} from '../src/testkit/index.js';

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

  it('passes deterministic durable keys to the model and tools', async () => {
    const tools = new MockToolInvoker([getIssue]);
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'getIssue', { issue: 'x' })]),
      finalResponse('done'),
    ]);
    await runAgent({ goal: 'x', model, tools });
    expect(model.requests.map((r) => r.key)).toEqual(['t1', 't2']);
    expect(tools.calls[0]!.key).toBe('t1:c1');
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
    expect(tools.calls.map((c) => c.key)).toEqual(['t1:c1', 't1:c2']);
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

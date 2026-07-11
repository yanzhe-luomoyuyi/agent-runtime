import { describe, expect, it } from 'vitest';

import { createAgent } from '../src/agent.js';
import { runAgent } from '../src/control/loop.js';
import { makeSubagentTool } from '../src/control/subagent.js';
import { MockToolInvoker, ScriptedChatModel, finalResponse, makeTool, toolCall, toolCallResponse } from '../src/testkit/index.js';

describe('sub-agent delegation', () => {
  it('runs a nested loop as a tool, namespacing durable keys under the parent call', async () => {
    const subTools = new MockToolInvoker([
      makeTool('lookup', 'lookup', { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, () => ({ answer: 42 })),
    ]);
    const subModel = new ScriptedChatModel([
      toolCallResponse([toolCall('s1', 'lookup', { q: 'x' })]),
      finalResponse('sub says 42'),
    ]);

    // ── NEW: sub-agent defined as an AgentConfig ──
    const lookupAgent = createAgent({
      name: 'lookup-agent',
      instructions: 'You are a data lookup specialist.',
      model: subModel,
      tools: subTools,
    });
    const subagent = makeSubagentTool({ agent: lookupAgent });

    const parentTools = new MockToolInvoker([{ spec: subagent.spec, handler: subagent.run }]);
    const parentModel = new ScriptedChatModel([
      toolCallResponse([toolCall('p1', 'delegate', { goal: 'find 42' })]),
      finalResponse('final 42'),
    ]);

    const parentAgent = createAgent({
      name: 'parent-agent',
      instructions: 'You are an orchestrator.',
      model: parentModel,
      tools: parentTools,
    });

    const res = await runAgent({ agent: parentAgent, goal: 'g' });

    expect(res.finished).toBe(true);
    expect(res.answer).toBe('final 42');
    expect(subTools.counts.lookup).toBe(1);
    // nested key = parent call key (t1:p1) + sub loop key (t1:s1)
    expect(subTools.calls[0]!.key).toBe('t1:p1:t1:s1');
  });
});

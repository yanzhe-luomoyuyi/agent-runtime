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

  it('surfaces a parsed `structured` result when outputSchema is set and the answer validates', async () => {
    const tools = new MockToolInvoker([]);
    const model = new ScriptedChatModel([finalResponse('{"dimension":"frontend","severity":"high"}')]);

    const subagent = makeSubagentTool({
      model,
      tools,
      outputSchema: {
        type: 'object',
        properties: { dimension: { type: 'string' }, severity: { type: 'string' } },
        required: ['dimension', 'severity'],
      },
    });

    const result = await subagent.run({ goal: 'analyze frontend' });

    expect(result.finished).toBe(true);
    expect(result.structured).toEqual({ dimension: 'frontend', severity: 'high' });
  });

  it('leaves `structured` undefined when no outputSchema is supplied', async () => {
    const tools = new MockToolInvoker([]);
    const model = new ScriptedChatModel([finalResponse('plain text answer')]);
    const subagent = makeSubagentTool({ model, tools });

    const result = await subagent.run({ goal: 'do something' });

    expect(result.answer).toBe('plain text answer');
    expect(result.structured).toBeUndefined();
  });
});

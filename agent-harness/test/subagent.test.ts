import { describe, expect, it } from 'vitest';

import { createAgent } from '../src/agent.js';
import { runAgent } from '../src/control/loop.js';
import { DelegationDepthExceededError, makeSubagentTool, type SubagentTool } from '../src/control/subagent.js';
import {
  MockToolInvoker,
  RuleChatModel,
  ScriptedChatModel,
  finalResponse,
  makeTool,
  toolCall,
  toolCallResponse,
} from '../src/testkit/index.js';

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
    // nested key = parent call key (t:1:p1) + sub loop key (t:1:s1)
    expect(subTools.calls[0]!.key).toBe('t:1:p1:t:1:s1');
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

describe('sub-agent delegation depth limit', () => {
  /** A model that always tries to delegate again, UNLESS it sees the depth-exceeded error in its last observation. */
  function makeRecursiveModel(): RuleChatModel {
    return new RuleChatModel((req) => {
      const last = req.messages[req.messages.length - 1];
      const content = typeof last?.content === 'string' ? last.content : '';
      if (content.includes('exceeds maxDepth')) {
        return finalResponse(`stopped: ${content}`);
      }
      return toolCallResponse([toolCall('s', 'delegate', { goal: 'go deeper' })]);
    });
  }

  it('refuses to delegate past maxDepth instead of recursing forever', async () => {
    // eslint-disable-next-line prefer-const
    let subagent!: SubagentTool;
    const tools = new MockToolInvoker([
      makeTool(
        'delegate',
        'recurse',
        { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
        (args, opts) => subagent.run(args, opts),
      ),
    ]);
    subagent = makeSubagentTool({ model: makeRecursiveModel(), tools, maxDepth: 3 });

    const result = await subagent.run({ goal: 'start' });

    // The chain terminates gracefully (never throws out of the top-level call) —
    // the depth-exceeded refusal surfaces as a tool-error observation that
    // propagates back up through every nesting level's final answer.
    expect(result.finished).toBe(true);
    expect(result.answer).toContain('exceeds maxDepth 3');
  });

  it('the depth-exceeded error is a normal tool-error observation, not an uncaught exception', async () => {
    // Same setup as above, but driven through a REAL parent loop (runAgent),
    // proving `_execOne`'s existing try/catch is what converts the thrown
    // DelegationDepthExceededError into an ordinary ERROR observation — no
    // special-casing needed anywhere else in the loop.
    // eslint-disable-next-line prefer-const
    let subagent!: SubagentTool;
    const tools = new MockToolInvoker([
      makeTool(
        'delegate',
        'recurse',
        { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
        (args, opts) => subagent.run(args, opts),
      ),
    ]);
    subagent = makeSubagentTool({ model: makeRecursiveModel(), tools, maxDepth: 1 });

    const parentTools = new MockToolInvoker([{ spec: subagent.spec, handler: subagent.run }]);
    const parentModel = new ScriptedChatModel([
      toolCallResponse([toolCall('p1', 'delegate', { goal: 'find 42' })]),
      finalResponse('parent recovered'),
    ]);
    const parentAgent = createAgent({ name: 'parent-agent', instructions: 'orchestrator', model: parentModel, tools: parentTools });

    const res = await runAgent({ agent: parentAgent, goal: 'g' });

    expect(res.finished).toBe(true); // the parent loop never crashes
    expect(res.answer).toBe('parent recovered');
  });

  it('defaults to a finite depth (5) when maxDepth is not configured', async () => {
    // eslint-disable-next-line prefer-const
    let subagent!: SubagentTool;
    const tools = new MockToolInvoker([
      makeTool(
        'delegate',
        'recurse',
        { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
        (args, opts) => subagent.run(args, opts),
      ),
    ]);
    subagent = makeSubagentTool({ model: makeRecursiveModel(), tools }); // no maxDepth => default

    const result = await subagent.run({ goal: 'start' });

    expect(result.finished).toBe(true);
    expect(result.answer).toContain('exceeds maxDepth 5');
  });

  it('DelegationDepthExceededError carries the depth and ceiling for programmatic handling', () => {
    const err = new DelegationDepthExceededError(4, 3);
    expect(err.depth).toBe(4);
    expect(err.maxDepth).toBe(3);
    expect(err.name).toBe('DelegationDepthExceededError');
  });

  it('two independent (non-nested) delegate calls in the same process do not share depth state', async () => {
    // AsyncLocalStorage must isolate unrelated call chains — a shallow, isolated
    // delegate call must NOT be affected by a separate, deep recursive chain
    // running (even concurrently) elsewhere in the same process.
    // eslint-disable-next-line prefer-const
    let recursiveSubagent!: SubagentTool;
    const recursiveTools = new MockToolInvoker([
      makeTool(
        'delegate',
        'recurse',
        { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] },
        (args, opts) => recursiveSubagent.run(args, opts),
      ),
    ]);
    recursiveSubagent = makeSubagentTool({ model: makeRecursiveModel(), tools: recursiveTools, maxDepth: 2 });

    const shallowModel = new ScriptedChatModel([finalResponse('shallow done')]);
    const shallowSubagent = makeSubagentTool({ model: shallowModel, tools: new MockToolInvoker([]), maxDepth: 2 });

    const [deep, shallow] = await Promise.all([
      recursiveSubagent.run({ goal: 'start' }),
      shallowSubagent.run({ goal: 'start' }),
    ]);

    expect(deep.answer).toContain('exceeds maxDepth 2');
    expect(shallow.answer).toBe('shallow done'); // unaffected by the concurrent deep chain
  });

  it('depth is scoped per call chain: two SEQUENTIAL (sibling) delegate calls from the SAME level both see the SAME depth, it does not keep accumulating', async () => {
    // subagentB never delegates further — it just answers immediately.
    const subagentB = makeSubagentTool({
      name: 'delegateB',
      model: new ScriptedChatModel([finalResponse('B done'), finalResponse('B done again')]),
      tools: new MockToolInvoker([]),
    });

    // subagentA's model calls delegateB TWICE, in two SEPARATE turns (turn 1,
    // then turn 2 after B's first call has already returned and finished) —
    // these are siblings, not nested inside each other.
    const subagentATools = new MockToolInvoker([{ spec: subagentB.spec, handler: subagentB.run }]);
    const subagentAModel = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'delegateB', { goal: 'first' })]),
      toolCallResponse([toolCall('c2', 'delegateB', { goal: 'second' })]),
      finalResponse('A done'),
    ]);
    // maxDepth 2 on subagentA: if depth wrongly kept accumulating across the
    // two sibling delegateB calls instead of correctly reverting to
    // subagentA's own ambient depth (1) once subagentB's first call finishes,
    // the SECOND delegateB call would compute depth 3 and be refused.
    const subagentA = makeSubagentTool({ model: subagentAModel, tools: subagentATools, maxDepth: 2 });

    const result = await subagentA.run({ goal: 'start' });

    expect(result.finished).toBe(true);
    expect(result.answer).toBe('A done'); // never hit "exceeds maxDepth" on the second, sibling delegateB call
  });
});

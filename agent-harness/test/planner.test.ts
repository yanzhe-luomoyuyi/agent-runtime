import { describe, expect, it } from 'vitest';

import { makePlan, parsePlan, runPlannedAgent } from '../src/control/planner.js';
import { MockToolInvoker, ScriptedChatModel, finalResponse, makeTool } from '../src/testkit/index.js';

describe('planner', () => {
  it('parses a JSON plan', () => {
    expect(parsePlan('{"steps":["a","b"]}').steps).toEqual(['a', 'b']);
  });

  it('falls back to numbered/bulleted lines', () => {
    expect(parsePlan('1. first\n2. second').steps).toEqual(['first', 'second']);
  });

  it('makePlan asks the model and returns steps', async () => {
    const model = new ScriptedChatModel([finalResponse('{"steps":["look","fix"]}')]);
    expect((await makePlan('goal', model)).steps).toEqual(['look', 'fix']);
  });

  it('runPlannedAgent injects the plan into the loop system prompt', async () => {
    const tools = new MockToolInvoker([makeTool('noop', 'noop', { type: 'object' }, () => ({}))]);
    const model = new ScriptedChatModel([
      finalResponse('{"steps":["step one","step two"]}'), // planning call
      finalResponse('all done'), // loop turn 1
    ]);
    const res = await runPlannedAgent({ goal: 'g', model, tools });
    expect(res.plan.steps).toEqual(['step one', 'step two']);
    expect(res.answer).toBe('all done');
    const firstLoopSystem = model.requests[1]!.messages.find((m) => m.role === 'system');
    expect(firstLoopSystem?.content).toContain('step one');
  });
});

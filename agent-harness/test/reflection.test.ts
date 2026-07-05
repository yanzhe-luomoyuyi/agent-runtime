import { describe, expect, it } from 'vitest';

import { parseCritique, runReflectiveAgent } from '../src/control/reflection.js';
import { MockToolInvoker, ScriptedChatModel, finalResponse, makeTool } from '../src/testkit/index.js';

describe('reflection', () => {
  it('parses a critique', () => {
    expect(parseCritique('{"satisfactory":false,"feedback":"add tests"}')).toEqual({ satisfactory: false, feedback: 'add tests' });
  });

  it('revises when unsatisfactory then stops when satisfactory', async () => {
    const tools = new MockToolInvoker([makeTool('noop', 'noop', { type: 'object' }, () => ({}))]);
    const model = new ScriptedChatModel([
      finalResponse('draft 1'), // attempt a0, turn 1
      finalResponse('{"satisfactory":false,"feedback":"more detail"}'), // reflect 0
      finalResponse('draft 2'), // attempt a1, turn 1
      finalResponse('{"satisfactory":true,"feedback":"good"}'), // reflect 1
    ]);
    const res = await runReflectiveAgent({ goal: 'g', model, tools, maxReflections: 2 });
    expect(res.answer).toBe('draft 2');
    expect(res.critiques.length).toBe(2);
    expect(res.critiques[1]!.satisfactory).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { buildRevisedGoal, parseCritique, runReflectiveAgent } from '../src/control/reflection.js';
import { MockToolInvoker, ScriptedChatModel, finalResponse, makeTool } from '../src/testkit/index.js';

describe('reflection', () => {
  it('parses a critique', () => {
    expect(parseCritique('{"satisfactory":false,"feedback":"add tests"}')).toEqual({ satisfactory: false, feedback: 'add tests' });
  });

  it('parses a structured (L2) critique with root cause, correction strategy, and what worked', () => {
    const text = JSON.stringify({
      satisfactory: false,
      feedback: 'missing error handling',
      rootCause: 'Step 3 assumes input is always valid JSON',
      correctionStrategy: 'validate input with a schema before parsing',
      whatWorked: ['Step 1 correctly fetches the data', 'Step 2 correctly transforms it'],
    });
    expect(parseCritique(text)).toEqual({
      satisfactory: false,
      feedback: 'missing error handling',
      rootCause: 'Step 3 assumes input is always valid JSON',
      correctionStrategy: 'validate input with a schema before parsing',
      whatWorked: ['Step 1 correctly fetches the data', 'Step 2 correctly transforms it'],
    });
  });

  it('omits empty structured fields rather than including them as blanks', () => {
    const text = JSON.stringify({ satisfactory: true, feedback: 'good', rootCause: '', whatWorked: [] });
    expect(parseCritique(text)).toEqual({ satisfactory: true, feedback: 'good' });
  });

  it('buildRevisedGoal weaves in root cause, correction strategy, and what worked when present', () => {
    const goal = buildRevisedGoal('do the thing', 'draft 1', {
      satisfactory: false,
      feedback: 'missing error handling',
      rootCause: 'no validation before parsing',
      correctionStrategy: 'validate with a schema first',
      whatWorked: ['data fetching is correct'],
    });
    expect(goal).toContain('do the thing');
    expect(goal).toContain('draft 1');
    expect(goal).toContain('Root cause of the shortfall:\nno validation before parsing');
    expect(goal).toContain('How to fix it this time:\nvalidate with a schema first');
    expect(goal).toContain('data fetching is correct');
    expect(goal).toContain('Reviewer feedback to address:\nmissing error handling');
  });

  it('buildRevisedGoal falls back to plain feedback for L1-shaped critiques', () => {
    const goal = buildRevisedGoal('do the thing', 'draft 1', { satisfactory: false, feedback: 'more detail' });
    expect(goal).not.toContain('Root cause');
    expect(goal).not.toContain('How to fix it this time');
    expect(goal).toContain('Reviewer feedback to address:\nmore detail');
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

  it('revises using structured diagnosis when the critic provides one', async () => {
    const tools = new MockToolInvoker([makeTool('noop', 'noop', { type: 'object' }, () => ({}))]);
    const model = new ScriptedChatModel([
      finalResponse('draft 1'), // attempt a0, turn 1
      finalResponse(
        JSON.stringify({
          satisfactory: false,
          feedback: 'missing edge case handling',
          rootCause: 'assumed input is never empty',
          correctionStrategy: 'add an explicit empty-input branch',
          whatWorked: ['overall structure is correct'],
        }),
      ), // reflect 0
      finalResponse('draft 2'), // attempt a1, turn 1
      finalResponse('{"satisfactory":true,"feedback":"good"}'), // reflect 1
    ]);
    const res = await runReflectiveAgent({ goal: 'g', model, tools, maxReflections: 2 });
    expect(res.answer).toBe('draft 2');
    expect(res.critiques[0]!.rootCause).toBe('assumed input is never empty');
    expect(res.critiques[0]!.correctionStrategy).toBe('add an explicit empty-input branch');
    expect(res.critiques[0]!.whatWorked).toEqual(['overall structure is correct']);
  });
});

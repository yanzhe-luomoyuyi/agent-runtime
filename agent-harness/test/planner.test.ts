import { describe, expect, it } from 'vitest';

import {
  makePlan,
  newPlan,
  parsePlanSteps,
  advancePlan,
  failCurrentStep,
  formatPlanForPrompt,
  validatePlanFeasibility,
  runPlannedAgent,
} from '../src/control/planner.js';
import {
  MockToolInvoker,
  ScriptedChatModel,
  finalResponse,
  makeTool,
  toolCall,
  toolCallResponse,
} from '../src/testkit/index.js';

describe('planner — plan state', () => {
  it('newPlan builds a PlanState with all steps pending', () => {
    const plan = newPlan(['a', 'b']);
    expect(plan.steps).toEqual(['a', 'b']);
    expect(plan.statuses).toEqual(['pending', 'pending']);
    expect(plan.currentStep).toBe(-1);
  });

  it('advancePlan sets current step to in_progress and earlier to completed', () => {
    const plan = advancePlan(newPlan(['a', 'b', 'c']), 1);
    expect(plan.statuses).toEqual(['completed', 'in_progress', 'pending']);
    expect(plan.currentStep).toBe(1);
  });

  it('failCurrentStep marks the current step as failed', () => {
    const plan = failCurrentStep(advancePlan(newPlan(['a', 'b', 'c']), 0));
    expect(plan.statuses[0]).toBe('failed');
  });

  it('formatPlanForPrompt renders ✓/→/○ markers', () => {
    const plan = advancePlan(newPlan(['do x', 'do y']), 0);
    const text = formatPlanForPrompt(plan);
    expect(text).toContain('→');
    expect(text).toContain('do x');
    expect(text).toContain('○');
    expect(text).toContain('do y');
  });
});

describe('planner — feasibility', () => {
  it('warns when plan does not reference any available tool', () => {
    const tools = new MockToolInvoker([makeTool('searchCode', 'search', { type: 'object' }, () => ({}))]);
    const warnings = validatePlanFeasibility(newPlan(['look at the code', 'fix it']), tools);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('searchCode');
  });

  it('returns no warnings when plan references tools', () => {
    const tools = new MockToolInvoker([makeTool('searchCode', 'search', { type: 'object' }, () => ({}))]);
    const warnings = validatePlanFeasibility(newPlan(['use searchCode to find the bug']), tools);
    expect(warnings).toEqual([]);
  });
});

describe('planner — parse & make', () => {
  it('parses a JSON plan', () => {
    expect(parsePlanSteps('{"steps":["a","b"]}')).toEqual(['a', 'b']);
  });

  it('falls back to numbered/bulleted lines', () => {
    expect(parsePlanSteps('1. first\n2. second')).toEqual(['first', 'second']);
  });

  it('makePlan asks the model and returns a PlanState', async () => {
    const model = new ScriptedChatModel([finalResponse('{"steps":["look","fix"]}')]);
    const plan = await makePlan('goal', model);
    expect(plan.steps).toEqual(['look', 'fix']);
  });
});

describe('planner — runPlannedAgent', () => {
  it('executes step by step with progress context', async () => {
    const tools = new MockToolInvoker([makeTool('noop', 'noop', { type: 'object' }, () => ({}))]);
    const model = new ScriptedChatModel([
      finalResponse('{"steps":["step one","step two"]}'), // plan
      finalResponse('step 1 done'),                        // s0 run
      finalResponse('step 2 done'),                        // s1 run
    ]);
    const res = await runPlannedAgent({ goal: 'g', model, tools });
    expect(res.plan.steps).toEqual(['step one', 'step two']);
    expect(res.plan.statuses).toEqual(['completed', 'completed']);
    expect(res.replans).toBe(0);
    // Each step had its own runAgent call
    expect(model.requests.length).toBe(3); // plan + 2 steps
  });

  it('re-plans on failure', async () => {
    // maxTurns=1, model returns a tool call (not final answer) →
    // step stops with 'max_turns' → triggers re-plan.
    const tools = new MockToolInvoker([makeTool('noop', 'noop', { type: 'object' }, () => ({}))]);
    const model = new ScriptedChatModel([
      finalResponse('{"steps":["bad step"]}'),             // 1: plan
      toolCallResponse([toolCall('c1', 'noop', {})]),      // 2: step 0 → tool call, hits max_turns
      finalResponse('{"steps":["retry step"]}'),           // 3: replan
      finalResponse('retry done'),                          // 4: step 0 re-run
    ]);
    const res = await runPlannedAgent({
      goal: 'g', model, tools,
      maxReplans: 1,
      maxTurns: 1,
    });
    expect(res.replans).toBe(1);
    expect(res.plan.steps).toEqual(['retry step']);
  });
});

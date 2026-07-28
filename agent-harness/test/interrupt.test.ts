import { describe, expect, it } from 'vitest';
import { isGoalMessage } from '@agent/contracts';

import { createInterruptHandle, type RunInterrupter } from '../src/control/interrupt.js';
import { runAgent, runAgentStreamed } from '../src/control/loop.js';
import {
  MockToolInvoker,
  ScriptedChatModel,
  finalResponse,
  makeTool,
  toolCall,
  toolCallResponse,
} from '../src/testkit/index.js';

function noopTools() {
  return new MockToolInvoker([makeTool('noop', 'noop', { type: 'object' }, () => ({}))]);
}

describe('mid-run interrupt / steer', () => {
  it('injects a steer message into the transcript before the next turn', async () => {
    const tools = noopTools();
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'noop', {})]),
      finalResponse('done'),
    ]);
    const interrupter: RunInterrupter = {
      atTurnBoundary: async (ctx) => {
        if (ctx.turnsCompleted === 1) {
          return { action: 'steer', inject: 'Focus on the safe path only.' };
        }
        return { action: 'continue' };
      },
    };

    const res = await runAgent({ goal: 'g', model, tools, interrupter, maxTurns: 5 });
    expect(res.finished).toBe(true);
    expect(res.messages.some((m) => m.role === 'user' && m.content === 'Focus on the safe path only.')).toBe(true);
  });

  it('rewrites the goal message on steer', async () => {
    const tools = noopTools();
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'noop', {})]),
      finalResponse('done'),
    ]);
    const interrupter: RunInterrupter = {
      atTurnBoundary: async (ctx) => {
        if (ctx.turnsCompleted === 1) return { action: 'steer', goal: 'revised goal' };
        return { action: 'continue' };
      },
    };

    const res = await runAgent({ goal: 'original', model, tools, interrupter, maxTurns: 5 });
    const goals = res.messages.filter(isGoalMessage);
    expect(goals.some((m) => m.content === 'Goal: revised goal')).toBe(true);
  });

  it('aborts with salvage — returns transcript and stopReason aborted', async () => {
    const tools = noopTools();
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'noop', {})]),
      finalResponse('should not run'),
    ]);
    const interrupter: RunInterrupter = {
      atTurnBoundary: async (ctx) => {
        if (ctx.turnsCompleted === 1) return { action: 'abort', reason: 'human stopped' };
        return { action: 'continue' };
      },
    };

    const res = await runAgent({ goal: 'g', model, tools, interrupter, maxTurns: 5 });
    expect(res.finished).toBe(false);
    expect(res.stopReason).toBe('aborted');
    expect(res.answer).toContain('human stopped');
    expect(res.turns).toBe(1);
    expect(res.messages.length).toBeGreaterThan(0);
    expect(tools.counts.noop).toBe(1);
    // Second model response was never consumed.
    expect(model.requests.length).toBe(1);
  });

  it('createInterruptHandle pause + resume unblocks the loop', async () => {
    const tools = noopTools();
    const model = new ScriptedChatModel([finalResponse('done')]);
    const handle = createInterruptHandle();
    handle.pause(); // block before turn 1 starts

    const runPromise = runAgent({
      goal: 'g',
      model,
      tools,
      interrupter: handle.interrupter,
      maxTurns: 5,
    });

    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (handle.isWaiting()) {
          clearInterval(poll);
          handle.resume();
          resolve();
        }
      }, 5);
    });

    const res = await runPromise;
    expect(res.finished).toBe(true);
    expect(res.stopReason).toBe('finished');
  });

  it('createInterruptHandle queued abort applies at the next boundary', async () => {
    const tools = noopTools();
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'noop', {})]),
      finalResponse('should not run'),
    ]);
    const handle = createInterruptHandle();
    handle.abort('queued stop');

    const res = await runAgent({
      goal: 'g',
      model,
      tools,
      interrupter: handle.interrupter,
      maxTurns: 5,
    });
    expect(res.stopReason).toBe('aborted');
    expect(res.turns).toBe(0);
    expect(model.requests.length).toBe(0);
  });

  it('emits steered / aborted stream events', async () => {
    const tools = noopTools();
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'noop', {})]),
      finalResponse('should not run'),
    ]);
    const interrupter: RunInterrupter = {
      atTurnBoundary: async (ctx) => {
        if (ctx.turnsCompleted === 0) return { action: 'steer', inject: 'hint' };
        if (ctx.turnsCompleted === 1) return { action: 'abort', reason: 'enough' };
        return { action: 'continue' };
      },
    };

    const events: string[] = [];
    const gen = runAgentStreamed({ goal: 'g', model, tools, interrupter, maxTurns: 5 });
    let iter = await gen.next();
    while (!iter.done) {
      events.push(iter.value.type);
      iter = await gen.next();
    }
    expect(events).toContain('steered');
    expect(events).toContain('aborted');
    expect(iter.value.stopReason).toBe('aborted');
  });
});

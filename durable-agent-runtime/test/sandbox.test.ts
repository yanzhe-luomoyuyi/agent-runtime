import { describe, expect, it } from 'vitest';

import type { ExecutionSandbox } from '@agent/contracts';

import { createStepContext } from '../src/step-context.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('sandbox enforcement', () => {
  it('blocks tool invocations before the tool runs', async () => {
    const sandbox: ExecutionSandbox = {
      kind: 'test-sandbox',
      resolvePath: (path) => path,
      guardToolInvocation: async (_tool, args) => {
        const candidate = typeof args === 'object' && args && 'path' in args ? String((args as { path?: unknown }).path) : '';
        if (candidate.startsWith('../')) throw new Error('sandbox denied');
      },
    };

    const tools = new ToolRegistry().register({
      name: 'read_file',
      description: 'read a file',
      inputSchema: {},
      run: async () => 'ok',
    });

    const events: Array<{ type: string }> = [];
    const ctx = createStepContext({
      runId: 'run-1',
      issue: 'test',
      tools,
      sandbox,
      record: (event) => events.push({ type: event.type }),
      getState: () => ({
        currentPhase: 'phase',
        currentStep: 1,
        input: { issue: 'test' },
        modelResults: {},
        toolResults: {},
        phases: {},
        stepsCompleted: [],
        status: 'running',
      }) as any,
      getSpentUsd: () => 0,
    });

    await expect(ctx.callTool('read_file', { path: '../secret.txt' })).rejects.toThrow('sandbox denied');
    expect(events.some((e) => e.type === 'ToolCallFailed')).toBe(true);
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { MockAgentModel } from '../src/app/agent-scenario.js';
import { createHarnessWorkflow } from '../src/app/harness-adapter.js';
import { listRunIds } from '../src/eventlog.js';
import { Runtime } from '../src/runtime.js';
import { estimateTokens, type ModelProvider, type ModelResult } from '../src/model/provider.js';
import { LOGIN_ISSUE, makeCountingTools } from './helpers/demo.js';

/** Model that keeps calling the same tool with identical args — loop-bait. */
class RepeatingAgentModel implements ModelProvider {
  readonly name = 'mock-repeating';

  async complete(prompt: string): Promise<ModelResult> {
    const goal = /Goal:\s*(.+)/.exec(prompt)?.[1]?.trim() ?? '';
    const text = JSON.stringify({ action: 'call_tool', tool: 'getIssue', args: { issue: goal } });
    return { text, promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(text) };
  }
}

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'harness-rt-'));
});

describe('@agent/harness on the durable runtime', () => {
  it('drives the loop to completion through the runtime seam', async () => {
    const { tools, calls } = makeCountingTools();
    const runtime = new Runtime({ baseDir, model: new MockAgentModel(), tools, workflow: createHarnessWorkflow() });

    const state = await runtime.run(LOGIN_ISSUE);

    expect(state.status).toBe('completed');
    const summary = state.summary as { proposal?: string; toolsUsed?: string[]; turns?: number; files?: string[] };
    expect(summary.toolsUsed).toEqual(['getIssue', 'searchCode']);
    expect(summary.turns).toBe(3);
    expect(summary.proposal).toContain('login.ts');
    expect(summary.files).toContain('src/auth/login.ts');
    expect(calls).toEqual({ getIssue: 1, searchCode: 1 });
  });

  it('resumes after a mid-loop crash without re-running completed tool calls', async () => {
    const { tools, calls } = makeCountingTools();

    // Attempt 1 crashes right after turn 1 — getIssue has executed and been recorded.
    const crashing = new Runtime({ baseDir, model: new MockAgentModel(), tools, workflow: createHarnessWorkflow({ crashAfterTurn: 1 }) });
    await expect(crashing.run(LOGIN_ISSUE)).rejects.toThrow(/__CRASH__/);
    expect(calls).toEqual({ getIssue: 1, searchCode: 0 });

    const [runId] = listRunIds(baseDir);
    expect(runId).toBeTruthy();

    // Attempt 2 (same log + same tools, no crash) resumes and completes.
    const resumer = new Runtime({ baseDir, model: new MockAgentModel(), tools, workflow: createHarnessWorkflow() });
    const state = await resumer.resume(runId!);

    expect(state.status).toBe('completed');
    // getIssue was replayed from the event log (NOT re-run); searchCode ran once on resume.
    expect(calls).toEqual({ getIssue: 1, searchCode: 1 });
    expect((state.summary as { proposal?: string }).proposal).toContain('login.ts');
  });

  it('aborts a repeating identical tool call via the default loop detector', async () => {
    const { tools } = makeCountingTools();
    const runtime = new Runtime({
      baseDir,
      model: new RepeatingAgentModel(),
      tools,
      workflow: createHarnessWorkflow(),
    });

    const state = await runtime.run(LOGIN_ISSUE);
    const result = state.stepOutputs['agent.1'] as { stopReason?: string; turns?: number };
    // Default limit 3: the 3rd identical getIssue call trips and ends the run.
    expect(result.stopReason).toBe('loop_detected');
    expect(result.turns).toBe(3);
  });

  it('honors loopOptions.toolLimits (raised limit does not trip)', async () => {
    const { tools } = makeCountingTools();
    const runtime = new Runtime({
      baseDir,
      model: new RepeatingAgentModel(),
      tools,
      workflow: createHarnessWorkflow({
        // toolLimits only governs the single-call repeat rule; sequence
        // detection is a separate trip path (see loop-detector), so disable it
        // here to isolate the toolLimits flow-through.
        loopOptions: { toolLimits: { getIssue: 100 }, sequenceDetection: false },
      }),
    });

    const state = await runtime.run(LOGIN_ISSUE);
    const result = state.stepOutputs['agent.1'] as { stopReason?: string; turns?: number };
    // No trip with the raised per-tool limit — runs to the turn budget instead.
    expect(result.stopReason).toBe('max_turns');
    expect(result.turns).toBe(12);
  });
});

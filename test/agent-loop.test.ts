import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { createAgentWorkflow, parseDecision, type AgentResult } from '../src/agent-loop.js';
import { MockAgentModel } from '../src/app/agent-scenario.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';

/** Tools that count real executions — used to prove idempotency across resume. */
function makeCountingTools(): { tools: ToolRegistry; calls: Record<string, number> } {
  const calls = { getIssue: 0, searchCode: 0 };
  const getIssue: ToolDef<{ issue: string }> = {
    name: 'getIssue',
    description: 'Fetch a mock issue.',
    inputSchema: { type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'] },
    run: (args) => {
      calls.getIssue++;
      return { title: args.issue.slice(0, 40), body: args.issue, labels: ['bug'] };
    },
  };
  const searchCode: ToolDef<{ query: string }> = {
    name: 'searchCode',
    description: 'Search the mock codebase.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: () => {
      calls.searchCode++;
      return { files: ['src/auth/login.ts', 'src/auth/session.ts'] };
    },
  };
  return { tools: new ToolRegistry().register(getIssue).register(searchCode), calls };
}

const ISSUE = 'Login page crashes with a null session';

describe('agent harness (model-driven loop)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-loop-'));
  });

  it('lets the model drive: getIssue -> searchCode -> finish', async () => {
    const { tools, calls } = makeCountingTools();
    const runtime = new Runtime({ baseDir: dir, model: new MockAgentModel(), tools, workflow: createAgentWorkflow() });

    const state = await runtime.run(ISSUE);

    expect(state.status).toBe('completed');
    const result = state.stepOutputs['agent.1'] as AgentResult;
    expect(result.finished).toBe(true);
    expect(result.turns).toBe(3); // getIssue, searchCode, then finish
    expect(result.transcript.map((t) => t.tool)).toEqual(['getIssue', 'searchCode']);
    expect(calls).toEqual({ getIssue: 1, searchCode: 1 });
    expect((state.summary as { proposal: string }).proposal).toContain('login.ts');
  });

  it('resumes after a mid-loop crash without re-running completed turns', async () => {
    const { tools, calls } = makeCountingTools();

    // Crash right after turn 1 (getIssue) has executed but before the loop finishes.
    const crashing = new Runtime({
      baseDir: dir,
      model: new MockAgentModel(),
      tools,
      workflow: createAgentWorkflow({ crashAfterTurn: 1 }),
    });
    await expect(crashing.run(ISSUE)).rejects.toThrow('__CRASH__');
    expect(calls).toEqual({ getIssue: 1, searchCode: 0 });

    const runId = readdirSync(dir)[0]!;

    // Resume with a fresh runtime and no crash hook — turn 1 replays from the log.
    const resumed = new Runtime({ baseDir: dir, model: new MockAgentModel(), tools, workflow: createAgentWorkflow() });
    const state = await resumed.resume(runId);

    expect(state.status).toBe('completed');
    // Idempotency guarantee: getIssue is NOT re-executed on resume (replayed from
    // the log); only the not-yet-run searchCode executes.
    expect(calls).toEqual({ getIssue: 1, searchCode: 1 });
    const result = state.stepOutputs['agent.1'] as AgentResult;
    expect(result.finished).toBe(true);
    expect(result.transcript.map((t) => t.tool)).toEqual(['getIssue', 'searchCode']);
  });

  it('a resumed run yields the same final state as a clean run', async () => {
    const clean = new Runtime({
      baseDir: mkdtempSync(join(tmpdir(), 'agent-clean-')),
      model: new MockAgentModel(),
      tools: makeCountingTools().tools,
      workflow: createAgentWorkflow(),
    });
    const cleanState = await clean.run(ISSUE);

    const crashDir = mkdtempSync(join(tmpdir(), 'agent-crash-'));
    const crashing = new Runtime({
      baseDir: crashDir,
      model: new MockAgentModel(),
      tools: makeCountingTools().tools,
      workflow: createAgentWorkflow({ crashAfterTurn: 1 }),
    });
    await expect(crashing.run(ISSUE)).rejects.toThrow('__CRASH__');
    const runId = readdirSync(crashDir)[0]!;
    const resumed = new Runtime({
      baseDir: crashDir,
      model: new MockAgentModel(),
      tools: makeCountingTools().tools,
      workflow: createAgentWorkflow(),
    });
    const resumedState = await resumed.resume(runId);

    expect(resumedState.status).toBe(cleanState.status);
    expect(resumedState.stepOutputs).toEqual(cleanState.stepOutputs);
    expect(resumedState.summary).toEqual(cleanState.summary);
  });

  it('keeps in-memory state equal to reduce(log) — the event-sourcing invariant', async () => {
    const { tools } = makeCountingTools();
    const runtime = new Runtime({ baseDir: dir, model: new MockAgentModel(), tools, workflow: createAgentWorkflow() });
    const state = await runtime.run(ISSUE);
    expect(state).toEqual(runtime.status(state.runId));
  });

  it('parseDecision tolerates code fences and surrounding prose', () => {
    expect(parseDecision('```json\n{"action":"finish","answer":"done"}\n```')).toEqual({ action: 'finish', answer: 'done' });
    expect(parseDecision('Sure! {"action":"call_tool","tool":"getIssue","args":{"issue":"x"}} ok')).toEqual({
      action: 'call_tool',
      tool: 'getIssue',
      args: { issue: 'x' },
    });
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { MockAgentModel } from '../src/app/agent-scenario.js';
import { createHarnessWorkflow } from '../src/app/harness-adapter.js';
import { listRunIds } from '../src/eventlog.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';

const ISSUE = 'Login page crashes with a null session';

/** Tools that count real executions — used to prove idempotent replay on resume. */
function makeCountingTools(): { tools: ToolRegistry; calls: { getIssue: number; searchCode: number } } {
  const calls = { getIssue: 0, searchCode: 0 };
  const getIssue: ToolDef<{ issue: string }> = {
    name: 'getIssue',
    description: 'fetch issue',
    inputSchema: { type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'] },
    run: (args) => {
      calls.getIssue++;
      return { title: args.issue.slice(0, 40), body: args.issue, labels: ['bug'] };
    },
  };
  const searchCode: ToolDef<{ query: string }> = {
    name: 'searchCode',
    description: 'search code',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: (args) => {
      calls.searchCode++;
      return { files: /login|auth|session/i.test(args.query) ? ['src/auth/login.ts', 'src/auth/session.ts'] : ['src/index.ts'] };
    },
  };
  return { tools: new ToolRegistry().register(getIssue).register(searchCode), calls };
}

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'harness-rt-'));
});

describe('@agent/harness on the durable runtime', () => {
  it('drives the loop to completion through the runtime seam', async () => {
    const { tools, calls } = makeCountingTools();
    const runtime = new Runtime({ baseDir, model: new MockAgentModel(), tools, workflow: createHarnessWorkflow() });

    const state = await runtime.run(ISSUE);

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
    await expect(crashing.run(ISSUE)).rejects.toThrow(/__CRASH__/);
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
});

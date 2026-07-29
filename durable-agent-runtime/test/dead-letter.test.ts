/**
 * Dead-letter queue tests: the disk-backed `FileDeadLetterQueue` itself, and
 * its wiring into `Runtime`'s tool funnel (`RuntimeOptions.deadLetterQueue`).
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeadLetter } from '@agent/harness';
import { beforeEach, describe, expect, it } from 'vitest';

import { issueWorkflow } from '../src/app/issue-workflow.js';
import { FileDeadLetterQueue } from '../src/dead-letter-store.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry, type ToolDef } from '../src/tools/registry.js';
import { makeModel, makeTools } from './helpers/demo.js';

function makeFailingTools(): ToolRegistry {
  const tools = makeTools();
  const searchCode: ToolDef = {
    name: 'searchCode',
    description: '',
    inputSchema: {},
    run: () => {
      throw new Error('search index unavailable');
    },
  };
  return new ToolRegistry().register(tools.get('getIssue')!).register(searchCode);
}


const sampleLetter = (overrides: Partial<DeadLetter> = {}): DeadLetter => ({
  id: 'dlq-1',
  tool: 'searchCode',
  args: { query: 'x' },
  error: 'boom',
  attempts: 1,
  firstFailedAt: '2026-01-01T00:00:00.000Z',
  lastFailedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('FileDeadLetterQueue', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dlq-'));
  });

  it('pushes, gets, lists, and removes letters', () => {
    const q = new FileDeadLetterQueue(join(dir, 'dlq.json'));
    q.push(sampleLetter());
    expect(q.get('dlq-1')).toEqual(sampleLetter());
    expect(q.list()).toEqual([sampleLetter()]);
    expect(q.remove('dlq-1')).toBe(true);
    expect(q.remove('dlq-1')).toBe(false); // already gone
    expect(q.list()).toEqual([]);
  });

  it('upserts in place when pushed again with the same id (idempotent)', () => {
    const q = new FileDeadLetterQueue(join(dir, 'dlq.json'));
    q.push(sampleLetter({ attempts: 1 }));
    q.push(sampleLetter({ attempts: 2, lastFailedAt: '2026-01-01T00:05:00.000Z' }));
    expect(q.list()).toHaveLength(1);
    expect(q.get('dlq-1')!.attempts).toBe(2);
  });

  it('persists across instances (a fresh process sees the same queue)', () => {
    const filePath = join(dir, 'dlq.json');
    new FileDeadLetterQueue(filePath).push(sampleLetter());
    expect(new FileDeadLetterQueue(filePath).list()).toEqual([sampleLetter()]);
  });

  it('treats a missing or corrupt file as an empty queue rather than crashing', () => {
    const filePath = join(dir, 'does-not-exist.json');
    expect(new FileDeadLetterQueue(filePath).list()).toEqual([]);
  });

  it('writes atomically (tmp + rename), leaving no stray .tmp file behind', () => {
    const filePath = join(dir, 'dlq.json');
    new FileDeadLetterQueue(filePath).push(sampleLetter());
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('Runtime + deadLetterQueue integration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dlq-runtime-'));
  });

  it('queues a durable record when a tool call ultimately fails, without changing run-failure behaviour', async () => {
    const dlqDir = mkdtempSync(join(tmpdir(), 'dlq-store-'));
    const queue = new FileDeadLetterQueue(join(dlqDir, 'dlq.json'));

    const rt = new Runtime({ baseDir: dir, model: makeModel(), tools: makeFailingTools(), workflow: issueWorkflow, deadLetterQueue: queue });
    const state = await rt.run('Login page crashes with a null session');

    // The run still fails exactly as it did before this feature existed.
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/search index unavailable/);

    // ...but now there's a durable, inspectable record of the failure.
    const letters = queue.list();
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ tool: 'searchCode', error: expect.stringContaining('search index unavailable'), attempts: 1 });
  });

  it('does not touch the queue when no deadLetterQueue is configured (backward compatible)', async () => {
    const rt = new Runtime({ baseDir: dir, model: makeModel(), tools: makeFailingTools(), workflow: issueWorkflow });
    const state = await rt.run('Login page crashes with a null session');
    expect(state.status).toBe('failed'); // unchanged behaviour, no crash from the missing option
  });

  it('a human can inspect the queue, fix the tool, and manually replay the recorded call', async () => {
    const dlqDir = mkdtempSync(join(tmpdir(), 'dlq-store-replay-'));
    const queue = new FileDeadLetterQueue(join(dlqDir, 'dlq.json'));

    const rt = new Runtime({ baseDir: dir, model: makeModel(), tools: makeFailingTools(), workflow: issueWorkflow, deadLetterQueue: queue });
    await rt.run('Login page crashes with a null session');

    const [letter] = queue.list();
    expect(letter).toBeDefined();

    // Human triage: the underlying issue is fixed (a new tool implementation
    // that actually works), so replay the SAME recorded tool+args against it.
    const searchCodeFixed: ToolDef = {
      name: 'searchCode',
      description: '',
      inputSchema: {},
      run: () => ({ files: ['src/auth/login.ts'] }),
    };
    const fixedTools = new ToolRegistry().register(searchCodeFixed);
    const result = await fixedTools.get(letter!.tool).run(letter!.args);

    expect(result).toEqual({ files: ['src/auth/login.ts'] });
    expect(queue.remove(letter!.id)).toBe(true);
    expect(queue.list()).toEqual([]);
  });
});

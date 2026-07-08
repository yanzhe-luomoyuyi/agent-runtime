import { describe, expect, it } from 'vitest';
import type { JSONSchema } from '@agent/contracts';

import { autoApprove, denyAll, requireApprovalFor, withApprovalCache } from '../src/control/human.js';
import { runAgent } from '../src/control/loop.js';
import {
  MockToolInvoker,
  ScriptedChatModel,
  finalResponse,
  makeTool,
  toolCall,
  toolCallResponse,
} from '../src/testkit/index.js';

const anyObject: JSONSchema = { type: 'object', additionalProperties: true };

function writeTools() {
  return new MockToolInvoker([makeTool('writeFile', 'writes a file', anyObject, () => ({ ok: true }))]);
}

describe('human-in-the-loop approval', () => {
  it('turns a denied call into an observation and does not execute it', async () => {
    const tools = writeTools();
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'writeFile', { path: 'x' })]),
      finalResponse('done anyway'),
    ]);
    const res = await runAgent({ goal: 'g', model, tools, approver: denyAll('needs review') });
    expect(tools.counts.writeFile ?? 0).toBe(0);
    expect(res.messages.find((m) => m.role === 'tool')?.content).toMatch(/DENIED/);
    expect(res.finished).toBe(true);
  });

  it('only gates the named sensitive tool', async () => {
    const tools = writeTools();
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'writeFile', {})]),
      finalResponse('ok'),
    ]);
    await runAgent({ goal: 'g', model, tools, approver: requireApprovalFor(['writeFile'], denyAll()) });
    expect(tools.counts.writeFile ?? 0).toBe(0);
  });

  it('auto-approves by default', async () => {
    const tools = writeTools();
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'writeFile', {})]),
      finalResponse('ok'),
    ]);
    await runAgent({ goal: 'g', model, tools, approver: autoApprove });
    expect(tools.counts.writeFile).toBe(1);
  });

  it('supports glob patterns in requireApprovalFor', async () => {
    const tools = new MockToolInvoker([
      makeTool('searchCode', 'search', anyObject, () => ({})),
      makeTool('deployApp', 'deploy', anyObject, () => ({})),
      makeTool('deleteFile', 'delete', anyObject, () => ({})),
    ]);
    // Pattern 'deploy*' should catch deployApp, but searchCode and deleteFile
    // are also caught by patterns — let's test: gate deploy* and delete*
    const approver = requireApprovalFor(['deploy*', 'delete*'], denyAll('restricted'));
    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'searchCode', {})]),  // should auto-approve
      toolCallResponse([toolCall('c2', 'deployApp', {})]),  // should deny
      finalResponse('ok'),
    ]);
    const res = await runAgent({ goal: 'g', model, tools, approver, maxTurns: 5 });
    // searchCode was allowed (not caught by patterns)
    expect(tools.counts.searchCode).toBe(1);
    // deployApp was denied
    expect(tools.counts.deployApp ?? 0).toBe(0);
    expect(res.messages.some((m) => m.content?.includes('DENIED'))).toBe(true);
  });
});

describe('approval cache', () => {
  it('remembers approvals within the cache window', async () => {
    let callCount = 0;
    const countingApprover = {
      approve: async () => { callCount++; return { approved: true } as const; },
    };
    const cached = withApprovalCache(countingApprover, 60_000); // 60s cache
    const req = { tool: 'deploy', args: { env: 'prod' }, callId: 'c1' };

    await cached.approve(req);
    expect(callCount).toBe(1);
    // Same call within cache window → no human interaction
    await cached.approve(req);
    expect(callCount).toBe(1); // still 1 — cached
  });

  it('different args bypass the cache', async () => {
    let callCount = 0;
    const countingApprover = {
      approve: async () => { callCount++; return { approved: true } as const; },
    };
    const cached = withApprovalCache(countingApprover, 60_000);

    await cached.approve({ tool: 'deploy', args: { env: 'prod' }, callId: 'c1' });
    expect(callCount).toBe(1);
    // Different args → new call
    await cached.approve({ tool: 'deploy', args: { env: 'staging' }, callId: 'c2' });
    expect(callCount).toBe(2);
  });

  it('expired cache entries re-trigger approval', async () => {
    let callCount = 0;
    const countingApprover = {
      approve: async () => { callCount++; return { approved: true, cacheMs: 1 } as const; }, // 1ms cache
    };
    const cached = withApprovalCache(countingApprover, 1);
    const req = { tool: 'deploy', args: {}, callId: 'c1' };

    await cached.approve(req);
    expect(callCount).toBe(1);
    // Wait for cache to expire
    await new Promise((r) => setTimeout(r, 5));
    await cached.approve(req);
    expect(callCount).toBe(2); // re-approved after expiry
  });
});

describe('modified args', () => {
  it('executes with human-modified arguments', async () => {
    const tools = writeTools();
    const actualArgs: unknown[] = [];
    const interceptTool = makeTool('writeFile', 'writes', anyObject, (args) => {
      actualArgs.push(args);
      return { ok: true };
    });
    const tools2 = new MockToolInvoker([interceptTool]);

    // Approver modifies the path
    const approver = {
      approve: async () => ({
        approved: true,
        modifiedArgs: { path: '/safe/path.txt' }, // human changed it
      }),
    };

    const model = new ScriptedChatModel([
      toolCallResponse([toolCall('c1', 'writeFile', { path: '/dangerous/path.txt' })]),
      finalResponse('done'),
    ]);
    await runAgent({ goal: 'g', model, tools: tools2, approver });
    expect(actualArgs[0]).toEqual({ path: '/safe/path.txt' });
  });
});

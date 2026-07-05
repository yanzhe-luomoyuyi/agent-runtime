import { describe, expect, it } from 'vitest';
import type { JSONSchema } from '@agent/contracts';

import { autoApprove, denyAll, requireApprovalFor } from '../src/control/human.js';
import { runAgent } from '../src/control/loop.js';
import { MockToolInvoker, ScriptedChatModel, finalResponse, makeTool, toolCall, toolCallResponse } from '../src/testkit/index.js';

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
});

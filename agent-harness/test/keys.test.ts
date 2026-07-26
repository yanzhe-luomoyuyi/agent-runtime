import { describe, expect, it } from 'vitest';
import {
  joinKey,
  keyScope,
  runtimeModelCallId,
  runtimeToolCallId,
} from '@agent/contracts';

describe('IdempotencyKey vocabulary', () => {
  it('builds normalized turn / compact / retrieve leaves', () => {
    const root = keyScope();
    expect(root.turnModel(3)).toBe('t:3');
    expect(root.turnTool(3, 'c1')).toBe('t:3:c1');
    expect(root.compact(3)).toBe('compact:3');
    expect(root.retrieveOnce()).toBe('retrieve:once');
    expect(root.retrieveRewrite()).toBe('retrieve:rewrite');
    expect(root.plan()).toBe('plan');
    expect(root.replan(0)).toBe('replan:0');
    expect(root.reflect(1)).toBe('reflect:1');
  });

  it('nests plan / reflect / subagent scopes without colliding', () => {
    const s0 = keyScope().planStep(0);
    expect(s0.turnModel(1)).toBe('s:0:t:1');
    expect(keyScope().attempt(0).turnTool(2, 'c9')).toBe('a:0:t:2:c9');
    expect(keyScope('t:1:c1').child('researcher').turnModel(1)).toBe('t:1:c1:researcher:t:1');
    expect(keyScope('t:1:c1').scratchpadSummary()).toBe('t:1:c1:sp:sum');
  });

  it('rejects colon inside a segment and empty scratchpad summary scope', () => {
    expect(() => joinKey('a:b')).toThrow(/must not contain/);
    expect(keyScope().turnTool(1, 'x:y')).toBe('t:1:x_y'); // callIds are sanitized
    expect(() => keyScope().scratchpadSummary()).toThrow(/requires a tool-call key/);
  });

  it('builds runtime callId envelopes', () => {
    expect(runtimeModelCallId('agent', 1, 't:1')).toBe('agent.1:t:1:model');
    expect(runtimeToolCallId('agent', 1, 'document_search', 'retrieve:once')).toBe(
      'agent.1:retrieve:once:document_search',
    );
  });
});

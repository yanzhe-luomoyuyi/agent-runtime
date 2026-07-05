import { describe, expect, it } from 'vitest';
import type { ChatResponse, Message, ToolSpec } from '@agent/contracts';

import { extractJsonObject, interpretResponse, parseTextToolCall } from '../src/protocol/tool-calling.js';

const specs: ToolSpec[] = [
  { name: 'searchCode', description: '', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

function resp(message: Message): ChatResponse {
  return { message, stopReason: message.toolCalls ? 'tool_calls' : 'stop', usage: { promptTokens: 1, completionTokens: 1 } };
}

describe('tool-calling protocol', () => {
  it('returns a final answer when there are no tool calls', () => {
    expect(interpretResponse(resp({ role: 'assistant', content: 'done' }), specs)).toEqual({ kind: 'final', answer: 'done' });
  });

  it('accepts a valid tool call', () => {
    const d = interpretResponse(resp({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'searchCode', arguments: { query: 'x' } }] }), specs);
    expect(d.kind).toBe('tool_calls');
    if (d.kind === 'tool_calls') expect(d.calls[0]!.valid).toBe(true);
  });

  it('flags an unknown tool', () => {
    const d = interpretResponse(resp({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'nope', arguments: {} }] }), specs);
    if (d.kind === 'tool_calls') {
      expect(d.calls[0]!.valid).toBe(false);
      expect(d.calls[0]!.error).toMatch(/Unknown tool/);
    }
  });

  it('flags invalid arguments', () => {
    const d = interpretResponse(resp({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'searchCode', arguments: {} }] }), specs);
    if (d.kind === 'tool_calls') {
      expect(d.calls[0]!.valid).toBe(false);
      expect(d.calls[0]!.error).toMatch(/Invalid arguments/);
    }
  });

  it('tolerantly parses a JSON tool call from fenced text', () => {
    const d = parseTextToolCall('```json\n{"action":"call_tool","tool":"searchCode","args":{"query":"x"}}\n```');
    expect(d?.kind).toBe('tool_calls');
  });

  it('parses a finish action from prose', () => {
    expect(parseTextToolCall('sure: {"action":"finish","answer":"hi"}')).toEqual({ kind: 'final', answer: 'hi' });
  });

  it('extractJsonObject respects nested braces and strings', () => {
    expect(extractJsonObject('prefix {"a":{"b":"}"}} suffix')).toBe('{"a":{"b":"}"}}');
  });
});

/**
 * Unit tests for chat response envelope encode/decode used by callChat replay.
 */

import { describe, expect, it } from 'vitest';

import {
  encodeChatPrompt,
  encodeChatResponse,
  tryDecodeChatResponse,
} from '../src/model/chat-provider.js';

describe('chat-provider envelope', () => {
  it('round-trips a ChatResponse', () => {
    const response = {
      message: {
        role: 'assistant' as const,
        toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '.' } }],
      },
      stopReason: 'tool_calls' as const,
      usage: { promptTokens: 10, completionTokens: 5 },
    };
    const raw = encodeChatResponse(response);
    expect(tryDecodeChatResponse(raw)).toEqual(response);
  });

  it('returns undefined for plain text', () => {
    expect(tryDecodeChatResponse('hello')).toBeUndefined();
  });

  it('encodes a prompt audit blob', () => {
    const raw = encodeChatPrompt({
      messages: [{ role: 'user', content: 'fix it' }],
      tools: [{ name: 'grep', description: 'g', inputSchema: { type: 'object' } }],
    });
    expect(JSON.parse(raw).tools).toEqual(['grep']);
  });
});

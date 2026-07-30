import { describe, expect, it } from 'vitest';
import type { ChatResponse, ChatStreamOutput } from '@agent/contracts';

import { accumulateChatStream, chatResponseToStream } from '../src/model/chat-provider.js';

describe('chat stream helpers', () => {
  it('round-trips a ChatResponse through stream synthesis', async () => {
    const response: ChatResponse = {
      message: {
        role: 'assistant',
        content: 'hello',
        thinking: 'why',
        toolCalls: [{ id: '1', name: 't', arguments: { a: 1 } }],
      },
      stopReason: 'tool_calls',
      usage: { promptTokens: 2, completionTokens: 4 },
      thinking: 'why',
    };
    const chunks: ChatStreamOutput[] = [];
    for await (const c of chatResponseToStream(response)) chunks.push(c);
    expect(accumulateChatStream(chunks)).toEqual(response);
  });
});

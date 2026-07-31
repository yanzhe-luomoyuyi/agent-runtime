/**
 * createResilientChatProvider — escalate across ChatModelProvider tiers.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ChatModelProvider, ChatModelRequest } from 'durable-agent-runtime';
import { TransientError } from '@agent/harness';

import { createResilientChatProvider } from '../src/model/resilient-provider.js';

const emptyReq: ChatModelRequest = { messages: [], tools: [] };

function okProvider(name: string): ChatModelProvider {
  return {
    name,
    chat: async () => ({
      message: { role: 'assistant', content: `from:${name}` },
      stopReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1 },
    }),
  };
}

function failProvider(name: string, err: unknown): ChatModelProvider {
  return {
    name,
    chat: async () => {
      throw err;
    },
  };
}

describe('createResilientChatProvider', () => {
  it('returns the primary response when healthy', async () => {
    const m = createResilientChatProvider({
      tiers: [{ provider: okProvider('primary'), retry: { retries: 0 } }],
    });
    const res = await m.chat(emptyReq);
    expect(res.message.content).toBe('from:primary');
  });

  it('escalates to the backup after primary transient failure', async () => {
    const onEscalate = vi.fn();
    const m = createResilientChatProvider({
      tiers: [
        {
          provider: failProvider('primary', new TransientError('503')),
          retry: { retries: 0 },
          breaker: false,
        },
        { provider: okProvider('backup'), retry: { retries: 0 }, breaker: false },
      ],
      onEscalate,
    });
    const res = await m.chat(emptyReq);
    expect(res.message.content).toBe('from:backup');
    expect(onEscalate).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'primary', to: 'backup', index: 0 }),
    );
  });

  it('escalates on chatStream when the primary stream fails', async () => {
    const primary: ChatModelProvider = {
      name: 'primary',
      chat: async () => {
        throw new Error('batch unused');
      },
      async *chatStream() {
        throw new TransientError('stream 503');
      },
    };
    const backup: ChatModelProvider = {
      name: 'backup',
      chat: async () => ({
        message: { role: 'assistant', content: 'stream-backup' },
        stopReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    };
    const m = createResilientChatProvider({
      tiers: [
        { provider: primary, retry: { retries: 0 }, breaker: false },
        { provider: backup, retry: { retries: 0 }, breaker: false },
      ],
    });
    const chunks = [];
    for await (const c of m.chatStream!(emptyReq)) chunks.push(c);
    const content = chunks.map((c) => ('content' in c ? c.content : '')).join('');
    expect(content).toBe('stream-backup');
  });
});

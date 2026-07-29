/**
 * Structured chat-model seam for native tool-calling providers.
 *
 * Complements text-in/text-out `ModelProvider`: hosts that need OpenAI/DeepSeek-style
 * tool_calls use `ChatModelProvider` via `StepContext.callChat`, which records and
 * replays a full `ChatResponse` under the same idempotency `key` as `callModel`.
 */

import type { ChatRequest, ChatResponse } from '@agent/contracts';

export type ChatModelRequest = Pick<ChatRequest, 'messages' | 'tools' | 'textCompletion'>;

export interface ChatModelProvider {
  readonly name: string;
  chat(req: ChatModelRequest): Promise<ChatResponse>;
}

/** Envelope stored in `ModelCalled.response` so resume can rebuild a ChatResponse. */
export interface ChatResponseEnvelope {
  v: 1;
  kind: 'chat';
  response: ChatResponse;
}

export function encodeChatResponse(response: ChatResponse): string {
  const envelope: ChatResponseEnvelope = { v: 1, kind: 'chat', response };
  return JSON.stringify(envelope);
}

export function tryDecodeChatResponse(raw: string): ChatResponse | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ChatResponseEnvelope>;
    if (parsed?.kind === 'chat' && parsed.response && typeof parsed.response === 'object') {
      return parsed.response;
    }
  } catch {
    // plain text model responses are not chat envelopes
  }
  return undefined;
}

export function encodeChatPrompt(req: ChatModelRequest): string {
  return JSON.stringify({
    textCompletion: Boolean(req.textCompletion),
    tools: req.tools.map((t) => t.name),
    messages: req.messages,
  });
}

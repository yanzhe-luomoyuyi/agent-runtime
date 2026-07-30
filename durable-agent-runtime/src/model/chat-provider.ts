/**
 * Structured chat-model seam for native tool-calling providers.
 *
 * Complements text-in/text-out `ModelProvider`: hosts that need OpenAI/DeepSeek-style
 * tool_calls use `ChatModelProvider` via `StepContext.callChat`, which records and
 * replays a full `ChatResponse` under the same idempotency `key` as `callModel`.
 * Optional `chatStream` powers live token UX; durable recording still stores one
 * final `ChatResponse` per turn (see `callChatStream`).
 */

import type { ChatRequest, ChatResponse, ChatStreamOutput } from '@agent/contracts';

export type ChatModelRequest = Pick<ChatRequest, 'messages' | 'tools' | 'textCompletion'>;

export interface ChatModelProvider {
  readonly name: string;
  chat(req: ChatModelRequest): Promise<ChatResponse>;
  /**
   * Optional streaming variant. When absent, `callChatStream` falls back to
   * `chat()` and synthesises a single-chunk stream.
   */
  chatStream?(req: ChatModelRequest): AsyncIterable<ChatStreamOutput>;
}

/** Expand a batch ChatResponse into the stream shape `runAgentStreamed` expects. */
export async function* chatResponseToStream(response: ChatResponse): AsyncIterable<ChatStreamOutput> {
  if (response.thinking) yield { thinking: response.thinking };
  if (response.message.content) yield { content: response.message.content };
  for (const tc of response.message.toolCalls ?? []) {
    yield { toolCall: tc };
  }
  yield {
    stopReason: response.stopReason,
    usage: response.usage,
    refusalReason: response.refusalReason,
  };
}

/** Fold stream chunks back into a ChatResponse (for durable ModelCalled recording). */
export function accumulateChatStream(chunks: ChatStreamOutput[]): ChatResponse {
  let content = '';
  let thinking = '';
  const toolCalls: NonNullable<ChatResponse['message']['toolCalls']> = [];
  let stopReason: ChatResponse['stopReason'] = 'stop';
  let usage: ChatResponse['usage'] = { promptTokens: 0, completionTokens: 0 };
  let refusalReason: string | undefined;

  for (const chunk of chunks) {
    if ('stopReason' in chunk) {
      stopReason = chunk.stopReason;
      usage = chunk.usage;
      refusalReason = chunk.refusalReason;
      continue;
    }
    if (chunk.thinking) thinking += chunk.thinking;
    if (chunk.content) content += chunk.content;
    if (chunk.toolCall) toolCalls.push(chunk.toolCall);
  }

  return {
    message: {
      role: 'assistant',
      content: content || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      thinking: thinking || undefined,
    },
    stopReason,
    usage,
    thinking: thinking || undefined,
    refusalReason,
  };
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

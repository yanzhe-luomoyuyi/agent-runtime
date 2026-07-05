/**
 * The model seam — a tool-calling chat model.
 *
 * Compared with the runtime's text-in/text-out `ModelProvider`, this contract is
 * transcript-in / structured-out: given the message history and the tool specs,
 * the model returns an assistant message that either carries `toolCalls` or a
 * final text answer, plus a `stopReason` and token `usage`. Real providers
 * (OpenAI / Anthropic tool-calling) map onto this directly; the durable runtime
 * adapts it onto `ctx.callModel`, passing `key` for idempotent replay.
 */

import type { Message } from './messages.js';
import type { ToolSpec } from './tools.js';

/** Token accounting for one model call. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/** Why the model stopped generating this turn. */
export type StopReason = 'tool_calls' | 'stop' | 'length';

/** One chat completion request. */
export interface ChatRequest {
  messages: Message[];
  tools: ToolSpec[];
  /** Deterministic idempotency handle for durable replay (see tools.ts header). */
  key?: string;
}

/** One chat completion response. */
export interface ChatResponse {
  /** The assistant message; may contain `toolCalls` or a final `content`. */
  message: Message;
  stopReason: StopReason;
  usage: Usage;
}

/** A tool-calling chat model. Swappable: mock for tests, live provider in prod. */
export interface ChatModel {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

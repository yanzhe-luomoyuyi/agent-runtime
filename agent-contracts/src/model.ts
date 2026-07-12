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
export type StopReason = 'tool_calls' | 'stop' | 'length' | 'refusal';

/** One chat completion request. */
export interface ChatRequest {
  messages: Message[];
  tools: ToolSpec[];
  /** Deterministic idempotency handle for durable replay (see tools.ts header). */
  key?: string;
  /**
   * Hint that this request is a plain TEXT completion (e.g. summarisation),
   * not an agentic tool-calling turn. Most models ignore it. But a bridge that
   * reformats the transcript into an agent-decision prompt (like the durable
   * runtime's text-model adapter) MUST, when this is true, pass the messages
   * through verbatim and return the raw text as `content` WITHOUT parsing it as
   * a tool call — otherwise a summary request would be mangled into an
   * agent-decision prompt and come back empty.
   */
  textCompletion?: boolean;
}

/** One chat completion response. */
export interface ChatResponse {
  /** The assistant message; may contain `toolCalls` or a final `content`. */
  message: Message;
  stopReason: StopReason;
  usage: Usage;
  /**
   * Internal reasoning / chain-of-thought produced by models with extended
   * thinking (o1/o3, Claude, DeepSeek-R1).  Stored separately from `content`
   * so the context layer can treat it specially (not shown to user, must be
   * fed back to the model on next turn).  When set, this is also available as
   * `message.thinking` for convenience.
   */
  thinking?: string;
  /**
   * When stopReason is 'refusal', the model's stated reason for refusing
   * to answer (safety filter, policy violation, etc.).
   */
  refusalReason?: string;
}

/** A tool-calling chat model. Swappable: mock for tests, live provider in prod. */
export interface ChatModel {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

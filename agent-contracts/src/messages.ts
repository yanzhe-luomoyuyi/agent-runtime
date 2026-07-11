/**
 * Conversation messages — the lingua franca between a host (e.g. the
 * durable-agent-runtime) and the harness's agentic loop.
 *
 * This is a tool-calling chat transcript, not a single prompt string: the model
 * emits `assistant` messages that may carry `toolCalls`, and each tool result is
 * fed back as a `tool` message correlated by `toolCallId`. Modelling the
 * transcript explicitly (rather than concatenating strings) is what lets the
 * harness do native tool calling, parallel calls, and — crucially — mark tool
 * output as `untrusted` so the context layer can isolate it from instructions.
 */

/** Who authored a message. `tool` messages carry the result of a tool call. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A single tool invocation the model requested in one assistant turn. */
export interface ToolCall {
  /** Unique within a turn; correlates the eventual `tool` result message. */
  id: string;
  /** Tool name the model wants to run. */
  name: string;
  /** Already-parsed argument object (the protocol layer parses/validates it). */
  arguments: unknown;
}

/** One entry in the conversation transcript. */
export interface Message {
  role: Role;
  /** Free text. Optional because an assistant turn may be tool calls only. */
  content?: string;
  /** assistant-only: the tool calls requested this turn. */
  toolCalls?: ToolCall[];
  /** tool-only: which `ToolCall.id` this message answers. */
  toolCallId?: string;
  /** tool-only: the tool's name (redundant with the originating call, but handy). */
  name?: string;
  /**
   * True for content that originated outside the operator's trust boundary —
   * above all, tool results. The context layer keeps untrusted content fenced
   * and out of the instruction region so a poisoned tool result cannot silently
   * rewrite the agent's objective (prompt-injection defence).
   */
  untrusted?: boolean;
  /**
   * Assistant-only: internal reasoning / chain-of-thought produced by models
   * that support extended thinking (OpenAI o1/o3, Claude Extended Thinking,
   * DeepSeek-R1).  This content MUST be fed back to the model on subsequent
   * turns so it remembers its prior reasoning, but it is typically NOT shown
   * to the end user.  Like `untrusted`, the context layer fences it from the
   * instruction region.
   */
  thinking?: string;
}

/** Construct a system (instruction) message. Always trusted. */
export function systemMessage(content: string): Message {
  return { role: 'system', content };
}

/** Construct a user (goal / request) message. */
export function userMessage(content: string): Message {
  return { role: 'user', content };
}

/** Construct an assistant message, optionally carrying tool calls. */
export function assistantMessage(content: string | undefined, toolCalls?: ToolCall[]): Message {
  const msg: Message = { role: 'assistant' };
  if (content !== undefined) msg.content = content;
  if (toolCalls && toolCalls.length > 0) msg.toolCalls = toolCalls;
  return msg;
}

/** Construct a tool-result message. Marked `untrusted` by default. */
export function toolResultMessage(call: Pick<ToolCall, 'id' | 'name'>, content: string): Message {
  return { role: 'tool', name: call.name, toolCallId: call.id, content, untrusted: true };
}

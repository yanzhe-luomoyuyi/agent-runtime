/**
 * @agent/harness/testkit — deterministic doubles for tests and demos.
 *
 * These let you drive the harness offline with no network and fully reproducible
 * behaviour: a scripted or rule-based `ChatModel`, an in-memory `ToolInvoker`
 * that records every call (name/args/key), and small builders for responses and
 * tools. Exported as a package subpath so the durable-agent-runtime's own
 * integration tests can reuse them.
 */

import type {
  CallOptions,
  ChatModel,
  ChatRequest,
  ChatResponse,
  JSONSchema,
  ToolCall,
  ToolInvoker,
  ToolSpec,
} from '@agent/contracts';

/** One programmed reply: a fixed response, an error to throw, or a function of the request. */
export type ScriptStep = ChatResponse | Error | ((req: ChatRequest) => ChatResponse);

/** A `ChatModel` that returns scripted steps in order. Records every request. */
export class ScriptedChatModel implements ChatModel {
  readonly name = 'scripted';
  readonly requests: ChatRequest[] = [];
  private index = 0;

  constructor(private readonly steps: ScriptStep[]) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(req);
    const step = this.steps[this.index++];
    if (step === undefined) throw new Error(`ScriptedChatModel ran out of steps (call #${this.index}).`);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(req) : step;
  }
}

/** A `ChatModel` driven by a pure decision function over the transcript. */
export class RuleChatModel implements ChatModel {
  readonly name = 'rule';
  calls = 0;

  constructor(private readonly decide: (req: ChatRequest) => ChatResponse) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls++;
    return this.decide(req);
  }
}

/** Build an assistant "final answer" response. */
export function finalResponse(text: string): ChatResponse {
  return { message: { role: 'assistant', content: text }, stopReason: 'stop', usage: usageFor(text) };
}

/** Build an assistant "tool calls" response. */
export function toolCallResponse(calls: ToolCall[], content = ''): ChatResponse {
  return {
    message: { role: 'assistant', content, toolCalls: calls },
    stopReason: 'tool_calls',
    usage: usageFor(content + JSON.stringify(calls)),
  };
}

/** Build a single tool call. */
export function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, name, arguments: args };
}

function usageFor(text: string): { promptTokens: number; completionTokens: number } {
  const tokens = Math.max(1, Math.ceil(text.length / 4));
  return { promptTokens: tokens, completionTokens: tokens };
}

/** A tool definition for the mock invoker. */
export interface MockToolDef {
  spec: ToolSpec;
  handler: (args: unknown, opts?: CallOptions) => unknown | Promise<unknown>;
}

/** Convenience builder for a `MockToolDef`. */
export function makeTool(
  name: string,
  description: string,
  inputSchema: JSONSchema,
  handler: MockToolDef['handler'],
): MockToolDef {
  return { spec: { name, description, inputSchema }, handler };
}

/** An in-memory `ToolInvoker` that records every call (including the durable key). */
export class MockToolInvoker implements ToolInvoker {
  readonly calls: Array<{ name: string; args: unknown; key?: string }> = [];
  readonly counts: Record<string, number> = {};
  private readonly map = new Map<string, MockToolDef>();

  constructor(defs: MockToolDef[]) {
    for (const def of defs) this.map.set(def.spec.name, def);
  }

  list(): ToolSpec[] {
    return [...this.map.values()].map((d) => d.spec);
  }

  async call(name: string, args: unknown, opts?: CallOptions): Promise<unknown> {
    this.calls.push({ name, args, key: opts?.key });
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    const def = this.map.get(name);
    if (!def) throw new Error(`Unknown tool: ${name}`);
    return def.handler(args, opts);
  }
}

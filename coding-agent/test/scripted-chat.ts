/**
 * Scripted ChatModelProvider for offline coding-agent tests.
 */

import type { ChatResponse, ToolCall } from '@agent/contracts';
import type { ChatModelProvider, ChatModelRequest } from 'durable-agent-runtime';

export type ScriptStep =
  | ChatResponse
  | ((req: ChatModelRequest, turn: number) => ChatResponse);

export class ScriptedChatProvider implements ChatModelProvider {
  readonly name = 'scripted';
  private i = 0;

  constructor(private readonly steps: ScriptStep[]) {}

  async chat(req: ChatModelRequest): Promise<ChatResponse> {
    if (req.textCompletion) {
      return {
        message: { role: 'assistant', content: 'summary' },
        stopReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    }
    const step = this.steps[this.i++];
    if (!step) throw new Error(`ScriptedChatProvider: no step left (turn ${this.i})`);
    return typeof step === 'function' ? step(req, this.i) : step;
  }
}

export function toolTurn(calls: Array<{ name: string; arguments?: unknown; id?: string }>, content = ''): ChatResponse {
  const toolCalls: ToolCall[] = calls.map((c, i) => ({
    id: c.id ?? `c${i + 1}`,
    name: c.name,
    arguments: c.arguments ?? {},
  }));
  return {
    message: { role: 'assistant', content: content || undefined, toolCalls },
    stopReason: 'tool_calls',
    usage: { promptTokens: 10, completionTokens: 5 },
  };
}

export function finalTurn(text: string): ChatResponse {
  return {
    message: { role: 'assistant', content: text },
    stopReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 20 },
  };
}

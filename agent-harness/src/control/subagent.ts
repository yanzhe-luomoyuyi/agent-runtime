/**
 * D: delegation via sub-agents.
 *
 * Exposes a nested agent as an ordinary tool. When the parent model calls the
 * `delegate` tool, the handler runs a fresh `runAgent` loop on the sub-goal with
 * its own (possibly narrower) toolset. The sub-agent's answer is returned as the
 * tool observation, so from the parent's point of view delegation looks exactly
 * like any other tool call.
 *
 * Prefer passing `agent` (an AgentConfig) — it bundles model, tools,
 * instructions, etc. into one value.  The individual fields (`model`, `tools`,
 * `systemPrompt`, …) are still supported for backward compatibility.
 *
 * Durability: the handler receives the parent's per-call key and uses it as the
 * sub-agent's `keyPrefix`, so nested model/tool keys stay globally unique
 * (`t1:call_2:t1`, `t1:call_2:t1:s1`, …) and the whole tree replays
 * deterministically.
 */

import type { CallOptions, ChatModel, JSONSchema, ToolInvoker, ToolSpec } from '@agent/contracts';

import type { AgentConfig } from '../agent.js';
import { ContextManager } from '../context/manager.js';
import { runAgent } from './loop.js';

export interface SubagentToolOptions {
  /** Tool name the parent uses to delegate. Default 'delegate'. */
  name?: string;
  description?: string;
  /**
   * The sub-agent to delegate to — bundles model, tools, instructions into
   * one value.  Preferred over the individual fields below.
   */
  agent?: AgentConfig;
  /** @deprecated Use `agent.model` instead. */
  model?: ChatModel;
  /** @deprecated Use `agent.tools` instead. */
  tools?: ToolInvoker;
  maxTurns?: number;
  context?: ContextManager;
  /** @deprecated Use `agent.instructions` instead. */
  systemPrompt?: string;
  /**
   * When set, the sub-agent's final answer is validated against this schema
   * (same mechanism as `RunAgentOptions.outputSchema`) and the parsed value is
   * surfaced on the result as `structured`. Use this when the parent fans out
   * several `delegate` calls in one turn and wants to merge their answers with
   * `mapReduce` / `aggregateVotes` instead of concatenating raw text.
   */
  outputSchema?: JSONSchema;
}

export interface SubagentResult {
  answer: string;
  finished: boolean;
  turns: number;
  toolsUsed: string[];
  /**
   * Parsed form of `answer` when `outputSchema` was set and the sub-agent's
   * final answer validated against it. Undefined if no schema was supplied,
   * validation failed, or the run didn't finish.
   */
  structured?: unknown;
}

export interface SubagentTool {
  spec: ToolSpec;
  /** ToolInvoker-compatible handler: runs the nested loop under a namespaced key. */
  run(args: unknown, opts?: CallOptions): Promise<SubagentResult>;
}

/** Build a delegation tool backed by a nested agent loop. */
export function makeSubagentTool(options: SubagentToolOptions): SubagentTool {
  const name = options.name ?? 'delegate';
  const spec: ToolSpec = {
    name,
    description:
      options.description ??
      'Delegate a self-contained sub-goal to a nested agent that has its own tools. Input: {"goal": string}.',
    inputSchema: {
      type: 'object',
      properties: { goal: { type: 'string', description: 'The sub-goal for the nested agent to accomplish.' } },
      required: ['goal'],
    },
  };

  return {
    spec,
    run: async (args, opts) => {
      const goal = isRecord(args) && typeof args.goal === 'string' ? args.goal : String(args ?? '');
      const prefix = opts?.key ? `${opts.key}:` : `${name}:`;
      const result = await runAgent({
        goal,
        agent: options.agent,
        model: options.model,
        tools: options.tools,
        maxTurns: options.maxTurns,
        context: options.context,
        systemPrompt: options.systemPrompt,
        outputSchema: options.outputSchema,
        keyPrefix: prefix,
      });
      let structured: unknown;
      if (options.outputSchema && result.finished) {
        try {
          structured = JSON.parse(result.answer);
        } catch {
          /* leave structured undefined — answer didn't parse as JSON */
        }
      }
      return { answer: result.answer, finished: result.finished, turns: result.turns, toolsUsed: result.toolsUsed, structured };
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

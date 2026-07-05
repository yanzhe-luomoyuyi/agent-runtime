/**
 * Harness adapter — runs the @agent/harness model-driven loop AS a durable
 * runtime step.
 *
 * The harness is host-agnostic: it drives an abstract `ChatModel` + `ToolInvoker`
 * (from @agent/contracts) and knows nothing about this runtime. This adapter
 * implements both over the runtime's `StepContext`, forwarding the harness's
 * per-turn `key` straight to `ctx.callModel` / `ctx.callTool`. That single
 * forwarded key IS the whole durability contract: every model turn and tool call
 * is recorded in the event log and replayed idempotently on resume, so a crash
 * mid-loop resumes without re-running the turns that already completed.
 *
 * Bridging note: the runtime's `ModelProvider` is text-in/text-out, so
 * `RuntimeChatModel` renders the transcript to a prompt, calls `ctx.callModel`,
 * and parses the reply back into a structured `ChatResponse` via the harness's
 * tolerant text protocol. A live tool-calling provider would skip that text
 * round-trip and return `toolCalls` directly — nothing else here would change.
 */

import type {
  ChatModel,
  ChatRequest,
  ChatResponse,
  JSONSchema,
  Message,
  ToolInvoker,
  ToolSpec,
} from '@agent/contracts';
import { parseTextToolCall, runAgent, type AgentRunResult } from '@agent/harness';

import type { RunState } from '../types.js';
import type { StepContext, WorkflowDef } from '../workflow.js';

/** Exposes the runtime's ToolRegistry to the harness, routing calls through the durable seam. */
export class RuntimeToolInvoker implements ToolInvoker {
  constructor(private readonly ctx: StepContext) {}

  list(): ToolSpec[] {
    return this.ctx.tools.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as unknown as JSONSchema,
    }));
  }

  call(name: string, args: unknown, opts?: { key?: string }): Promise<unknown> {
    // Forward the harness key so the call is idempotent across resumes.
    return this.ctx.callTool(name, args, { key: opts?.key });
  }
}

/** Bridges the harness's tool-calling `ChatModel` onto the runtime's text `callModel`. */
export class RuntimeChatModel implements ChatModel {
  readonly name = 'runtime-bridge';

  constructor(private readonly ctx: StepContext) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const prompt = renderPrompt(req.messages, req.tools);
    const text = await this.ctx.callModel(prompt, { key: req.key });

    // A text model returns one decision as JSON; parse it into a structured reply.
    const decision = parseTextToolCall(text, 'c1');
    if (decision?.kind === 'tool_calls') {
      return {
        message: { role: 'assistant', toolCalls: decision.calls.map((c) => c.call) },
        stopReason: 'tool_calls',
        usage: usage(prompt, text),
      };
    }
    const answer = decision?.kind === 'final' ? decision.answer : text;
    return { message: { role: 'assistant', content: answer }, stopReason: 'stop', usage: usage(prompt, text) };
  }
}

export interface HarnessWorkflowOptions {
  name?: string;
  /** Hard cap on turns. */
  maxTurns?: number;
  /** Inject a crash right after this turn's tool calls (to demo mid-loop resume). */
  crashAfterTurn?: number;
}

/**
 * Build a WorkflowDef whose single step runs the @agent/harness loop over the
 * runtime seam. The runtime drives and resumes it exactly like any other
 * workflow, while the MODEL decides each turn.
 */
export function createHarnessWorkflow(opts: HarnessWorkflowOptions = {}): WorkflowDef {
  return {
    name: opts.name ?? 'harness',
    summarize: summarizeHarnessRun,
    phases: [
      {
        name: 'agent',
        skippable: false,
        steps: [
          {
            id: 'agent.1',
            name: 'Harness loop',
            run: (ctx) =>
              runAgent({
                goal: ctx.input.issue,
                model: new RuntimeChatModel(ctx),
                tools: new RuntimeToolInvoker(ctx),
                maxTurns: opts.maxTurns,
                crashAfterTurn: opts.crashAfterTurn,
              }),
          },
        ],
      },
    ],
  };
}

/** Surface the loop's final answer + files in the run summary (same shape the CLI prints). */
function summarizeHarnessRun(state: RunState): unknown {
  const result = state.stepOutputs['agent.1'] as AgentRunResult | undefined;
  if (!result) return { proposal: undefined, files: [] };
  return {
    proposal: result.answer,
    files: collectFiles(result.messages),
    turns: result.turns,
    finished: result.finished,
    toolsUsed: result.toolsUsed,
  };
}

/** Render the transcript to a text prompt a text model (or the mock brain) understands. */
function renderPrompt(messages: Message[], tools: ToolSpec[]): string {
  const goalLine = messages.find((m) => m.role === 'user')?.content ?? '';
  const toolLines = tools
    .map((t) => `- ${t.name}: ${t.description} (input schema: ${JSON.stringify(t.inputSchema)})`)
    .join('\n');

  // Reconstruct "called <tool>(<args>) -> <observation>" lines by pairing each
  // assistant tool call with its result message (correlated by tool-call id).
  const argsById = new Map<string, unknown>();
  const nameById = new Map<string, string>();
  const lines: string[] = [];
  let turn = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const c of m.toolCalls) {
        argsById.set(c.id, c.arguments);
        nameById.set(c.id, c.name);
      }
    } else if (m.role === 'tool' && m.toolCallId) {
      const name = nameById.get(m.toolCallId) ?? m.name ?? 'tool';
      const args = argsById.has(m.toolCallId) ? JSON.stringify(argsById.get(m.toolCallId)) : '{}';
      lines.push(`(turn ${++turn}) called ${name}(${args}) -> ${m.content ?? ''}`);
    }
  }
  const transcript = lines.length > 0 ? lines.join('\n') : '(no tools called yet)';

  return [
    '[agent] You are a durable, tool-using agent. Achieve the goal by calling tools one at a time.',
    '',
    goalLine.startsWith('Goal:') ? goalLine : `Goal: ${goalLine}`,
    '',
    'Available tools:',
    toolLines,
    '',
    'Transcript so far:',
    transcript,
    '',
    'Reply with EXACTLY ONE JSON object and nothing else:',
    '- to call a tool:  {"action":"call_tool","tool":"<name>","args":{...}}',
    '- when finished:   {"action":"finish","answer":"<final answer>"}',
  ].join('\n');
}

/** Best-effort: collect any `files: string[]` a (JSON) tool observation exposed. */
function collectFiles(messages: Message[]): string[] {
  const files = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool' || !m.content) continue;
    try {
      const obs = JSON.parse(m.content) as { files?: unknown };
      if (Array.isArray(obs.files)) for (const f of obs.files) if (typeof f === 'string') files.add(f);
    } catch {
      // observation wasn't JSON — skip
    }
  }
  return [...files];
}

function usage(prompt: string, text: string): { promptTokens: number; completionTokens: number } {
  const est = (s: string) => Math.max(1, Math.ceil(s.length / 4));
  return { promptTokens: est(prompt), completionTokens: est(text) };
}

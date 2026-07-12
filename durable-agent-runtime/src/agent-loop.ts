/**
 * Agent harness — a real, MODEL-DRIVEN agentic loop, expressed as a durable
 * workflow so the runtime's guarantees (event log, idempotent replay, resume)
 * apply to every LLM turn and every tool call.
 *
 * Contrast with the demo *workflow* (./app/issue-workflow.ts), whose control
 * flow is fixed in code (analyze -> locate -> propose). Here the MODEL decides:
 * each turn the harness shows it the goal, the available tools, and the
 * transcript so far; the model replies with either a tool call or a final
 * answer; the harness runs the tool, appends the observation, and loops until
 * the model finishes (or a turn budget is hit). That is the difference we care
 * about — code-driven pipeline vs. model-driven loop.
 *
 * Durability design: the whole loop is a SINGLE workflow step. Each turn's model
 * call and tool call gets a per-turn idempotency key (`t<turn>`), so a crash
 * mid-loop resumes by replaying the already-completed turns from the log (no
 * repeated side effects) and continuing at the first turn that had not finished.
 * The runtime is unchanged; the agentic control flow rides on top of it — this is
 * the "loop as a durable step" idea. A real deployment swaps the mock brain for a
 * live tool-calling LLM implementing the same ModelProvider contract; nothing
 * here changes.
 */

import { extractJsonObject } from '@agent/contracts';

import type { ToolRegistry } from './tools/registry.js';
import type { RunState } from './types.js';
import type { StepContext, WorkflowDef } from './workflow.js';

/** What the model returns each turn: either call a tool, or finish. */
export type AgentDecision =
  | { action: 'call_tool'; tool: string; args: unknown }
  | { action: 'finish'; answer: string };

/** One completed tool turn, kept in the transcript and shown back to the model. */
export interface AgentTurn {
  turn: number;
  tool: string;
  args: unknown;
  observation: unknown;
}

/** The single step's output — the whole loop result. */
export interface AgentResult {
  answer: string;
  turns: number;
  finished: boolean;
  transcript: AgentTurn[];
}

export interface AgentToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentWorkflowOptions {
  name?: string;
  /** Hard cap on turns so a misbehaving model can't loop forever. */
  maxTurns?: number;
  /** Test/demo hook: throw right after this turn's tool call to exercise mid-loop resume. */
  crashAfterTurn?: number;
}

const DEFAULT_MAX_TURNS = 12;

/** Build the prompt the model sees each turn: goal + tools + transcript + protocol. */
export function buildAgentPrompt(goal: string, tools: AgentToolInfo[], transcript: AgentTurn[]): string {
  const toolLines = tools
    .map((t) => `- ${t.name}: ${t.description} (input schema: ${JSON.stringify(t.inputSchema)})`)
    .join('\n');
  const historyLines =
    transcript.length === 0
      ? '(no tools called yet)'
      : transcript
          .map((h) => `(turn ${h.turn}) called ${h.tool}(${JSON.stringify(h.args)}) -> ${JSON.stringify(h.observation)}`)
          .join('\n');
  return [
    '[agent] You are a durable, tool-using agent. Achieve the goal by calling tools one at a time.',
    '',
    `Goal: ${goal}`,
    '',
    'Available tools:',
    toolLines,
    '',
    'Transcript so far:',
    historyLines,
    '',
    'Reply with EXACTLY ONE JSON object and nothing else:',
    '- to call a tool:  {"action":"call_tool","tool":"<name>","args":{...}}',
    '- when finished:   {"action":"finish","answer":"<final answer>"}',
  ].join('\n');
}

/** Parse a model reply into a decision. Tolerant of code fences / surrounding prose. */
export function parseDecision(raw: string): AgentDecision {
  const json = extractJsonObject(raw);
  if (!json) throw new Error(`Agent model did not return a JSON decision: ${raw.slice(0, 120)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Agent model returned invalid JSON: ${json.slice(0, 120)}`);
  }
  const d = parsed as Record<string, unknown>;
  if (d.action === 'finish' && typeof d.answer === 'string') {
    return { action: 'finish', answer: d.answer };
  }
  if (d.action === 'call_tool' && typeof d.tool === 'string') {
    return { action: 'call_tool', tool: d.tool, args: d.args ?? {} };
  }
  throw new Error(`Agent model returned an unrecognized decision: ${json.slice(0, 120)}`);
}

function toolInfo(tools: ToolRegistry): AgentToolInfo[] {
  return tools.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** The agentic loop itself, as a single durable step. */
async function runAgentLoop(ctx: StepContext, maxTurns: number, crashAfterTurn?: number): Promise<AgentResult> {
  const tools = toolInfo(ctx.tools);
  const transcript: AgentTurn[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Per-turn idempotency key: on resume, completed turns replay from the log
    // (same key -> cached result) instead of re-issuing the model/tool call.
    const prompt = buildAgentPrompt(ctx.input.issue, tools, transcript);
    const reply = await ctx.callModel(prompt, { key: `t${turn}` });
    const decision = parseDecision(reply);

    if (decision.action === 'finish') {
      return { answer: decision.answer, turns: turn, finished: true, transcript };
    }

    const observation = await ctx.callTool(decision.tool, decision.args, { key: `t${turn}` });
    transcript.push({ turn, tool: decision.tool, args: decision.args, observation });

    if (crashAfterTurn === turn) {
      // Crash AFTER the tool side effect is recorded but BEFORE the loop finishes
      // — the exact window durable replay must get right on resume.
      throw new Error(`__CRASH__ injected after agent turn ${turn}`);
    }
  }

  return {
    answer: `Stopped after the ${maxTurns}-turn budget without a final answer.`,
    turns: maxTurns,
    finished: false,
    transcript,
  };
}

/** Summary derived from the loop's single step output — surfaces the final answer. */
function summarizeAgentRun(state: RunState): unknown {
  const result = state.stepOutputs['agent.1'] as AgentResult | undefined;
  if (!result) return { proposal: undefined, files: [] };
  return {
    proposal: result.answer,
    files: collectFiles(result.transcript),
    turns: result.turns,
    finished: result.finished,
    toolsUsed: result.transcript.map((t) => t.tool),
  };
}

/** Best-effort: collect any `files: string[]` an observation exposed (for display). */
function collectFiles(transcript: AgentTurn[]): string[] {
  const files = new Set<string>();
  for (const turn of transcript) {
    const obs = turn.observation as { files?: unknown } | null;
    if (obs && Array.isArray(obs.files)) {
      for (const f of obs.files) if (typeof f === 'string') files.add(f);
    }
  }
  return [...files];
}

/**
 * Build a model-driven agent as a durable workflow: one phase, one step — the
 * whole ReAct-style loop — so the runtime drives and resumes it like any other
 * workflow, while the MODEL (not the code) decides each step.
 */
export function createAgentWorkflow(opts: AgentWorkflowOptions = {}): WorkflowDef {
  const maxTurns = opts.maxTurns && opts.maxTurns > 0 ? opts.maxTurns : DEFAULT_MAX_TURNS;
  return {
    name: opts.name ?? 'agent-loop',
    summarize: summarizeAgentRun,
    phases: [
      {
        name: 'agent',
        skippable: false,
        steps: [
          {
            id: 'agent.1',
            name: 'Agent loop',
            run: (ctx) => runAgentLoop(ctx, maxTurns, opts.crashAfterTurn),
          },
        ],
      },
    ],
  };
}

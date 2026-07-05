/**
 * D: plan-then-execute.
 *
 * Before entering the loop, ask the model for an explicit ordered plan, then run
 * the normal agent loop with that plan injected into the system prompt. This
 * gives the model a scaffold to follow and makes the intended decomposition
 * visible/inspectable. The planning model call gets its own idempotency key
 * (`<prefix>plan`), distinct from the loop's `t<turn>` keys, so it replays
 * cleanly on a durable host.
 */

import type { ChatModel, ToolInvoker } from '@agent/contracts';
import { systemMessage, userMessage } from '@agent/contracts';

import { extractJsonObject } from '../protocol/tool-calling.js';
import { DEFAULT_SYSTEM_PROMPT, runAgent, type AgentRunResult, type RunAgentOptions } from './loop.js';

export interface Plan {
  steps: string[];
}

/** Ask the model for an ordered plan. Tolerant of JSON or bulleted/numbered text. */
export async function makePlan(goal: string, model: ChatModel, opts: { key?: string; tools?: ToolInvoker } = {}): Promise<Plan> {
  const toolList = opts.tools
    ? opts.tools.list().map((t) => `- ${t.name}: ${t.description}`).join('\n')
    : '(tools become available during execution)';
  const messages = [
    systemMessage('You are a planner. Decompose the goal into a short ordered list of concrete steps. Reply with ONLY a JSON object: {"steps":["step 1","step 2"]}.'),
    userMessage(`Goal: ${goal}\n\nAvailable tools:\n${toolList}`),
  ];
  const resp = await model.chat({ messages, tools: [], key: opts.key ?? 'plan' });
  return parsePlan(resp.message.content ?? '');
}

/** Parse a plan from model text: prefer JSON `{steps:[]}`, fall back to list lines. */
export function parsePlan(text: string): Plan {
  const json = extractJsonObject(text);
  if (json) {
    try {
      const parsed = JSON.parse(json) as { steps?: unknown };
      if (Array.isArray(parsed.steps)) {
        const steps = parsed.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
        if (steps.length > 0) return { steps };
      }
    } catch {
      /* fall through to line parsing */
    }
  }
  const steps = text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
    .filter((line) => line.length > 0);
  return { steps };
}

export interface PlannedAgentOptions extends RunAgentOptions {
  /** Idempotency key for the planning call. Default `<keyPrefix>plan`. */
  planKey?: string;
}

/** Plan first, then run the loop with the plan folded into the system prompt. */
export async function runPlannedAgent(opts: PlannedAgentOptions): Promise<AgentRunResult & { plan: Plan }> {
  const prefix = opts.keyPrefix ?? '';
  const plan = await makePlan(opts.goal, opts.model, { key: opts.planKey ?? `${prefix}plan`, tools: opts.tools });
  const planText = plan.steps.map((step, i) => `${i + 1}. ${step}`).join('\n');
  const systemPrompt = `${opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT}\n\nFollow this plan:\n${planText}`;
  const result = await runAgent({ ...opts, systemPrompt });
  return { ...result, plan };
}

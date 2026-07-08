/**
 * D: plan-then-execute with progress tracking and re-planning.
 *
 * Before entering the loop, ask the model for an explicit ordered plan, then
 * execute it step-by-step — each step gets its own `runAgent` call with
 * plan-progress context injected into the system prompt.  The plan is rendered
 * with ✓/→/○ markers so the model always knows what's done, what it's working
 * on, and what's pending.
 *
 * If a step fails, the planner can optionally re-plan the remaining steps,
 * asking the model to adjust its approach based on what went wrong.
 *
 * Each execution (plan generation + each step's run) gets its own idempotency
 * key namespace (`plan`, `s0:`, `s1:`, `replan0`, …) so the whole plan-execute
 * cycle replays deterministically on a durable host.
 *
 * Improvements over the earlier version:
 *  - Step-by-step execution: each plan step is a separate `runAgent` call.
 *  - Progress-tracked plan (✓ / → / ○) injected into the system prompt.
 *  - Re-plan on failure: when a step fails, re-generate remaining steps.
 *  - Plan feasibility check: detect when no available tools are referenced.
 */

import type { ChatModel, Message, ToolInvoker } from '@agent/contracts';
import { systemMessage, userMessage } from '@agent/contracts';

import { extractJsonObject } from '../protocol/tool-calling.js';
import { DEFAULT_SYSTEM_PROMPT, runAgent, type AgentRunResult, type AgentStopReason, type RunAgentOptions } from './loop.js';

// ── Types ───────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanState {
  steps: string[];
  statuses: StepStatus[];
  /** Index of the step currently being attempted (0-based), or -1. */
  currentStep: number;
}

export interface PlannedAgentOptions extends RunAgentOptions {
  planKey?: string;
  /** Re-plan remaining steps when a step fails. Default true. */
  replanOnFailure?: boolean;
  /** Max re-planning attempts across the run. Default 2. */
  maxReplans?: number;
}

export interface PlannedAgentResult extends AgentRunResult {
  plan: PlanState;
  replans: number;
}

// ── Plan helpers ────────────────────────────────────────────────────

export function newPlan(steps: string[]): PlanState {
  return { steps, statuses: steps.map(() => 'pending'), currentStep: -1 };
}

export function formatPlanForPrompt(plan: PlanState): string {
  if (plan.steps.length === 0) return '(no plan)';
  return plan.steps
    .map((step, i) => {
      const s = plan.statuses[i]!;
      const m = s === 'completed' ? '✓' : s === 'failed' ? '✗' : s === 'in_progress' ? '→' : '○';
      return `  ${m} Step ${i + 1}: ${step}`;
    })
    .join('\n');
}

export function advancePlan(plan: PlanState, stepIndex: number): PlanState {
  const statuses = plan.statuses.map((s, i) =>
    i < stepIndex ? 'completed' : i === stepIndex ? 'in_progress' : s,
  );
  return { ...plan, statuses, currentStep: stepIndex };
}

export function failCurrentStep(plan: PlanState): PlanState {
  if (plan.currentStep < 0 || plan.currentStep >= plan.steps.length) return plan;
  const statuses = [...plan.statuses];
  statuses[plan.currentStep] = 'failed';
  return { ...plan, statuses };
}

export function validatePlanFeasibility(plan: PlanState, tools: ToolInvoker): string[] {
  const available = new Set(tools.list().map((t) => t.name));
  const planText = plan.steps.join(' ');
  const referenced = [...available].filter((t) => planText.includes(t));
  if (referenced.length === 0 && available.size > 0) {
    return [`Plan does not reference any available tools (${[...available].join(', ')}).`];
  }
  return [];
}

// ── Plan generation ─────────────────────────────────────────────────

export async function makePlan(
  goal: string,
  model: ChatModel,
  opts: { key?: string; tools?: ToolInvoker; previousFailures?: string[] } = {},
): Promise<PlanState> {
  const toolList = opts.tools
    ? opts.tools.list().map((t) => `- ${t.name}: ${t.description}`).join('\n')
    : '(tools become available during execution)';

  const failureCtx = opts.previousFailures?.length
    ? `\n\nPrevious attempts failed. Adjust the plan:\n${opts.previousFailures.map((f) => `- ${f}`).join('\n')}`
    : '';

  const messages = [
    systemMessage(
      'You are a planner. Decompose the goal into a short ordered list of concrete, ' +
      'actionable steps. Each step should correspond to roughly one or two tool calls. ' +
      'Reply with ONLY a JSON object: {"steps":["step 1","step 2"]}.',
    ),
    userMessage(`Goal: ${goal}\n\nAvailable tools:\n${toolList}${failureCtx}`),
  ];
  const resp = await model.chat({ messages, tools: [], key: opts.key ?? 'plan' });
  return newPlan(parsePlanSteps(resp.message.content ?? ''));
}

export function parsePlanSteps(text: string): string[] {
  const json = extractJsonObject(text);
  if (json) {
    try {
      const parsed = JSON.parse(json) as { steps?: unknown };
      if (Array.isArray(parsed.steps)) {
        const steps = parsed.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
        if (steps.length > 0) return steps;
      }
    } catch { /* fall through */ }
  }
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
    .filter((l) => l.length > 0);
}

// ── Plan-driven execution ───────────────────────────────────────────

export async function runPlannedAgent(opts: PlannedAgentOptions): Promise<PlannedAgentResult> {
  const prefix = opts.keyPrefix ?? '';
  const maxReplans = opts.maxReplans ?? 2;
  const replanOnFailure = opts.replanOnFailure ?? true;

  let plan = await makePlan(opts.goal, opts.model, {
    key: opts.planKey ?? `${prefix}plan`,
    tools: opts.tools,
  });
  if (plan.steps.length === 0) plan = newPlan(['Accomplish the goal']);
  plan = advancePlan(plan, 0);

  let replans = 0;
  const allMessages: Message[] = [];
  const allToolsUsed: string[] = [];
  let finalAnswer = '';
  let finished = false;
  let stopReason: AgentStopReason = 'finished';
  let totalTurns = 0;
  const startTime = Date.now();

  while (plan.currentStep >= 0 && plan.currentStep < plan.steps.length) {
    const stepGoal = buildStepGoal(opts.goal, plan);

    const result = await runAgent({
      ...opts,
      goal: stepGoal,
      keyPrefix: `${prefix}s${plan.currentStep}:`,
      systemPrompt: (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT) +
        `\n\nFollow this plan (you are on → step ${plan.currentStep + 1}):\n${formatPlanForPrompt(plan)}`,
    });

    totalTurns += result.turns;
    allMessages.push(...result.messages);
    allToolsUsed.push(...result.toolsUsed);
    finalAnswer = result.answer;
    finished = result.finished;
    stopReason = result.stopReason;

    if (result.finished && result.stopReason === 'finished') {
      plan = advancePlan(plan, plan.currentStep + 1);
    } else if (replanOnFailure && replans < maxReplans) {
      plan = failCurrentStep(plan);
      const failures = plan.steps
        .filter((_, i) => plan.statuses[i] === 'failed')
        .map((s) => `Step "${s}" was not completed.`);
      plan = await makePlan(opts.goal, opts.model, {
        key: `${prefix}replan${replans}`,
        tools: opts.tools,
        previousFailures: failures,
      });
      plan = advancePlan(plan, 0);
      replans++;
    } else {
      plan = failCurrentStep(plan);
      break;
    }
  }

  return {
    answer: finalAnswer,
    finished,
    stopReason,
    turns: totalTurns,
    messages: allMessages,
    toolsUsed: allToolsUsed,
    durationMs: Date.now() - startTime,
    plan,
    replans,
  };
}

function buildStepGoal(originalGoal: string, plan: PlanState): string {
  const step = plan.steps[plan.currentStep];
  if (!step) return originalGoal;

  const completed = plan.steps
    .filter((_, i) => plan.statuses[i] === 'completed')
    .map((s) => `  ✓ ${s}`)
    .join('\n');
  const pending = plan.steps
    .filter((_, i) => plan.statuses[i] === 'pending')
    .map((s) => `  ○ ${s}`)
    .join('\n');

  let g = `Overall goal: ${originalGoal}\n`;
  g += `\nCurrent step (${plan.currentStep + 1}/${plan.steps.length}): ${step}\n`;
  if (completed) g += `\nAlready completed:\n${completed}\n`;
  if (pending) g += `\nStill to do:\n${pending}\n`;
  g += `\nFocus ONLY on the current step. When it is done, reply with your findings.`;
  return g;
}
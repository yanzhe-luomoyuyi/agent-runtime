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
 * Optional `PlanReviewer` gates each generated plan (initial + replan) so a
 * human can approve, edit steps, or reject (optionally remaking with feedback)
 * before execution starts.
 *
 * Each execution (plan generation + each step's run) gets its own idempotency
 * key namespace via `keyScope` (`plan`, `s:{n}`, `replan:{n}`, …) so the whole
 * plan-execute cycle replays deterministically on a durable host.
 *
 * Improvements over the earlier version:
 *  - Step-by-step execution: each plan step is a separate `runAgent` call.
 *  - Progress-tracked plan (✓ / → / ○) injected into the system prompt.
 *  - Re-plan on failure: when a step fails, re-generate remaining steps.
 *  - Plan feasibility check: detect when no available tools are referenced.
 *  - Human plan review gate after makePlan / replan.
 */

import type { ChatModel, Message, ToolInvoker } from '@agent/contracts';
import { keyScope, systemMessage, userMessage } from '@agent/contracts';

import { extractJsonObject } from '@agent/contracts';
import { DEFAULT_SYSTEM_PROMPT, runAgent, type AgentRunResult, type AgentStopReason, type RunAgentOptions } from './loop.js';

// ── Types ───────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanState {
  steps: string[];
  statuses: StepStatus[];
  /** Index of the step currently being attempted (0-based), or -1. */
  currentStep: number;
}

/** Input to a plan review gate (after makePlan / replan). */
export interface PlanReviewRequest {
  plan: PlanState;
  goal: string;
  /** 0 = initial plan; n ≥ 1 = after the n-th replan. */
  attempt: number;
}

/**
 * Human (or scripted) decision on a generated plan.
 * - `approve` — execute as-is
 * - `edit` — replace with the supplied plan (statuses reset)
 * - `reject` — stop, or remake once with optional feedback (`remake` defaults true)
 */
export type PlanReviewDecision =
  | { action: 'approve' }
  | { action: 'edit'; plan: PlanState }
  | { action: 'reject'; feedback?: string; remake?: boolean };

export interface PlanReviewer {
  review(req: PlanReviewRequest): Promise<PlanReviewDecision>;
}

/** Approve every plan — the default for headless runs. */
export const autoApprovePlan: PlanReviewer = {
  review: async () => ({ action: 'approve' }),
};

export interface PlannedAgentOptions extends RunAgentOptions {
  planKey?: string;
  /** Re-plan remaining steps when a step fails. Default true. */
  replanOnFailure?: boolean;
  /** Max re-planning attempts across the run. Default 2. */
  maxReplans?: number;
  /**
   * Gate after each `makePlan` (initial + replan). Default: auto-approve.
   * Set `reviewReplans: false` to only review the first plan.
   */
  planReviewer?: PlanReviewer;
  /** When false, only the initial plan is reviewed (replans auto-approve). Default true. */
  reviewReplans?: boolean;
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
  const resp = await model.chat({ messages, tools: [], key: opts.key ?? keyScope().plan() });
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

/**
 * Run a plan through the reviewer. Returns the (possibly edited) plan, or
 * `null` when the reviewer rejects without a usable remake.
 */
async function reviewGeneratedPlan(
  plan: PlanState,
  goal: string,
  attempt: number,
  reviewer: PlanReviewer,
  model: ChatModel,
  tools: ToolInvoker,
  remakeKey: string,
): Promise<PlanState | null> {
  let current = plan.steps.length === 0 ? newPlan(['Accomplish the goal']) : plan;
  let rejectRemakes = 0;

  while (true) {
    const decision = await reviewer.review({ plan: current, goal, attempt });
    if (decision.action === 'approve') return current;
    if (decision.action === 'edit') {
      const edited = decision.plan.steps.length > 0 ? decision.plan : current;
      return newPlan(edited.steps);
    }
    // reject
    const remake = decision.remake !== false;
    if (!remake || rejectRemakes >= 1) return null;
    rejectRemakes++;
    const feedback = decision.feedback ?? 'Plan rejected by reviewer.';
    current = await makePlan(goal, model, {
      key: remakeKey,
      tools,
      previousFailures: [feedback],
    });
    if (current.steps.length === 0) current = newPlan(['Accomplish the goal']);
  }
}

// ── Plan-driven execution ───────────────────────────────────────────

export async function runPlannedAgent(opts: PlannedAgentOptions): Promise<PlannedAgentResult> {
  const scope = keyScope(opts.keyPrefix);
  const maxReplans = opts.maxReplans ?? 2;
  const replanOnFailure = opts.replanOnFailure ?? true;
  const reviewer = opts.planReviewer ?? autoApprovePlan;
  const reviewReplans = opts.reviewReplans ?? true;

  // Resolve model/tools from explicit override or agent config (backward compat).
  const model = opts.model ?? opts.agent?.model;
  const tools = opts.tools ?? opts.agent?.tools;
  if (!model) throw new Error('runPlannedAgent: a model is required');
  if (!tools) throw new Error('runPlannedAgent: tools are required');

  let plan = await makePlan(opts.goal, model, {
    key: opts.planKey ?? scope.plan(),
    tools,
  });
  const reviewed = await reviewGeneratedPlan(
    plan, opts.goal, 0, reviewer, model, tools, `${scope.plan()}:review-remake`,
  );
  if (!reviewed) {
    return {
      answer: 'Stopped: plan rejected by reviewer.',
      finished: false,
      stopReason: 'aborted',
      turns: 0,
      messages: [],
      toolsUsed: [],
      durationMs: 0,
      plan: plan.steps.length === 0 ? newPlan(['Accomplish the goal']) : plan,
      replans: 0,
    };
  }
  plan = advancePlan(reviewed, 0);

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

    // Resolve the base system prompt — from explicit override, agent config, or default.
    const basePrompt = opts.systemPrompt ?? opts.agent?.instructions ?? DEFAULT_SYSTEM_PROMPT;

    const result = await runAgent({
      ...opts,
      goal: stepGoal,
      keyPrefix: scope.planStep(plan.currentStep).toPrefix(),
      systemPrompt: basePrompt +
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
      let next = await makePlan(opts.goal, model, {
        key: scope.replan(replans),
        tools,
        previousFailures: failures,
      });
      if (reviewReplans) {
        const reReviewed = await reviewGeneratedPlan(
          next, opts.goal, replans + 1, reviewer, model, tools,
          `${scope.replan(replans)}:review-remake`,
        );
        if (!reReviewed) {
          stopReason = 'aborted';
          finished = false;
          finalAnswer = 'Stopped: replan rejected by reviewer.';
          break;
        }
        next = reReviewed;
      } else if (next.steps.length === 0) {
        next = newPlan(['Accomplish the goal']);
      }
      plan = advancePlan(next, 0);
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

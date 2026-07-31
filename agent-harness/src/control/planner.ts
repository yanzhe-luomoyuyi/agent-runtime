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
import { extractJsonObject, keyScope, systemMessage, userMessage } from '@agent/contracts';

import { withPriorConversation } from './context-format.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  runAgentStreamed,
  streamTextModelCall,
  type AgentRunResult,
  type AgentStopReason,
  type AgentStreamEvent,
  type RunAgentOptions,
} from './loop.js';

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

export type PlannedStreamEvent =
  | Extract<AgentStreamEvent, { type: 'model_token' | 'thinking_token' }>
  | { type: 'done'; result: PlannedAgentResult };

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
  if (available.size > 0 && referenced.length === 0) {
    return [`Plan does not reference any available tools (${[...available].join(', ')}).`];
  }
  return [];
}

// ── Plan generation ─────────────────────────────────────────────────

export type MakePlanOptions = {
  key?: string;
  tools?: ToolInvoker;
  previousFailures?: string[];
  /** Prior session turns so the planner can resolve references in the goal. */
  conversationHistory?: Message[];
};

function planMessages(goal: string, opts: MakePlanOptions = {}): Message[] {
  const toolList = opts.tools
    ? opts.tools.list().map((t) => `- ${t.name}: ${t.description}`).join('\n')
    : '(tools become available during execution)';

  const failureCtx = opts.previousFailures?.length
    ? `\n\nPrevious attempts failed. Adjust the plan:\n${opts.previousFailures.map((f) => `- ${f}`).join('\n')}`
    : '';

  const body = withPriorConversation(
    `Goal: ${goal}\n\nAvailable tools:\n${toolList}${failureCtx}`,
    opts.conversationHistory,
  );

  return [
    systemMessage(
      'You are a planner. Decompose the goal into a short ordered list of concrete, ' +
        'actionable steps. Use Prior conversation (when present) to resolve references ' +
        'in the goal (e.g. "1 and 2" from an earlier list). Each step should correspond ' +
        'to roughly one or two tool calls. ' +
        'Reply with ONLY a JSON object: {"steps":["step 1","step 2"]}.',
    ),
    userMessage(body),
  ];
}

export async function makePlan(
  goal: string,
  model: ChatModel,
  opts: MakePlanOptions = {},
): Promise<PlanState> {
  const resp = await model.chat({
    messages: planMessages(goal, opts),
    tools: [],
    key: opts.key ?? keyScope().plan(),
  });
  return newPlan(parsePlanSteps(resp.message.content ?? ''));
}

/** Streaming plan generation — yields planner-lane tokens, returns PlanState. */
export async function* makePlanStreamed(
  goal: string,
  model: ChatModel,
  opts: MakePlanOptions = {},
): AsyncGenerator<PlannedStreamEvent, PlanState, void> {
  const gen = streamTextModelCall(
    model,
    {
      messages: planMessages(goal, opts),
      tools: [],
      key: opts.key ?? keyScope().plan(),
    },
    'planner',
  );
  let next = await gen.next();
  while (!next.done) {
    yield next.value;
    next = await gen.next();
  }
  return newPlan(parsePlanSteps(next.value));
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
    } catch {
      /* fall through */
    }
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
async function* reviewGeneratedPlanStreamed(
  plan: PlanState,
  goal: string,
  attempt: number,
  reviewer: PlanReviewer,
  model: ChatModel,
  tools: ToolInvoker,
  remakeKey: string,
  conversationHistory?: Message[],
): AsyncGenerator<PlannedStreamEvent, PlanState | null, void> {
  let current = plan.steps.length === 0 ? newPlan(['Accomplish the goal']) : plan;
  let rejectRemakes = 0;

  while (true) {
    const decision = await reviewer.review({ plan: current, goal, attempt });
    if (decision.action === 'approve') return current;
    if (decision.action === 'edit') {
      const edited = decision.plan.steps.length > 0 ? decision.plan : current;
      return newPlan(edited.steps);
    }
    const remake = decision.remake !== false;
    if (!remake || rejectRemakes >= 1) return null;
    rejectRemakes++;
    const feedback = decision.feedback ?? 'Plan rejected by reviewer.';
    const remakeGen = makePlanStreamed(goal, model, {
      key: remakeKey,
      tools,
      previousFailures: [feedback],
      conversationHistory,
    });
    let next = await remakeGen.next();
    while (!next.done) {
      yield next.value;
      next = await remakeGen.next();
    }
    current = next.value;
    if (current.steps.length === 0) current = newPlan(['Accomplish the goal']);
  }
}

// ── Plan-driven execution ───────────────────────────────────────────

/** Batch wrapper — drains {@link runPlannedAgentStreamed}. */
export async function runPlannedAgent(opts: PlannedAgentOptions): Promise<PlannedAgentResult> {
  let result: PlannedAgentResult | undefined;
  for await (const ev of runPlannedAgentStreamed(opts)) {
    if (ev.type === 'done') result = ev.result;
  }
  if (!result) throw new Error('runPlannedAgent: stream ended without done');
  return result;
}

/** Streaming plan → execute → optional replan. Token events carry `lane`. */
export async function* runPlannedAgentStreamed(
  opts: PlannedAgentOptions,
): AsyncGenerator<PlannedStreamEvent, PlannedAgentResult, void> {
  const scope = keyScope(opts.keyPrefix);
  const maxReplans = opts.maxReplans ?? 2;
  const replanOnFailure = opts.replanOnFailure ?? true;
  const reviewer = opts.planReviewer ?? autoApprovePlan;
  const reviewReplans = opts.reviewReplans ?? true;

  const model = opts.model ?? opts.agent?.model;
  const tools = opts.tools ?? opts.agent?.tools;
  if (!model) throw new Error('runPlannedAgent: a model is required');
  if (!tools) throw new Error('runPlannedAgent: tools are required');

  const planGen = makePlanStreamed(opts.goal, model, {
    key: opts.planKey ?? scope.plan(),
    tools,
    conversationHistory: opts.conversationHistory,
  });
  let planNext = await planGen.next();
  while (!planNext.done) {
    yield planNext.value;
    planNext = await planGen.next();
  }
  let plan = planNext.value;

  const reviewGen = reviewGeneratedPlanStreamed(
    plan,
    opts.goal,
    0,
    reviewer,
    model,
    tools,
    `${scope.plan()}:review-remake`,
    opts.conversationHistory,
  );
  let reviewNext = await reviewGen.next();
  while (!reviewNext.done) {
    yield reviewNext.value;
    reviewNext = await reviewGen.next();
  }
  const reviewed = reviewNext.value;
  if (!reviewed) {
    const rejected: PlannedAgentResult = {
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
    yield { type: 'done', result: rejected };
    return rejected;
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
    const basePrompt = opts.systemPrompt ?? opts.agent?.instructions ?? DEFAULT_SYSTEM_PROMPT;

    const stepOpts: RunAgentOptions = {
      ...opts,
      goal: stepGoal,
      keyPrefix: scope.planStep(plan.currentStep).toPrefix(),
      systemPrompt:
        basePrompt +
        `\n\nFollow this plan (you are on → step ${plan.currentStep + 1}):\n${formatPlanForPrompt(plan)}`,
    };

    let result: AgentRunResult | undefined;
    for await (const ev of runAgentStreamed(stepOpts)) {
      if (ev.type === 'model_token' || ev.type === 'thinking_token') {
        yield { ...ev, lane: ev.lane ?? 'agent' };
      }
      if (ev.type === 'done') result = ev.result;
    }
    if (!result) throw new Error('runPlannedAgent: step ended without done');

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
      const replanGen = makePlanStreamed(opts.goal, model, {
        key: scope.replan(replans),
        tools,
        previousFailures: failures,
        conversationHistory: opts.conversationHistory,
      });
      let replanNext = await replanGen.next();
      while (!replanNext.done) {
        yield replanNext.value;
        replanNext = await replanGen.next();
      }
      let next = replanNext.value;
      if (reviewReplans) {
        const reReviewGen = reviewGeneratedPlanStreamed(
          next,
          opts.goal,
          replans + 1,
          reviewer,
          model,
          tools,
          `${scope.replan(replans)}:review-remake`,
          opts.conversationHistory,
        );
        let reReviewNext = await reReviewGen.next();
        while (!reReviewNext.done) {
          yield reReviewNext.value;
          reReviewNext = await reReviewGen.next();
        }
        const reReviewed = reReviewNext.value;
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

  const out: PlannedAgentResult = {
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
  yield { type: 'done', result: out };
  return out;
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

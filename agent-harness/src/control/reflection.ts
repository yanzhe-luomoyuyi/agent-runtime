/**
 * D: reflection / self-critique (Q&A-oriented).
 *
 * After the loop produces an answer, a critic model call judges whether it
 * actually satisfies the goal in a Q&A sense (correctness, completeness,
 * answering the referenced items). If not, the loop runs again — up to
 * `maxReflections` times. Each attempt and each critique gets its own key
 * namespace via `keyScope` (`a:{i}` and `reflect:{i}`) so the whole reflective
 * run remains deterministic and replayable on a durable host.
 *
 * Structured diagnosis (L2): the critic doesn't just say pass/fail — it's
 * asked to name the root cause of the shortfall, propose a concrete
 * correction strategy, and call out which parts of the prior attempt were
 * already correct (so the next attempt doesn't redo good work). This gives
 * the next attempt a targeted fix instead of a vague "try again".
 *
 * Session `conversationHistory` is injected into the critic so multi-turn
 * goals like "do 1 and 2" resolve against prior turns. This mode is intended
 * for Q&A review, not code-edit verification via diffs.
 */

import type { ChatModel, Message } from '@agent/contracts';
import { extractJsonObject, keyScope, systemMessage, userMessage } from '@agent/contracts';
import { withPriorConversation } from './context-format.js';
import {
  runAgentStreamed,
  streamTextModelCall,
  type AgentRunResult,
  type AgentStreamEvent,
  type RunAgentOptions,
} from './loop.js';

export interface Critique {
  satisfactory: boolean;
  /** One-line summary of the verdict. */
  feedback: string;
  /** Why the answer fell short (omitted when satisfactory). */
  rootCause?: string;
  /** Concrete steps the next attempt should take to fix it. */
  correctionStrategy?: string;
  /** Parts of the prior attempt that were already correct and should be kept as-is. */
  whatWorked?: string[];
}

export type ReflectiveAgentResult = AgentRunResult & { critiques: Critique[] };

export type ReflectiveStreamEvent =
  | Extract<AgentStreamEvent, { type: 'model_token' | 'thinking_token' }>
  | { type: 'done'; result: ReflectiveAgentResult };

export type CritiqueOptions = {
  key?: string;
  /** Prior session turns so the critic can resolve references in the goal. */
  conversationHistory?: Message[];
};

function critiqueMessages(goal: string, answer: string, opts: CritiqueOptions = {}): Message[] {
  const body = withPriorConversation(`Goal: ${goal}\n\nProposed answer:\n${answer}`, opts.conversationHistory);
  return [
    systemMessage(
      'You are a strict Q&A reviewer. Use Prior conversation (when present) to resolve ' +
        'references in the goal (e.g. "1 and 2" from an earlier list). Judge whether the ' +
        'answer is correct, complete, and on-topic for that goal. Do NOT require code, diffs, ' +
        'or file edits as pass criteria — this review is for Q&A quality, not code verification. ' +
        'If the answer falls short, diagnose precisely. Reply with ONLY JSON: ' +
        '{"satisfactory":true|false,"feedback":"one-line summary",' +
        '"rootCause":"why it fell short, omit or empty if satisfactory",' +
        '"correctionStrategy":"concrete steps to fix it next attempt, omit or empty if satisfactory",' +
        '"whatWorked":["parts of the attempt that were already correct and should be kept, if any"]}.',
    ),
    userMessage(body),
  ];
}

/** Ask the model to critique an answer against the goal. Tolerant JSON parse. */
export async function critique(
  goal: string,
  answer: string,
  model: ChatModel,
  opts: CritiqueOptions = {},
): Promise<Critique> {
  const resp = await model.chat({
    messages: critiqueMessages(goal, answer, opts),
    tools: [],
    key: opts.key ?? keyScope().reflect(0),
  });
  return parseCritique(resp.message.content ?? '');
}

/** Streaming critique — yields reflection-lane tokens, returns Critique. */
export async function* critiqueStreamed(
  goal: string,
  answer: string,
  model: ChatModel,
  opts: CritiqueOptions = {},
): AsyncGenerator<ReflectiveStreamEvent, Critique, void> {
  const gen = streamTextModelCall(
    model,
    {
      messages: critiqueMessages(goal, answer, opts),
      tools: [],
      key: opts.key ?? keyScope().reflect(0),
    },
    'reflection',
  );
  let next = await gen.next();
  while (!next.done) {
    yield next.value;
    next = await gen.next();
  }
  return parseCritique(next.value);
}

/** Parse a critique from model text. */
export function parseCritique(text: string): Critique {
  const json = extractJsonObject(text);
  if (json) {
    try {
      const parsed = JSON.parse(json) as {
        satisfactory?: unknown;
        feedback?: unknown;
        rootCause?: unknown;
        correctionStrategy?: unknown;
        whatWorked?: unknown;
      };
      const result: Critique = {
        satisfactory: parsed.satisfactory === true,
        feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
      };
      if (typeof parsed.rootCause === 'string' && parsed.rootCause.trim()) {
        result.rootCause = parsed.rootCause.trim();
      }
      if (typeof parsed.correctionStrategy === 'string' && parsed.correctionStrategy.trim()) {
        result.correctionStrategy = parsed.correctionStrategy.trim();
      }
      if (Array.isArray(parsed.whatWorked)) {
        const worked = parsed.whatWorked.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
        if (worked.length > 0) result.whatWorked = worked;
      }
      return result;
    } catch {
      /* fall through */
    }
  }
  return {
    satisfactory: /\b(satisfactory|looks good|correct|approved|lgtm)\b/i.test(text),
    feedback: text.trim().slice(0, 500),
  };
}

/**
 * Build the follow-up goal fed to the next attempt. Uses the critic's
 * structured diagnosis (root cause, correction strategy, what worked) when
 * available, falling back to the raw feedback for critiques that only ever
 * produced the L1 pass/fail shape.
 */
export function buildRevisedGoal(goal: string, previousAnswer: string, c: Critique): string {
  const parts = [goal, `A previous attempt answered:\n${previousAnswer}`];

  if (c.rootCause) {
    parts.push(`Root cause of the shortfall:\n${c.rootCause}`);
  }
  if (c.correctionStrategy) {
    parts.push(`How to fix it this time:\n${c.correctionStrategy}`);
  }
  if (c.whatWorked && c.whatWorked.length > 0) {
    parts.push(
      `Parts of the previous attempt that were already correct — keep them:\n- ${c.whatWorked.join('\n- ')}`,
    );
  }
  parts.push(`Reviewer feedback to address:\n${c.feedback}`);

  return parts.join('\n\n');
}

export interface ReflectiveAgentOptions extends RunAgentOptions {
  /** Max critique/revise cycles after the first attempt. Default 1. */
  maxReflections?: number;
}

/** Batch wrapper — drains {@link runReflectiveAgentStreamed}. */
export async function runReflectiveAgent(
  opts: ReflectiveAgentOptions,
): Promise<ReflectiveAgentResult> {
  let result: ReflectiveAgentResult | undefined;
  for await (const ev of runReflectiveAgentStreamed(opts)) {
    if (ev.type === 'done') result = ev.result;
  }
  if (!result) throw new Error('runReflectiveAgent: stream ended without done');
  return result;
}

/** Streaming attempt → critique → revise. Token events carry `lane`. */
export async function* runReflectiveAgentStreamed(
  opts: ReflectiveAgentOptions,
): AsyncGenerator<ReflectiveStreamEvent, ReflectiveAgentResult, void> {
  const scope = keyScope(opts.keyPrefix);
  const maxReflections = opts.maxReflections ?? 1;
  const critiques: Critique[] = [];

  const model = opts.model ?? opts.agent?.model;
  if (!model) throw new Error('runReflectiveAgent: a model is required');

  let result: AgentRunResult | undefined;
  for await (const ev of runAgentStreamed({ ...opts, keyPrefix: scope.attempt(0).toPrefix() })) {
    if (ev.type === 'model_token' || ev.type === 'thinking_token') {
      yield { ...ev, lane: ev.lane ?? 'agent' };
    }
    if (ev.type === 'done') result = ev.result;
  }
  if (!result) throw new Error('runReflectiveAgent: attempt ended without done');

  for (let i = 0; i < maxReflections; i++) {
    const critiqueGen = critiqueStreamed(opts.goal, result.answer, model, {
      key: scope.reflect(i),
      conversationHistory: opts.conversationHistory,
    });
    let cNext = await critiqueGen.next();
    while (!cNext.done) {
      yield cNext.value;
      cNext = await critiqueGen.next();
    }
    const c = cNext.value;
    critiques.push(c);
    if (c.satisfactory) break;

    const revisedGoal = buildRevisedGoal(opts.goal, result.answer, c);
    result = undefined;
    for await (const ev of runAgentStreamed({
      ...opts,
      goal: revisedGoal,
      keyPrefix: scope.attempt(i + 1).toPrefix(),
    })) {
      if (ev.type === 'model_token' || ev.type === 'thinking_token') {
        yield { ...ev, lane: ev.lane ?? 'agent' };
      }
      if (ev.type === 'done') result = ev.result;
    }
    if (!result) throw new Error('runReflectiveAgent: revise attempt ended without done');
  }

  const out: ReflectiveAgentResult = { ...result, critiques };
  yield { type: 'done', result: out };
  return out;
}

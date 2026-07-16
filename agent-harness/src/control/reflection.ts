/**
 * D: reflection / self-critique.
 *
 * After the loop produces an answer, a critic model call judges whether it
 * actually satisfies the goal. If not, the loop runs again — up to
 * `maxReflections` times. Each attempt and each critique gets its own key
 * namespace (`a<i>:` and `reflect<i>`) so the whole reflective run remains
 * deterministic and replayable on a durable host.
 *
 * Structured diagnosis (L2): the critic doesn't just say pass/fail — it's
 * asked to name the root cause of the shortfall, propose a concrete
 * correction strategy, and call out which parts of the prior attempt were
 * already correct (so the next attempt doesn't redo good work). This gives
 * the next attempt a targeted fix instead of a vague "try again".
 */

import type { ChatModel } from '@agent/contracts';
import { systemMessage, userMessage } from '@agent/contracts';

import { extractJsonObject } from '@agent/contracts';
import { runAgent, type AgentRunResult, type RunAgentOptions } from './loop.js';

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

/** Ask the model to critique an answer against the goal. Tolerant JSON parse. */
export async function critique(goal: string, answer: string, model: ChatModel, opts: { key?: string } = {}): Promise<Critique> {
  const messages = [
    systemMessage(
      'You are a strict reviewer. Decide whether the answer fully satisfies the goal. ' +
        'If it does not, diagnose precisely what is wrong instead of a vague verdict. Reply with ONLY JSON: ' +
        '{"satisfactory":true|false,"feedback":"one-line summary",' +
        '"rootCause":"why it fell short, omit or empty if satisfactory",' +
        '"correctionStrategy":"concrete steps to fix it next attempt, omit or empty if satisfactory",' +
        '"whatWorked":["parts of the attempt that were already correct and should be kept, if any"]}.',
    ),
    userMessage(`Goal: ${goal}\n\nProposed answer:\n${answer}`),
  ];
  const resp = await model.chat({ messages, tools: [], key: opts.key ?? 'reflect' });
  return parseCritique(resp.message.content ?? '');
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
  return { satisfactory: /\b(satisfactory|looks good|correct|approved|lgtm)\b/i.test(text), feedback: text.trim().slice(0, 500) };
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
    parts.push(`Parts of the previous attempt that were already correct — keep them:\n- ${c.whatWorked.join('\n- ')}`);
  }
  parts.push(`Reviewer feedback to address:\n${c.feedback}`);

  return parts.join('\n\n');
}

export interface ReflectiveAgentOptions extends RunAgentOptions {
  /** Max critique/revise cycles after the first attempt. Default 1. */
  maxReflections?: number;
}

/** Run the agent, then critique and optionally revise up to `maxReflections` times. */
export async function runReflectiveAgent(opts: ReflectiveAgentOptions): Promise<AgentRunResult & { critiques: Critique[] }> {
  const prefix = opts.keyPrefix ?? '';
  const maxReflections = opts.maxReflections ?? 1;
  const critiques: Critique[] = [];

  // Resolve model from explicit override or agent config (backward compat).
  const model = opts.model ?? opts.agent?.model;
  if (!model) throw new Error('runReflectiveAgent: a model is required');

  let result = await runAgent({ ...opts, keyPrefix: `${prefix}a0:` });

  for (let i = 0; i < maxReflections; i++) {
    const c = await critique(opts.goal, result.answer, model, { key: `${prefix}reflect${i}` });
    critiques.push(c);
    if (c.satisfactory) break;

    const revisedGoal = buildRevisedGoal(opts.goal, result.answer, c);
    result = await runAgent({ ...opts, goal: revisedGoal, keyPrefix: `${prefix}a${i + 1}:` });
  }

  return { ...result, critiques };
}

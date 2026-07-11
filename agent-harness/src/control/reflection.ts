/**
 * D: reflection / self-critique.
 *
 * After the loop produces an answer, a critic model call judges whether it
 * actually satisfies the goal. If not, the feedback is appended to the goal and
 * the loop runs again — up to `maxReflections` times. Each attempt and each
 * critique gets its own key namespace (`a<i>:` and `reflect<i>`) so the whole
 * reflective run remains deterministic and replayable on a durable host.
 */

import type { ChatModel } from '@agent/contracts';
import { systemMessage, userMessage } from '@agent/contracts';

import { extractJsonObject } from '../protocol/tool-calling.js';
import { runAgent, type AgentRunResult, type RunAgentOptions } from './loop.js';

export interface Critique {
  satisfactory: boolean;
  feedback: string;
}

/** Ask the model to critique an answer against the goal. Tolerant JSON parse. */
export async function critique(goal: string, answer: string, model: ChatModel, opts: { key?: string } = {}): Promise<Critique> {
  const messages = [
    systemMessage('You are a strict reviewer. Decide whether the answer fully satisfies the goal. Reply with ONLY JSON: {"satisfactory":true|false,"feedback":"what to fix"}.'),
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
      const parsed = JSON.parse(json) as { satisfactory?: unknown; feedback?: unknown };
      return {
        satisfactory: parsed.satisfactory === true,
        feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
      };
    } catch {
      /* fall through */
    }
  }
  return { satisfactory: /\b(satisfactory|looks good|correct|approved|lgtm)\b/i.test(text), feedback: text.trim().slice(0, 500) };
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

    const revisedGoal = `${opts.goal}\n\nA previous attempt answered:\n${result.answer}\n\nReviewer feedback to address:\n${c.feedback}`;
    result = await runAgent({ ...opts, goal: revisedGoal, keyPrefix: `${prefix}a${i + 1}:` });
  }

  return { ...result, critiques };
}

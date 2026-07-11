/**
 * A: the tool-calling protocol.
 *
 * Turns a model's `ChatResponse` into a concrete decision the loop can act on:
 * either a set of tool calls (each pre-validated against its `ToolSpec`) or a
 * final answer. Argument validation happens HERE, before any side effect, so a
 * bad call becomes a structured error the loop can feed back to the model rather
 * than an exception that aborts the run.
 *
 * Two model styles are supported:
 *  - Native tool calling: the model returns structured `toolCalls`. Preferred.
 *  - Text-only models: `parseTextToolCall` tolerantly extracts a JSON tool call
 *    (or final answer) from free-form text — the fallback for providers without
 *    native tool calling. This is where the old hand-rolled JSON protocol lives,
 *    now isolated behind the same structured decision.
 */

import type { ChatResponse, ToolCall, ToolSpec } from '@agent/contracts';

import { formatErrors, validate } from '../schema/validate.js';

/** The loop-facing decision derived from a model reply. */
export type ProtocolDecision =
  | { kind: 'final'; answer: string; /** Internal reasoning from this turn (o1/Claude/R1). */ thinking?: string }
  | { kind: 'tool_calls'; calls: PreparedCall[]; /** Internal reasoning from this turn. */ thinking?: string; /** Natural-language text the model produced alongside its tool calls (Anthropic multi-block). */ aside?: string };

/** A tool call after name/argument checking. `error` is set when it must not run. */
export interface PreparedCall {
  call: ToolCall;
  valid: boolean;
  /** Present iff `valid` is false — a model-readable reason (unknown tool / bad args). */
  error?: string;
}

/** Interpret a structured model response into tool calls (validated) or a final answer. */
export function interpretResponse(resp: ChatResponse, specs: ToolSpec[]): ProtocolDecision {
  const thinking = resp.thinking ?? resp.message.thinking;
  const toolCalls = resp.message.toolCalls;
  if (toolCalls && toolCalls.length > 0) {
    const byName = new Map(specs.map((s) => [s.name, s]));
    return {
      kind: 'tool_calls',
      calls: toolCalls.map((call) => prepareCall(call, byName)),
      thinking,
      aside: resp.message.content || undefined,
    };
  }
  return { kind: 'final', answer: resp.message.content ?? '', thinking };
}

/** Validate one requested call against the known tools. Never throws. */
export function prepareCall(call: ToolCall, byName: Map<string, ToolSpec>): PreparedCall {
  const spec = byName.get(call.name);
  if (!spec) {
    const available = [...byName.keys()].join(', ') || '(none)';
    return { call, valid: false, error: `Unknown tool "${call.name}". Available tools: ${available}.` };
  }
  const errors = validate(call.arguments, spec.inputSchema);
  if (errors.length > 0) {
    return { call, valid: false, error: `Invalid arguments for "${call.name}": ${formatErrors(errors)}.` };
  }
  return { call, valid: true };
}

/**
 * Tolerant fallback for text-only models: pull a single JSON decision out of
 * arbitrary prose / code fences. Recognises both the explicit action form
 * (`{"action":"call_tool","tool":..,"args":..}` / `{"action":"finish","answer":..}`)
 * and a bare `{"tool":..,"args":..}`. Returns `undefined` if nothing parseable.
 */
export function parseTextToolCall(raw: string, idHint = 'call-1'): ProtocolDecision | undefined {
  const json = extractJsonObject(raw);
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  if (parsed.action === 'finish' && typeof parsed.answer === 'string') {
    return { kind: 'final', answer: parsed.answer };
  }
  const name = typeof parsed.tool === 'string' ? parsed.tool : undefined;
  if (name) {
    const args = 'args' in parsed ? parsed.args : {};
    const call: ToolCall = { id: idHint, name, arguments: args ?? {} };
    return { kind: 'tool_calls', calls: [{ call, valid: true }] };
  }
  return undefined;
}

/** Extract the first balanced `{...}` object from arbitrary text (string-aware). */
export function extractJsonObject(text: string): string | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Workflow contract — the platform-side types that describe what a workflow
 * looks like. This file is part of the *runtime*, not any particular agent.
 *
 * A workflow is a declarative list of phases, each with ordered steps. A step is
 * a plain async function that receives a `StepContext`: the current derived
 * state, an idempotent `callModel`/`callTool`, and `getStepOutput` to read the
 * outputs of earlier steps. Keeping workflows declarative (data, not control
 * flow) is what lets the runtime drive and resume any of them generically.
 *
 * Concrete workflows are the demo workload and live under ./app (for example
 * ./app/issue-workflow.ts).
 */

import type { ChatResponse, ChatStreamOutput } from '@agent/contracts';

import type { ChatModelRequest } from './model/chat-provider.js';
import type { ToolRegistry } from './tools/registry.js';
import type { AgentEvent, RunState, StreamNotifyEvent } from './types.js';

/**
 * Options for a single tool/model call. A `key` disambiguates multiple calls
 * *within one step*: idempotency is normally keyed by `<phase>.<step>`, so a step
 * that issues many model/tool calls (e.g. an agentic loop, one call per turn)
 * must pass a unique key per call — otherwise every call would collide on the
 * same idempotency id and replay the first result.
 */
export interface CallOptions {
  key?: string;
}

export interface StepContext {
  runId: string;
  input: { issue: string; conversationHistory?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> };
  state: RunState;
  tools: ToolRegistry;
  /** Call a tool with automatic, deterministic idempotency across resumes. */
  callTool: <R = unknown>(tool: string, args: unknown, opts?: CallOptions) => Promise<R>;
  /** Call the model; recorded as a ModelCalled event (tokens/cost/latency) and idempotent across resumes. */
  callModel: (prompt: string, opts?: CallOptions) => Promise<string>;
  /**
   * Native tool-calling chat turn. Recorded/replayed like `callModel` under the
   * same key space. Present when Runtime was constructed with `chatModel`.
   */
  callChat?: (req: ChatModelRequest, opts?: CallOptions) => Promise<ChatResponse>;
  /**
   * Streaming chat turn. Yields tokens live; still records one final
   * `ModelCalled` with the full ChatResponse (replay synthesises the stream).
   * Present when Runtime was constructed with `chatModel`.
   */
  callChatStream?: (req: ChatModelRequest, opts?: CallOptions) => AsyncIterable<ChatStreamOutput>;
  /** Read the output an earlier step produced (e.g. "analyze.1"). */
  getStepOutput: <R = unknown>(stepId: string) => R | undefined;
  /**
   * Append an observability event (no RunState transition). Used for HITL
   * audit — e.g. mid-run steer / abort — so the log records who changed what.
   */
  emit: (event: Extract<AgentEvent, { type: 'HumanIntervention' }>) => void;
  /**
   * Live-only stream notify (tokens). Not written to the durable event log —
   * hosts use RuntimeOptions.onStreamEvent for CLI/SSE UX.
   */
  notifyStream?: (event: StreamNotifyEvent) => void;
}

export interface StepDef {
  id: string;
  name: string;
  run: (ctx: StepContext) => Promise<unknown>;
}

export interface PhaseDef {
  name: string;
  steps: StepDef[];
}

export interface WorkflowDef {
  name: string;
  phases: PhaseDef[];
  /**
   * Optional: derive the run's `summary` from the final derived state.
   * Demo issue→fix workflow and harness adapter each supply their own.
   */
  summarize?: (state: RunState) => unknown;
}

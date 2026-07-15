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

import type { ToolRegistry } from './tools/registry.js';
import type { RunState } from './types.js';

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
  /** Read the output an earlier step produced (e.g. "analyze.1"). */
  getStepOutput: <R = unknown>(stepId: string) => R | undefined;
}

export interface StepDef {
  id: string;
  name: string;
  run: (ctx: StepContext) => Promise<unknown>;
}

export interface PhaseDef {
  name: string;
  skippable: boolean;
  steps: StepDef[];
}

export interface WorkflowDef {
  name: string;
  phases: PhaseDef[];
  /**
   * Optional: derive the run's `summary` from the final derived state. If omitted,
   * the runtime falls back to the demo workload's convention (reading `propose.1`).
   * A model-driven agent (see ../agent-loop.ts) uses this to surface its final answer.
   */
  summarize?: (state: RunState) => unknown;
}

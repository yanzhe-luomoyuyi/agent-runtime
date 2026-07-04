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

export interface StepContext {
  runId: string;
  input: { issue: string };
  state: RunState;
  tools: ToolRegistry;
  /** Call a tool with automatic, deterministic idempotency across resumes. */
  callTool: <R = unknown>(tool: string, args: unknown) => Promise<R>;
  /** Call the model; recorded as a ModelCalled event (tokens/cost/latency) and idempotent across resumes. */
  callModel: (prompt: string) => Promise<string>;
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
}

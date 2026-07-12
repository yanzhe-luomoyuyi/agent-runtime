/**
 * Core domain types.
 *
 * The event log is the single source of truth. `RunState` is never persisted —
 * it is always re-derived from the ordered list of `AgentEvent`s by the reducer.
 */

export interface RunInput {
  issue: string;
  /** Previous conversation turns from earlier runs in the same session. */
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Every meaningful thing that happens during a run is recorded as an event and
 * appended (immutably) to the log. Replaying the events rebuilds the exact state.
 */
export type AgentEvent =
  | { type: 'RunStarted'; runId: string; input: RunInput; workflow: string; ts: string }
  | { type: 'PhaseStarted'; phase: string; ts: string }
  | { type: 'StepStarted'; phase: string; step: number; stepId: string; ts: string }
  | { type: 'ToolCallRequested'; callId: string; tool: string; args: unknown; ts: string }
  | { type: 'ToolCallSucceeded'; callId: string; tool: string; result: unknown; ts: string }
  | { type: 'ToolCallFailed'; callId: string; tool: string; error: string; ts: string }
  | { type: 'PolicyDenied'; scope: 'tool' | 'model'; target: string; code: string; reason: string; ts: string }
  | { type: 'ModelCalled'; callId: string; phase: string; step: number; prompt: string; response: string; promptTokens: number; completionTokens: number; costUsd: number; latencyMs: number; cached?: boolean; ts: string }
  | { type: 'StepCompleted'; phase: string; step: number; stepId: string; output: unknown; ts: string }
  | { type: 'PhaseCompleted'; phase: string; ts: string }
  | { type: 'PhaseSkipped'; phase: string; reason: string; ts: string }
  | { type: 'RunCompleted'; summary: unknown; ts: string }
  | { type: 'RunFailed'; error: string; ts: string };

export type RunStatus = 'running' | 'completed' | 'failed';
export type PhaseStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';

export interface PhaseState {
  status: PhaseStatus;
  stepsCompleted: number[];
  skipReason?: string;
}

export interface RunState {
  runId: string;
  input?: RunInput;
  workflow?: string;
  status: RunStatus;
  currentPhase?: string;
  currentStep?: number;
  phases: Record<string, PhaseState>;
  /** Output of each completed step, keyed by stepId (e.g. "analyze.2"). */
  stepOutputs: Record<string, unknown>;
  /** Idempotency cache: deterministic callId -> tool result. Derived from the log. */
  toolResults: Record<string, unknown>;
  /** Idempotency cache: deterministic callId -> model response text. Derived from the log. */
  modelResults: Record<string, string>;
  summary?: unknown;
  error?: string;
}

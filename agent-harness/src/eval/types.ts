/**
 * L2 harness-loop eval: Scenario / Scorer types that grade `runAgent` (or a
 * single assemble/compact decision) via `AgentTrace` + `AgentRunResult` — no
 * durable runtime, no coding sandbox.
 */

import type { Message } from '@agent/contracts';

import type { ContextManager } from '../context/manager.js';
import type { AgentRunResult, RunAgentOptions } from '../control/loop.js';
import type { AgentTrace } from '../tracing/collector.js';

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** Scorer input: durable transcript + harness decision trace. */
export interface ScoreContext {
  result: AgentRunResult;
  trace: AgentTrace;
  /** Ablation / policy label from the scenario (e.g. `importance+pin`). */
  label?: string;
}

export type Scorer = (ctx: ScoreContext) => CheckResult | Promise<CheckResult>;

/** Full agent-loop scenario: runner attaches `TraceCollector`. */
export interface LoopScenario {
  name: string;
  kind?: 'loop';
  /**
   * Build `runAgent` options. Do not pass `trace` — the runner always installs
   * a fresh `TraceCollector` so scorers see assemble/compact/recall.
   */
  setup: () => Omit<RunAgentOptions, 'trace'> | Promise<Omit<RunAgentOptions, 'trace'>>;
  checks: Scorer[];
  label?: string;
}

/**
 * Assemble-only ablation: one `assembleDetailed` call projected into the same
 * ScoreContext shape so context scorers stay reusable without a model turn.
 */
export interface AssembleScenario {
  name: string;
  kind: 'assemble';
  setup: () =>
    | { messages: Message[]; context: ContextManager }
    | Promise<{ messages: Message[]; context: ContextManager }>;
  checks: Scorer[];
  label?: string;
}

/**
 * Compact-only ablation: one `compactIfNeededDetailed` call projected into
 * ScoreContext (compact decision on turn 1).
 */
export interface CompactScenario {
  name: string;
  kind: 'compact';
  setup: () =>
    | { messages: Message[]; context: ContextManager; turn?: number; keyPrefix?: string }
    | Promise<{ messages: Message[]; context: ContextManager; turn?: number; keyPrefix?: string }>;
  checks: Scorer[];
  label?: string;
}

export type Scenario = LoopScenario | AssembleScenario | CompactScenario;

export interface ScenarioResult {
  scenario: string;
  passed: boolean;
  checks: CheckResult[];
  label?: string;
}

export interface EvalReport {
  results: ScenarioResult[];
  passed: number;
  failed: number;
  total: number;
  allPassed: boolean;
}

/**
 * Harness L2 eval runner: execute loop / assemble / compact scenarios, score
 * with composable checks, emit a pass/fail report. In-process only — testkit
 * model + MockToolInvoker; no durable-agent-runtime.
 */

import type { Message } from '@agent/contracts';

import type { ContextManager } from '../context/manager.js';
import { runAgent, type AgentRunResult } from '../control/loop.js';
import { FALLBACK_PRICING, TraceCollector, type AgentTrace } from '../tracing/collector.js';
import type {
  AssembleScenario,
  CompactScenario,
  EvalReport,
  LoopScenario,
  Scenario,
  ScenarioResult,
  ScoreContext,
} from './types.js';

function emptyTraceBase(): Omit<AgentTrace, 'turns'> {
  return {
    runDurationMs: 0,
    totalTurns: 0,
    totalRetries: 0,
    totalToolCalls: 0,
    toolOk: 0,
    toolFail: 0,
    toolSuccessRate: 1,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCachedPromptTokens: 0,
    estimatedCostUsd: 0,
    pricingModel: FALLBACK_PRICING,
  };
}

/** Project one assembleDetailed call into ScoreContext (same shape as a loop run). */
function scoreContextFromAssemble(
  scenario: AssembleScenario,
  messages: Message[],
  context: ContextManager,
): ScoreContext {
  const { messages: out, decision } = context.assembleDetailed(messages);
  const result: AgentRunResult = {
    answer: '',
    finished: true,
    stopReason: 'finished',
    turns: 0,
    messages: out,
    toolsUsed: [],
    durationMs: 0,
  };
  const trace: AgentTrace = {
    ...emptyTraceBase(),
    turns: [
      {
        turn: 1,
        model: { turn: 1, retries: 0, ok: true, durationMs: 0 },
        tools: [],
        context: { assemble: decision },
      },
    ],
  };
  return { result, trace, label: scenario.label };
}

async function scoreContextFromCompact(
  scenario: CompactScenario,
  messages: Message[],
  context: ContextManager,
  turn: number,
  keyPrefix: string,
): Promise<ScoreContext> {
  const { messages: out, decision } = await context.compactIfNeededDetailed(messages, {
    turn,
    keyPrefix,
  });
  const result: AgentRunResult = {
    answer: '',
    finished: true,
    stopReason: 'finished',
    turns: 0,
    messages: out,
    toolsUsed: [],
    durationMs: 0,
  };
  const trace: AgentTrace = {
    ...emptyTraceBase(),
    turns: [
      {
        turn: 1,
        model: { turn: 1, retries: 0, ok: true, durationMs: 0 },
        tools: [],
        context: { compact: decision },
      },
    ],
  };
  return { result, trace, label: scenario.label };
}

async function runLoopScenario(scenario: LoopScenario): Promise<ScenarioResult> {
  const opts = await scenario.setup();
  const collector = new TraceCollector(FALLBACK_PRICING);
  const result = await runAgent({ ...opts, trace: collector });
  const trace = collector.snapshot(result.durationMs);
  const ctx: ScoreContext = { result, trace, label: scenario.label };
  const checks = await Promise.all(scenario.checks.map((c) => c(ctx)));
  return {
    scenario: scenario.name,
    passed: checks.every((c) => c.passed),
    checks,
    label: scenario.label,
  };
}

async function runAssembleScenario(scenario: AssembleScenario): Promise<ScenarioResult> {
  const { messages, context } = await scenario.setup();
  const ctx = scoreContextFromAssemble(scenario, messages, context);
  const checks = await Promise.all(scenario.checks.map((c) => c(ctx)));
  return {
    scenario: scenario.name,
    passed: checks.every((c) => c.passed),
    checks,
    label: scenario.label,
  };
}

async function runCompactScenario(scenario: CompactScenario): Promise<ScenarioResult> {
  const { messages, context, turn = 1, keyPrefix = '' } = await scenario.setup();
  const ctx = await scoreContextFromCompact(scenario, messages, context, turn, keyPrefix);
  const checks = await Promise.all(scenario.checks.map((c) => c(ctx)));
  return {
    scenario: scenario.name,
    passed: checks.every((c) => c.passed),
    checks,
    label: scenario.label,
  };
}

function isAssembleScenario(s: Scenario): s is AssembleScenario {
  return s.kind === 'assemble';
}

function isCompactScenario(s: Scenario): s is CompactScenario {
  return s.kind === 'compact';
}

/** Run all scenarios; one failure does not skip the rest. */
export async function runHarnessEval(scenarios: Scenario[]): Promise<EvalReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    try {
      let result: ScenarioResult;
      if (isAssembleScenario(scenario)) result = await runAssembleScenario(scenario);
      else if (isCompactScenario(scenario)) result = await runCompactScenario(scenario);
      else result = await runLoopScenario(scenario);
      results.push(result);
    } catch (err) {
      results.push({
        scenario: scenario.name,
        passed: false,
        label: scenario.label,
        checks: [
          {
            name: 'run threw',
            passed: false,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
      });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    results,
    passed,
    failed: results.length - passed,
    total: results.length,
    allPassed: passed === results.length,
  };
}

export function renderHarnessReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    const tag = r.label ? ` [${r.label}]` : '';
    lines.push(`${r.passed ? 'PASS' : 'FAIL'}  ${r.scenario}${tag}`);
    for (const c of r.checks) {
      lines.push(`   ${c.passed ? '\u2713' : '\u2717'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
    }
  }
  lines.push('');
  lines.push(
    `${report.passed}/${report.total} scenarios passed${report.allPassed ? '' : '  \u2014 REGRESSION'}`,
  );
  return lines.join('\n');
}

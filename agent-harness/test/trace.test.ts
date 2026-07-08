import { describe, expect, it } from 'vitest';

import {
  compareTraces,
  DEFAULT_PRICING,
  estimateCost,
  FALLBACK_PRICING,
  formatTraceReport,
  TraceCollector,
  type AgentTrace,
} from '../src/tracing/collector.js';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
describe('pricing', () => {
  it('has pricing for common models', () => {
    expect(DEFAULT_PRICING['gpt-4o']).toBeDefined();
    expect(DEFAULT_PRICING['claude-3.5-sonnet']).toBeDefined();
  });

  it('estimates cost correctly', () => {
    const cost = estimateCost(1000, 500, 0, FALLBACK_PRICING);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(1000 * 3e-6 + 500 * 1.5e-5, 6);
  });

  it('applies cached-prompt discount', () => {
    const pricing = DEFAULT_PRICING['claude-3.5-sonnet']!;
    // 900 cached + 100 regular prompt, 500 completion
    const cost = estimateCost(1000, 500, 900, pricing);
    const expected = 100 * pricing.promptUsdPerToken + 900 * pricing.cachedPromptUsdPerToken! + 500 * pricing.completionUsdPerToken;
    expect(cost).toBeCloseTo(expected, 8);
  });
});

// ---------------------------------------------------------------------------
// TraceCollector
// ---------------------------------------------------------------------------
describe('TraceCollector', () => {
  it('records model and tool calls', () => {
    const t = new TraceCollector(FALLBACK_PRICING);
    t.startTurn(1);
    t.startModelCall();
    t.endModelCall({ promptTokens: 100, completionTokens: 50 });
    t.startToolCall();
    t.endToolCall('search', true, { query: 'bug' });
    t.startToolCall();
    t.endToolCall('deploy', false, { env: 'prod' }, 'permission denied');

    const trace = t.snapshot(5000);
    expect(trace.totalTurns).toBe(1);
    expect(trace.totalToolCalls).toBe(2);
    expect(trace.toolOk).toBe(1);
    expect(trace.toolFail).toBe(1);
    expect(trace.toolSuccessRate).toBe(0.5);
    expect(trace.totalPromptTokens).toBe(100);
    expect(trace.totalCompletionTokens).toBe(50);
    expect(trace.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('handles model call errors (no usage)', () => {
    const t = new TraceCollector(FALLBACK_PRICING);
    t.startTurn(1);
    t.startModelCall();
    t.endModelCallError('rate limited');

    const trace = t.snapshot(1000);
    expect(trace.totalTurns).toBe(1);
    expect(trace.turns[0]!.model.ok).toBe(false);
    expect(trace.turns[0]!.model.error).toContain('rate limited');
    expect(trace.turns[0]!.model.usage).toBeUndefined();
    // Token totals should be 0 (no successful call contributed).
    expect(trace.totalPromptTokens).toBe(0);
  });

  it('tracks retries per model call', () => {
    const t = new TraceCollector(FALLBACK_PRICING);
    t.startTurn(1);
    t.startModelCall();
    t.recordRetry(new Error('429'), 1);
    t.recordRetry(new Error('429'), 2);
    t.endModelCall({ promptTokens: 100, completionTokens: 50 });

    const trace = t.snapshot(5000);
    expect(trace.totalRetries).toBe(2);
    expect(trace.turns[0]!.model.retries).toBe(2);
  });

  it('tracks tool args for decision tracing', () => {
    const t = new TraceCollector(FALLBACK_PRICING);
    t.startTurn(1);
    t.startModelCall();
    t.endModelCall({ promptTokens: 10, completionTokens: 5 });
    t.startToolCall();
    t.endToolCall('search', true, { query: 'login bug', path: 'src/' });

    const trace = t.snapshot(1000);
    expect(trace.turns[0]!.tools[0]!.args).toEqual({ query: 'login bug', path: 'src/' });
  });

  it('works without usage data (backward compat)', () => {
    const t = new TraceCollector(FALLBACK_PRICING);
    t.startTurn(1);
    t.startModelCall();
    t.endModelCall(); // no usage arg — backward compat
    t.startToolCall();
    t.endToolCall('search', true); // no args — backward compat

    const trace = t.snapshot(1000);
    expect(trace.totalTurns).toBe(1);
    expect(trace.turns[0]!.model.usage).toBeUndefined();
    expect(trace.turns[0]!.tools[0]!.args).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatTraceReport
// ---------------------------------------------------------------------------
describe('formatTraceReport', () => {
  it('produces a readable report', () => {
    const t = new TraceCollector(FALLBACK_PRICING);
    t.startTurn(1);
    t.startModelCall();
    t.endModelCall({ promptTokens: 100, completionTokens: 50 });
    t.startToolCall();
    t.endToolCall('search', true, { q: 'x' });

    const report = formatTraceReport(t.snapshot(3000));
    expect(report).toContain('Agent Trace Report');
    expect(report).toContain('Token Economics');
    expect(report).toContain('search');
  });
});

// ---------------------------------------------------------------------------
// compareTraces
// ---------------------------------------------------------------------------
describe('compareTraces', () => {
  function makeTrace(turns: number, toolCalls: number, cost: number): AgentTrace {
    return {
      runDurationMs: 1000,
      totalTurns: turns,
      totalRetries: 0,
      totalToolCalls: toolCalls,
      toolOk: toolCalls,
      toolFail: 0,
      toolSuccessRate: 1,
      totalPromptTokens: 1000,
      totalCompletionTokens: 500,
      totalCachedPromptTokens: 0,
      estimatedCostUsd: cost,
      pricingModel: FALLBACK_PRICING,
      turns: [],
    };
  }

  it('compares two traces with percentage deltas', () => {
    const a = makeTrace(5, 10, 0.01);
    const b = makeTrace(3, 6, 0.006);
    const cmp = compareTraces(a, b);
    expect(cmp).toContain('Trace Comparison');
    expect(cmp).toContain('Turns:');
    expect(cmp).toContain('Cost:');
  });
});
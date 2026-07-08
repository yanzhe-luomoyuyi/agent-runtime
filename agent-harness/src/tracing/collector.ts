/**
 * Tracing / observability — structured per-run metrics with token economics.
 *
 * A `TraceCollector` is called by the loop at key instrumentation points.
 * After the run, call `snapshot()` to get a plain-data `AgentTrace` suitable
 * for logging, dashboards, eval scoring, or cost attribution.
 *
 * No runtime cost when not used: the loop checks for `trace` and only calls
 * methods when a collector is provided.
 *
 * Improvements over the earlier version:
 *  - Token tracking per model call (prompt / completion / cached → cost).
 *  - Pluggable pricing model so cost estimates stay accurate per provider.
 *  - Decision trace: what tool was called + its arguments.
 *  - `formatTraceReport()` for human-readable summaries.
 *  - `compareTraces()` for A/B / eval comparison.
 */

// ── Pricing ────────────────────────────────────────────────────────

/** Per-token pricing for a model.  Prices are per TOKEN (not per 1K). */
export interface PricingModel {
  promptUsdPerToken: number;
  completionUsdPerToken: number;
  /** Anthropic prompt-caching discount rate (default: same as prompt). */
  cachedPromptUsdPerToken?: number;
}

/** Pre-built pricing for common models (prices in USD per token, mid-2025). */
export const DEFAULT_PRICING: Record<string, PricingModel> = {
  'gpt-4o':        { promptUsdPerToken: 2.5e-6,  completionUsdPerToken: 1e-5 },
  'gpt-4o-mini':   { promptUsdPerToken: 1.5e-7,  completionUsdPerToken: 6e-7 },
  'gpt-4-turbo':   { promptUsdPerToken: 1e-5,    completionUsdPerToken: 3e-5 },
  'claude-3.5-sonnet': { promptUsdPerToken: 3e-6, completionUsdPerToken: 1.5e-5, cachedPromptUsdPerToken: 3.75e-7 },
  'claude-3-opus': { promptUsdPerToken: 1.5e-5,  completionUsdPerToken: 7.5e-5 },
  'claude-3-haiku':{ promptUsdPerToken: 2.5e-7,  completionUsdPerToken: 1.25e-6 },
};

/** Fallback pricing when the model is unknown. */
export const FALLBACK_PRICING: PricingModel = {
  promptUsdPerToken: 3e-6,
  completionUsdPerToken: 1.5e-5,
};

/** Compute cost for one model call. */
export function estimateCost(
  promptTokens: number,
  completionTokens: number,
  cachedPromptTokens: number,
  pricing: PricingModel,
): number {
  const cachedRate = pricing.cachedPromptUsdPerToken ?? pricing.promptUsdPerToken;
  const regularPrompt = Math.max(0, promptTokens - cachedPromptTokens);
  return regularPrompt * pricing.promptUsdPerToken
       + cachedPromptTokens * cachedRate
       + completionTokens * pricing.completionUsdPerToken;
}

// ── Trace data types ────────────────────────────────────────────────

/** Token usage + cost for one model call. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** Tokens served from the provider's server-side cache (Anthropic / OpenAI). */
  cachedPromptTokens: number;
  /** Estimated cost for this call (USD). */
  costUsd: number;
}

/** One model-call record (includes retries + token economics). */
export interface ModelCallTrace {
  turn: number;
  retries: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** Token usage — present when the call succeeded. */
  usage?: TokenUsage;
}

/** One tool-call record. */
export interface ToolCallTrace {
  turn: number;
  tool: string;
  /** The arguments the model supplied (may be invalid). */
  args: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface TurnTrace {
  turn: number;
  model: ModelCallTrace;
  tools: ToolCallTrace[];
}

export interface AgentTrace {
  runDurationMs: number;
  totalTurns: number;
  totalRetries: number;
  totalToolCalls: number;
  toolOk: number;
  toolFail: number;
  toolSuccessRate: number; // 0–1

  // Token economics
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedPromptTokens: number;
  estimatedCostUsd: number;
  pricingModel: PricingModel;

  turns: TurnTrace[];
}

// ── Collector ────────────────────────────────────────────────────────

export class TraceCollector {
  private turns: TurnTrace[] = [];
  private currentTurn = 0;
  private modelStart = 0;
  private toolStart = 0;
  private retryCount = 0;
  private retriesThisCall = 0;
  private pricing: PricingModel;

  // Accumulators for token economics (separate from turn-level records so
  // a failed model call still contributes to the run-level summary).
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalCachedPromptTokens = 0;

  /**
   * @param pricing  Pricing model for cost estimation.  Default: tries
   *                 `DEFAULT_PRICING[modelName]`, falls back to `FALLBACK_PRICING`.
   * @param modelName  Model identifier used to look up pricing.
   */
  constructor(pricing?: PricingModel, modelName?: string) {
    this.pricing = pricing ?? (modelName ? DEFAULT_PRICING[modelName] : undefined) ?? FALLBACK_PRICING;
  }

  // ── Called by the loop ──────────────────────────────────────────

  startTurn(turn: number): void {
    this.currentTurn = turn;
  }

  startModelCall(): void {
    this.modelStart = Date.now();
    this.retriesThisCall = 0;
  }

  /**
   * Called right after a successful `model.chat()`.
   * @param usage  Token usage from the model response.  When omitted, the turn
   *               is still recorded but without token/cost data.
   */
  endModelCall(usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number }): void {
    const durationMs = Date.now() - this.modelStart;
    const tokenUsage: TokenUsage | undefined = usage
      ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedPromptTokens: usage.cachedPromptTokens ?? 0,
          costUsd: estimateCost(usage.promptTokens, usage.completionTokens, usage.cachedPromptTokens ?? 0, this.pricing),
        }
      : undefined;

    if (tokenUsage) {
      this.totalPromptTokens += tokenUsage.promptTokens;
      this.totalCompletionTokens += tokenUsage.completionTokens;
      this.totalCachedPromptTokens += tokenUsage.cachedPromptTokens;
    }

    this.turns.push({
      turn: this.currentTurn,
      model: { turn: this.currentTurn, retries: this.retriesThisCall, ok: true, durationMs, usage: tokenUsage },
      tools: [],
    });
  }

  endModelCallError(error: string): void {
    const durationMs = Date.now() - this.modelStart;
    this.turns.push({
      turn: this.currentTurn,
      model: { turn: this.currentTurn, retries: this.retriesThisCall, ok: false, durationMs, error },
      tools: [],
    });
  }

  recordRetry(_err: unknown, _attempt: number): void {
    this.retriesThisCall++;
    this.retryCount++;
  }

  startToolCall(): void {
    this.toolStart = Date.now();
  }

  /**
   * Called right after a tool completes (or throws).
   * @param args  The arguments the model supplied — captured for decision tracing.
   */
  endToolCall(tool: string, ok: boolean, args?: unknown, error?: string): void {
    const durationMs = Date.now() - this.toolStart;
    const current = this.turns[this.turns.length - 1];
    if (current) {
      current.tools.push({ turn: this.currentTurn, tool, args, ok, durationMs, error });
    }
  }

  // ── Snapshot ────────────────────────────────────────────────────

  snapshot(runDurationMs: number): AgentTrace {
    const totalToolCalls = this.turns.reduce((s, t) => s + t.tools.length, 0);
    const toolOk = this.turns.reduce((s, t) => s + t.tools.filter((c) => c.ok).length, 0);
    return {
      runDurationMs,
      totalTurns: this.turns.length,
      totalRetries: this.retryCount,
      totalToolCalls,
      toolOk,
      toolFail: totalToolCalls - toolOk,
      toolSuccessRate: totalToolCalls > 0 ? toolOk / totalToolCalls : 1,
      totalPromptTokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      totalCachedPromptTokens: this.totalCachedPromptTokens,
      estimatedCostUsd: estimateCost(
        this.totalPromptTokens, this.totalCompletionTokens, this.totalCachedPromptTokens, this.pricing,
      ),
      pricingModel: { ...this.pricing },
      turns: [...this.turns],
    };
  }
}

// ── Utilities ───────────────────────────────────────────────────────

/**
 * Format a human-readable trace report (suitable for logs or terminal output).
 * Includes token economics and per-turn breakdown.
 */
export function formatTraceReport(trace: AgentTrace): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════',
    '  Agent Trace Report',
    '═══════════════════════════════════════════════',
    `  Duration:       ${(trace.runDurationMs / 1000).toFixed(1)}s`,
    `  Turns:          ${trace.totalTurns}`,
    `  Retries:        ${trace.totalRetries}`,
    `  Tool calls:     ${trace.totalToolCalls} (${trace.toolOk} ok, ${trace.toolFail} fail, ${(trace.toolSuccessRate * 100).toFixed(0)}% success)`,
    '',
    '  ── Token Economics ──',
    `  Prompt tokens:     ${trace.totalPromptTokens.toLocaleString()}`,
    `  Cached (free):     ${trace.totalCachedPromptTokens.toLocaleString()}`,
    `  Completion tokens: ${trace.totalCompletionTokens.toLocaleString()}`,
    `  Est. cost:         $${trace.estimatedCostUsd.toFixed(4)}`,
    '',
    '  ── Per-Turn ──',
  ];

  for (const turn of trace.turns) {
    const modelStatus = turn.model.ok ? '✓' : '✗';
    const modelCost = turn.model.usage
      ? ` $${turn.model.usage.costUsd.toFixed(4)}`
      : '';
    lines.push(`  Turn ${String(turn.turn).padStart(2)}  model ${modelStatus}  ${turn.model.durationMs}ms${modelCost}  (${turn.model.retries} retries)`);

    for (const tc of turn.tools) {
      const status = tc.ok ? '✓' : '✗';
      const argsSummary = typeof tc.args === 'object' && tc.args !== null
        ? JSON.stringify(tc.args).slice(0, 80)
        : '';
      lines.push(`         tool ${status} ${tc.tool}(${argsSummary})  ${tc.durationMs}ms${tc.error ? `  ${tc.error}` : ''}`);
    }
  }

  lines.push('═══════════════════════════════════════════════');
  return lines.join('\n');
}

/**
 * Compare two traces and return a diff-like summary.  Useful for A/B testing
 * or eval: "did the new system prompt reduce tool calls?  increase cost?"
 */
export function compareTraces(baseline: AgentTrace, candidate: AgentTrace): string {
  const pct = (a: number, b: number) => (b === 0 ? 'N/A' : `${(((a - b) / b) * 100).toFixed(1)}%`);

  const lines: string[] = [
    '═══════════════════════════════════════════════',
    '  Trace Comparison',
    '═══════════════════════════════════════════════',
    `  Turns:           ${baseline.totalTurns} → ${candidate.totalTurns}  (${pct(candidate.totalTurns, baseline.totalTurns)})`,
    `  Retries:         ${baseline.totalRetries} → ${candidate.totalRetries}  (${pct(candidate.totalRetries, baseline.totalRetries)})`,
    `  Tool calls:      ${baseline.totalToolCalls} → ${candidate.totalToolCalls}  (${pct(candidate.totalToolCalls, baseline.totalToolCalls)})`,
    `  Tool success:    ${(baseline.toolSuccessRate * 100).toFixed(0)}% → ${(candidate.toolSuccessRate * 100).toFixed(0)}%`,
    `  Prompt tokens:   ${baseline.totalPromptTokens.toLocaleString()} → ${candidate.totalPromptTokens.toLocaleString()}`,
    `  Cost:            $${baseline.estimatedCostUsd.toFixed(4)} → $${candidate.estimatedCostUsd.toFixed(4)}  (${pct(candidate.estimatedCostUsd, baseline.estimatedCostUsd)})`,
    `  Duration:        ${(baseline.runDurationMs / 1000).toFixed(1)}s → ${(candidate.runDurationMs / 1000).toFixed(1)}s`,
    '═══════════════════════════════════════════════',
  ];
  return lines.join('\n');
}

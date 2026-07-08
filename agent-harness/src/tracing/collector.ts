/**
 * Tracing / observability — structured per-run metrics.
 *
 * A `TraceCollector` is called by the loop at key instrumentation points
 * (before/after model calls, before/after tool calls, on retry). After the run,
 * call `snapshot(runDurationMs)` to get a plain-data `AgentTrace` suitable for
 * logging, dashboards, or eval scoring.
 *
 * No runtime cost when not used: the loop checks for `trace` and only calls
 * methods when a collector is provided.
 */

// ── Trace data types ────────────────────────────────────────────────

/** One model-call record (includes retries). */
export interface ModelCallTrace {
  /** Turn number (1-based). */
  turn: number;
  /** Number of retries before success (0 = first attempt succeeded). */
  retries: number;
  /** Whether the call ultimately succeeded. */
  ok: boolean;
  /** Wall-clock duration of the entire call including retries (ms). */
  durationMs: number;
  /** Error message if the call failed after all retries. */
  error?: string;
}

/** One tool-call record. */
export interface ToolCallTrace {
  /** Turn number (1-based). */
  turn: number;
  /** Tool name. */
  tool: string;
  ok: boolean;
  /** Wall-clock duration of the tool execution (ms). */
  durationMs: number;
  /** Error / observation text if not ok. */
  error?: string;
}

/** Per-turn summary. */
export interface TurnTrace {
  turn: number;
  model: ModelCallTrace;
  tools: ToolCallTrace[];
}

/** Full-run trace snapshot. */
export interface AgentTrace {
  /** Total wall-clock duration of the `runAgent` call (ms). */
  totalDurationMs: number;
  totalTurns: number;
  totalRetries: number;
  totalToolCalls: number;
  toolOk: number;
  toolFail: number;
  toolSuccessRate: number; // 0–1
  turns: TurnTrace[];
}

// ── Collector ────────────────────────────────────────────────────────

/**
 * Non-invasive trace collector. Pass as `trace` to `runAgent`:
 *
 * ```ts
 * const trace = new TraceCollector();
 * const result = await runAgent({ goal, model, tools, trace });
 * console.log(trace.snapshot(result.durationMs));
 * ```
 */
export class TraceCollector {
  private turns: TurnTrace[] = [];
  private currentTurn = 0;
  private modelStart = 0;
  private toolStart = 0;
  private retryCount = 0;
  private retriesThisCall = 0;

  // ── Called by the loop ──────────────────────────────────────────

  /** Called at the top of each turn. */
  startTurn(turn: number): void {
    this.currentTurn = turn;
  }

  /** Called right before `model.chat()`. */
  startModelCall(): void {
    this.modelStart = Date.now();
    this.retriesThisCall = 0;
  }

  /** Called right after a successful `model.chat()`. */
  endModelCall(): void {
    const durationMs = Date.now() - this.modelStart;
    this.turns.push({
      turn: this.currentTurn,
      model: { turn: this.currentTurn, retries: this.retriesThisCall, ok: true, durationMs },
      tools: [],
    });
  }

  /** Called if the model call failed after all retries. */
  endModelCallError(error: string): void {
    const durationMs = Date.now() - this.modelStart;
    this.turns.push({
      turn: this.currentTurn,
      model: { turn: this.currentTurn, retries: this.retriesThisCall, ok: false, durationMs, error },
      tools: [],
    });
  }

  /** Wire to `RetryOptions.onRetry`. */
  recordRetry(_err: unknown, _attempt: number): void {
    this.retriesThisCall++;
    this.retryCount++;
  }

  /** Called right before a tool executes. */
  startToolCall(): void {
    this.toolStart = Date.now();
  }

  /** Called right after a tool completes (or throws). */
  endToolCall(tool: string, ok: boolean, error?: string): void {
    const durationMs = Date.now() - this.toolStart;
    const current = this.turns[this.turns.length - 1];
    if (current) {
      current.tools.push({ turn: this.currentTurn, tool, ok, durationMs, error });
    }
  }

  // ── Snapshot ────────────────────────────────────────────────────

  /**
   * Produce a plain-data trace snapshot. `runDurationMs` should be the
   * wall-clock time of the entire `runAgent` call (from `AgentRunResult.durationMs`).
   */
  snapshot(runDurationMs: number): AgentTrace {
    const totalToolCalls = this.turns.reduce((s, t) => s + t.tools.length, 0);
    const toolOk = this.turns.reduce((s, t) => s + t.tools.filter((c) => c.ok).length, 0);
    return {
      totalDurationMs: runDurationMs,
      totalTurns: this.turns.length,
      totalRetries: this.retryCount,
      totalToolCalls,
      toolOk,
      toolFail: totalToolCalls - toolOk,
      toolSuccessRate: totalToolCalls > 0 ? toolOk / totalToolCalls : 1,
      turns: [...this.turns],
    };
  }
}

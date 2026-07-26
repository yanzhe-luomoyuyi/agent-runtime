/**
 * Durable idempotency keys — the single vocabulary for harness ↔ runtime replay.
 *
 * Grammar: non-empty segments joined by `:`. A segment MUST NOT itself contain `:`.
 *
 * | Kind              | Form                         | Example        |
 * |-------------------|------------------------------|----------------|
 * | turn model        | `t:{turn}`                   | `t:3`          |
 * | turn tool         | `t:{turn}:{callId}`          | `t:3:c1`       |
 * | compact           | `compact:{turn}`             | `compact:3`    |
 * | retrieve once     | `retrieve:once`              |                |
 * | retrieve rewrite  | `retrieve:rewrite`           |                |
 * | plan / replan     | `plan` / `replan:{n}`        | `replan:0`     |
 * | plan-step scope   | `s:{n}` (prefix)             | `s:0:t:1`      |
 * | attempt scope     | `a:{n}` (prefix)             | `a:0:t:1`      |
 * | reflect           | `reflect:{n}`                | `reflect:0`    |
 * | scratchpad sum    | `{toolKey}:sp:sum`           | `t:1:c1:sp:sum`|
 * | child / subagent  | `{name}` (prefix segment)    | `researcher:t:1`|
 *
 * Runtime wraps a harness key into a callId:
 *   `{phase}.{step}:{key}:model` | `{phase}.{step}:{key}:{tool}`
 * (see {@link runtimeModelCallId} / {@link runtimeToolCallId}).
 *
 * All call sites MUST build keys via {@link keyScope} / these helpers — no ad-hoc
 * string templates for durable keys.
 */

/** Join validated segments with `:`. */
export function joinKey(...segments: string[]): string {
  if (segments.length === 0) throw new Error('IdempotencyKey: joinKey requires at least one segment');
  return segments.map(assertSegment).join(':');
}

/** Parse a scope prefix (with or without trailing `:`) into a {@link KeyScope}. */
export function keyScope(prefix?: string): KeyScope {
  return KeyScope.parse(prefix);
}

/** A nested idempotency namespace; leaf methods return the final key string. */
export class KeyScope {
  private constructor(private readonly segments: readonly string[]) {}

  static parse(prefix?: string): KeyScope {
    if (prefix == null || prefix === '') return new KeyScope([]);
    const trimmed = prefix.replace(/^:+|:+$/g, '');
    if (!trimmed) return new KeyScope([]);
    return new KeyScope(trimmed.split(':').map(assertSegment));
  }

  static root(): KeyScope {
    return new KeyScope([]);
  }

  /** Append one or more scope segments (e.g. sub-agent name). */
  child(...segs: string[]): KeyScope {
    return new KeyScope([...this.segments, ...segs.map(assertSegment)]);
  }

  /** Reflection / multi-attempt scope: `a:{n}`. */
  attempt(n: number): KeyScope {
    return this.child('a', indexSeg(n));
  }

  /** Plan-step execution scope: `s:{n}`. */
  planStep(n: number): KeyScope {
    return this.child('s', indexSeg(n));
  }

  /** Prefix string suitable for `keyPrefix` / nesting (no trailing colon). */
  toPrefix(): string {
    return this.segments.join(':');
  }

  turnModel(turn: number): string {
    return this.leaf('t', indexSeg(turn));
  }

  turnTool(turn: number, callId: string): string {
    return this.leaf('t', indexSeg(turn), sanitizeCallId(callId));
  }

  compact(turn: number): string {
    return this.leaf('compact', indexSeg(turn));
  }

  retrieveOnce(): string {
    return this.leaf('retrieve', 'once');
  }

  retrieveRewrite(): string {
    return this.leaf('retrieve', 'rewrite');
  }

  plan(): string {
    return this.leaf('plan');
  }

  replan(n: number): string {
    return this.leaf('replan', indexSeg(n));
  }

  reflect(n: number): string {
    return this.leaf('reflect', indexSeg(n));
  }

  /**
   * Scratchpad write-time summary under the current scope (normally the tool
   * call key). Requires a non-empty scope — never invent a counter-based key.
   */
  scratchpadSummary(): string {
    if (this.segments.length === 0) {
      throw new Error('IdempotencyKey: scratchpadSummary requires a tool-call key scope');
    }
    return this.leaf('sp', 'sum');
  }

  private leaf(...segs: string[]): string {
    return joinKey(...this.segments, ...segs);
  }
}

/** Runtime envelope: model call idempotency id inside a workflow step. */
export function runtimeModelCallId(phase: string, step: string | number, key?: string): string {
  assertEnvelopePart(phase, 'phase');
  return `${phase}.${step}:${key ? `${key}:` : ''}model`;
}

/** Runtime envelope: tool call idempotency id inside a workflow step. */
export function runtimeToolCallId(phase: string, step: string | number, tool: string, key?: string): string {
  assertEnvelopePart(phase, 'phase');
  assertEnvelopePart(tool, 'tool');
  return `${phase}.${step}:${key ? `${key}:` : ''}${tool}`;
}

function assertSegment(s: string): string {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error(`IdempotencyKey: segment must be a non-empty string, got ${JSON.stringify(s)}`);
  }
  if (s.includes(':')) {
    throw new Error(`IdempotencyKey: segment must not contain ':': ${JSON.stringify(s)}`);
  }
  return s;
}

function indexSeg(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`IdempotencyKey: expected non-negative integer, got ${n}`);
  }
  return String(n);
}

/** Tool call ids from models must not break the `:` grammar. */
function sanitizeCallId(callId: string): string {
  if (typeof callId !== 'string' || callId.length === 0) {
    throw new Error(`IdempotencyKey: callId must be a non-empty string`);
  }
  return assertSegment(callId.replace(/:/g, '_'));
}

function assertEnvelopePart(s: string, label: string): void {
  if (typeof s !== 'string' || s.length === 0 || s.includes(':') || s.includes('.')) {
    throw new Error(`IdempotencyKey: invalid runtime ${label} ${JSON.stringify(s)}`);
  }
}

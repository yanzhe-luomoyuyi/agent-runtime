/**
 * B: circuit breaker — stop hammering a service that is already down.
 *
 * `withRetry` handles *individual* transient failures with backoff. But when a
 * provider is genuinely unhealthy (sustained 5xx, hard timeouts), retrying every
 * call still wastes time and piles load onto the failing service. A circuit
 * breaker short-circuits: after enough consecutive failures it "opens" and
 * fails fast (no call at all) for a cool-off window, then lets a single probe
 * through ("half-open") to see whether the service recovered.
 *
 *   closed  ──(failures ≥ threshold)──▶  open
 *   open    ──(resetTimeout elapsed)──▶  half_open
 *   half_open ──(probe succeeds)──────▶  closed
 *   half_open ──(probe fails)─────────▶  open
 *
 * This is deliberately a *primitive*: it wraps one `fn`. The resilient model
 * (fallback.ts) composes one breaker per tier; callers can also use it directly.
 *
 * State is in-memory by design — on a durable resume (fresh process) the breaker
 * starts closed again, which is the correct default: a new process should probe
 * the service rather than inherit a stale "open" verdict.
 */

/** The three breaker states (classic Nygard/Polly model). */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** Thrown when a call is rejected because the breaker is open (fail-fast). */
export class CircuitOpenError extends Error {
  constructor(
    /** Epoch-ms at which the breaker will next allow a probe. */
    readonly openUntil: number,
  ) {
    super(`Circuit is open until ${new Date(openUntil).toISOString()} — failing fast`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip the breaker open. Default 5. */
  failureThreshold?: number;
  /** Successful probes in half-open required to close again. Default 1. */
  successThreshold?: number;
  /** How long the breaker stays open before allowing a half-open probe (ms). Default 30_000. */
  resetTimeoutMs?: number;
  /**
   * Which errors count as failures toward tripping. Default: everything counts.
   * Use this to ignore client errors (4xx) that indicate a bad request rather
   * than an unhealthy service.
   */
  isFailure?: (err: unknown) => boolean;
  /** Clock seam — inject a fake clock in tests. Default `Date.now`. */
  now?: () => number;
  /** Observability hook fired on every state transition. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private halfOpenSuccesses = 0;
  private openUntil = 0;
  /** True while a half-open probe is in flight, so we admit only one probe. */
  private probing = false;

  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly isFailure: (err: unknown) => boolean;
  private readonly now: () => number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.successThreshold = opts.successThreshold ?? 1;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.isFailure = opts.isFailure ?? (() => true);
    this.now = opts.now ?? (() => Date.now());
    this.onStateChange = opts.onStateChange;
  }

  /** Current state (evaluates the open→half_open time transition lazily). */
  get currentState(): CircuitState {
    if (this.state === 'open' && this.now() >= this.openUntil) {
      this.transition('half_open');
    }
    return this.state;
  }

  /**
   * Run `fn` through the breaker.
   *  - open (still cooling): throws `CircuitOpenError` without calling `fn`.
   *  - half-open with a probe already in flight: throws `CircuitOpenError`.
   *  - otherwise: calls `fn`, recording success/failure to drive transitions.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;

    if (state === 'open') {
      throw new CircuitOpenError(this.openUntil);
    }
    if (state === 'half_open') {
      if (this.probing) throw new CircuitOpenError(this.openUntil);
      this.probing = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) this.onFailure();
      else this.onSuccess(); // a non-failure error still proves the service is reachable
      throw err;
    } finally {
      if (state === 'half_open') this.probing = false;
    }
  }

  /** Force the breaker back to a healthy closed state. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.halfOpenSuccesses = 0;
    this.openUntil = 0;
    this.probing = false;
    this.transition('closed');
  }

  private onSuccess(): void {
    if (this.state === 'half_open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) {
        this.consecutiveFailures = 0;
        this.transition('closed');
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    if (this.state === 'half_open' || this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = this.now() + this.resetTimeoutMs;
      this.transition('open');
    }
  }

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    if (to === 'half_open') this.halfOpenSuccesses = 0;
    this.onStateChange?.(from, to);
  }
}

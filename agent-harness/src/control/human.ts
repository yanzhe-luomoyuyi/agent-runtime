/**
 * D: human-in-the-loop approval.
 *
 * A seam the loop consults before running a tool.  Production deployments wire an
 * approver to a UI / chat prompt for destructive or side-effecting tools; tests
 * and headless runs use `autoApprove`.
 *
 * Improvements over the earlier version:
 *  - Approval with modifications: the human can edit tool arguments before
 *    approving (e.g. change "deploy prod" → "deploy staging").
 *  - Approval caching: `withApprovalCache` remembers recent approvals so the
 *    human isn't pestered for the same tool+args within a time window.
 *  - Audit trail: each decision records a timestamp so callers can log who
 *    approved what and when.
 *  - Pattern-based gating: `requireApprovalFor` supports glob-like patterns
 *    (e.g. `deploy*`, `write*`), not just exact tool-name matches.
 */

// ── Types ───────────────────────────────────────────────────────────

export interface ApprovalRequest {
  tool: string;
  args: unknown;
  callId: string;
  /** The current turn number (1-based), for context-aware approvals. */
  turn?: number;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  /**
   * When the human wants to approve but with modified arguments (e.g.
   * "deploy, but to staging not prod").  The loop uses these instead of the
   * original args when present.
   */
  modifiedArgs?: unknown;
  /**
   * How long (ms) this decision should be cached.  0 = this call only.
   * Set by `withApprovalCache` automatically; raw approvers can set it too.
   */
  cacheMs?: number;
  /** Unix-ms timestamp of this decision (audit trail). */
  decidedAt?: number;
}

export interface Approver {
  approve(req: ApprovalRequest): Promise<ApprovalDecision>;
}

// ── Built-in approvers ──────────────────────────────────────────────

/** Approve everything. The default — headless, non-interactive. */
export const autoApprove: Approver = {
  approve: async () => ({ approved: true, decidedAt: Date.now() }),
};

/** Deny everything, with an optional reason. Useful for tests and lockdown modes. */
export function denyAll(reason = 'denied by policy'): Approver {
  return {
    approve: async () => ({ approved: false, reason, decidedAt: Date.now() }),
  };
}

/**
 * Gate named (sensitive) tools through `delegate`; auto-approve the rest.
 * `sensitiveTools` supports exact names and trailing-`*` glob patterns.
 *
 * @example
 * ```ts
 * requireApprovalFor(['deploy*', 'delete*', 'publish'], humanApprover)
 * ```
 */
export function requireApprovalFor(sensitive: string[], delegate: Approver): Approver {
  const exact = new Set(sensitive.filter((p) => !p.endsWith('*')));
  const prefixes = sensitive.filter((p) => p.endsWith('*')).map((p) => p.slice(0, -1));

  const isSensitive = (tool: string): boolean => {
    if (exact.has(tool)) return true;
    return prefixes.some((prefix) => tool.startsWith(prefix));
  };

  return {
    approve: async (req) =>
      isSensitive(req.tool) ? delegate.approve(req) : { approved: true, decidedAt: Date.now() },
  };
}

// ── Approval cache ──────────────────────────────────────────────────

interface CachedDecision {
  tool: string;
  argsKey: string; // stable JSON for matching
  decision: ApprovalDecision;
  expiresAt: number;
}

/**
 * Wrap an approver with a time-based cache.  After the human approves a tool
 * with specific args, subsequent identical calls within `defaultCacheMs` are
 * auto-approved without asking.
 *
 * The cache key is `tool + stableJSON(args)`, so "deploy({env:'prod'})" and
 * "deploy({env:'staging'})" are treated as different requests.
 *
 * @param delegate   The real (human) approver.
 * @param defaultCacheMs  Default cache duration (ms).  Can be overridden per-call
 *                        by the delegate returning `cacheMs` on the decision.
 */
export function withApprovalCache(delegate: Approver, defaultCacheMs = 300_000): Approver {
  const cache = new Map<string, CachedDecision>();

  return {
    approve: async (req) => {
      const argsKey = stableKey(req.args);
      const cacheKey = `${req.tool}:${argsKey}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return { ...cached.decision, decidedAt: Date.now() };
      }

      const decision = await delegate.approve(req);
      const cacheMs = decision.cacheMs ?? defaultCacheMs;

      if (decision.approved && cacheMs > 0) {
        cache.set(cacheKey, {
          tool: req.tool,
          argsKey,
          decision,
          expiresAt: Date.now() + cacheMs,
        });
      }

      return { ...decision, decidedAt: decision.decidedAt ?? Date.now() };
    },
  };
}

/** Simple stable serialisation for cache key matching (sorted keys, no whitespace). */
function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value, Object.keys(value as object).sort());
  } catch {
    return String(value);
  }
}

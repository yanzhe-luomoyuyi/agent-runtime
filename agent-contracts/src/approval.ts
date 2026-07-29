/**
 * Tool-level human-in-the-loop approval — shared types only.
 *
 * Implementations (`autoApprove`, `requireApprovalFor`, `countingApprover`, …)
 * live in `@agent/harness`. The durable runtime eval/scorers only need these
 * shapes so the platform layer does not import the harness package.
 */

export interface ApprovalRequest {
  tool: string;
  args: unknown;
  callId: string;
  /** Current turn number (1-based), for context-aware approvals. */
  turn?: number;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  /**
   * When the human approves with edited arguments (e.g. deploy staging not prod).
   * The loop uses these instead of the original args when present.
   */
  modifiedArgs?: unknown;
  /**
   * How long (ms) this decision should be cached. 0 = this call only.
   * Set by cache wrappers; raw approvers can set it too.
   */
  cacheMs?: number;
  /** Unix-ms timestamp of this decision (audit trail). */
  decidedAt?: number;
}

export interface Approver {
  approve(req: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Running counts from a counting approver wrapper — used by eval scorers. */
export interface ApprovalStats {
  /** Total `approve()` calls made through the wrapped approver. */
  requested: number;
  /** Decisions where `approved` was true. */
  approved: number;
  /** Decisions where `approved` was false. */
  denied: number;
}

/**
 * D: human-in-the-loop approval.
 *
 * A seam the loop consults before running a tool. Production deployments wire an
 * approver to a UI / chat prompt for destructive or side-effecting tools; tests
 * and headless runs use `autoApprove`. `requireApprovalFor` gates only a named
 * set of sensitive tools and waves everything else through.
 */

export interface ApprovalRequest {
  tool: string;
  args: unknown;
  callId: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

export interface Approver {
  approve(req: ApprovalRequest): Promise<ApprovalDecision>;
}

/** Approve everything. The default — headless, non-interactive. */
export const autoApprove: Approver = {
  approve: async () => ({ approved: true }),
};

/** Deny everything, with an optional reason. Useful for tests and lockdown modes. */
export function denyAll(reason = 'denied by policy'): Approver {
  return { approve: async () => ({ approved: false, reason }) };
}

/** Gate only the named (sensitive) tools through `delegate`; auto-approve the rest. */
export function requireApprovalFor(sensitiveTools: string[], delegate: Approver): Approver {
  const sensitive = new Set(sensitiveTools);
  return {
    approve: async (req) => (sensitive.has(req.tool) ? delegate.approve(req) : { approved: true }),
  };
}

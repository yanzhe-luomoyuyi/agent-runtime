/**
 * Promise-based Approver for the Workbench: emit needs_input, wait for POST approve.
 */

import type { ApprovalDecision, ApprovalRequest, Approver } from '@agent/contracts';

export interface UiApprovalPending {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

/** Default HITL wait — avoid hanging the agent loop forever if the UI never responds. */
export const DEFAULT_UI_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export function createUiApprover(deps: {
  onRequest: (req: ApprovalRequest) => void;
  registerPending: (pending: UiApprovalPending) => void;
  clearPending: (callId: string) => void;
  /** Reject with approved:false after this many ms. Default 5 minutes. */
  timeoutMs?: number;
}): Approver {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_UI_APPROVAL_TIMEOUT_MS;
  return {
    async approve(req: ApprovalRequest): Promise<ApprovalDecision> {
      deps.onRequest(req);
      return new Promise<ApprovalDecision>((resolve) => {
        let settled = false;
        const settle = (decision: ApprovalDecision) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          deps.clearPending(req.callId);
          resolve(decision);
        };
        const timer = setTimeout(() => {
          settle({
            approved: false,
            reason: `approval timed out after ${timeoutMs}ms`,
            decidedAt: Date.now(),
          });
        }, timeoutMs);
        deps.registerPending({
          request: req,
          resolve: settle,
        });
      });
    },
  };
}

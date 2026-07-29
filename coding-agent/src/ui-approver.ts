/**
 * Promise-based Approver for the Workbench: emit needs_input, wait for POST approve.
 */

import type { ApprovalDecision, ApprovalRequest, Approver } from '@agent/contracts';

export interface UiApprovalPending {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

export function createUiApprover(deps: {
  onRequest: (req: ApprovalRequest) => void;
  registerPending: (pending: UiApprovalPending) => void;
  clearPending: (callId: string) => void;
}): Approver {
  return {
    async approve(req: ApprovalRequest): Promise<ApprovalDecision> {
      deps.onRequest(req);
      return new Promise<ApprovalDecision>((resolve) => {
        deps.registerPending({
          request: req,
          resolve: (decision) => {
            deps.clearPending(req.callId);
            resolve(decision);
          },
        });
      });
    },
  };
}

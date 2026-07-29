/**
 * Policy funnel helpers — check → record PolicyDenied → throw.
 *
 * Runtime wires these at the single callModel/callTool seam; the PolicyEnforcer
 * owns the checks, this module owns the audit-event boilerplate.
 */

import type { AgentEvent } from '../types.js';
import { PolicyViolationError, type PolicyEnforcer } from '../policy.js';

type RecordFn = (event: AgentEvent) => void;

function now(): string {
  return new Date().toISOString();
}

/** Deny a tool that is not on the policy allow-list (records the denial first). */
export function enforceToolAllowed(
  policy: PolicyEnforcer | undefined,
  tool: string,
  record: RecordFn,
): void {
  if (!policy) return;
  try {
    policy.checkTool(tool);
  } catch (e) {
    if (e instanceof PolicyViolationError) {
      record({ type: 'PolicyDenied', scope: 'tool', target: tool, code: e.code, reason: e.message, ts: now() });
    }
    throw e;
  }
}

/** Deny a tool call once its token bucket is exhausted (records the denial first). */
export function enforceRateLimit(
  policy: PolicyEnforcer | undefined,
  tool: string,
  record: RecordFn,
): void {
  if (!policy) return;
  try {
    policy.checkRateLimit(tool);
  } catch (e) {
    if (e instanceof PolicyViolationError) {
      record({ type: 'PolicyDenied', scope: 'tool', target: tool, code: e.code, reason: e.message, ts: now() });
    }
    throw e;
  }
}

/** Deny a model call once the cumulative cost budget is exhausted. */
export function enforceBudget(
  policy: PolicyEnforcer | undefined,
  spentUsd: number,
  callId: string,
  record: RecordFn,
): void {
  if (!policy) return;
  try {
    policy.checkBudget(spentUsd, callId);
  } catch (e) {
    if (e instanceof PolicyViolationError) {
      record({ type: 'PolicyDenied', scope: 'model', target: callId, code: e.code, reason: e.message, ts: now() });
    }
    throw e;
  }
}

/**
 * Pre-model guard: jailbreak + content checks on the raw prompt.
 * Records PolicyDenied on violation so blocked calls are auditable.
 */
export async function enforceContentSafety(
  policy: PolicyEnforcer,
  prompt: string,
  callId: string,
  record: RecordFn,
): Promise<void> {
  const jb = await policy.checkJailbreak(prompt);
  if (!jb.safe) {
    record({
      type: 'PolicyDenied',
      scope: 'model',
      target: callId,
      code: 'jailbreak',
      reason: `${jb.attackType ?? 'prompt_injection'}: ${jb.reason ?? 'jailbreak detected'}`,
      ts: now(),
    });
    throw new PolicyViolationError('jailbreak', 'model', callId, jb.reason ?? 'Prompt injection detected');
  }

  const cc = await policy.checkContent(prompt);
  if (!cc.safe) {
    record({
      type: 'PolicyDenied',
      scope: 'model',
      target: callId,
      code: 'content_safety',
      reason: `${cc.category ?? 'unsafe'}(severity=${cc.severity ?? '?'}): ${cc.reason ?? 'harmful content'}`,
      ts: now(),
    });
    throw new PolicyViolationError('content_safety', 'model', callId, cc.reason ?? 'Harmful content detected');
  }
}

/**
 * Post-model guard: check the model's response before it returns to the workflow.
 */
export async function enforceOutputSafety(
  policy: PolicyEnforcer,
  response: string,
  callId: string,
  record: RecordFn,
): Promise<void> {
  const oc = await policy.checkOutput(response);
  if (!oc.safe) {
    record({
      type: 'PolicyDenied',
      scope: 'model',
      target: callId,
      code: 'output_safety',
      reason: `${oc.category ?? 'unsafe'}: ${oc.reason ?? 'harmful output'}`,
      ts: now(),
    });
    throw new PolicyViolationError('output_safety', 'model', callId, oc.reason ?? 'Harmful model output detected');
  }
}

/**
 * Shared demo workload fixtures — one place for canned proposals and the
 * issue→fix trajectory answers used by both the fixed workflow mock and the
 * harness MockAgentModel. Keeps `AGENT_REGRESS` / eval expectations in sync.
 */

import { ToolRegistry } from '../tools/registry.js';

import { getIssue, searchCode } from './tools.js';

export const DEMO_PROPOSALS = {
  login: 'Guard against a null session in src/auth/login.ts before reading user.token.',
  button: 'Fix the conditional render in src/ui/Button.tsx so the component mounts.',
  regressed: 'Try turning it off and on again.',
  analyzeSummary:
    'Login crashes because the session can be null. Keywords: login, auth, session, null.',
} as const;

/** Pick a deterministic final answer from the user goal (harness mock brain). */
export function proposeForGoal(goal: string): string {
  if (/null|session|login|auth/i.test(goal)) return DEMO_PROPOSALS.login;
  if (/render|button|ui|component/i.test(goal)) return DEMO_PROPOSALS.button;
  return `Investigated and addressed: ${goal}`;
}

/** Canned fixed-workflow model replies keyed by step prompt tags. */
export function cannedResponses(opts?: { regress?: boolean }): Record<string, string> {
  const regress = opts?.regress ?? Boolean(process.env.AGENT_REGRESS);
  return {
    'analyze.summary': DEMO_PROPOSALS.analyzeSummary,
    'propose.fix': regress ? DEMO_PROPOSALS.regressed : DEMO_PROPOSALS.login,
  };
}

/** Register the demo issue-fix tools on a fresh (or provided) registry. */
export function registerDemoTools(registry: ToolRegistry = new ToolRegistry()): ToolRegistry {
  return registry.register(getIssue).register(searchCode);
}

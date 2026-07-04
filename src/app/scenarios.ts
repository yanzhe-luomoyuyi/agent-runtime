/**
 * Demo eval fixtures — scenarios and their expected outcomes for the issue-fix
 * agent. This is workload-specific business data (issues, expected files and
 * keywords); it is kept out of the generic eval harness (../eval.ts) so the
 * platform stays workload-agnostic. The scorers are composed from the harness.
 */

import {
  costUnderUsd,
  heuristicJudge,
  llmJudge,
  noPolicyViolations,
  noToolFailures,
  policyDenied,
  proposalContains,
  runCompleted,
  runFailedWith,
  touchedFile,
  type Scenario,
} from '../eval.js';

export const demoScenarios: Scenario[] = [
  {
    name: 'null-session login bug',
    issue: 'Login page crashes with a null session',
    checks: [
      runCompleted(),
      proposalContains('guard'),
      proposalContains('login.ts'),
      touchedFile('src/auth/login.ts'),
      llmJudge(heuristicJudge, 'the proposal addresses the bug with a concrete, file-specific fix'),
      costUnderUsd(0.01),
      noToolFailures(),
      noPolicyViolations(),
    ],
  },
  {
    name: 'button render bug',
    issue: 'Button does not render on the settings page',
    checks: [runCompleted(), touchedFile('src/ui/Button.tsx'), costUnderUsd(0.01), noToolFailures(), noPolicyViolations()],
  },
  {
    // Guardrail regression: a deliberately tiny budget must stop the agent mid-run.
    // Proves the declarative policy layer *enforces* (not just records) the budget.
    name: 'cost-budget guardrail halts a runaway agent',
    issue: 'Login page crashes with a null session',
    policy: { maxCostUsd: 0.000001 },
    checks: [runFailedWith('budget'), policyDenied()],
  },
];

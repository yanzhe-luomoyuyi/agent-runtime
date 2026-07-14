/**
 * Demo eval fixtures — scenarios and their expected outcomes for the issue-fix
 * agent. This is workload-specific business data (issues, expected files and
 * keywords); it is kept out of the generic eval harness (../eval.ts) so the
 * platform stays workload-agnostic. The scorers are composed from the harness.
 */

import { autoApprove, countingApprover, requireApprovalFor } from '@agent/harness';

import {
  costUnderUsd,
  heuristicJudge,
  heuristicTrajectoryJudge,
  humanInterventionRequested,
  humanInterventionsUnder,
  llmJudge,
  noPolicyViolations,
  noToolFailures,
  policyDenied,
  proposalContains,
  runCompleted,
  runFailedWith,
  toolSuccessRate,
  touchedFile,
  trajectoryJudge,
  turnsUnder,
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
      toolSuccessRate(1),
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
  {
    // Process/trajectory eval: drives the @agent/harness model-driven loop
    // (not the fixed workflow), so `turnsUnder` and the tool-call SEQUENCE
    // (not just the final proposal) can be graded.
    name: 'harness run: bounded turns and a sensible tool trajectory',
    issue: 'Login page crashes with a null session',
    harness: true,
    checks: [
      runCompleted(),
      turnsUnder(6),
      toolSuccessRate(1),
      trajectoryJudge(heuristicTrajectoryJudge, 'the agent fetches the issue before searching code, with no redundant repeats'),
    ],
  },
  (() => {
    // Human-in-the-loop metric: gate `searchCode` behind an approver and prove
    // the gate actually fires — `humanInterventionRequested` reads the live
    // `ApprovalStats` object populated by THIS scenario's own run.
    const { approver: countedHuman, stats } = countingApprover(autoApprove);
    return {
      name: 'harness run: sensitive tool requires human approval',
      issue: 'Login page crashes with a null session',
      harness: true,
      approver: requireApprovalFor(['searchCode'], countedHuman),
      checks: [runCompleted(), humanInterventionRequested(stats, 1), humanInterventionsUnder(stats, 1)],
    } satisfies Scenario;
  })(),
];

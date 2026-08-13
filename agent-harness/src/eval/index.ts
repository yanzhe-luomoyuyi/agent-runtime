/**
 * @agent/harness eval — L2 harness-loop evaluation (Scenario / Scorer over
 * AgentTrace). Host-agnostic: scripted model + MockToolInvoker; no durable
 * runtime. See `defaultHarnessScenarios` for the built-in CI suite.
 */

export type {
  AssembleScenario,
  CheckResult,
  CompactScenario,
  EvalReport,
  LoopScenario,
  Scenario,
  ScenarioResult,
  ScoreContext,
  Scorer,
} from './types.js';

export {
  afterAssembleDropsToolCallId,
  afterAssembleKeepsToolCallId,
  afterCompactDropsToolCallId,
  afterCompactKeepsToolCallId,
  answerContains,
  assembleBudgetRespected,
  assembleRespectsBudgetGate,
  assembleShrinksWhenOverBudget,
  assembleTriggered,
  check,
  compactOutcomeIs,
  compactProtectedUnitsAtLeast,
  compactReasonIs,
  compactRemovedToolResultsAtLeast,
  costUnderUsd,
  humanInterventionRequested,
  humanInterventionsUnder,
  importanceScoringIs,
  messageContentIncludes,
  noMessageContentIncludes,
  noToolFailures,
  pinnedRecentSurvives,
  recalledAfterEviction,
  retrievalMessageCountIs,
  retrievalStaysUntrusted,
  runFinished,
  scratchpadNotOffloaded,
  scratchpadOffloaded,
  stopReasonIs,
  toolResultsUntrusted,
  toolSuccessRate,
  toolsUsedEquals,
  toolsUsedIncludes,
  turnsUnder,
} from './scorers.js';

export { renderHarnessReport, runHarnessEval } from './runner.js';

export {
  assembleAblationMessages,
  charTokenizer,
  compactProtectMessages,
  demoBigRead,
  demoDeploy,
  demoGetIssue,
  demoReadFile,
  demoSearchCode,
  makeAssembleContext,
  makeCompactContext,
  summarizerChatModel,
} from './fixtures.js';

export { defaultHarnessScenarios } from './scenarios.js';

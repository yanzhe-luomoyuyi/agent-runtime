/**
 * coding-agent eval scenarios — scores the harness-hosted agent loop against
 * real bug-fixture workspaces using deterministic scripted models (no network).
 */

import {
  costUnderUsd,
  noPolicyViolations,
  noToolFailures,
  policyDenied,
  runCompleted,
  runFailedWith,
  toolSuccessRate,
  turnsUnder,
  type ChatModelProvider,
  type Scenario,
  type ScoreContext,
  type Scorer,
} from 'durable-agent-runtime';

import { finalTurn, ScriptedChatProvider, toolTurn } from '../model/scripted-chat.js';
import { bugCases, GREETER_BUG, type BugCase } from './fixtures.js';

const EDIT_TOOLS = new Set(['write_file', 'str_replace', 'apply_patch', 'delete_file']);

/** Did an editing tool call (write_file / str_replace / apply_patch / delete_file) target `path`? */
export const editedFile = (path: string): Scorer => (ctx: ScoreContext) => {
  const result = ctx.state.stepOutputs['agent.1'] as
    | { messages?: Array<{ toolCalls?: Array<{ name: string; arguments: unknown }> }> }
    | undefined;
  const calls = (result?.messages ?? []).flatMap((m) => m.toolCalls ?? []);
  const hit = calls.find(
    (c) => EDIT_TOOLS.has(c.name) && (c.arguments as { path?: string } | undefined)?.path === path,
  );
  return {
    name: `edited ${path}`,
    passed: Boolean(hit),
    detail: hit ? `${hit.name}(path=${path})` : `no write_file/str_replace/apply_patch/delete_file call touched ${path}`,
  };
};

/**
 * Objective ground truth: did the agent's own `run_tests` call actually turn
 * the fixture's failing test green? Catches "the model claims the fix works"
 * without any real code change — string-matching the final answer can't.
 */
export const testsPass = (): Scorer => (ctx: ScoreContext) => {
  const result = ctx.state.stepOutputs['agent.1'] as
    | { messages?: Array<{ role: string; name?: string; content?: string | null }> }
    | undefined;
  const runs = (result?.messages ?? []).filter((m) => m.role === 'tool' && m.name === 'run_tests');
  const last = runs[runs.length - 1];
  if (!last?.content) {
    return { name: 'run_tests passes (red \u2192 green)', passed: false, detail: 'run_tests was never called' };
  }
  try {
    const parsed = JSON.parse(last.content) as { ok?: boolean; exitCode?: number | null };
    return {
      name: 'run_tests passes (red \u2192 green)',
      passed: parsed.ok === true,
      detail: `exitCode=${parsed.exitCode}`,
    };
  } catch {
    return { name: 'run_tests passes (red \u2192 green)', passed: false, detail: 'run_tests result was not JSON' };
  }
};

export const GUARDRAIL_SCENARIO_NAME = 'cost-budget guardrail halts a runaway agent';

function scenarioForBug(bug: BugCase): Scenario {
  return {
    name: bug.name,
    issue: bug.goal,
    checks: [
      runCompleted(),
      editedFile(bug.srcPath),
      testsPass(),
      noToolFailures(),
      toolSuccessRate(1),
      costUnderUsd(0.01),
      noPolicyViolations(),
      turnsUnder(6),
    ],
  };
}

export const codingScenarios: Scenario[] = [
  ...bugCases.map(scenarioForBug),
  {
    // Guardrail regression: a deliberately tiny budget must stop the agent
    // mid-run — proves the declarative policy layer *enforces* the budget,
    // not just records it.
    name: GUARDRAIL_SCENARIO_NAME,
    issue: GREETER_BUG.goal,
    policy: { maxCostUsd: 0.000001 },
    checks: [runFailedWith('budget'), policyDenied()],
  },
];

const bugByScenarioName = new Map(bugCases.map((b) => [b.name, b]));

/** Good script: reads the file first, applies the exact fix, then verifies with run_tests. */
function goodModelFor(bug: BugCase): ChatModelProvider {
  return new ScriptedChatProvider([
    toolTurn([{ name: 'read_file', arguments: { path: bug.srcPath } }]),
    toolTurn([{ name: 'str_replace', arguments: { path: bug.srcPath, old_string: bug.fix.oldString, new_string: bug.fix.newString } }]),
    toolTurn([{ name: 'run_tests', arguments: {} }]),
    finalTurn(`Fixed ${bug.srcPath} and verified with run_tests.`),
  ]);
}

/** Regressed script: guesses a fix without reading the file — old_string never matches, so str_replace throws. */
function regressedModelFor(bug: BugCase): ChatModelProvider {
  return new ScriptedChatProvider([
    toolTurn([{ name: 'str_replace', arguments: { path: bug.srcPath, old_string: '__REGRESSED_MISMATCH__', new_string: 'x' } }]),
    finalTurn('Fixed it.'),
  ]);
}

/** Scripted model for a scenario by name — falls back to the greeter script for the guardrail scenario. */
export function chatModelForEval(scenarioName: string, regressed: boolean): ChatModelProvider {
  const bug = bugByScenarioName.get(scenarioName) ?? GREETER_BUG;
  return regressed ? regressedModelFor(bug) : goodModelFor(bug);
}


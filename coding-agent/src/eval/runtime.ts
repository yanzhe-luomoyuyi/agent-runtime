/**
 * Eval runtime factory — builds a fresh bug-fixture workspace + scripted
 * model per scenario, reusing the same `createCodingRuntime` assembly path
 * as `run`/`resume` (same tools, policy, harness workflow).
 */

import { autoApprove } from '@agent/harness';
import type { Runtime, Scenario } from 'durable-agent-runtime';

import { loadCodingConfig } from '../config.js';
import { createCodingRuntime } from '../runtime-factory.js';
import { bugCases, createFixtureWorkspace, GREETER_BUG } from './fixtures.js';
import { chatModelForEval } from './scenarios.js';

export interface EvalRuntimeOptions {
  /** Use the regressed scripted model (guesses a fix without reading the file first). Default false. */
  regressed?: boolean;
}

/** Returns a `buildRuntime` callback suitable for `runEval(scenarios, ...)`. */
export function makeEvalRuntimeBuilder(opts: EvalRuntimeOptions = {}) {
  const cfg = loadCodingConfig({ skipEnv: true });
  return function buildEvalRuntime(baseDir: string, scenario: Scenario): Runtime {
    const bug = bugCases.find((b) => b.name === scenario.name) ?? GREETER_BUG;
    return createCodingRuntime({
      baseDir,
      workspaceRoot: createFixtureWorkspace(bug),
      chatModel: chatModelForEval(scenario.name, opts.regressed ?? false),
      approver: autoApprove,
      autoApproveWrites: true,
      policy: scenario.policy,
      config: cfg,
      maxTurns: 8,
    });
  };
}


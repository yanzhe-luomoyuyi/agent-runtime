/**
 * Eval runtime factory — builds a fresh bug-fixture workspace + scripted
 * model per scenario, reusing the same `createCodingRuntime` assembly path
 * as `run`/`resume` (same tools, policy, harness workflow).
 */

import { autoApprove } from '@agent/harness';
import type { Runtime, Scenario } from 'durable-agent-runtime';

import { loadCodingConfig } from '../config.js';
import { chatProviderFromEnv } from '../model/openai-compatible.js';
import { createCodingRuntime } from '../runtime-factory.js';
import { bugCases, createFixtureWorkspace, GREETER_BUG } from './fixtures.js';
import { chatModelForEval } from './scenarios.js';

export interface EvalRuntimeOptions {
  /** Use the regressed scripted model (guesses a fix without reading the file first). Default false. */
  regressed?: boolean;
  /**
   * Use the real configured chat provider (e.g. DeepSeek) instead of a
   * scripted model — tests actual prompt/skill capability, not just harness
   * wiring. Needs network + a valid API key; costs money; non-deterministic.
   * Never enabled by default (see `AGENT_EVAL_LIVE` in the CLI).
   */
  live?: boolean;
}

/** Returns a `buildRuntime` callback suitable for `runEval(scenarios, ...)`. */
export function makeEvalRuntimeBuilder(opts: EvalRuntimeOptions = {}) {
  const cfg = loadCodingConfig({ skipEnv: true });
  return function buildEvalRuntime(baseDir: string, scenario: Scenario): Runtime {
    const bug = bugCases.find((b) => b.name === scenario.name) ?? GREETER_BUG;
    const chatModel = opts.live
      ? chatProviderFromEnv(process.env, {
          baseUrl: cfg.model.baseUrl,
          model: cfg.model.model,
          apiKeyEnv: cfg.model.apiKeyEnv,
          apiKeyEnvFallbacks: cfg.model.apiKeyEnvFallbacks,
          baseUrlEnv: cfg.model.baseUrlEnv,
          modelEnv: cfg.model.modelEnv,
          providerName: cfg.model.provider,
          fallbacks: cfg.model.fallbacks,
        })
      : chatModelForEval(scenario.name, opts.regressed ?? false);
    if (!chatModel) {
      throw new Error(`AGENT_EVAL_LIVE=1 requires ${cfg.model.apiKeyEnv} to be set (or an apiKeyEnvFallbacks entry).`);
    }
    return createCodingRuntime({
      baseDir,
      workspaceRoot: createFixtureWorkspace(bug),
      chatModel,
      approver: autoApprove,
      autoApproveWrites: true,
      policy: scenario.policy,
      config: cfg,
      maxTurns: opts.live ? 20 : 8,
    });
  };
}



/**
 * CLI entrypoint.
 *
 *   agent run "<issue text>"     Start a new run.
 *   agent resume <runId>         Continue an interrupted run from its event log.
 *   agent status <runId>         Print the derived state of a run.
 *
 * Set CRASH_AFTER=<stepId> (e.g. CRASH_AFTER=locate.1) to inject a crash and
 * demo resume. Run logs live under AGENT_RUNS_DIR (default: .agent-runs).
 */

import { existsSync, readFileSync } from 'node:fs';

import { demoScenarios, renderReport, runEval } from './eval.js';
import { CachingModelProvider, FileResponseCache } from './model/caching.js';
import { MockModelProvider } from './model/provider.js';
import { DEFAULT_PRICING, type ModelPricing } from './pricing.js';
import { Runtime } from './runtime.js';
import { getIssue, searchCode } from './tools/builtins.js';
import { ToolRegistry } from './tools/registry.js';
import { renderTimeline } from './trace.js';
import type { RunState } from './types.js';
import { issueWorkflow } from './workflow.js';

const BASE_DIR = process.env.AGENT_RUNS_DIR ?? '.agent-runs';

/** Load token pricing from agent.config.json (or $AGENT_CONFIG), falling back to defaults. */
function loadPricing(): ModelPricing {
  const path = process.env.AGENT_CONFIG ?? 'agent.config.json';
  if (existsSync(path)) {
    try {
      const cfg = JSON.parse(readFileSync(path, 'utf8')) as { pricing?: Partial<ModelPricing> };
      return { ...DEFAULT_PRICING, ...cfg.pricing };
    } catch {
      // malformed config — fall back to defaults
    }
  }
  return DEFAULT_PRICING;
}

function cannedResponses(): Record<string, string> {
  return {
    'analyze.summary': 'Login crashes because the session can be null. Keywords: login, auth, session, null.',
    // AGENT_REGRESS simulates a prompt/model change that degrades the output.
    'propose.fix': process.env.AGENT_REGRESS
      ? 'Try turning it off and on again.'
      : 'Guard against a null session in src/auth/login.ts before reading user.token.',
  };
}

/** Evals build a fresh, un-cached model so a stale response cache can't mask a regression. */
function buildEvalRuntime(baseDir: string): Runtime {
  const tools = new ToolRegistry().register(getIssue).register(searchCode);
  return new Runtime({ baseDir, model: new MockModelProvider(cannedResponses()), tools, workflow: issueWorkflow, pricing: loadPricing() });
}

function makeRuntime(baseDir: string = BASE_DIR): Runtime {
  const model = new CachingModelProvider(
    new MockModelProvider(cannedResponses()),
    new FileResponseCache(process.env.AGENT_CACHE ?? '.agent-cache.json'),
  );
  const tools = new ToolRegistry().register(getIssue).register(searchCode);
  return new Runtime({
    baseDir,
    model,
    tools,
    workflow: issueWorkflow,
    pricing: loadPricing(),
    crashAfter: process.env.CRASH_AFTER,
    onEvent: (event) => {
      if (event.type === 'RunStarted') process.stderr.write(`\u25b6 run ${event.runId}\n`);
      else if (event.type === 'ToolCallSucceeded') process.stderr.write(`  \u00b7 tool ${event.tool} \u2192 ok\n`);
      else if (event.type === 'StepCompleted') process.stderr.write(`  \u2713 ${event.stepId}\n`);
      else if (event.type === 'PhaseCompleted') process.stderr.write(`\u2713 phase ${event.phase}\n`);
    },
  });
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  const runtime = makeRuntime();

  switch (command) {
    case 'run': {
      const state = await runtime.run(arg ?? 'Login page crashes with a null session');
      printResult(state);
      break;
    }
    case 'resume': {
      if (!arg) throw new Error('Usage: agent resume <runId>');
      printResult(await runtime.resume(arg));
      break;
    }
    case 'status': {
      if (!arg) throw new Error('Usage: agent status <runId>');
      printResult(runtime.status(arg));
      break;
    }
    case 'recover': {
      const recovered = await runtime.recover();
      if (recovered.length === 0) process.stdout.write('No interrupted runs to recover.\n');
      for (const r of recovered) {
        if (r.conflict) process.stdout.write(`~ ${r.runId} skipped (another worker owns it)\n`);
        else process.stdout.write(`\u2713 ${r.runId} \u2192 ${r.state!.status}\n`);
      }
      break;
    }
    case 'trace': {
      if (!arg) throw new Error('Usage: agent trace <runId>');
      process.stdout.write(renderTimeline(runtime.trace(arg)) + '\n');
      break;
    }
    case 'eval': {
      const report = await runEval(demoScenarios, buildEvalRuntime);
      process.stdout.write(renderReport(report) + '\n');
      process.exitCode = report.allPassed ? 0 : 1;
      break;
    }
    default:
      process.stdout.write('Usage: agent <run|resume|status|recover|trace|eval> [issue|runId]\n');
      process.exit(1);
  }
}

function printResult(state: RunState): void {
  process.stdout.write(`\n=== Run ${state.runId} \u2192 ${state.status} ===\n`);
  for (const [name, phase] of Object.entries(state.phases)) {
    process.stdout.write(`  ${name.padEnd(10)} ${phase.status.padEnd(12)} steps=[${phase.stepsCompleted.join(',')}]\n`);
  }
  const summary = state.summary as { proposal?: string; files?: string[] } | undefined;
  if (summary?.proposal) {
    process.stdout.write(`\nProposal: ${summary.proposal}\n`);
    if (summary.files?.length) process.stdout.write(`Files:    ${summary.files.join(', ')}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\n\u2716 ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

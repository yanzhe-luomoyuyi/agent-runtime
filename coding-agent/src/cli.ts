/**
 * coding-agent CLI — independent of durable-agent-runtime's demo CLI.
 *
 *   coding-agent "<goal>"
 *   coding-agent --workspace <path> "<goal>"
 *   coding-agent resume <runId>
 *   coding-agent status <runId>
 *   coding-agent trace <runId>
 */

import type { RunState } from 'durable-agent-runtime';
import { extractAnswer, renderTimeline } from 'durable-agent-runtime';
import { join } from 'node:path';

import { parseArgs } from './cli-args.js';
import { loadEnvFile } from './load-env.js';
import { createCodingRuntime, loadCodingConfigFile, PACKAGE_ROOT, resolveWorkspaceRoot } from './runtime-factory.js';

loadEnvFile(join(PACKAGE_ROOT, '.env'));
loadEnvFile(join(PACKAGE_ROOT, '.env.local'));

const BASE_DIR = process.env.AGENT_RUNS_DIR ?? '.coding-agent-runs';

async function main(): Promise<void> {
  const { workspace: workspaceFlag, args } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(workspaceFlag);

  if (cmd === 'resume' || cmd === 'status' || cmd === 'trace') {
    const runId = rest[0];
    if (!runId) throw new Error(`${cmd} requires <runId>`);
    const rt = buildRuntime(workspaceRoot);
    if (cmd === 'status') {
      console.log(JSON.stringify(rt.status(runId), null, 2));
      return;
    }
    if (cmd === 'trace') {
      console.log(renderTimeline(rt.trace(runId)));
      return;
    }
    printResult(await rt.resume(runId));
    return;
  }

  const goalParts = cmd === 'run' ? rest : [cmd, ...rest];
  const goal = goalParts.join(' ').trim();
  if (!goal) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  process.stderr.write(`▶ coding-agent workspace=${workspaceRoot}\n`);
  printResult(await buildRuntime(workspaceRoot).run(goal));
}

function buildRuntime(workspaceRoot: string) {
  const cfg = loadCodingConfigFile();
  return createCodingRuntime({
    baseDir: BASE_DIR,
    workspaceRoot,
    pricing: cfg.pricing,
    policy: cfg.policy,
    maxTurns: numFromEnv('AGENT_MAX_TURNS'),
    crashAfterTurn: numFromEnv('HARNESS_CRASH_TURN'),
    onEvent: (e) => {
      if (e.type === 'RunStarted') process.stderr.write(`▶ run ${e.runId}\n`);
      if (e.type === 'ToolCallSucceeded') process.stderr.write(`  ✓ ${e.tool}\n`);
      if (e.type === 'ToolCallFailed') process.stderr.write(`  ✗ ${e.tool}: ${e.error}\n`);
      if (e.type === 'RunCompleted') process.stderr.write(`✔ completed\n`);
      if (e.type === 'RunFailed') process.stderr.write(`✖ failed: ${e.error}\n`);
    },
  });
}

function printResult(state: RunState): void {
  console.log(`runId: ${state.runId}`);
  console.log(`status: ${state.status}`);
  if (state.error) console.log(`error: ${state.error}`);
  const answer = extractAnswer(state);
  if (answer) console.log(`\n${answer}\n`);
  else if (state.summary) console.log(JSON.stringify(state.summary, null, 2));
}

function numFromEnv(name: string): number | undefined {
  const v = process.env[name];
  return v ? Number(v) : undefined;
}

function printHelp(): void {
  console.log(`Usage:
  coding-agent "<goal>"
  coding-agent run "<goal>"
  coding-agent --workspace <path> "<goal>"
  coding-agent resume <runId>
  coding-agent status <runId>
  coding-agent trace <runId>

Flags:
  --workspace <path> / -W <path>   override workspace (else AGENT_WORKSPACE / fixture)

Env:
  DEEPSEEK_API_KEY      required for live model
  DEEPSEEK_MODEL        default deepseek-chat
  DEEPSEEK_BASE_URL     default https://api.deepseek.com
  AGENT_WORKSPACE       default: package fixtures/coding-sandbox
  AGENT_AUTO_APPROVE=1  skip write_file approval prompts
  AGENT_RUNS_DIR        default .coding-agent-runs
  AGENT_MAX_TURNS / HARNESS_CRASH_TURN
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

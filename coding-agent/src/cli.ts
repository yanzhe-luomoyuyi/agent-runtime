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
import { loadCodingConfig } from './config.js';
import { createCodingRuntime, PACKAGE_ROOT, resolveWorkspaceRoot } from './runtime-factory.js';

loadEnvFile(join(PACKAGE_ROOT, '.env'));
loadEnvFile(join(PACKAGE_ROOT, '.env.local'));

async function main(): Promise<void> {
  const { workspace: workspaceFlag, args } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  const cfg = loadCodingConfig();
  const workspaceRoot = resolveWorkspaceRoot(workspaceFlag, process.env, cfg);

  if (cmd === 'resume' || cmd === 'status' || cmd === 'trace') {
    const runId = rest[0];
    if (!runId) throw new Error(`${cmd} requires <runId>`);
    const rt = buildRuntime(workspaceRoot, cfg);
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
  let streamedAnswer = false;
  let thinkingHeader = false;
  const state = await buildRuntime(workspaceRoot, cfg, {
    onThinkingToken: (token) => {
      if (!thinkingHeader) {
        process.stderr.write('thinking:\n');
        thinkingHeader = true;
      }
      process.stderr.write(token);
    },
    onModelToken: (token) => {
      if (thinkingHeader && !streamedAnswer) {
        process.stderr.write('\n');
        process.stdout.write('\n');
      }
      process.stdout.write(token);
      streamedAnswer = true;
    },
  }).run(goal);
  if (thinkingHeader && !streamedAnswer) process.stderr.write('\n');
  if (streamedAnswer) process.stdout.write('\n');
  printResult(state, { skipAnswer: streamedAnswer });
}

function buildRuntime(
  workspaceRoot: string,
  cfg = loadCodingConfig(),
  stream?: {
    onModelToken?: (token: string) => void;
    onThinkingToken?: (token: string) => void;
  },
) {
  return createCodingRuntime({
    baseDir: cfg.run.runsDir,
    workspaceRoot,
    config: cfg,
    pricing: cfg.pricing,
    policy: cfg.policy,
    maxTurns: cfg.run.maxTurns,
    crashAfterTurn: numFromEnv('HARNESS_CRASH_TURN'),
    onEvent: (e) => {
      if (e.type === 'RunStarted') process.stderr.write(`▶ run ${e.runId}\n`);
      if (e.type === 'ToolCallSucceeded') process.stderr.write(`  ✓ ${e.tool}\n`);
      if (e.type === 'ToolCallFailed') process.stderr.write(`  ✗ ${e.tool}: ${e.error}\n`);
      if (e.type === 'RunCompleted') process.stderr.write(`✔ completed\n`);
      if (e.type === 'RunFailed') process.stderr.write(`✖ failed: ${e.error}\n`);
    },
    onStreamEvent:
      stream?.onModelToken || stream?.onThinkingToken
        ? (e) => {
            if (e.type === 'model_token') stream.onModelToken?.(e.token);
            if (e.type === 'thinking_token') stream.onThinkingToken?.(e.token);
          }
        : undefined,
  });
}

function printResult(state: RunState, opts?: { skipAnswer?: boolean }): void {
  console.log(`runId: ${state.runId}`);
  console.log(`status: ${state.status}`);
  if (state.error) console.log(`error: ${state.error}`);
  if (opts?.skipAnswer) return;
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
  --workspace <path> / -W <path>   override workspace (else AGENT_WORKSPACE / config)

Config:
  agent.config.json   unified defaults (agent / model / workspace / tools / run / policy / pricing)
  AGENT_CONFIG        path override for that file

Env (override config):
  DEEPSEEK_API_KEY      required for live model
  DEEPSEEK_MODEL        default from config (deepseek-chat)
  DEEPSEEK_BASE_URL     default from config
  AGENT_WORKSPACE       default workspace root
  AGENT_AUTO_APPROVE=1  skip mutating FS tool approval prompts
  AGENT_LONG_TERM_MEMORY=1|0  enable/disable memory_* tools (cross-session FileMemoryStore)
  AGENT_MEMORY_DIR      memory store directory (default .coding-agent-memory)
  AGENT_LOOP_MODE       agent | planner | reflection (default agent)
  AGENT_RUNS_DIR        runs directory
  AGENT_MAX_TURNS / AGENT_MAX_PROMPT_TOKENS / HARNESS_CRASH_TURN
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

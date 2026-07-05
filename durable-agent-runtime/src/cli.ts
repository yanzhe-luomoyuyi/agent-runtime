/**
 * CLI entrypoint.
 *
 *   agent run "<issue text>"     Start a new run.
 *   agent resume <runId>         Continue an interrupted run from its event log.
 *   agent status <runId>         Print the derived state of a run.
 *   agent recover                Drive any interrupted runs to completion.
 *   agent trace <runId>          Print the run's timeline + token/cost/replay totals.
 *   agent eval                   Score the demo scenarios (exit 1 on regression).
 *
 * Set CRASH_AFTER=<stepId> (e.g. CRASH_AFTER=locate.1) to inject a crash and
 * demo resume. Run logs live under AGENT_RUNS_DIR (default: .agent-runs).
 * Set AGENT_REGRESS=1 to degrade the propose step and demo an eval regression.
 * Set AGENT_LOOP=1 to run the in-runtime model-driven demo loop (src/agent-loop.ts)
 * instead of the fixed demo workflow; AGENT_LOOP_CRASH_TURN=<n> injects a mid-loop crash.
 * Set HARNESS=1 to run the standalone @agent/harness loop over the runtime seam
 * (src/app/harness-adapter.ts); HARNESS_CRASH_TURN=<n> injects a mid-loop crash.
 */

import { existsSync, readFileSync } from 'node:fs';

import { createAgentWorkflow } from './agent-loop.js';
import { MockAgentModel } from './app/agent-scenario.js';
import { createHarnessWorkflow } from './app/harness-adapter.js';
import { issueWorkflow } from './app/issue-workflow.js';
import { demoMcpServers } from './app/mcp-servers.js';
import { cannedResponses } from './app/responses.js';
import { demoScenarios } from './app/scenarios.js';
import { getIssue, searchCode } from './app/tools.js';
import { renderReport, runEval, type Scenario } from './eval.js';
import { registerMcpServer } from './mcp/adapter.js';
import { McpClient } from './mcp/client.js';
import { InMemoryTransport } from './mcp/transport.js';
import { TokenCache } from './mcp/token-cache.js';
import { CachingModelProvider, FileResponseCache } from './model/caching.js';
import { MockModelProvider } from './model/provider.js';
import { type Policy, resolveRedactions } from './policy.js';
import { DEFAULT_PRICING, type ModelPricing } from './pricing.js';
import { Runtime } from './runtime.js';
import { ToolRegistry } from './tools/registry.js';
import { renderTimeline } from './trace.js';
import type { AgentEvent, RunState } from './types.js';

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

/** Load declarative guardrails from agent.config.json (or $AGENT_CONFIG). */
function loadPolicy(): Policy | undefined {
  const path = process.env.AGENT_CONFIG ?? 'agent.config.json';
  if (!existsSync(path)) return undefined;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as {
      policy?: { allowedTools?: string[]; maxCostUsd?: number; redactions?: string[] };
    };
    if (!cfg.policy) return undefined;
    return {
      allowedTools: cfg.policy.allowedTools,
      maxCostUsd: cfg.policy.maxCostUsd,
      redactions: cfg.policy.redactions ? resolveRedactions(cfg.policy.redactions) : undefined,
    };
  } catch {
    return undefined; // malformed config — run without a policy rather than crash
  }
}

/**
 * Build the tool registry. Local by default; set AGENT_MCP=1 to source the SAME
 * demo tools through the shared MCP base SDK — one JSON-RPC client per server, all
 * sharing a single token cache — proving the runtime can't tell local from remote.
 */
async function buildTools(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  if (process.env.AGENT_MCP !== '1') {
    return registry.register(getIssue).register(searchCode);
  }
  const servers = demoMcpServers();
  const tokenCache = new TokenCache(() => ({ token: 'demo-token', expiresAtMs: Date.now() + 3_600_000 }));
  for (const server of servers) {
    const client = new McpClient({ serverName: server.name, transport: new InMemoryTransport(server.handle), tokenCache });
    await registerMcpServer(registry, client);
  }
  process.stderr.write(`\u25b6 tools via MCP base SDK \u2014 ${servers.length} servers sharing ${tokenCache.fetches} auth fetch\n`);
  return registry;
}

/**
 * Evals build a fresh, un-cached model so a stale response cache can't mask a
 * regression, and they exercise the SAME shared MCP base SDK + declarative policy
 * the CLI uses — so a broken tool path or mis-set guardrail is caught in CI. A
 * scenario may override the policy (e.g. to assert a budget guardrail fires).
 */
async function buildEvalRuntime(baseDir: string, scenario: Scenario): Promise<Runtime> {
  const tools = new ToolRegistry();
  const tokenCache = new TokenCache(() => ({ token: 'demo-token', expiresAtMs: Date.now() + 3_600_000 }));
  for (const server of demoMcpServers()) {
    await registerMcpServer(tools, new McpClient({ serverName: server.name, transport: new InMemoryTransport(server.handle), tokenCache }));
  }
  return new Runtime({
    baseDir,
    model: new MockModelProvider(cannedResponses()),
    tools,
    workflow: issueWorkflow,
    pricing: loadPricing(),
    policy: scenario.policy ?? loadPolicy(),
  });
}

async function makeRuntime(baseDir: string = BASE_DIR): Promise<Runtime> {
  const tools = await buildTools();

  // HARNESS=1 runs the standalone @agent/harness loop over the runtime seam: the
  // model drives, and the adapter forwards each turn's key to ctx.callModel/callTool
  // so the whole loop is durable, resumable, and idempotent. HARNESS_CRASH_TURN=<n>
  // injects a mid-loop crash to demo resume. (Set the same env on `resume`.)
  if (process.env.HARNESS === '1') {
    return new Runtime({
      baseDir,
      model: new MockAgentModel(),
      tools,
      workflow: createHarnessWorkflow({
        maxTurns: numFromEnv('AGENT_MAX_TURNS'),
        crashAfterTurn: numFromEnv('HARNESS_CRASH_TURN'),
      }),
      pricing: loadPricing(),
      policy: loadPolicy(),
      onEvent: agentOnEvent,
    });
  }

  // AGENT_LOOP=1 selects the in-runtime model-driven demo loop (src/agent-loop.ts)
  // instead of the fixed demo workflow. The model becomes the deterministic MockAgentModel,
  // which plays the tool-calling LLM's role offline. (Set the same env on `resume`.)
  if (process.env.AGENT_LOOP === '1') {
    const workflow = createAgentWorkflow({
      maxTurns: numFromEnv('AGENT_MAX_TURNS'),
      crashAfterTurn: numFromEnv('AGENT_LOOP_CRASH_TURN'),
    });
    return new Runtime({
      baseDir,
      model: new MockAgentModel(),
      tools,
      workflow,
      pricing: loadPricing(),
      policy: loadPolicy(),
      onEvent: agentOnEvent,
    });
  }

  const model = new CachingModelProvider(
    new MockModelProvider(cannedResponses()),
    new FileResponseCache(process.env.AGENT_CACHE ?? '.agent-cache.json'),
  );
  return new Runtime({
    baseDir,
    model,
    tools,
    workflow: issueWorkflow,
    pricing: loadPricing(),
    policy: loadPolicy(),
    crashAfter: process.env.CRASH_AFTER,
    onEvent: workflowOnEvent,
  });
}

function numFromEnv(name: string): number | undefined {
  const v = process.env[name];
  return v ? Number(v) : undefined;
}

/** Progress logging for the fixed demo workflow. */
function workflowOnEvent(event: AgentEvent): void {
  if (event.type === 'RunStarted') process.stderr.write(`\u25b6 run ${event.runId}\n`);
  else if (event.type === 'ToolCallSucceeded') process.stderr.write(`  \u00b7 tool ${event.tool} \u2192 ok\n`);
  else if (event.type === 'PolicyDenied') process.stderr.write(`  \u2716 policy denied ${event.scope} "${event.target}" (${event.code})\n`);
  else if (event.type === 'StepCompleted') process.stderr.write(`  \u2713 ${event.stepId}\n`);
  else if (event.type === 'PhaseCompleted') process.stderr.write(`\u2713 phase ${event.phase}\n`);
}

/** Progress logging for the model-driven agent harness (one line per turn). */
function agentOnEvent(event: AgentEvent): void {
  if (event.type === 'RunStarted') process.stderr.write(`\u25b6 agent run ${event.runId}\n`);
  else if (event.type === 'ModelCalled') process.stderr.write(`  \u00b7 ${event.callId.split(':')[1] ?? 'turn'} \u2192 model decides (${event.promptTokens}+${event.completionTokens} tok)\n`);
  else if (event.type === 'ToolCallSucceeded') process.stderr.write(`  \u00b7 tool ${event.tool} \u2192 ok\n`);
  else if (event.type === 'PolicyDenied') process.stderr.write(`  \u2716 policy denied ${event.scope} "${event.target}" (${event.code})\n`);
  else if (event.type === 'RunCompleted') process.stderr.write(`\u2713 agent finished\n`);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  const runtime = await makeRuntime();

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
  const summary = state.summary as { proposal?: string; files?: string[]; turns?: number; toolsUsed?: string[] } | undefined;
  if (summary?.turns) {
    process.stdout.write(`\nAgent: ${summary.turns} turns, tools=[${(summary.toolsUsed ?? []).join(', ')}]\n`);
  }
  if (summary?.proposal) {
    process.stdout.write(`\nProposal: ${summary.proposal}\n`);
    if (summary.files?.length) process.stdout.write(`Files:    ${summary.files.join(', ')}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\n\u2716 ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

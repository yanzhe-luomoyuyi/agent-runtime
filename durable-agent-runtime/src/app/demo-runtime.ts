/**
 * Shared demo Runtime factory — one wiring path for CLI `run`/`eval` and tests.
 * Chooses fixed workflow vs harness, local vs MCP tools.
 */

import type { Approver } from '@agent/contracts';

import { MockModelProvider, type ModelProvider } from '../model/provider.js';
import { registerMcpServer } from '../mcp/adapter.js';
import { McpClient } from '../mcp/client.js';
import { TokenCache } from '../mcp/token-cache.js';
import { InMemoryTransport } from '../mcp/transport.js';
import type { Policy } from '../policy.js';
import type { ModelPricing } from '../pricing.js';
import { Runtime } from '../runtime.js';
import { ToolRegistry } from '../tools/registry.js';
import type { AgentEvent } from '../types.js';

import { MockAgentModel } from './agent-scenario.js';
import { cannedResponses, registerDemoTools } from './demo-fixtures.js';
import { createHarnessWorkflow } from './harness-adapter.js';
import { issueWorkflow } from './issue-workflow.js';
import { demoMcpServers } from './mcp-servers.js';

export type DemoToolSource = 'local' | 'mcp';

export interface DemoRuntimeOptions {
  baseDir: string;
  /** Model-driven harness loop instead of the fixed issue→fix workflow. */
  harness?: boolean;
  /** Override tools; when omitted, built from `toolSource`. */
  tools?: ToolRegistry;
  toolSource?: DemoToolSource;
  /** Suppress the MCP banner (for eval / tests). */
  quiet?: boolean;
  model?: ModelProvider;
  pricing?: ModelPricing;
  policy?: Policy;
  crashAfter?: string;
  crashAfterTurn?: number;
  maxTurns?: number;
  approver?: Approver;
  onEvent?: (event: AgentEvent) => void;
}

/** Local tools by default; AGENT_MCP=1 (or toolSource:'mcp') uses the shared MCP SDK. */
export async function buildDemoTools(
  source: DemoToolSource = 'local',
  opts: { quiet?: boolean } = {},
): Promise<ToolRegistry> {
  if (source === 'local') return registerDemoTools();

  const registry = new ToolRegistry();
  const tokenCache = new TokenCache(() => ({
    token: 'demo-token',
    expiresAtMs: Date.now() + 3_600_000,
  }));
  const servers = demoMcpServers();
  for (const server of servers) {
    const client = new McpClient({
      serverName: server.name,
      transport: new InMemoryTransport(server.handle),
      tokenCache,
    });
    await registerMcpServer(registry, client);
  }
  if (!opts.quiet) {
    process.stderr.write(
      `\u25b6 tools via MCP base SDK \u2014 ${servers.length} servers sharing ${tokenCache.fetches} auth fetch\n`,
    );
  }
  return registry;
}

export async function createDemoRuntime(opts: DemoRuntimeOptions): Promise<Runtime> {
  const toolSource = opts.toolSource ?? 'local';
  const tools = opts.tools ?? (await buildDemoTools(toolSource, { quiet: opts.quiet }));

  if (opts.harness) {
    return new Runtime({
      baseDir: opts.baseDir,
      model: opts.model ?? new MockAgentModel(),
      tools,
      workflow: createHarnessWorkflow({
        maxTurns: opts.maxTurns,
        crashAfterTurn: opts.crashAfterTurn,
        approver: opts.approver,
      }),
      pricing: opts.pricing,
      policy: opts.policy,
      onEvent: opts.onEvent,
    });
  }

  let model: ModelProvider = opts.model ?? new MockModelProvider(cannedResponses());

  return new Runtime({
    baseDir: opts.baseDir,
    model,
    tools,
    workflow: issueWorkflow,
    pricing: opts.pricing,
    policy: opts.policy,
    crashAfter: opts.crashAfter,
    onEvent: opts.onEvent,
  });
}

/** Resolve CLI tool source from env (shared by run + eval). */
export function toolSourceFromEnv(): DemoToolSource {
  return process.env.AGENT_MCP === '1' ? 'mcp' : 'local';
}

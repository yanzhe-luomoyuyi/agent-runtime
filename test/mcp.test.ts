import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { issueWorkflow } from '../src/app/issue-workflow.js';
import { demoMcpServers } from '../src/app/mcp-servers.js';
import { registerMcpServer } from '../src/mcp/adapter.js';
import { McpClient, McpError } from '../src/mcp/client.js';
import { InMemoryMcpServer } from '../src/mcp/server.js';
import { InMemoryTransport } from '../src/mcp/transport.js';
import { TokenCache } from '../src/mcp/token-cache.js';
import { MockModelProvider } from '../src/model/provider.js';
import { Runtime } from '../src/runtime.js';
import { ToolRegistry } from '../src/tools/registry.js';

function clientFor(server: InMemoryMcpServer, tokenCache: TokenCache): McpClient {
  return new McpClient({ serverName: server.name, transport: new InMemoryTransport(server.handle), tokenCache });
}

function freshTokenCache(): TokenCache {
  return new TokenCache(() => ({ token: 'demo-token', expiresAtMs: Date.now() + 3_600_000 }));
}

describe('MCP base SDK', () => {
  it('lists and calls tools over JSON-RPC', async () => {
    const server = new InMemoryMcpServer({
      name: 'echo-server',
      tools: [{ name: 'echo', description: 'echoes', inputSchema: {}, handler: (a: { v: number }) => ({ doubled: a.v * 2 }) }],
    });
    const client = clientFor(server, freshTokenCache());

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);

    const result = await client.callTool<{ doubled: number }>('echo', { v: 21 });
    expect(result.doubled).toBe(42);
  });

  it('shares ONE token cache across many clients/servers (the convergence win)', async () => {
    const tokenCache = freshTokenCache();
    const [issues, code] = demoMcpServers();
    const issuesClient = clientFor(issues!, tokenCache);
    const codeClient = clientFor(code!, tokenCache);

    await issuesClient.listTools();
    await codeClient.listTools();
    await issuesClient.callTool('getIssue', { issue: 'x' });
    await codeClient.callTool('searchCode', { query: 'login' });

    // Four RPCs across two servers, but the auth endpoint was hit exactly once.
    expect(tokenCache.fetches).toBe(1);
  });

  it('surfaces server errors as McpError (unknown tool, bad auth)', async () => {
    const server = new InMemoryMcpServer({ name: 'empty', tools: [] });
    const okClient = clientFor(server, freshTokenCache());
    await expect(okClient.callTool('nope', {})).rejects.toBeInstanceOf(McpError);

    const denyServer = new InMemoryMcpServer({ name: 'locked', tools: [], authorize: () => false });
    const deniedClient = clientFor(denyServer, freshTokenCache());
    await expect(deniedClient.listTools()).rejects.toThrow(/unauthorized/i);
  });

  it('refreshes the token when it expires (shared refresh logic, not per-server)', async () => {
    let nowMs = 0;
    const cache = new TokenCache(() => ({ token: 't', expiresAtMs: nowMs + 10_000 }), 1_000, () => nowMs);
    await cache.get(); // fetch #1
    nowMs = 5_000;
    await cache.get(); // still valid → served from cache
    expect(cache.fetches).toBe(1);
    nowMs = 9_500; // inside the skew window before the 10_000 expiry → refresh
    await cache.get();
    expect(cache.fetches).toBe(2);
  });

  it('the adapter makes MCP tools indistinguishable from local ones, end to end', async () => {
    const registry = new ToolRegistry();
    const tokenCache = freshTokenCache();
    for (const server of demoMcpServers()) {
      await registerMcpServer(registry, clientFor(server, tokenCache));
    }
    expect(registry.list().map((t) => t.name).sort()).toEqual(['getIssue', 'searchCode']);

    const model = new MockModelProvider({
      'analyze.summary': 'Null session on login.',
      'propose.fix': 'Guard the null session in src/auth/login.ts.',
    });
    const dir = mkdtempSync(join(tmpdir(), 'agent-mcp-'));
    const rt = new Runtime({ baseDir: dir, model, tools: registry, workflow: issueWorkflow });
    const state = await rt.run('Login page crashes with a null session');

    expect(state.status).toBe('completed');
    expect((state.summary as { files: string[] }).files).toContain('src/auth/login.ts');
    // A shared token cache across both servers, even after a full workflow run.
    expect(tokenCache.fetches).toBe(1);
  });
});

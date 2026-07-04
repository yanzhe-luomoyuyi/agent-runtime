/**
 * Demo MCP servers — offline, in-memory stand-ins that host the SAME demo tools
 * (getIssue / searchCode) behind the shared MCP base SDK. Part of the demo
 * *workload*, not the runtime.
 *
 * Enable via AGENT_MCP=1 to route the CLI's tools through JSON-RPC + a shared
 * token cache instead of direct local calls. The runtime behaves identically
 * either way — that parity is the point.
 */

import { InMemoryMcpServer } from '../mcp/server.js';

import { getIssue, searchCode } from './tools.js';

export function demoMcpServers(): InMemoryMcpServer[] {
  const issues = new InMemoryMcpServer({
    name: 'issues-server',
    tools: [
      { name: getIssue.name, description: getIssue.description, inputSchema: getIssue.inputSchema, handler: getIssue.run },
    ],
  });
  const code = new InMemoryMcpServer({
    name: 'code-server',
    tools: [
      { name: searchCode.name, description: searchCode.description, inputSchema: searchCode.inputSchema, handler: searchCode.run },
    ],
  });
  return [issues, code];
}

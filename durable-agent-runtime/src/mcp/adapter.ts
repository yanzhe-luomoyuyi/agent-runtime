/**
 * The convergence point: project every tool a remote MCP server advertises into
 * a local `ToolDef` and register it. After this, the runtime cannot tell an
 * MCP-backed tool from a hand-written local one — they satisfy the exact same
 * contract (../tools/registry.ts), so the platform never learns whether a tool
 * is local or remote.
 */

import type { ToolDef, ToolRegistry } from '../tools/registry.js';

import type { McpClient } from './client.js';

/** Register all of `client`'s tools into `registry`. Returns the tool names added. */
export async function registerMcpServer(registry: ToolRegistry, client: McpClient): Promise<string[]> {
  const descriptors = await client.listTools();
  for (const descriptor of descriptors) {
    const def: ToolDef = {
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      run: (args) => client.callTool(descriptor.name, args),
    };
    registry.register(def);
  }
  return descriptors.map((d) => d.name);
}

/**
 * MCP client base — the one place JSON-RPC framing, transport, and auth-token
 * injection are wired together. Every server "converges" onto this: instead of
 * 8 servers each hand-rolling curl + JSON-RPC + token caching, they share this
 * client and differ only in their transport target and (optionally) token cache.
 */

import { isJsonRpcError, type JsonRpcRequest, type JsonRpcResponse } from './jsonrpc.js';
import type { TokenCache } from './token-cache.js';
import type { Transport } from './transport.js';

/** A tool as advertised by a server's `tools/list`. Mirrors the local `ToolDef` shape. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientOptions {
  serverName: string;
  transport: Transport;
  tokenCache: TokenCache;
}

/** Thrown when a server responds with a JSON-RPC error. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export class McpClient {
  private nextId = 1;

  constructor(private readonly opts: McpClientOptions) {}

  get serverName(): string {
    return this.opts.serverName;
  }

  /** Discover the tools a server offers. */
  async listTools(): Promise<McpToolDescriptor[]> {
    const { tools } = await this.rpc<{ tools: McpToolDescriptor[] }>('tools/list', {});
    return tools;
  }

  /** Invoke a remote tool by name. */
  async callTool<R = unknown>(name: string, args: unknown): Promise<R> {
    return this.rpc<R>('tools/call', { name, arguments: args });
  }

  /** The single funnel: attach a (shared, cached) token, send, map errors. */
  private async rpc<R>(method: string, params: Record<string, unknown>): Promise<R> {
    const token = await this.opts.tokenCache.get();
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params: { ...params, _meta: { token } },
    };
    const response = (await this.opts.transport.send(request)) as JsonRpcResponse<R>;
    if (isJsonRpcError(response)) {
      throw new McpError(response.error.code, `${this.opts.serverName}: ${response.error.message}`);
    }
    return response.result;
  }
}

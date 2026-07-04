/**
 * In-memory MCP server — a deterministic, offline stand-in for a real MCP server.
 *
 * It exists so the demo and tests can exercise the full base SDK (JSON-RPC +
 * transport + shared token auth) without a network. A real server would sit
 * behind an HTTP transport instead; the `handle` entrypoint and wire contract are
 * identical, which is the whole point of "converging servers onto a base SDK".
 */

import {
  jsonRpcError,
  jsonRpcResult,
  JSONRPC_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonrpc.js';

export interface McpServerTool<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Args) => Promise<Result> | Result;
}

export interface McpServerOptions {
  name: string;
  tools: Array<McpServerTool<any, any>>;
  /** Validate a bearer token. Default: accept any non-empty token. */
  authorize?: (token: string | undefined) => boolean;
}

interface CallParams {
  _meta?: { token?: string };
  name?: string;
  arguments?: unknown;
}

export class InMemoryMcpServer {
  private readonly tools = new Map<string, McpServerTool<any, any>>();

  constructor(private readonly opts: McpServerOptions) {
    for (const tool of opts.tools) this.tools.set(tool.name, tool);
  }

  get name(): string {
    return this.opts.name;
  }

  /** The single JSON-RPC entrypoint a transport calls. Arrow fn so it can be passed unbound. */
  handle = async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const params = (request.params ?? {}) as CallParams;
    const authorize = this.opts.authorize ?? ((token) => typeof token === 'string' && token.length > 0);
    if (!authorize(params._meta?.token)) {
      return jsonRpcError(request.id, JSONRPC_ERROR.UNAUTHORIZED, 'unauthorized: missing or invalid token');
    }

    try {
      switch (request.method) {
        case 'tools/list':
          return jsonRpcResult(request.id, {
            tools: [...this.tools.values()].map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          });
        case 'tools/call': {
          const tool = this.tools.get(params.name ?? '');
          if (!tool) {
            return jsonRpcError(request.id, JSONRPC_ERROR.METHOD_NOT_FOUND, `unknown tool: ${params.name}`);
          }
          const result = await tool.handler(params.arguments);
          return jsonRpcResult(request.id, result);
        }
        default:
          return jsonRpcError(request.id, JSONRPC_ERROR.METHOD_NOT_FOUND, `unknown method: ${request.method}`);
      }
    } catch (e) {
      return jsonRpcError(request.id, JSONRPC_ERROR.INTERNAL, e instanceof Error ? e.message : String(e));
    }
  };
}

/**
 * Minimal JSON-RPC 2.0 types + helpers, shared by every MCP client and server.
 *
 * This is the framing that each of Yifan's 8 servers would otherwise re-implement
 * by hand. Factoring it out once is the first half of the "shared MCP base SDK":
 * request/response shape, id correlation, and a small set of error codes.
 */

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: number;
  result: R;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcErrorResponse;

/** Type guard: did the server return an error rather than a result? */
export function isJsonRpcError(response: JsonRpcResponse): response is JsonRpcErrorResponse {
  return 'error' in response;
}

/** A small, MCP-relevant subset of JSON-RPC error codes. */
export const JSONRPC_ERROR = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
} as const;

export function jsonRpcResult<R>(id: number, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id: number, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

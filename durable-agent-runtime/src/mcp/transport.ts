/**
 * Transport seam — how a JSON-RPC request actually reaches a server.
 *
 * The base SDK depends only on this interface, so the wire (HTTP, stdio, a mock)
 * is swappable without touching client or server logic. `InMemoryTransport` is
 * the offline/deterministic implementation used by the demo and tests: it routes
 * straight to a server handler, but round-trips through JSON first so callers
 * can't accidentally rely on shared object references (mimicking a real wire).
 */

import type { JsonRpcRequest, JsonRpcResponse } from './jsonrpc.js';

export interface Transport {
  send(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

export type JsonRpcHandler = (request: JsonRpcRequest) => Promise<JsonRpcResponse> | JsonRpcResponse;

export class InMemoryTransport implements Transport {
  constructor(private readonly handler: JsonRpcHandler) {}

  async send(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const wire = JSON.parse(JSON.stringify(request)) as JsonRpcRequest;
    const response = await this.handler(wire);
    return JSON.parse(JSON.stringify(response)) as JsonRpcResponse;
  }
}

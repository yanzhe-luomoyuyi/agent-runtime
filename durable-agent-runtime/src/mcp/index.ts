/**
 * Shared MCP base SDK — public surface.
 *
 * The pieces every server would otherwise duplicate, factored out once:
 *   - jsonrpc     : JSON-RPC 2.0 framing + error codes
 *   - transport   : the swappable wire (in-memory for the demo; HTTP in prod)
 *   - token-cache : one shared, refreshing auth-token cache
 *   - client      : the base client that wires them together
 *   - server      : an offline in-memory server for the demo/tests
 *   - adapter     : projects remote tools into the local ToolRegistry
 */

export * from './jsonrpc.js';
export * from './transport.js';
export * from './token-cache.js';
export * from './client.js';
export * from './server.js';
export * from './adapter.js';

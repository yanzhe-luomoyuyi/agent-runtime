/**
 * @agent/contracts — the shared seam.
 *
 * The only thing the durable-agent-runtime and the @agent/harness both import.
 * It carries NO logic and NO dependency on either side: just the message, tool,
 * and model types they use to interoperate. Keeping the contract here (rather
 * than inside one project) is what lets the harness stay host-agnostic and the
 * runtime stay agent-agnostic while still working together.
 */

export * from './messages.js';
export * from './tools.js';
export * from './model.js';

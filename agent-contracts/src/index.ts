/**
 * @agent/contracts — the shared seam.
 *
 * The only thing the durable-agent-runtime and the @agent/harness both import.
 * Mostly types (messages, tools, model) plus small pure helpers both sides need
 * to stay in sync — notably durable {@link keyScope} idempotency keys. No
 * dependency on either project; that is what keeps the harness host-agnostic
 * and the runtime agent-agnostic while still working together.
 */

export * from './messages.js';
export * from './tools.js';
export * from './model.js';
export * from './utils.js';
export * from './keys.js';

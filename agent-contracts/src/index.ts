/**
 * @agent/contracts — the shared seam.
 *
 * The only thing durable-agent-runtime *platform* code and @agent/harness both
 * import. Types (messages, tools, model, DLQ, approval, corpus) plus small pure
 * helpers both sides need — notably durable {@link keyScope} idempotency keys
 * and {@link deadLetterId}. No dependency on either project.
 *
 * Note: the runtime *app* adapter (`src/app/harness-adapter.ts`) may still
 * import `@agent/harness` to host `runAgent`; that is intentional and does not
 * break the platform↔harness seam.
 */

export * from './messages.js';
export * from './tools.js';
export * from './model.js';
export * from './utils.js';
export * from './keys.js';
export * from './dead-letter.js';
export * from './approval.js';
export * from './corpus.js';

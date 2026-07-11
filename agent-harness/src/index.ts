/**
 * @agent/harness — a model-driven agent harness.
 *
 * Runtime-agnostic: it depends only on @agent/contracts (messages, tools, model)
 * and knows nothing about how a host runs it. A plain host can call `runAgent`
 * directly; a durable host (the durable-agent-runtime) implements the contracts'
 * `ChatModel` / `ToolInvoker` over its idempotent `ctx.callModel` / `ctx.callTool`
 * — passing the harness-supplied `key` — so every turn becomes replayable.
 *
 * Layers:
 *  - A  protocol/  — tool-calling interpretation + argument validation
 *  - B  recovery/  — transient-failure retry + loop detection
 *  - C  context/   — token budgeting, compaction, untrusted-output isolation
 *  - D  control/   — the loop, plus planning, reflection, sub-agents, approval
 */

// Agent — the "what" that the harness runs
export * from './agent.js';

// A — tool-calling protocol + schema validation
export * from './schema/validate.js';
export * from './protocol/tool-calling.js';

// C — context & memory
export * from './context/manager.js';
export * from './context/tokenizer.js';

// B — recovery
export * from './recovery/retry.js';
export * from './recovery/loop-detector.js';
export * from './recovery/circuit-breaker.js';
export * from './recovery/fallback.js';
export * from './recovery/compensation.js';

// D — control flow
export * from './control/human.js';
export * from './control/loop.js';
export * from './control/planner.js';
export * from './control/reflection.js';
export * from './control/subagent.js';

// Tracing / observability
export * from './tracing/collector.js';

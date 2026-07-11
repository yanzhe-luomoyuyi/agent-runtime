/**
 * Agent — the "what" that the harness runs.
 *
 * An Agent is a configuration bundle: it says WHO the agent is (name,
 * instructions), WHAT it can do (model, tools), and optionally HOW it delegates
 * (sub-agents).  The harness provides the execution engine — loop, context
 * management, protocol interpretation, retry, loop detection — and the Agent
 * provides the configuration that makes each run behave differently.
 *
 * An Agent is deliberately just data.  There is no runtime behaviour attached
 * to it — no `run()` method, no internal state.  That keeps Agents serialisable,
 * composable, and easy to register in a host-side agent catalogue.
 *
 * Usage
 * -----
 *   const dev = createAgent({
 *     name: 'dev-agent',
 *     instructions: '你是资深后端工程师。',
 *     model: gpt4Model,
 *     tools: devTools,
 *   });
 *
 *   const result = await runAgent({ agent: dev, goal: '实现登录 API' });
 */

import type { ChatModel, ToolInvoker } from '@agent/contracts';

import type { ContextManager } from './context/manager.js';

/**
 * Everything the harness needs to know about an agent's identity and
 * capabilities.  All fields except `name` and `instructions` are optional at
 * the config level — the harness supplies sensible defaults for anything
 * omitted.
 */
export interface AgentConfig {
  /** Unique identifier — used in logs, tracing, and agent registries. */
  name: string;

  /**
   * System-level instructions that define the agent's persona, expertise,
   * constraints, and output style.  Equivalent to the old `systemPrompt`
   * parameter.
   */
  instructions: string;

  /** The chat model (brain) the agent uses. */
  model: ChatModel;

  /** Tools the agent may call. */
  tools: ToolInvoker;

  /**
   * Sub-agents this agent can delegate to.  When set, the harness
   * automatically exposes a `delegate` tool for each sub-agent so the
   * parent model can call them just like any other tool.
   */
  subAgents?: AgentConfig[];

  /** Hard cap on turns.  Default: 12 (from the harness). */
  maxTurns?: number;

  /** Optional per-agent context manager (token budget, compaction, etc.). */
  context?: ContextManager;
}

/**
 * Create an Agent from a configuration object.  Currently a pure pass-through
 * (AgentConfig is just data), but kept as a factory so we can add validation,
 * defaults, or derived fields later without changing call sites.
 */
export function createAgent(config: AgentConfig): AgentConfig {
  return config;
}

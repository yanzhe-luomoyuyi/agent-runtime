/**
 * Agent — the "what" that the harness runs.
 *
 * An Agent is a configuration bundle: it says WHO the agent is (name,
 * instructions), WHAT it can do (model, tools), optionally WHICH skills it
 * follows, and optionally HOW it delegates (sub-agents).  The harness provides
 * the execution engine — loop, context management, protocol interpretation,
 * retry, loop detection — and the Agent provides the configuration that makes
 * each run behave differently.
 *
 * An Agent is deliberately just data.  There is no runtime behaviour attached
 * to it — no `run()` method, no internal state.  That keeps Agents serialisable,
 * composable, and easy to register in a host-side agent catalogue.
 *
 * `createAgent` materialises skills and sub-agents (see `skills/resolve.ts`):
 *   - skill catalog always lands in `instructions`
 *   - eager skill bodies are inlined; on_demand skills expose skill_list/skill_read
 *   - each sub-agent becomes a `delegate_<name>` tool
 *
 * Usage
 * -----
 *   const dev = createAgent({
 *     name: 'dev-agent',
 *     instructions: '你是资深后端工程师。',
 *     model: gpt4Model,
 *     tools: devTools,
 *     skills: [parseSkillMarkdown(md)],
 *   });
 *
 *   const result = await runAgent({ agent: dev, goal: '实现登录 API' });
 */

import type { ChatModel, ToolInvoker } from '@agent/contracts';

import type { ContextManager } from './context/manager.js';
import { resolveAgent } from './skills/resolve.js';
import type { SkillLoadMode, SkillSpec } from './skills/types.js';

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
   * parameter.  After `createAgent`, may also include the skill catalog and
   * any eagerly loaded skill bodies.
   */
  instructions: string;

  /** The chat model (brain) the agent uses. */
  model: ChatModel;

  /** Tools the agent may call. */
  tools: ToolInvoker;

  /**
   * Skill playbooks for this agent.  Catalog (name + description) is always
   * injected into instructions; body loading follows `loadMode` / `skillLoadMode`.
   */
  skills?: SkillSpec[];

  /**
   * Default load mode for skills that omit `loadMode`.
   * Default: `on_demand` (catalog only; model calls `skill_read` for the body).
   */
  skillLoadMode?: SkillLoadMode;

  /**
   * Sub-agents this agent can delegate to.  `createAgent` exposes each as a
   * `delegate_<name>` tool so the parent model can call them like any other tool.
   * Orthogonal to skills (skills = context; sub-agents = nested runs).
   */
  subAgents?: AgentConfig[];

  /** Hard cap on turns.  Default: 12 (from the harness). */
  maxTurns?: number;

  /** Optional per-agent context manager (token budget, compaction, etc.). */
  context?: ContextManager;

  /**
   * Set by `createAgent` after skills / sub-agents have been materialised.
   * Subsequent `createAgent` calls are a no-op when this is true.
   */
  resolved?: boolean;
}

/**
 * Create an Agent from a configuration object.  Resolves skills and sub-agents
 * into instructions + tools (idempotent when `resolved` is already set).
 */
export function createAgent(config: AgentConfig): AgentConfig {
  return resolveAgent(config);
}

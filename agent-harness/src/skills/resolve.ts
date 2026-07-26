/**
 * Materialise skills + sub-agents onto an AgentConfig.
 *
 * - Catalog (name + description) is always appended to instructions.
 * - `eager` skills: full body appended to instructions.
 * - `on_demand` skills (default): `skill_list` / `skill_read` via AugmentedToolInvoker.
 * - `subAgents`: each becomes a `delegate_<name>` tool via makeSubagentTool.
 *
 * Skills and sub-agents are orthogonal: skills reshape context; sub-agents
 * nest another runAgent behind a tool.
 */

import type { ToolInvoker } from '@agent/contracts';

import type { AgentConfig } from '../agent.js';
import { AugmentedToolInvoker, type ManagedToolDef } from '../context/tool-augment.js';
import { makeSubagentTool } from '../control/subagent.js';
import { skillToolDefs } from './tools.js';
import type { SkillLoadMode, SkillSpec } from './types.js';

/** Marker inserted into instructions so resolve is idempotent. */
export const SKILLS_CATALOG_MARKER = '## Available skills';

const DEFAULT_SKILL_LOAD_MODE: SkillLoadMode = 'on_demand';

/**
 * Resolve skills / sub-agents into instructions + tools.
 * No-op when `config.resolved` is already true.
 */
export function resolveAgent(config: AgentConfig): AgentConfig {
  if (config.resolved) return config;

  const skillLoadMode = config.skillLoadMode ?? DEFAULT_SKILL_LOAD_MODE;
  const skills = config.skills ?? [];
  const subAgents = (config.subAgents ?? []).map((s) => resolveAgent(s));

  const eager: SkillSpec[] = [];
  const onDemand: SkillSpec[] = [];
  for (const s of skills) {
    const mode = s.loadMode ?? skillLoadMode;
    if (mode === 'eager') eager.push(s);
    else onDemand.push(s);
  }

  let instructions = config.instructions;
  if (skills.length > 0 && !instructions.includes(SKILLS_CATALOG_MARKER)) {
    instructions = appendSkillsToInstructions(instructions, skills, eager, onDemand);
  }

  const extra: ManagedToolDef[] = [];
  if (onDemand.length > 0) {
    extra.push(...skillToolDefs(onDemand));
  }
  for (const sub of subAgents) {
    const toolName = delegateToolName(sub.name);
    const subagent = makeSubagentTool({
      name: toolName,
      description:
        `Delegate a self-contained sub-goal to the "${sub.name}" sub-agent. ` +
        'Input: {"goal": string}.',
      agent: sub,
      maxTurns: sub.maxTurns,
      context: sub.context,
    });
    extra.push({
      name: subagent.spec.name,
      description: subagent.spec.description,
      inputSchema: subagent.spec.inputSchema,
      handler: subagent.run,
    });
  }

  const tools = extra.length > 0 ? augmentTools(config.tools, extra) : config.tools;

  return {
    ...config,
    instructions,
    tools,
    subAgents: subAgents.length > 0 ? subAgents : config.subAgents,
    resolved: true,
  };
}

function appendSkillsToInstructions(
  instructions: string,
  all: SkillSpec[],
  eager: SkillSpec[],
  onDemand: SkillSpec[],
): string {
  const lines: string[] = [instructions.trimEnd(), '', SKILLS_CATALOG_MARKER, ''];

  if (onDemand.length > 0) {
    lines.push(
      'Some skills are loaded on demand. Call `skill_list` to refresh the catalog, then `skill_read` with a skill name before following its steps.',
      '',
    );
  }

  for (const s of all) {
    const mode = eager.includes(s) ? 'eager' : 'on_demand';
    const corpus = s.corpusId ? ` · corpus: ${s.corpusId}` : '';
    lines.push(`- **${s.name}** (${mode}${corpus}): ${s.description}`);
  }

  for (const s of eager) {
    lines.push('', `## Skill: ${s.name}`, '', s.body.trim());
  }

  return lines.join('\n');
}

function augmentTools(inner: ToolInvoker, defs: ManagedToolDef[]): ToolInvoker {
  // Avoid double-advertising if the host already registered the same names.
  const existing = new Set(inner.list().map((t) => t.name));
  const fresh = defs.filter((d) => !existing.has(d.name));
  return fresh.length > 0 ? new AugmentedToolInvoker(inner, fresh) : inner;
}

/** Stable tool name for a sub-agent: `delegate_<sanitized_name>`. */
export function delegateToolName(agentName: string): string {
  const sanitized = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `delegate_${sanitized || 'agent'}`;
}

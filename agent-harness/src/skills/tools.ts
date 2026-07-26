/**
 * On-demand skill tools — catalog is always in the system prompt; body is
 * fetched via `skill_read` so long playbooks do not consume the context window
 * until the model needs them.
 *
 * Handlers are pure functions of the static `SkillSpec[]`, so they are safe to
 * attach with `AugmentedToolInvoker` even under a durable host (no mutable
 * cross-session state).
 */

import type { ManagedToolDef } from '../context/tool-augment.js';
import type { SkillSpec } from './types.js';

export const SKILL_LIST_TOOL = 'skill_list';
export const SKILL_READ_TOOL = 'skill_read';

/** Build `skill_list` + `skill_read` for the given on-demand skills. */
export function skillToolDefs(skills: SkillSpec[]): ManagedToolDef[] {
  const byName = new Map(skills.map((s) => [s.name, s]));

  return [
    {
      name: SKILL_LIST_TOOL,
      description:
        'List available skills (name + description). Use skill_read to load a skill\'s full playbook before following it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: () =>
        skills.map((s) => ({
          name: s.name,
          description: s.description,
          tools: s.tools,
          hasReferences: Boolean(s.references && Object.keys(s.references).length > 0),
        })),
    },
    {
      name: SKILL_READ_TOOL,
      description:
        'Load the full body of a skill playbook by name. Call this before following a skill\'s steps. Input: {"name": string, "reference"?: string}.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name from skill_list / the catalog.' },
          reference: {
            type: 'string',
            description: 'Optional: return only this named reference attachment instead of the full body.',
          },
        },
        required: ['name'],
      },
      handler: (args: unknown) => {
        const a = (args ?? {}) as { name?: unknown; reference?: unknown };
        if (typeof a.name !== 'string' || !a.name.trim()) {
          return 'ERROR: skill_read requires a non-empty string "name".';
        }
        const skill = byName.get(a.name.trim());
        if (!skill) {
          const known = [...byName.keys()].join(', ') || '(none)';
          return `ERROR: unknown skill "${a.name}". Known: ${known}.`;
        }
        if (typeof a.reference === 'string' && a.reference.trim()) {
          const ref = skill.references?.[a.reference.trim()];
          if (ref === undefined) {
            const known = Object.keys(skill.references ?? {}).join(', ') || '(none)';
            return `ERROR: skill "${skill.name}" has no reference "${a.reference}". Known: ${known}.`;
          }
          return { name: skill.name, reference: a.reference.trim(), content: ref };
        }
        return {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          tools: skill.tools,
          references: skill.references ? Object.keys(skill.references) : undefined,
        };
      },
    },
  ];
}

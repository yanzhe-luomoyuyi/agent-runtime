/**
 * Skills — reusable playbooks an agent can follow.
 *
 * A skill is static guidance (steps, constraints, output format), not a tool
 * implementation and not a sub-agent. Skills reshape the current agent's
 * context; sub-agents run a nested `runAgent` behind a delegate tool.
 */

/** How skill body text is exposed to the model. */
export type SkillLoadMode = 'eager' | 'on_demand';

/**
 * One skill pack. Typically loaded from a markdown file with YAML frontmatter
 * (`name` / `description` / optional `loadMode`), or constructed in code.
 */
export interface SkillSpec {
  /** Unique id within an agent's skill set. */
  name: string;
  /** One-line summary shown in the skill catalog (always injected). */
  description: string;
  /** Full playbook markdown (steps, rules, templates). */
  body: string;
  /**
   * Per-skill override. When omitted, the agent's `skillLoadMode` applies
   * (default `on_demand`).
   */
  loadMode?: SkillLoadMode;
  /** Soft hint: tool names this playbook expects the host to provide. */
  tools?: string[];
  /**
   * Optional document corpus this playbook is scoped to.
   * Hosts bind retrieval tools to an allow-list; the model does not invent corpus ids.
   */
  corpusId?: string;
  /** Optional named attachments (templates, schemas) returned by `skill_read`. */
  references?: Record<string, string>;
}

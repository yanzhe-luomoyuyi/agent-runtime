/**
 * Resolve which document corpus a run should use — host default and/or skill bindings.
 *
 * Skills may declare `corpusId` so a playbook is scoped to one knowledge base.
 * The model never invents corpus ids; the host allow-lists them when registering tools.
 * Uses contracts {@link CorpusScoped} so platform code does not import harness `SkillSpec`.
 */

import type { CorpusScoped } from '@agent/contracts';

/** Unique corpus ids declared on skills (order preserved, first occurrence wins). */
export function collectSkillCorpora(skills: readonly CorpusScoped[] | undefined): string[] {
  if (!skills?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of skills) {
    const id = s.corpusId?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface ResolveRunCorpusOptions {
  /** Explicit host default (createHarnessWorkflow retrieval.corpusId). */
  corpusId?: string;
  /** Skills (or any {@link CorpusScoped}) that may declare corpusId. */
  skills?: readonly CorpusScoped[];
  /** Optional policy allow-list; resolved id must be in this set when provided. */
  allowedCorpora?: readonly string[];
}

/**
 * Pick the corpus for system retrieve / default tool binding.
 * Preference: explicit corpusId → first skill corpusId.
 * Throws if nothing resolves, or if the result is not in allowedCorpora.
 */
export function resolveRunCorpusId(opts: ResolveRunCorpusOptions): string {
  const fromSkills = collectSkillCorpora(opts.skills);
  const candidate = opts.corpusId?.trim() || fromSkills[0];
  if (!candidate) {
    throw new Error(
      'resolveRunCorpusId: no corpusId — set retrieval.corpusId or SkillSpec.corpusId on at least one skill',
    );
  }
  if (opts.allowedCorpora && opts.allowedCorpora.length > 0 && !opts.allowedCorpora.includes(candidate)) {
    throw new Error(
      `resolveRunCorpusId: corpus "${candidate}" is not in allowedCorpora [${opts.allowedCorpora.join(', ')}]`,
    );
  }
  return candidate;
}

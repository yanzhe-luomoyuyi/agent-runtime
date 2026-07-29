/**
 * Corpus binding — minimal seam so hosts can resolve a document corpus from
 * playbook metadata without depending on harness `SkillSpec`.
 *
 * Anything with an optional `corpusId` (skills, host config) is structurally
 * compatible; harness `SkillSpec` satisfies this shape.
 */

/** Declares an optional document corpus id. */
export interface CorpusScoped {
  corpusId?: string;
}

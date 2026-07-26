/**
 * Load / parse skill markdown.
 *
 * Frontmatter is a tiny `key: value` subset (no nested YAML) so we stay
 * dependency-free. fabric-shell SKILL.md files are a reference format only —
 * this parser is owned by harness and does not import that package.
 */

import { readFileSync } from 'node:fs';

import type { SkillLoadMode, SkillSpec } from './types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a skill markdown document into a `SkillSpec`.
 * Requires `name` + `description` (frontmatter or `opts` overrides).
 */
export function parseSkillMarkdown(markdown: string, opts?: { name?: string; loadMode?: SkillLoadMode }): SkillSpec {
  const trimmed = markdown.trim();
  const m = FRONTMATTER_RE.exec(trimmed);
  let meta: Record<string, string> = {};
  let body = trimmed;
  if (m) {
    meta = parseSimpleFrontmatter(m[1] ?? '');
    body = (m[2] ?? '').trim();
  }

  const name = opts?.name ?? meta.name;
  const description = meta.description;
  if (!name || !name.trim()) throw new Error('parseSkillMarkdown: skill requires a name (frontmatter or opts.name)');
  if (!description || !description.trim()) throw new Error(`parseSkillMarkdown: skill "${name}" requires a description in frontmatter`);

  const loadMode = opts?.loadMode ?? parseLoadMode(meta.loadMode);
  return {
    name: name.trim(),
    description: description.trim(),
    body,
    ...(loadMode ? { loadMode } : {}),
  };
}

/** Read a skill markdown file from disk and parse it. */
export function loadSkillFile(path: string, opts?: { name?: string; loadMode?: SkillLoadMode }): SkillSpec {
  return parseSkillMarkdown(readFileSync(path, 'utf8'), opts);
}

function parseLoadMode(raw: string | undefined): SkillLoadMode | undefined {
  if (raw === 'eager' || raw === 'on_demand') return raw;
  return undefined;
}

/** Minimal frontmatter: `key: value` or `key: "value"` per line. */
function parseSimpleFrontmatter(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const colon = t.indexOf(':');
    if (colon <= 0) continue;
    const key = t.slice(0, colon).trim();
    let value = t.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

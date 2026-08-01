/**
 * Load .gitignore (root) + hard defaults for workspace walks / snapshots.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ignore, { type Ignore } from 'ignore';

const ALWAYS = [
  '.git/',
  'node_modules/',
  '.coding-agent-runs/',
  '.coding-agent-memory/',
  '.coding-agent-dead-letters/',
  'dist/',
  '.DS_Store',
];

export type PathIgnorer = {
  /** True if this relative path should be skipped (posix-style, no leading ./). */
  ignores: (relPath: string) => boolean;
};

/** Build an ignorer for a workspace root (defaults + root `.gitignore` if present). */
export function createWorkspaceIgnorer(rootDir: string): PathIgnorer {
  const ig: Ignore = ignore();
  ig.add(ALWAYS);
  const gitignorePath = join(rootDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      ig.add(readFileSync(gitignorePath, 'utf8'));
    } catch {
      // unreadable gitignore — keep defaults only
    }
  }
  return {
    ignores: (relPath: string) => {
      const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!norm || norm === '.') return false;
      return ig.ignores(norm);
    },
  };
}

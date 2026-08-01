/**
 * Shared workspace file walk with optional gitignore filter.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createWorkspaceIgnorer, type PathIgnorer } from './gitignore.js';

export type WalkVisit = (absPath: string, relPath: string) => boolean | void;

export interface WalkOptions {
  /** Skip files larger than this (bytes). */
  maxFileBytes?: number;
  ignorer?: PathIgnorer;
  /** Start under a subdirectory (still ignore-relative to rootDir). */
  startDir?: string;
}

/**
 * Depth-first walk; visit return false to stop entirely.
 *
 * Symlinks are NOT followed (lstat) — a symlinked dir could point outside the
 * workspace (exfiltrating secrets via grep/snapshot) or form a cycle
 * (`a -> b -> a`) that would recurse forever. Matches list_dir/list_tree,
 * which also treat symlinks as leaves.
 */
export function walkWorkspace(rootDir: string, visit: WalkVisit, opts: WalkOptions = {}): void {
  const ignorer = opts.ignorer ?? createWorkspaceIgnorer(rootDir);
  walkDir(rootDir, opts.startDir ?? rootDir, visit, ignorer, opts.maxFileBytes);
}

function walkDir(
  root: string,
  dir: string,
  visit: WalkVisit,
  ignorer: PathIgnorer,
  maxFileBytes?: number,
): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return true;
  }
  for (const name of names) {
    const abs = join(dir, name);
    const rel = relative(root, abs).split('\\').join('/');
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never follow links out of the sandbox
    if (st.isDirectory()) {
      if (ignorer.ignores(rel) || ignorer.ignores(`${rel}/`)) continue;
      if (!walkDir(root, abs, visit, ignorer, maxFileBytes)) return false;
      continue;
    }
    if (!st.isFile()) continue;
    if (ignorer.ignores(rel)) continue;
    if (maxFileBytes !== undefined && st.size > maxFileBytes) continue;
    if (visit(abs, rel) === false) return false;
  }
  return true;
}

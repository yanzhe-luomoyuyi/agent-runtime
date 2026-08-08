/**
 * Path sandbox for a coding workspace.
 *
 * Tools never see absolute user paths that escape `rootDir` — not even through
 * symlinks. Injected via CLI `--workspace`, UI path, or `AGENT_WORKSPACE`.
 */

import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'node:path';

import type { ExecutionSandbox } from '@agent/contracts';

const MAX_SYMLINK_DEPTH = 64;

export class WorkspaceEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceEscapeError';
  }
}

export class Workspace implements ExecutionSandbox {
  readonly rootDir: string;
  readonly kind = 'workspace';
  /** Canonical (symlink-resolved) workspace root — the containment baseline. */
  private readonly rootReal: string;

  constructor(rootDir: string) {
    const abs = resolve(rootDir);
    if (!existsSync(abs)) {
      throw new Error(`Workspace root does not exist: ${abs}`);
    }
    this.rootDir = abs;
    this.rootReal = realpathSync(abs);
  }

  /**
   * Resolve a user-supplied path to an absolute path inside the workspace.
   * Throws `WorkspaceEscapeError` on lexical escapes (`..`, absolute, NUL) and
   * on any symlink chain that would land outside the workspace.
   */
  resolve(userPath = '.'): string {
    const raw = userPath.trim() === '' ? '.' : userPath;
    if (raw.includes('\0')) {
      throw new WorkspaceEscapeError('path contains NUL');
    }
    const candidate = isAbsolute(raw) ? normalize(raw) : resolve(this.rootDir, raw);
    const rel = relative(this.rootDir, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceEscapeError(`path escapes workspace: ${userPath}`);
    }
    this.assertNoSymlinkEscape(candidate, userPath, new Set());
    return candidate;
  }

  resolvePath(path: string): string {
    return this.resolve(path);
  }

  async guardToolInvocation(toolName: string, args: unknown): Promise<void> {
    for (const candidate of collectSandboxPaths(toolName, args)) {
      this.resolve(candidate);
    }
  }

  /**
   * Walk `candidate` from its deepest existing component upward, rejecting if
   * following a symlink would escape the workspace. A symlink component's
   * *target* is checked recursively; a `seen` set breaks symlink cycles
   * (`link -> link`).
   */
  private assertNoSymlinkEscape(candidate: string, userPath: string, seen: Set<string>): void {
    if (seen.size > MAX_SYMLINK_DEPTH) {
      throw new WorkspaceEscapeError(`path escapes workspace (symlink depth): ${userPath}`);
    }
    if (seen.has(candidate)) {
      throw new WorkspaceEscapeError(`path escapes workspace (symlink cycle): ${userPath}`);
    }
    seen.add(candidate);

    const missing: string[] = [];
    let cur = candidate;
    for (;;) {
      let st;
      try {
        st = lstatSync(cur);
      } catch {
        st = undefined; // component does not exist (yet) — cannot be a symlink
      }
      if (st?.isSymbolicLink()) {
        // Existing (possibly dangling) symlink: verify its resolved target
        // stays inside the workspace, then re-check the path below it.
        const target = readlinkSync(cur);
        const resolvedTarget = isAbsolute(target)
          ? normalize(target)
          : resolve(dirname(cur), target);
        const through = missing.length > 0 ? resolve(resolvedTarget, ...missing) : resolvedTarget;
        this.assertNoSymlinkEscape(through, userPath, seen);
        return;
      }
      if (st) {
        // Existing non-symlink component: its real path must stay inside the
        // canonical workspace root. `missing` segments below it cannot be
        // symlinks (they did not exist), so the tail is safe once this holds.
        const real = realpathSync(cur);
        const rel = relative(this.rootReal, real);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          throw new WorkspaceEscapeError(`path escapes workspace via symlink: ${userPath}`);
        }
        return;
      }
      const parent = dirname(cur);
      if (parent === cur) {
        throw new WorkspaceEscapeError(`cannot resolve path: ${userPath}`);
      }
      missing.unshift(basename(cur));
      cur = parent;
    }
  }

  relative(absPath: string): string {
    const rel = relative(this.rootDir, absPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceEscapeError(`path outside workspace: ${absPath}`);
    }
    return rel === '' ? '.' : rel;
  }
}

function collectSandboxPaths(toolName: string, args: unknown): string[] {
  if (typeof args === 'string') return [args];
  if (!args || typeof args !== 'object') return [];
  const record = args as Record<string, unknown>;
  const keys = ['path', 'filePath', 'targetPath', 'sourcePath', 'oldPath', 'newPath', 'from', 'to'];
  const candidates: string[] = [];

  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') candidates.push(value);
  }

  if (Array.isArray(record.paths)) {
    for (const value of record.paths) {
      if (typeof value === 'string') candidates.push(value);
    }
  }

  if (toolName === 'apply_patch' && typeof record.patchText === 'string') {
    return [];
  }

  return [...new Set(candidates)];
}

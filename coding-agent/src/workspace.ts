/**
 * Path sandbox for a coding workspace.
 *
 * Tools never see absolute user paths that escape `rootDir`. Phase A binds a
 * default fixture root; a later `--workspace` flag only changes the constructor arg.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export class WorkspaceEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceEscapeError';
  }
}

export class Workspace {
  readonly rootDir: string;

  constructor(rootDir: string) {
    const abs = resolve(rootDir);
    if (!existsSync(abs)) {
      throw new Error(`Workspace root does not exist: ${abs}`);
    }
    this.rootDir = abs;
  }

  /** Resolve a user-supplied path to an absolute path inside the workspace. */
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
    // Windows drive-letter absolute check already covered by isAbsolute(rel)
    if (rel.split(sep).includes('..')) {
      throw new WorkspaceEscapeError(`path escapes workspace: ${userPath}`);
    }
    return candidate;
  }

  relative(absPath: string): string {
    const rel = relative(this.rootDir, absPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceEscapeError(`path outside workspace: ${absPath}`);
    }
    return rel === '' ? '.' : rel;
  }
}

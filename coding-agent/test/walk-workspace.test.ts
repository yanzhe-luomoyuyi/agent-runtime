/**
 * walkWorkspace — must not follow symlinks: an external link would leak
 * outside-files to grep/snapshot, and a cyclic link would recurse forever.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { walkWorkspace } from '../src/walk-workspace.js';

describe('walkWorkspace symlink handling', () => {
  it('does not follow symlinked directories or files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-link-'));
    const outside = mkdtempSync(join(tmpdir(), 'walk-outside-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'a');
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      mkdirSync(join(outside, 'sub'), { recursive: true });
      writeFileSync(join(outside, 'sub', 'deep.txt'), 'deep');
      symlinkSync(outside, join(dir, 'ext'));
      symlinkSync('a.txt', join(dir, 'alink.txt'));

      const seen: string[] = [];
      walkWorkspace(dir, (_abs, rel) => {
        seen.push(rel);
      });
      expect(seen).toContain('a.txt');
      expect(seen).not.toContain('ext');
      expect(seen).not.toContain('ext/secret.txt');
      expect(seen).not.toContain('ext/sub/deep.txt');
      expect(seen).not.toContain('alink.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('survives a cyclic symlink without stack overflow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-cycle-'));
    try {
      mkdirSync(join(dir, 'sub'), { recursive: true });
      writeFileSync(join(dir, 'top.txt'), 'top');
      symlinkSync(join(dir, 'sub'), join(dir, 'sub', 'loop')); // sub/loop -> sub

      const seen: string[] = [];
      expect(() =>
        walkWorkspace(dir, (_abs, rel) => {
          seen.push(rel);
        }),
      ).not.toThrow();
      expect(seen).toContain('top.txt');
      expect(seen).not.toContain('sub/loop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

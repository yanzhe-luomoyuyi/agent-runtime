import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createWorkspaceIgnorer } from '../src/gitignore.js';
import { diffSnapshots, snapshotWorkspace, unifiedDiff } from '../src/workspace-diff.js';

describe('workspace-diff', () => {
  it('marks modified files and includes +/− lines', () => {
    const before = { 'a.js': 'const x = 1;\n' };
    const after = { 'a.js': 'const x = 2;\n' };
    const diffs = diffSnapshots(before, after);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.status).toBe('modified');
    expect(diffs[0]!.unified).toContain('-const x = 1;');
    expect(diffs[0]!.unified).toContain('+const x = 2;');
  });

  it('unifiedDiff headers include path', () => {
    const u = unifiedDiff('src/x.js', 'a\n', 'b\n');
    expect(u).toContain('--- a/src/x.js');
    expect(u).toContain('+++ b/src/x.js');
  });

  it('snapshotWorkspace skips gitignored paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-agent-snap-'));
    writeFileSync(join(root, '.gitignore'), 'secret.txt\nignored/\n');
    writeFileSync(join(root, 'keep.js'), 'ok\n');
    writeFileSync(join(root, 'secret.txt'), 'nope\n');
    mkdirSync(join(root, 'ignored'));
    writeFileSync(join(root, 'ignored', 'x.js'), 'nope\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'pkg.js'), 'nope\n');

    const snap = snapshotWorkspace(root);
    expect(snap['keep.js']).toBe('ok\n');
    expect(snap['secret.txt']).toBeUndefined();
    expect(snap['ignored/x.js']).toBeUndefined();
    expect(snap['node_modules/pkg.js']).toBeUndefined();
  });
});

describe('gitignore', () => {
  it('always ignores .git and node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-agent-ig-'));
    const ig = createWorkspaceIgnorer(root);
    expect(ig.ignores('node_modules/foo')).toBe(true);
    expect(ig.ignores('.git/config')).toBe(true);
  });
});

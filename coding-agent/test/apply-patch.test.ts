import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Workspace } from '../src/workspace.js';
import { applyDiff, applyPatchToWorkspace, parsePatchEnvelope } from '../src/tools/apply-patch.js';
import { createFsTools } from '../src/tools/fs-tools.js';

describe('applyDiff', () => {
  it('replaces a unique context-anchored hunk', () => {
    const input = ['a', 'b', 'c', 'd'].join('\n');
    const out = applyDiff(input, ['@@', ' a', '-b', '+B', ' c']);
    expect(out).toBe(['a', 'B', 'c', 'd'].join('\n'));
  });

  it('fails when context cannot be found', () => {
    expect(() => applyDiff('hello\n', ['@@', '-missing', '+x'])).toThrow(/context not found/);
  });

  it('pinpoints the first mismatched line in context-not-found errors', () => {
    const input = [
      'export interface RunAgentOptions {',
      '  goal: string;',
      '  /** detection). When provided, loopLimit is ignored in favour of this object. */',
      '  loopOptions?: object;',
      '}',
    ].join('\n');
    expect(() =>
      applyDiff(input, [
        '@@',
        ' export interface RunAgentOptions {',
        '   goal: string;',
        '   /** detection). When provided, loopLimit is ignored (use loopOptions.limit). */',
        '   loopOptions?: object;',
        ' }',
      ]),
    ).toThrow(/at file line 3.*expected .*use loopOptions\.limit.*got .*in favour of this object/);
  });
});

describe('parsePatchEnvelope', () => {
  it('parses add / update / delete ops', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: new.txt',
      '+hello',
      '*** Update File: a.ts',
      '@@',
      '-old',
      '+new',
      '*** Delete File: gone.txt',
      '*** End Patch',
    ].join('\n');
    const ops = parsePatchEnvelope(patch);
    expect(ops.map((o) => o.kind)).toEqual(['add', 'update', 'delete']);
  });
});

describe('applyPatchToWorkspace', () => {
  it('adds, updates, moves, and deletes files in one patch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-patch-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.ts'), 'const x = 1;\nconst y = 2;\n', 'utf8');
      writeFileSync(join(dir, 'gone.txt'), 'bye\n', 'utf8');

      const ws = new Workspace(dir);
      const patch = [
        '*** Begin Patch',
        '*** Add File: hello.txt',
        '+Hello world',
        '*** Update File: src/a.ts',
        '*** Move to: src/b.ts',
        '@@',
        ' const x = 1;',
        '-const y = 2;',
        '+const y = 3;',
        '*** Delete File: gone.txt',
        '*** End Patch',
      ].join('\n');

      const result = applyPatchToWorkspace(ws, patch);
      expect(result.actions).toEqual([
        { type: 'add', path: 'hello.txt' },
        { type: 'move', path: 'src/a.ts', to: 'src/b.ts' },
        { type: 'delete', path: 'gone.txt' },
      ]);

      expect(readFileSync(join(dir, 'hello.txt'), 'utf8')).toBe('Hello world');
      expect(existsSync(join(dir, 'src', 'a.ts'))).toBe(false);
      expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf8')).toBe('const x = 1;\nconst y = 3;\n');
      expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is exposed as the apply_patch FS tool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-patch-tool-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8');
      const tools = Object.fromEntries(createFsTools(new Workspace(dir)).map((t) => [t.name, t]));
      const out = tools.apply_patch!.run({
        patch: [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@',
          '-one',
          '+two',
          '*** End Patch',
        ].join('\n'),
      }) as { filesChanged: number; actions: Array<{ type: string }> };
      expect(out.filesChanged).toBe(1);
      expect(out.actions[0]!.type).toBe('update');
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back earlier ops when a later op fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apply-patch-tx-'));
    try {
      writeFileSync(join(dir, 'ok.txt'), 'keep\n', 'utf8');
      const ws = new Workspace(dir);
      expect(() =>
        applyPatchToWorkspace(
          ws,
          [
            '*** Begin Patch',
            '*** Add File: new.txt',
            '+created',
            '*** Update File: ok.txt',
            '@@',
            '-keep',
            '+changed',
            '*** Delete File: missing.txt',
            '*** End Patch',
          ].join('\n'),
        ),
      ).toThrow(/missing\.txt|ENOENT|not a file/);
      expect(existsSync(join(dir, 'new.txt'))).toBe(false);
      expect(readFileSync(join(dir, 'ok.txt'), 'utf8')).toBe('keep\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

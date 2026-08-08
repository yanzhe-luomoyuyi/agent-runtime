import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Workspace, WorkspaceEscapeError } from '../src/workspace.js';
import { compileGlob, createFsTools } from '../src/tools/fs-tools.js';

describe('Workspace', () => {
  it('resolves relative paths inside root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.js'), 'export {}');
      const ws = new Workspace(dir);
      expect(ws.resolve('src/a.js')).toContain('a.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects escape via ..', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      const ws = new Workspace(dir);
      expect(() => ws.resolve('../package.json')).toThrow(WorkspaceEscapeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('guards tool invocations through the shared sandbox interface', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'safe.txt'), 'ok');
      const ws = new Workspace(dir);
      await expect(ws.guardToolInvocation('read_file', { path: '../outside.txt' })).rejects.toThrow(
        WorkspaceEscapeError,
      );
      await expect(ws.guardToolInvocation('read_file', { path: 'src/safe.txt' })).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects paths through a symlink pointing outside the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-link-'));
    const outside = mkdtempSync(join(tmpdir(), 'coding-ws-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(outside, join(dir, 'link'));
      const ws = new Workspace(dir);
      expect(() => ws.resolve('link/secret.txt')).toThrow(WorkspaceEscapeError);
      expect(() => ws.resolve('link/new.txt')).toThrow(WorkspaceEscapeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('allows a symlink whose target stays inside the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-link-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'real.txt'), 'hi');
      symlinkSync('src', join(dir, 'alias'));
      const ws = new Workspace(dir);
      expect(() => ws.resolve('alias/real.txt')).not.toThrow();
      // and the fs tools can actually read through it
      const tools = Object.fromEntries(createFsTools(ws).map((t) => [t.name, t]));
      const got = tools.read_file!.run({ path: 'alias/real.txt' }) as { content: string };
      expect(got.content).toContain('hi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a dangling symlink that points outside the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-link-'));
    try {
      symlinkSync('/nonexistent-target', join(dir, 'dangling'));
      const ws = new Workspace(dir);
      expect(() => ws.resolve('dangling/x.txt')).toThrow(WorkspaceEscapeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a self-referential symlink cycle without hanging', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-link-'));
    try {
      symlinkSync('loop', join(dir, 'loop'));
      const ws = new Workspace(dir);
      expect(() => ws.resolve('loop/x')).toThrow(WorkspaceEscapeError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('write_file cannot write through an external symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-link-'));
    const outside = mkdtempSync(join(tmpdir(), 'coding-ws-outside-'));
    try {
      symlinkSync(outside, join(dir, 'link'));
      const ws = new Workspace(dir);
      const tools = Object.fromEntries(createFsTools(ws).map((t) => [t.name, t]));
      expect(() => tools.write_file!.run({ path: 'link/evil.txt', content: 'x' })).toThrow(
        WorkspaceEscapeError,
      );
      expect(existsSync(join(outside, 'evil.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('compileGlob', () => {
  it('matches basename globs at any depth and brace alternatives', () => {
    const ts = compileGlob('*.ts');
    expect(ts.test('a.ts')).toBe(true);
    expect(ts.test('src/a.ts')).toBe(true);
    expect(ts.test('src/a.js')).toBe(false);

    const braced = compileGlob('**/*.{ts,tsx}');
    expect(braced.test('src/a.ts')).toBe(true);
    expect(braced.test('src/a.tsx')).toBe(true);
    expect(braced.test('src/a.js')).toBe(false);
  });
});

describe('fs tools', () => {
  it('list_tree returns a shallow indented tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-tree-'));
    try {
      mkdirSync(join(dir, 'src', 'util'), { recursive: true });
      writeFileSync(join(dir, 'README.md'), '# hi');
      writeFileSync(join(dir, 'src', 'index.ts'), 'export {}');
      writeFileSync(join(dir, 'src', 'util', 'a.ts'), 'export const a = 1');
      const tools = Object.fromEntries(createFsTools(new Workspace(dir)).map((t) => [t.name, t]));
      const out = tools.list_tree!.run({ path: '.', depth: 2 }) as {
        tree: string;
        truncated: boolean;
        entries: number;
        depth: number;
      };
      expect(out.depth).toBe(2);
      expect(out.truncated).toBe(false);
      expect(out.tree).toContain('README.md');
      expect(out.tree).toContain('src/');
      expect(out.tree).toContain('index.ts');
      expect(out.tree).toContain('util/');
      // tree -L 2 shows util/ but not its children
      expect(out.tree).not.toContain('a.ts');
      const deep = tools.list_tree!.run({ path: '.', depth: 3 }) as { tree: string };
      expect(deep.tree).toContain('a.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('list_dir / read_file / write_file round-trip in a temp workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'session.js'), 'export {}');
      const ws = new Workspace(dir);
      const tools = Object.fromEntries(createFsTools(ws).map((t) => [t.name, t]));
      const listed = tools.list_dir!.run({ path: 'src' }) as { entries: Array<{ name: string }> };
      expect(listed.entries.some((e) => e.name === 'session.js')).toBe(true);

      const write = tools.write_file!;
      const read = tools.read_file!;
      write.run({ path: 'hello.txt', content: 'hi' });
      const got = read.run({ path: 'hello.txt' }) as { content: string; totalLines: number };
      expect(got.content).toContain('hi');
      expect(got.totalLines).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('str_replace edits a unique match and rejects ambiguous / missing strings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      const tmp = new Workspace(dir);
      const tools = Object.fromEntries(createFsTools(tmp).map((t) => [t.name, t]));
      tools.write_file!.run({
        path: 'a.ts',
        content: 'const a = 1;\nconst b = 1;\nconst a = 1;\n',
      });

      const once = tools.str_replace!.run({
        path: 'a.ts',
        old_string: 'const b = 1;',
        new_string: 'const b = 2;',
      }) as { replacements: number };
      expect(once.replacements).toBe(1);

      expect(() =>
        tools.str_replace!.run({
          path: 'a.ts',
          old_string: 'const a = 1;',
          new_string: 'const a = 3;',
        }),
      ).toThrow(/found 2 times/);

      const all = tools.str_replace!.run({
        path: 'a.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 3;',
        replace_all: true,
      }) as { replacements: number };
      expect(all.replacements).toBe(2);

      const got = tools.read_file!.run({ path: 'a.ts' }) as { content: string };
      expect(got.content).toContain('const b = 2;');
      expect(got.content).toContain('const a = 3;');
      expect(got.content).not.toContain('const a = 1;');

      expect(() =>
        tools.str_replace!.run({
          path: 'a.ts',
          old_string: 'missing',
          new_string: 'x',
        }),
      ).toThrow(/not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('str_replace hints when old_string only mismatches whitespace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      const tmp = new Workspace(dir);
      const tools = Object.fromEntries(createFsTools(tmp).map((t) => [t.name, t]));
      tools.write_file!.run({
        path: 'loop.ts',
        content: '/** Context passed to error handlers. */\nexport type Ctx = {};\n',
      });

      expect(() =>
        tools.str_replace!.run({
          path: 'loop.ts',
          old_string: '  /** Context passed to error handlers. */',
          new_string: '/** Short. */',
        }),
      ).toThrow(/whitespace-only mismatch near line 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('read_file returns pagination metadata and supports negative offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      const tmp = new Workspace(dir);
      const tools = Object.fromEntries(createFsTools(tmp).map((t) => [t.name, t]));
      const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
      tools.write_file!.run({ path: 'n.txt', content: lines.join('\n') });

      const page = tools.read_file!.run({ path: 'n.txt', offset: 3, limit: 2 }) as {
        content: string;
        totalLines: number;
        startLine: number;
        endLine: number;
        truncated: boolean;
      };
      expect(page.totalLines).toBe(10);
      expect(page.startLine).toBe(3);
      expect(page.endLine).toBe(4);
      expect(page.truncated).toBe(true);
      expect(page.content).toContain('3|L3');
      expect(page.content).toContain('4|L4');

      const tail = tools.read_file!.run({ path: 'n.txt', offset: -2, limit: 2 }) as {
        startLine: number;
        endLine: number;
        content: string;
        truncated: boolean;
      };
      expect(tail.startLine).toBe(9);
      expect(tail.endLine).toBe(10);
      expect(tail.truncated).toBe(false);
      expect(tail.content).toContain('9|L9');
      expect(tail.content).toContain('10|L10');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('grep supports glob, context, and output modes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'a.ts'), 'alpha\nfindme here\nomega\n', 'utf8');
      writeFileSync(join(dir, 'src', 'b.js'), 'findme in js\n', 'utf8');
      writeFileSync(join(dir, 'readme.md'), 'findme in md\n', 'utf8');

      const tmp = new Workspace(dir);
      const tools = Object.fromEntries(createFsTools(tmp).map((t) => [t.name, t]));

      const content = tools.grep!.run({
        query: 'findme',
        glob: '*.ts',
        context: 1,
        literal: true,
      }) as {
        mode: string;
        matches: Array<{ path: string; line: number; text: string; before?: string[]; after?: string[] }>;
        truncated: boolean;
      };
      expect(content.mode).toBe('content');
      expect(content.matches).toHaveLength(1);
      expect(content.matches[0]!.path).toBe('src/a.ts');
      expect(content.matches[0]!.before).toEqual(['alpha']);
      expect(content.matches[0]!.after).toEqual(['omega']);

      const files = tools.grep!.run({
        query: 'findme',
        outputMode: 'files_with_matches',
        literal: true,
      }) as { files: string[]; matches: unknown[] };
      expect(files.files.sort()).toEqual(['readme.md', 'src/a.ts', 'src/b.js']);
      expect(files.matches).toEqual([]);

      const counts = tools.grep!.run({
        query: 'findme',
        glob: 'src/*',
        outputMode: 'count',
        literal: true,
      }) as { counts: Array<{ path: string; count: number }> };
      expect(counts.counts).toEqual(
        expect.arrayContaining([
          { path: 'src/a.ts', count: 1 },
          { path: 'src/b.js', count: 1 },
        ]),
      );
      expect(counts.counts).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delete_file removes a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      const tmp = new Workspace(dir);
      const tools = Object.fromEntries(createFsTools(tmp).map((t) => [t.name, t]));
      tools.write_file!.run({ path: 'gone.txt', content: 'x' });
      expect(existsSync(join(dir, 'gone.txt'))).toBe(true);
      tools.delete_file!.run({ path: 'gone.txt' });
      expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

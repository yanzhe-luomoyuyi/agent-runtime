import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Workspace, WorkspaceEscapeError } from '../src/workspace.js';
import { compileGlob, createFsTools } from '../src/tools/fs-tools.js';

describe('Workspace', () => {
  it('resolves relative paths inside root', () => {
    const ws = new Workspace(join(import.meta.dirname, '../fixtures/coding-sandbox'));
    expect(ws.resolve('src/session.js')).toContain('session.js');
  });

  it('rejects escape via ..', () => {
    const ws = new Workspace(join(import.meta.dirname, '../fixtures/coding-sandbox'));
    expect(() => ws.resolve('../package.json')).toThrow(WorkspaceEscapeError);
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

  it('list_dir / read_file / write_file round-trip in a temp copy path', () => {
    const fixture = join(import.meta.dirname, '../fixtures/coding-sandbox');
    const ws = new Workspace(fixture);
    const tools = Object.fromEntries(createFsTools(ws).map((t) => [t.name, t]));
    const listed = tools.list_dir!.run({ path: 'src' }) as { entries: Array<{ name: string }> };
    expect(listed.entries.some((e) => e.name === 'session.js')).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'coding-ws-'));
    try {
      const tmp = new Workspace(dir);
      const write = createFsTools(tmp).find((t) => t.name === 'write_file')!;
      const read = createFsTools(tmp).find((t) => t.name === 'read_file')!;
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

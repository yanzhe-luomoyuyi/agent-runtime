import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Workspace, WorkspaceEscapeError } from '../src/workspace.js';
import { createFsTools } from '../src/tools/fs-tools.js';

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

describe('fs tools', () => {
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
      const got = read.run({ path: 'hello.txt' }) as { content: string };
      expect(got.content).toContain('hi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

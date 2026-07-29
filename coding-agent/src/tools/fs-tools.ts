/**
 * Filesystem tools bound to a Workspace — general-ready (root is injected).
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ToolDef } from 'durable-agent-runtime';

import { createWorkspaceIgnorer } from '../gitignore.js';
import { walkWorkspace } from '../walk-workspace.js';
import { Workspace, WorkspaceEscapeError } from '../workspace.js';

export interface FsToolsOptions {
  readFileDefaultLimit?: number;
  readFileMaxChars?: number;
  grepDefaultMatches?: number;
}

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_CHARS = 80_000;
const DEFAULT_GREP_MATCHES = 40;

export function createFsTools(workspace: Workspace, opts: FsToolsOptions = {}): ToolDef[] {
  const readLimit = opts.readFileDefaultLimit ?? DEFAULT_READ_LIMIT;
  const maxReadChars = opts.readFileMaxChars ?? MAX_READ_CHARS;
  const grepMatches = opts.grepDefaultMatches ?? DEFAULT_GREP_MATCHES;
  const ignorer = createWorkspaceIgnorer(workspace.rootDir);

  const list_dir: ToolDef<{ path?: string }, { entries: Array<{ name: string; type: 'file' | 'dir' }> }> = {
    name: 'list_dir',
    description: 'List files and directories under a workspace-relative path (default "."). Honors .gitignore.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path inside the workspace.' } },
    },
    run: ({ path }) => {
      const abs = workspace.resolve(path ?? '.');
      const baseRel = workspace.relative(abs);
      const entries = readdirSync(abs, { withFileTypes: true })
        .map((d) => ({
          name: d.name,
          type: d.isDirectory() ? ('dir' as const) : ('file' as const),
        }))
        .filter((e) => {
          const rel = baseRel === '.' ? e.name : join(baseRel, e.name).split('\\').join('/');
          return !(ignorer.ignores(rel) || (e.type === 'dir' && ignorer.ignores(`${rel}/`)));
        });
      return { entries };
    },
  };

  const grep: ToolDef<
    { query: string; path?: string; maxMatches?: number },
    { matches: Array<{ path: string; line: number; text: string }> }
  > = {
    name: 'grep',
    description: 'Search file contents for a substring or JS regex. Scoped to the workspace; skips gitignored paths.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: 'Subdirectory or file to search (default ".").' },
        maxMatches: { type: 'number' },
      },
      required: ['query'],
    },
    run: ({ query, path, maxMatches }) => {
      if (!query) return { matches: [] };
      let pattern: RegExp;
      try {
        pattern = new RegExp(query, 'i');
      } catch {
        pattern = new RegExp(escapeRegExp(query), 'i');
      }
      const cap = Math.min(maxMatches ?? grepMatches, 200);
      const start = workspace.resolve(path ?? '.');
      const matches: Array<{ path: string; line: number; text: string }> = [];

      let st;
      try {
        st = statSync(start);
      } catch (e) {
        if (e instanceof WorkspaceEscapeError) throw e;
        return { matches };
      }

      const considerFile = (fileAbs: string): boolean => {
        if (matches.length >= cap) return false;
        let text: string;
        try {
          text = readFileSync(fileAbs, 'utf8');
        } catch {
          return true;
        }
        if (text.includes('\0')) return true;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= cap) return false;
          const line = lines[i]!;
          if (pattern.test(line)) {
            matches.push({
              path: workspace.relative(fileAbs),
              line: i + 1,
              text: line.slice(0, 400),
            });
          }
        }
        return true;
      };

      if (st.isFile()) {
        const rel = workspace.relative(start);
        if (!ignorer.ignores(rel)) considerFile(start);
        return { matches };
      }

      walkWorkspace(
        workspace.rootDir,
        (fileAbs) => considerFile(fileAbs),
        { startDir: start, ignorer },
      );
      return { matches };
    },
  };

  const read_file: ToolDef<
    { path: string; offset?: number; limit?: number },
    { path: string; content: string; truncated: boolean }
  > = {
    name: 'read_file',
    description: 'Read a text file (1-based offset line, limit lines). Caps total characters.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', description: '1-based start line (default 1).' },
        limit: { type: 'number', description: 'Max lines to return.' },
      },
      required: ['path'],
    },
    run: ({ path, offset, limit }) => {
      const abs = workspace.resolve(path);
      const st = statSync(abs);
      if (!st.isFile()) throw new Error(`not a file: ${path}`);
      const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
      const start = Math.max(1, offset ?? 1);
      const maxLines = Math.min(limit ?? readLimit, 2000);
      const slice = lines.slice(start - 1, start - 1 + maxLines);
      let content = slice.map((l, i) => `${start + i}|${l}`).join('\n');
      let truncated = start - 1 + maxLines < lines.length;
      if (content.length > maxReadChars) {
        content = content.slice(0, maxReadChars);
        truncated = true;
      }
      return { path: workspace.relative(abs), content, truncated };
    },
  };

  const write_file: ToolDef<{ path: string; content: string }, { path: string; bytes: number }> = {
    name: 'write_file',
    description:
      'Write full file contents at a workspace-relative path (creates parents). Prefer idempotent full rewrites.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    run: ({ path, content }) => {
      if (typeof content !== 'string') throw new Error('write_file requires string content');
      const abs = workspace.resolve(path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      return { path: workspace.relative(abs), bytes: Buffer.byteLength(content, 'utf8') };
    },
  };

  return [list_dir, grep, read_file, write_file] as ToolDef[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

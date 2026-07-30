/**
 * Filesystem tools bound to a Workspace — general-ready (root is injected).
 */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ToolDef } from 'durable-agent-runtime';

import { createWorkspaceIgnorer } from '../gitignore.js';
import { walkWorkspace } from '../walk-workspace.js';
import { Workspace, WorkspaceEscapeError } from '../workspace.js';
import { applyPatchToWorkspace } from './apply-patch.js';

export interface FsToolsOptions {
  readFileDefaultLimit?: number;
  readFileMaxChars?: number;
  grepDefaultMatches?: number;
  /** Skip files larger than this when grepping (bytes). */
  grepMaxFileBytes?: number;
}

const DEFAULT_READ_LIMIT = 200;
const MAX_READ_CHARS = 80_000;
const DEFAULT_GREP_MATCHES = 40;
const DEFAULT_GREP_MAX_FILE_BYTES = 1_000_000;

/** FS tools that mutate the workspace — gated by HITL / auto-approve together. */
export const MUTATING_FS_TOOLS = ['write_file', 'str_replace', 'delete_file', 'apply_patch'] as const;

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';

export function createFsTools(workspace: Workspace, opts: FsToolsOptions = {}): ToolDef[] {
  const readLimit = opts.readFileDefaultLimit ?? DEFAULT_READ_LIMIT;
  const maxReadChars = opts.readFileMaxChars ?? MAX_READ_CHARS;
  const grepMatches = opts.grepDefaultMatches ?? DEFAULT_GREP_MATCHES;
  const grepMaxFileBytes = opts.grepMaxFileBytes ?? DEFAULT_GREP_MAX_FILE_BYTES;
  const ignorer = createWorkspaceIgnorer(workspace.rootDir);

  const list_dir: ToolDef<{ path?: string }, { entries: Array<{ name: string; type: 'file' | 'dir' }> }> = {
    name: 'list_dir',
    description:
      'List one directory level under a workspace-relative path (default "."). Honors .gitignore. ' +
      'For multi-level layout discovery prefer list_tree (depth=2) instead of calling list_dir on every child.',
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

  const list_tree: ToolDef<
    { path?: string; depth?: number; maxEntries?: number },
    { tree: string; truncated: boolean; entries: number; depth: number }
  > = {
    name: 'list_tree',
    description:
      'Show a shallow directory tree (default depth 2) under a workspace path. ' +
      'Use this once for layout discovery instead of many list_dir calls. Honors .gitignore.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path inside the workspace (default ".").' },
        depth: { type: 'number', description: 'Max directory depth to expand (default 2, max 4).' },
        maxEntries: {
          type: 'number',
          description: 'Cap on files+dirs listed (default 200, max 500). Truncates with a marker.',
        },
      },
    },
    run: ({ path, depth, maxEntries }) => {
      const maxDepth = Math.min(4, Math.max(1, Math.floor(depth ?? 2)));
      const cap = Math.min(500, Math.max(1, Math.floor(maxEntries ?? 200)));
      const absRoot = workspace.resolve(path ?? '.');
      const baseRel = workspace.relative(absRoot);
      const lines: string[] = [];
      let counted = 0;
      let truncated = false;

      const walk = (abs: string, rel: string, level: number, prefix: string): void => {
        if (truncated || counted >= cap) {
          truncated = true;
          return;
        }
        let entries: Array<{ name: string; type: 'file' | 'dir' }>;
        try {
          entries = readdirSync(abs, { withFileTypes: true })
            .map((d) => ({
              name: d.name,
              type: d.isDirectory() ? ('dir' as const) : ('file' as const),
            }))
            .filter((e) => {
              const childRel = rel === '.' ? e.name : `${rel}/${e.name}`;
              return !(ignorer.ignores(childRel) || (e.type === 'dir' && ignorer.ignores(`${childRel}/`)));
            })
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
        } catch {
          return;
        }

        for (let i = 0; i < entries.length; i++) {
          if (counted >= cap) {
            truncated = true;
            lines.push(`${prefix}… (truncated at ${cap} entries)`);
            return;
          }
          const e = entries[i]!;
          const last = i === entries.length - 1;
          const branch = last ? '└── ' : '├── ';
          const childRel = rel === '.' ? e.name : `${rel}/${e.name}`;
          lines.push(`${prefix}${branch}${e.name}${e.type === 'dir' ? '/' : ''}`);
          counted += 1;
          if (e.type === 'dir' && level < maxDepth) {
            const nextPrefix = prefix + (last ? '    ' : '│   ');
            walk(join(abs, e.name), childRel, level + 1, nextPrefix);
          }
        }
      };

      const rootLabel = baseRel === '.' ? '.' : baseRel;
      lines.push(`${rootLabel}/`);
      walk(absRoot, baseRel === '.' ? '.' : baseRel, 1, '');
      return { tree: lines.join('\n'), truncated, entries: counted, depth: maxDepth };
    },
  };

  const grep: ToolDef<
    {
      query: string;
      path?: string;
      maxMatches?: number;
      glob?: string;
      caseSensitive?: boolean;
      literal?: boolean;
      context?: number;
      outputMode?: GrepOutputMode;
    },
    {
      mode: GrepOutputMode;
      truncated: boolean;
      matches: Array<{ path: string; line: number; text: string; before?: string[]; after?: string[] }>;
      files: string[];
      counts: Array<{ path: string; count: number }>;
    }
  > = {
    name: 'grep',
    description:
      'Search file contents for a substring or JS regex (skips gitignored paths). ' +
      'Use glob to narrow files (e.g. "*.ts", "src/**/*.js"). ' +
      'Prefer outputMode=files_with_matches or count for discovery; use content (+ optional context) when you need the matching lines. ' +
      'Then read_file only the relevant slices.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string', description: 'Subdirectory or file to search (default ".").' },
        maxMatches: { type: 'number', description: 'Cap on matches / files / counted paths (default 40, max 200).' },
        glob: {
          type: 'string',
          description: 'Optional file glob filter (e.g. "*.ts", "**/*.{ts,tsx}" — brace expansion supported).',
        },
        caseSensitive: { type: 'boolean', description: 'Default false (case-insensitive).' },
        literal: { type: 'boolean', description: 'If true, treat query as literal substring (not regex).' },
        context: {
          type: 'number',
          description: 'For content mode: lines of context before/after each match (0–10).',
        },
        outputMode: {
          type: 'string',
          description: 'content (default) | files_with_matches | count',
          enum: ['content', 'files_with_matches', 'count'],
        },
      },
      required: ['query'],
    },
    run: ({ query, path, maxMatches, glob, caseSensitive, literal, context, outputMode }) => {
      const mode: GrepOutputMode =
        outputMode === 'files_with_matches' || outputMode === 'count' ? outputMode : 'content';
      const empty = { mode, truncated: false, matches: [], files: [] as string[], counts: [] as Array<{ path: string; count: number }> };
      if (!query) return empty;

      const flags = caseSensitive ? '' : 'i';
      let pattern: RegExp;
      if (literal) {
        pattern = new RegExp(escapeRegExp(query), flags);
      } else {
        try {
          pattern = new RegExp(query, flags);
        } catch {
          pattern = new RegExp(escapeRegExp(query), flags);
        }
      }

      const cap = Math.min(Math.max(1, maxMatches ?? grepMatches), 200);
      const ctx = Math.min(Math.max(0, Math.floor(context ?? 0)), 10);
      const globRe = glob ? compileGlob(glob) : null;
      const start = workspace.resolve(path ?? '.');

      const matches: Array<{ path: string; line: number; text: string; before?: string[]; after?: string[] }> = [];
      const files: string[] = [];
      const counts: Array<{ path: string; count: number }> = [];
      let truncated = false;

      let st;
      try {
        st = statSync(start);
      } catch (e) {
        if (e instanceof WorkspaceEscapeError) throw e;
        return empty;
      }

      const acceptRel = (rel: string): boolean => !globRe || globRe.test(rel);

      const considerFile = (fileAbs: string): boolean => {
        const rel = workspace.relative(fileAbs);
        if (!acceptRel(rel)) return true;

        let text: string;
        try {
          text = readFileSync(fileAbs, 'utf8');
        } catch {
          return true;
        }
        if (text.includes('\0')) return true;

        const lines = text.split(/\r?\n/);

        if (mode === 'files_with_matches') {
          for (const line of lines) {
            if (pattern.test(line)) {
              files.push(rel);
              if (files.length >= cap) {
                truncated = true;
                return false;
              }
              return true;
            }
          }
          return true;
        }

        if (mode === 'count') {
          let n = 0;
          for (const line of lines) {
            if (pattern.test(line)) n += 1;
          }
          if (n > 0) {
            counts.push({ path: rel, count: n });
            if (counts.length >= cap) {
              truncated = true;
              return false;
            }
          }
          return true;
        }

        // content mode
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (!pattern.test(line)) continue;
          const entry: (typeof matches)[number] = {
            path: rel,
            line: i + 1,
            text: line.slice(0, 400),
          };
          if (ctx > 0) {
            entry.before = lines.slice(Math.max(0, i - ctx), i).map((l) => l.slice(0, 400));
            entry.after = lines.slice(i + 1, i + 1 + ctx).map((l) => l.slice(0, 400));
          }
          matches.push(entry);
          if (matches.length >= cap) {
            truncated = true;
            return false;
          }
        }
        return true;
      };

      if (st.isFile()) {
        const rel = workspace.relative(start);
        if (!ignorer.ignores(rel)) considerFile(start);
        return { mode, truncated, matches, files, counts };
      }

      walkWorkspace(
        workspace.rootDir,
        (fileAbs) => considerFile(fileAbs),
        { startDir: start, ignorer, maxFileBytes: grepMaxFileBytes },
      );
      return { mode, truncated, matches, files, counts };
    },
  };

  const read_file: ToolDef<
    { path: string; offset?: number; limit?: number },
    {
      path: string;
      content: string;
      truncated: boolean;
      totalLines: number;
      startLine: number;
      endLine: number;
    }
  > = {
    name: 'read_file',
    description:
      'Read a text file by line window. Prefer small slices: use offset/limit after grep, not whole-file reads. ' +
      'offset is 1-based; negative offset counts from the end (-1 = last line). ' +
      'Returns totalLines / startLine / endLine so you can paginate.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: {
          type: 'number',
          description: '1-based start line (default 1). Negative counts from end (-1 = last line).',
        },
        limit: { type: 'number', description: 'Max lines to return (default 200, max 2000).' },
      },
      required: ['path'],
    },
    run: ({ path, offset, limit }) => {
      const abs = workspace.resolve(path);
      const st = statSync(abs);
      if (!st.isFile()) throw new Error(`not a file: ${path}`);
      const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
      const totalLines = lines.length;
      const maxLines = Math.min(Math.max(1, limit ?? readLimit), 2000);

      let start: number;
      if (offset === undefined) {
        start = 1;
      } else if (offset < 0) {
        // -1 → last line; -N with limit N → last N lines
        start = Math.max(1, totalLines + offset + 1);
      } else {
        start = Math.max(1, Math.floor(offset));
      }

      const slice = lines.slice(start - 1, start - 1 + maxLines);
      const endLine = slice.length === 0 ? start - 1 : start + slice.length - 1;
      let content = slice.map((l, i) => `${start + i}|${l}`).join('\n');
      let truncated = start - 1 + maxLines < totalLines;
      if (content.length > maxReadChars) {
        content = content.slice(0, maxReadChars);
        truncated = true;
      }
      return {
        path: workspace.relative(abs),
        content,
        truncated,
        totalLines,
        startLine: start,
        endLine,
      };
    },
  };

  const write_file: ToolDef<{ path: string; content: string }, { path: string; bytes: number }> = {
    name: 'write_file',
    description:
      'Create a new file or overwrite an entire file at a workspace-relative path (creates parents). ' +
      'For editing an existing file, prefer str_replace — only use write_file for new files or intentional full rewrites.',
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

  const str_replace: ToolDef<
    { path: string; old_string: string; new_string: string; replace_all?: boolean },
    { path: string; replacements: number; bytes: number }
  > = {
    name: 'str_replace',
    description:
      'Edit an existing file by replacing an exact string match. Prefer this over write_file for partial edits. ' +
      'old_string must match the file exactly (including whitespace). ' +
      'Fails if old_string is missing or not unique unless replace_all is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string', description: 'Exact text to find in the file.' },
        new_string: { type: 'string', description: 'Replacement text (may be empty to delete).' },
        replace_all: {
          type: 'boolean',
          description: 'If true, replace every occurrence; otherwise require exactly one match.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    run: ({ path, old_string, new_string, replace_all }) => {
      if (typeof old_string !== 'string' || typeof new_string !== 'string') {
        throw new Error('str_replace requires string old_string and new_string');
      }
      if (old_string.length === 0) throw new Error('str_replace old_string must be non-empty');
      if (old_string === new_string) throw new Error('str_replace old_string and new_string are identical');

      const abs = workspace.resolve(path);
      const st = statSync(abs);
      if (!st.isFile()) throw new Error(`not a file: ${path}`);

      const before = readFileSync(abs, 'utf8');
      const occurrences = countOccurrences(before, old_string);
      if (occurrences === 0) {
        throw new Error(`str_replace: old_string not found in ${workspace.relative(abs)}`);
      }
      if (!replace_all && occurrences > 1) {
        throw new Error(
          `str_replace: old_string found ${occurrences} times in ${workspace.relative(abs)}; ` +
            'provide a more unique old_string or set replace_all=true',
        );
      }

      const after = replace_all
        ? before.split(old_string).join(new_string)
        : before.replace(old_string, new_string);
      writeFileSync(abs, after, 'utf8');
      return {
        path: workspace.relative(abs),
        replacements: replace_all ? occurrences : 1,
        bytes: Buffer.byteLength(after, 'utf8'),
      };
    },
  };

  const delete_file: ToolDef<{ path: string }, { path: string; deleted: true }> = {
    name: 'delete_file',
    description: 'Delete a file at a workspace-relative path. Fails if the path is missing or not a file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    run: ({ path }) => {
      const abs = workspace.resolve(path);
      const st = statSync(abs);
      if (!st.isFile()) throw new Error(`not a file: ${path}`);
      unlinkSync(abs);
      return { path: workspace.relative(abs), deleted: true as const };
    },
  };

  const apply_patch: ToolDef<
    { patch: string },
    { actions: Array<{ type: string; path: string; to?: string }>; filesChanged: number }
  > = {
    name: 'apply_patch',
    description:
      'Apply a V4A patch (Codex/OpenAI style) to create/update/delete one or more files in one call. ' +
      'Prefer this for multi-hunk or multi-file edits; use str_replace for a single exact swap. ' +
      'Patch must use relative paths and the *** Begin Patch / *** End Patch envelope. ' +
      'Hunk lines start with space (context), - (remove), or + (add). ' +
      'Example:\n' +
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch',
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: 'Full V4A patch text including Begin/End Patch markers.',
        },
      },
      required: ['patch'],
    },
    run: ({ patch }) => {
      if (typeof patch !== 'string' || !patch.trim()) {
        throw new Error('apply_patch requires a non-empty patch string');
      }
      const { actions } = applyPatchToWorkspace(workspace, patch);
      return { actions, filesChanged: actions.length };
    },
  };

  return [list_dir, list_tree, grep, read_file, write_file, str_replace, delete_file, apply_patch] as ToolDef[];
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a simple glob to RegExp. Supports *, ?, **, and {a,b} braces.
 * Patterns without `/` match any depth (e.g. "*.ts" → "**\/\.ts").
 */
export function compileGlob(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  const withDepth = normalized.includes('/') ? normalized : `**/${normalized}`;
  const alts = expandBraces(withDepth);
  const body = alts.map((g) => globPieceToRegExp(g)).join('|');
  return new RegExp(`^(?:${body})$`);
}

function expandBraces(pattern: string): string[] {
  const m = pattern.match(/\{([^{}]+)\}/);
  if (!m || m.index === undefined) return [pattern];
  const i = m.index;
  const before = pattern.slice(0, i);
  const after = pattern.slice(i + m[0].length);
  const choices = m[1]!.split(',');
  return choices.flatMap((c) => expandBraces(before + c + after));
}

function globPieceToRegExp(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob[i] === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += 2;
      continue;
    }
    const ch = glob[i]!;
    if (ch === '*') {
      out += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (/[\\.^$|()[\]{}+]/.test(ch)) {
      out += `\\${ch}`;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

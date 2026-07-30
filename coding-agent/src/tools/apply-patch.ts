/**
 * V4A apply_patch — Codex / OpenAI-style envelope for multi-file edits.
 *
 * Format (relative paths only):
 *   *** Begin Patch
 *   *** Add File: path
 *   +line
 *   *** Update File: path
 *   *** Move to: newPath   (optional)
 *   @@ [optional anchor]
 *    context
 *   -removed
 *   +added
 *   *** Delete File: path
 *   *** End Patch
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Workspace } from '../workspace.js';

export type PatchAction =
  | { type: 'add'; path: string }
  | { type: 'update'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'move'; path: string; to: string };

export interface ApplyPatchResult {
  actions: PatchAction[];
}

type FileOp =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; diffLines: string[] };

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const END_FILE = '*** End of File';

/** Apply a full V4A patch envelope inside a Workspace sandbox. */
export function applyPatchToWorkspace(workspace: Workspace, patchText: string): ApplyPatchResult {
  const ops = parsePatchEnvelope(patchText);
  if (ops.length === 0) throw new Error('apply_patch: patch contains no file operations');

  const actions: PatchAction[] = [];

  for (const op of ops) {
    if (op.kind === 'add') {
      const abs = workspace.resolve(op.path);
      if (existsSync(abs)) throw new Error(`apply_patch: Add File target already exists: ${op.path}`);
      mkdirSync(dirname(abs), { recursive: true });
      const content = op.lines.join('\n');
      writeFileSync(abs, content, 'utf8');
      actions.push({ type: 'add', path: workspace.relative(abs) });
      continue;
    }

    if (op.kind === 'delete') {
      const abs = workspace.resolve(op.path);
      const st = statSync(abs);
      if (!st.isFile()) throw new Error(`apply_patch: Delete File is not a file: ${op.path}`);
      unlinkSync(abs);
      actions.push({ type: 'delete', path: workspace.relative(abs) });
      continue;
    }

    // update (+ optional move)
    const abs = workspace.resolve(op.path);
    const st = statSync(abs);
    if (!st.isFile()) throw new Error(`apply_patch: Update File is not a file: ${op.path}`);
    const before = readFileSync(abs, 'utf8');
    const after = op.diffLines.length === 0 ? before : applyDiff(before, op.diffLines);

    if (op.moveTo) {
      const dest = workspace.resolve(op.moveTo);
      if (existsSync(dest) && dest !== abs) {
        throw new Error(`apply_patch: Move to target already exists: ${op.moveTo}`);
      }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, after, 'utf8');
      if (dest !== abs) unlinkSync(abs);
      actions.push({
        type: 'move',
        path: workspace.relative(abs),
        to: workspace.relative(dest),
      });
    } else {
      writeFileSync(abs, after, 'utf8');
      actions.push({ type: 'update', path: workspace.relative(abs) });
    }
  }

  return { actions };
}

/** Parse *** Begin Patch … *** End Patch into ordered file ops. */
export function parsePatchEnvelope(patchText: string): FileOp[] {
  const lines = normalizeLines(patchText);
  let start = lines.findIndex((l) => l === BEGIN);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === END) {
      end = i;
      break;
    }
  }

  // Allow a bare body without envelope for slightly more forgiving callers.
  let body: string[];
  if (start >= 0 && end > start) {
    body = lines.slice(start + 1, end);
  } else if (start < 0 && end < 0 && lines.some((l) => l.startsWith('*** '))) {
    body = lines;
  } else {
    throw new Error('apply_patch: missing *** Begin Patch / *** End Patch envelope');
  }

  const ops: FileOp[] = [];
  let i = 0;
  while (i < body.length) {
    const line = body[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      if (!path) throw new Error('apply_patch: Add File missing path');
      i += 1;
      const addLines: string[] = [];
      while (i < body.length && !body[i]!.startsWith('*** ')) {
        const raw = body[i]!;
        if (!raw.startsWith('+')) throw new Error(`apply_patch: invalid Add File line: ${raw}`);
        addLines.push(raw.slice(1));
        i += 1;
      }
      ops.push({ kind: 'add', path, lines: addLines });
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      if (!path) throw new Error('apply_patch: Delete File missing path');
      ops.push({ kind: 'delete', path });
      i += 1;
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      if (!path) throw new Error('apply_patch: Update File missing path');
      i += 1;
      let moveTo: string | undefined;
      if (i < body.length && body[i]!.startsWith('*** Move to: ')) {
        moveTo = body[i]!.slice('*** Move to: '.length).trim();
        if (!moveTo) throw new Error('apply_patch: Move to missing path');
        i += 1;
      }
      const diffStart = i;
      while (i < body.length && !isFileOpHeader(body[i]!)) i += 1;
      ops.push({ kind: 'update', path, moveTo, diffLines: body.slice(diffStart, i) });
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }
    throw new Error(`apply_patch: unexpected line in patch: ${line}`);
  }

  return ops;
}

function isFileOpHeader(line: string): boolean {
  return (
    line.startsWith('*** Add File: ') ||
    line.startsWith('*** Delete File: ') ||
    line.startsWith('*** Update File: ')
  );
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ''))
    .filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
}

// --- V4A update diff (adapted from openai-agents-js applyDiff) ----------------

type Chunk = { origIndex: number; delLines: string[]; insLines: string[] };

/** Apply headerless V4A hunks to existing file content. */
export function applyDiff(input: string, diffLines: string[]): string {
  const { chunks } = parseUpdateDiff(diffLines, input);
  return applyChunks(input, chunks);
}

type ParserState = { lines: string[]; index: number; fuzz: number };

function parseUpdateDiff(lines: string[], input: string): { chunks: Chunk[]; fuzz: number } {
  const parser: ParserState = { lines: [...lines, END], index: 0, fuzz: 0 };
  const inputLines = input.split('\n');
  const chunks: Chunk[] = [];
  let cursor = 0;

  while (!isDone(parser, [END, '*** Update File:', '*** Delete File:', '*** Add File:', END_FILE])) {
    const anchor = readStr(parser, '@@ ');
    const hasBareAnchor = !anchor && parser.lines[parser.index] === '@@';
    if (hasBareAnchor) parser.index += 1;

    if (!(anchor || hasBareAnchor || cursor === 0)) {
      throw new Error(`apply_patch: invalid hunk line:\n${parser.lines[parser.index]}`);
    }

    if (anchor.trim()) {
      cursor = advanceCursorToAnchor(anchor, inputLines, cursor, parser);
    }

    const { nextContext, sectionChunks, endIndex, eof } = readSection(parser.lines, parser.index);
    const { newIndex, fuzz } = findContext(inputLines, nextContext, cursor, eof);

    if (newIndex === -1) {
      throw new Error(formatContextNotFoundError(inputLines, nextContext, cursor, eof));
    }

    parser.fuzz += fuzz;
    for (const ch of sectionChunks) {
      chunks.push({ ...ch, origIndex: ch.origIndex + newIndex });
    }

    cursor = newIndex + nextContext.length;
    parser.index = endIndex;
  }

  return { chunks, fuzz: parser.fuzz };
}

function isDone(state: ParserState, prefixes: string[]): boolean {
  if (state.index >= state.lines.length) return true;
  return prefixes.some((p) => state.lines[state.index]?.startsWith(p));
}

function readStr(state: ParserState, prefix: string): string {
  const current = state.lines[state.index];
  if (typeof current === 'string' && current.startsWith(prefix)) {
    state.index += 1;
    return current.slice(prefix.length);
  }
  return '';
}

function advanceCursorToAnchor(
  anchor: string,
  inputLines: string[],
  cursor: number,
  parser: ParserState,
): number {
  let found = false;

  if (!inputLines.slice(0, cursor).some((s) => s === anchor)) {
    for (let i = cursor; i < inputLines.length; i += 1) {
      if (inputLines[i] === anchor) {
        cursor = i + 1;
        found = true;
        break;
      }
    }
  }

  if (!found && !inputLines.slice(0, cursor).some((s) => s.trim() === anchor.trim())) {
    for (let i = cursor; i < inputLines.length; i += 1) {
      if (inputLines[i]!.trim() === anchor.trim()) {
        cursor = i + 1;
        parser.fuzz += 1;
        found = true;
        break;
      }
    }
  }

  return cursor;
}

function readSection(
  lines: string[],
  startIndex: number,
): {
  nextContext: string[];
  sectionChunks: Chunk[];
  endIndex: number;
  eof: boolean;
} {
  const context: string[] = [];
  let delLines: string[] = [];
  let insLines: string[] = [];
  const sectionChunks: Chunk[] = [];
  let mode: 'keep' | 'add' | 'delete' = 'keep';
  let index = startIndex;
  const origIndex = index;

  while (index < lines.length) {
    const raw = lines[index]!;
    if (
      raw.startsWith('@@') ||
      raw.startsWith(END) ||
      raw.startsWith('*** Update File:') ||
      raw.startsWith('*** Delete File:') ||
      raw.startsWith('*** Add File:') ||
      raw.startsWith(END_FILE)
    ) {
      break;
    }
    if (raw === '***') break;
    if (raw.startsWith('***')) throw new Error(`apply_patch: invalid line: ${raw}`);

    index += 1;
    const lastMode = mode;
    let line = raw === '' ? ' ' : raw;

    if (line[0] === '+') mode = 'add';
    else if (line[0] === '-') mode = 'delete';
    else if (line[0] === ' ') mode = 'keep';
    else throw new Error(`apply_patch: invalid hunk line (need ' '/'+'/'-' prefix): ${raw}`);

    line = line.slice(1);

    const switchingToContext = mode === 'keep' && lastMode !== mode;
    if (switchingToContext && (insLines.length || delLines.length)) {
      sectionChunks.push({
        origIndex: context.length - delLines.length,
        delLines,
        insLines,
      });
      delLines = [];
      insLines = [];
    }

    if (mode === 'delete') {
      delLines.push(line);
      context.push(line);
    } else if (mode === 'add') {
      insLines.push(line);
    } else {
      context.push(line);
    }
  }

  if (insLines.length || delLines.length) {
    sectionChunks.push({
      origIndex: context.length - delLines.length,
      delLines,
      insLines,
    });
  }

  if (index < lines.length && lines[index] === END_FILE) {
    index += 1;
    return { nextContext: context, sectionChunks, endIndex: index, eof: true };
  }

  if (index === origIndex) {
    throw new Error(`apply_patch: empty hunk section at index=${index}`);
  }

  return { nextContext: context, sectionChunks, endIndex: index, eof: false };
}

function findContext(
  lines: string[],
  context: string[],
  start: number,
  eof: boolean,
): { newIndex: number; fuzz: number } {
  if (eof) {
    const endStart = Math.max(0, lines.length - context.length);
    const endMatch = findContextCore(lines, context, endStart);
    if (endMatch.newIndex !== -1) return endMatch;
    const fallback = findContextCore(lines, context, start);
    return { newIndex: fallback.newIndex, fuzz: fallback.fuzz + 10000 };
  }
  return findContextCore(lines, context, start);
}

/** Pinpoint the first mismatched line instead of dumping the whole expected context. */
function formatContextNotFoundError(
  lines: string[],
  context: string[],
  start: number,
  eof: boolean,
): string {
  const prefix = eof
    ? `apply_patch: invalid EOF context (search from line ${start + 1})`
    : `apply_patch: context not found (search from line ${start + 1})`;

  if (!context.length) {
    return `${prefix}: empty context`;
  }

  let bestAt = start;
  let bestMatched = -1;
  const searchEnd = Math.max(start, lines.length - 1);
  for (let i = start; i <= searchEnd; i += 1) {
    let matched = 0;
    while (matched < context.length && i + matched < lines.length) {
      if (!lineFuzzEqual(lines[i + matched]!, context[matched]!)) break;
      matched += 1;
    }
    if (matched > bestMatched) {
      bestMatched = matched;
      bestAt = i;
    }
    if (i + context.length > lines.length && matched === 0 && i > start) break;
  }

  const mismatchIdx = bestMatched < 0 ? 0 : bestMatched;
  const fileLine = bestAt + mismatchIdx + 1;
  const expected = context[mismatchIdx] ?? '(end of expected context)';
  const actual =
    bestAt + mismatchIdx < lines.length ? lines[bestAt + mismatchIdx]! : '(EOF)';

  const detail =
    bestMatched > 0
      ? `matched ${bestMatched}/${context.length} lines from line ${bestAt + 1}; `
      : '';
  return (
    `${prefix}: ${detail}at file line ${fileLine}, ` +
    `expected ${JSON.stringify(clipErr(expected))} got ${JSON.stringify(clipErr(actual))}`
  );
}

function lineFuzzEqual(a: string, b: string): boolean {
  return a === b || a.trimEnd() === b.trimEnd() || a.trim() === b.trim();
}

function clipErr(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function findContextCore(
  lines: string[],
  context: string[],
  start: number,
): { newIndex: number; fuzz: number } {
  if (!context.length) return { newIndex: start, fuzz: 0 };

  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, (s) => s)) return { newIndex: i, fuzz: 0 };
  }
  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, (s) => s.trimEnd())) return { newIndex: i, fuzz: 1 };
  }
  for (let i = start; i < lines.length; i += 1) {
    if (equalsSlice(lines, context, i, (s) => s.trim())) return { newIndex: i, fuzz: 100 };
  }
  return { newIndex: -1, fuzz: 0 };
}

function equalsSlice(
  source: string[],
  target: string[],
  start: number,
  mapFn: (value: string) => string,
): boolean {
  if (start + target.length > source.length) return false;
  for (let i = 0; i < target.length; i += 1) {
    if (mapFn(source[start + i]!) !== mapFn(target[i]!)) return false;
  }
  return true;
}

function applyChunks(input: string, chunks: Chunk[]): string {
  const origLines = input.split('\n');
  const destLines: string[] = [];
  let origIndex = 0;

  for (const chunk of chunks) {
    if (chunk.origIndex > origLines.length) {
      throw new Error(
        `apply_patch: chunk.origIndex ${chunk.origIndex} > input length ${origLines.length}`,
      );
    }
    if (origIndex > chunk.origIndex) {
      throw new Error(
        `apply_patch: overlapping chunk at ${chunk.origIndex} (cursor ${origIndex})`,
      );
    }

    destLines.push(...origLines.slice(origIndex, chunk.origIndex));
    origIndex = chunk.origIndex;
    if (chunk.insLines.length) destLines.push(...chunk.insLines);
    origIndex += chunk.delLines.length;
  }

  destLines.push(...origLines.slice(origIndex));
  return destLines.join('\n');
}

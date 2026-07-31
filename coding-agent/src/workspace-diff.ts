/**
 * Snapshot workspace text files and produce unified-style diffs after a run.
 * Walks respect root `.gitignore` plus hard defaults (node_modules, .git, …).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { walkWorkspace } from './walk-workspace.js';

export type FileSnapshot = Record<string, string>;

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  before: string;
  after: string;
  /** Unified diff without headers (hunks only), or empty if identical. */
  unified: string;
}

const MAX_SNAPSHOT_BYTES = 512_000;
/** Skip full LCS when either side exceeds this many lines (O(n×m) cost). */
const MAX_DIFF_LINES = 4_000;

export function snapshotWorkspace(rootDir: string): FileSnapshot {
  const out: FileSnapshot = {};
  walkWorkspace(
    rootDir,
    (abs, rel) => {
      try {
        const text = readFileSync(abs, 'utf8');
        if (text.includes('\0')) return;
        out[rel] = text;
      } catch {
        // ignore unreadable
      }
    },
    { maxFileBytes: MAX_SNAPSHOT_BYTES },
  );
  return out;
}

export function diffSnapshots(before: FileSnapshot, after: FileSnapshot): FileDiff[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const a = before[path];
    const b = after[path];
    if (a === b) continue;
    if (a === undefined && b !== undefined) {
      diffs.push({ path, status: 'added', before: '', after: b, unified: unifiedDiff(path, '', b) });
    } else if (a !== undefined && b === undefined) {
      diffs.push({ path, status: 'deleted', before: a, after: '', unified: unifiedDiff(path, a, '') });
    } else {
      diffs.push({
        path,
        status: 'modified',
        before: a!,
        after: b!,
        unified: unifiedDiff(path, a!, b!),
      });
    }
  }
  return diffs;
}

export function readAnalysisMd(rootDir: string): string | null {
  const p = join(rootDir, 'ANALYSIS.md');
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Minimal Myers-inspired LCS line diff → unified hunks.
 * Only emits changed lines (`+`/`-`) and hunk headers — no unchanged context.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  // Drop trailing empty from final newline
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ file too large for line diff (${a.length} → ${b.length} lines; cap ${MAX_DIFF_LINES}) @@`,
      `-${a.length} lines`,
      `+${b.length} lines`,
    ].join('\n');
  }

  const edits = lineEdits(a, b);
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let i = 0;
  let j = 0;
  let hunk: string[] = [];
  let hunkStartA = 1;
  let hunkStartB = 1;
  let countA = 0;
  let countB = 0;

  const flush = () => {
    if (hunk.length === 0) return;
    lines.push(`@@ -${hunkStartA},${countA} +${hunkStartB},${countB} @@`);
    lines.push(...hunk);
    hunk = [];
    countA = 0;
    countB = 0;
  };

  for (const e of edits) {
    if (e.type === 'equal') {
      // Close the current change hunk; skip unchanged lines entirely.
      flush();
      i++;
      j++;
      continue;
    }
    if (hunk.length === 0) {
      hunkStartA = i + 1;
      hunkStartB = j + 1;
    }
    if (e.type === 'del') {
      hunk.push(`-${e.line}`);
      countA++;
      i++;
    } else {
      hunk.push(`+${e.line}`);
      countB++;
      j++;
    }
  }
  flush();
  return lines.join('\n');
}

type Edit = { type: 'equal' | 'del' | 'add'; line: string };

function lineEdits(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const edits: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      edits.push({ type: 'equal', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      edits.push({ type: 'del', line: a[i]! });
      i++;
    } else {
      edits.push({ type: 'add', line: b[j]! });
      j++;
    }
  }
  while (i < n) edits.push({ type: 'del', line: a[i++]! });
  while (j < m) edits.push({ type: 'add', line: b[j++]! });
  return edits;
}

/**
 * Long-term memory wiring for coding-agent — FileMemoryStore + tool names /
 * policy helpers. Scope is per workspace so repos do not share facts.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export const MEMORY_TOOL_NAMES = ['memory_write', 'memory_search', 'memory_read'] as const;

export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];

/** Stable scope id for a workspace root (path-sanitised hash). */
export function workspaceMemoryScope(workspaceRoot: string): string {
  const abs = resolve(workspaceRoot);
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 16);
  return `ws-${hash}`;
}

/** Merge memory tools into a policy allow-list (no-op when already present). */
export function withMemoryToolsAllowed(allowedTools: string[] | undefined): string[] {
  const base = allowedTools ? [...allowedTools] : [];
  for (const name of MEMORY_TOOL_NAMES) {
    if (!base.includes(name)) base.push(name);
  }
  return base;
}

/** Short instruction appended when long-term memory tools are registered. */
export const MEMORY_INSTRUCTIONS =
  'Long-term memory is enabled for this run. ' +
  'Call memory_search early when prior preferences or durable notes may help. ' +
  'Call memory_write for facts that should survive future sessions (user prefs, recurring pitfalls, project conventions). ' +
  'Do not store full file contents or secrets in memory.';

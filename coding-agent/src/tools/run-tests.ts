/**
 * Whitelisted test runner — no arbitrary shell in phase A.
 */

import { spawnSync } from 'node:child_process';

import type { ToolDef } from 'durable-agent-runtime';

import type { Workspace } from '../workspace.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 40_000;

export function createRunTestsTool(workspace: Workspace): ToolDef<Record<string, never>, {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return {
    name: 'run_tests',
    description: 'Run the workspace test suite (`npm test`). No arbitrary commands.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => {
      const result = spawnSync('npm', ['test'], {
        cwd: workspace.rootDir,
        encoding: 'utf8',
        timeout: DEFAULT_TIMEOUT_MS,
        shell: process.platform === 'win32',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      const stdout = truncate(result.stdout ?? '');
      const stderr = truncate(result.stderr ?? '');
      const exitCode = result.status;
      return {
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
      };
    },
  };
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]`;
}

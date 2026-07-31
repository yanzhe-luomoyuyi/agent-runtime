/**
 * Whitelisted test runner — no arbitrary shell in phase A.
 */

import { spawnSync } from 'node:child_process';

import type { ToolDef } from 'durable-agent-runtime';

import type { Workspace } from '../workspace.js';

export interface RunTestsOptions {
  /** argv: first element is the executable. Default `['npm', 'test']`. */
  command?: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
}

const DEFAULT_COMMAND = ['npm', 'test'];
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 40_000;

export function createRunTestsTool(
  workspace: Workspace,
  opts: RunTestsOptions = {},
): ToolDef<Record<string, never>, {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const command = opts.command?.length ? opts.command : DEFAULT_COMMAND;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const [bin, ...args] = command;
  if (!bin) throw new Error('runTests.command must be a non-empty argv array');

  return {
    name: 'run_tests',
    description: `Run the workspace test suite (\`${command.join(' ')}\`). No arbitrary commands.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => {
      const result = spawnSync(bin, args, {
        cwd: workspace.rootDir,
        encoding: 'utf8',
        timeout: timeoutMs,
        shell: process.platform === 'win32',
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      const stdout = truncate(result.stdout ?? '', maxOutputChars);
      let stderr = truncate(result.stderr ?? '', maxOutputChars);
      if (result.error) {
        const detail =
          result.error.message +
          (result.signal ? ` (signal=${result.signal})` : '') +
          ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
            ? ` — timed out after ${timeoutMs}ms`
            : '');
        stderr = stderr ? `${stderr}\n${detail}` : detail;
      }
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated]`;
}

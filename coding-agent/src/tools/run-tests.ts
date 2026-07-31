/**
 * Whitelisted test runner — no arbitrary shell in phase A.
 */

import { spawnSync } from 'node:child_process';

import { TransientError } from '@agent/harness';
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

/** Spawn / network errno codes that should be retried by RetryingToolInvoker. */
const TRANSIENT_ERRNO = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
]);

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
        const err = result.error as NodeJS.ErrnoException;
        if (err.code && TRANSIENT_ERRNO.has(err.code)) {
          throw new TransientError(
            `run_tests transient spawn failure (${err.code}): ${err.message}` +
              (result.signal ? ` (signal=${result.signal})` : ''),
          );
        }
        const detail =
          result.error.message +
          (result.signal ? ` (signal=${result.signal})` : '') +
          (err.code === 'ETIMEDOUT' ? ` — timed out after ${timeoutMs}ms` : '');
        stderr = stderr ? `${stderr}\n${detail}` : detail;
      }
      const exitCode = result.status;
      // npm registry / network blips often exit non-zero without result.error.
      if (exitCode !== 0 && looksLikeNpmNetworkBlip(stdout, stderr)) {
        throw new TransientError(
          `run_tests transient npm/network failure (exit=${exitCode}): ${summarizeBlip(stdout, stderr)}`,
        );
      }
      return {
        ok: exitCode === 0,
        exitCode,
        stdout,
        stderr,
      };
    },
  };
}

function looksLikeNpmNetworkBlip(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return (
    /npm err!.*(network|econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|tunneling socket)/i.test(
      text,
    ) ||
    /err_socket|getaddrinfo|connect econnrefused|read econnreset/.test(text)
  );
}

function summarizeBlip(stdout: string, stderr: string): string {
  const line =
    stderr
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /npm err|econn|etimedout|enotfound|network/i.test(l)) ??
    stderr.trim().split('\n')[0] ??
    stdout.trim().split('\n')[0] ??
    'network blip';
  return line.slice(0, 200);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated]`;
}

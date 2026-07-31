/**
 * Whitelisted verify recipes (test / build / typecheck / …) — no arbitrary shell.
 */

import { spawnSync } from 'node:child_process';

import { TransientError } from '@agent/harness';
import type { ToolDef } from 'durable-agent-runtime';

import type { Workspace } from '../workspace.js';

export interface VerifyRecipe {
  command: string[];
}

export interface VerifyOptions {
  recipes: Record<string, VerifyRecipe>;
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface VerifyResult {
  ok: boolean;
  recipe: string;
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
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

const NPM_FAMILY = new Set(['npm', 'npx', 'yarn', 'pnpm', 'bun']);

/**
 * Append filter / extra argv. For npm-family CLIs, insert `--` so args reach the
 * underlying runner (vitest/jest/tsc) instead of being eaten by npm.
 */
export function appendVerifyArgs(
  command: string[],
  opts: { filter?: string; extraArgs?: string[] } = {},
): string[] {
  const extras = [
    ...(opts.filter?.trim() ? [opts.filter.trim()] : []),
    ...(opts.extraArgs ?? []).filter((a) => a.length > 0),
  ];
  if (extras.length === 0) return [...command];
  const bin = (command[0] ?? '').toLowerCase();
  if (NPM_FAMILY.has(bin) && !command.includes('--') && extras[0] !== '--') {
    return [...command, '--', ...extras];
  }
  return [...command, ...extras];
}

export function runVerifyCommand(
  workspace: Workspace,
  recipe: string,
  command: string[],
  opts: { timeoutMs?: number; maxOutputChars?: number; toolLabel?: string } = {},
): VerifyResult {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const label = opts.toolLabel ?? `verify:${recipe}`;
  const [bin, ...args] = command;
  if (!bin) throw new Error(`${label}: command must be a non-empty argv array`);

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
        `${label} transient spawn failure (${err.code}): ${err.message}` +
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
  if (exitCode !== 0 && looksLikeNpmNetworkBlip(stdout, stderr)) {
    throw new TransientError(
      `${label} transient npm/network failure (exit=${exitCode}): ${summarizeBlip(stdout, stderr)}`,
    );
  }
  return {
    ok: exitCode === 0,
    recipe,
    command,
    exitCode,
    stdout,
    stderr,
  };
}

export function createRunTestsTool(
  workspace: Workspace,
  opts: {
    recipes?: Record<string, VerifyRecipe>;
    /** Legacy: used as recipes.test when that key is absent. */
    command?: string[];
    timeoutMs?: number;
    maxOutputChars?: number;
  } = {},
): ToolDef<{ filter?: string; extraArgs?: string[] }, VerifyResult> {
  const recipes = { ...(opts.recipes ?? {}) };
  if (opts.command?.length && !recipes.test) {
    recipes.test = { command: opts.command };
  }
  const testRecipe = recipes.test;
  if (!testRecipe?.command?.length) {
    throw new Error('verify.recipes.test.command must be a non-empty argv array');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const baseCommand = testRecipe.command;

  return {
    name: 'run_tests',
    description:
      `Run the workspace test recipe (\`${baseCommand.join(' ')}\`). ` +
      `Optional \`filter\` (file path or -t pattern) and \`extraArgs\` are appended; ` +
      `no arbitrary shell.`,
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description:
            'Optional vitest/jest filter: file path or test name pattern (passed after `--` for npm).',
        },
        extraArgs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra argv after the recipe command (and after `--` for npm-family).',
        },
      },
      additionalProperties: false,
    },
    run: (input) => {
      const command = appendVerifyArgs(baseCommand, {
        filter: input.filter,
        extraArgs: input.extraArgs,
      });
      return runVerifyCommand(workspace, 'test', command, {
        timeoutMs,
        maxOutputChars,
        toolLabel: 'run_tests',
      });
    },
  };
}

export function createRunCheckTool(
  workspace: Workspace,
  opts: VerifyOptions,
): ToolDef<{ recipe: string; extraArgs?: string[] }, VerifyResult> {
  const recipes = opts.recipes;
  const names = Object.keys(recipes).sort();
  if (names.length === 0) {
    throw new Error('verify.recipes must define at least one recipe');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const summary = names
    .map((n) => `${n}=${(recipes[n]?.command ?? []).join(' ')}`)
    .join('; ');

  return {
    name: 'run_check',
    description:
      `Run a whitelisted verify recipe (${names.join(', ')}). ` +
      `Configured: ${summary}. Prefer typecheck/build before full tests when iterating. ` +
      `No arbitrary shell.`,
    inputSchema: {
      type: 'object',
      properties: {
        recipe: {
          type: 'string',
          description: `One of: ${names.join(', ')}`,
          enum: names,
        },
        extraArgs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra argv appended to the recipe command.',
        },
      },
      required: ['recipe'],
      additionalProperties: false,
    },
    run: (input) => {
      const recipe = input.recipe?.trim();
      const def = recipe ? recipes[recipe] : undefined;
      if (!recipe || !def?.command?.length) {
        return {
          ok: false,
          recipe: recipe || '',
          command: [],
          exitCode: null,
          stdout: '',
          stderr: `Unknown verify recipe "${recipe ?? ''}". Allowed: ${names.join(', ')}`,
        };
      }
      const command = appendVerifyArgs(def.command, { extraArgs: input.extraArgs });
      return runVerifyCommand(workspace, recipe, command, {
        timeoutMs,
        maxOutputChars,
        toolLabel: `run_check:${recipe}`,
      });
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

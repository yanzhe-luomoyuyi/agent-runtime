/**
 * Whitelisted verify recipes — argv append + run_check / run_tests behavior.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TransientError } from '@agent/harness';
import { describe, expect, it } from 'vitest';

import {
  appendVerifyArgs,
  createRunCheckTool,
  createRunTestsTool,
} from '../src/tools/verify.js';
import { Workspace } from '../src/workspace.js';

describe('appendVerifyArgs', () => {
  it('inserts -- for npm-family before filter/extraArgs', () => {
    expect(appendVerifyArgs(['npm', 'test'], { filter: 'test/foo.test.ts' })).toEqual([
      'npm',
      'test',
      '--',
      'test/foo.test.ts',
    ]);
    expect(
      appendVerifyArgs(['npx', 'vitest', 'run'], { extraArgs: ['-t', 'bar'] }),
    ).toEqual(['npx', 'vitest', 'run', '--', '-t', 'bar']);
  });

  it('does not duplicate -- when already present', () => {
    expect(appendVerifyArgs(['npm', 'test', '--', '-t', 'x'], { filter: 'y' })).toEqual([
      'npm',
      'test',
      '--',
      '-t',
      'x',
      'y',
    ]);
  });

  it('appends directly for non-npm binaries', () => {
    expect(appendVerifyArgs(['./scripts/check.sh'], { extraArgs: ['--strict'] })).toEqual([
      './scripts/check.sh',
      '--strict',
    ]);
  });
});

describe('createRunCheckTool / createRunTestsTool', () => {
  it('run_check executes a named recipe and returns exit metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-check-'));
    try {
      const script = join(dir, 'ok.mjs');
      writeFileSync(script, `console.log('typecheck ok'); process.exit(0);`);
      const tool = createRunCheckTool(new Workspace(dir), {
        recipes: {
          typecheck: { command: [process.execPath, script] },
          build: { command: [process.execPath, '-e', 'process.exit(1)'] },
        },
        timeoutMs: 5_000,
      });
      const result = await Promise.resolve(tool.run({ recipe: 'typecheck' }));
      expect(result.ok).toBe(true);
      expect(result.recipe).toBe('typecheck');
      expect(result.stdout).toContain('typecheck ok');
      expect(result.command).toEqual([process.execPath, script]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run_check rejects unknown recipes without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-check-unknown-'));
    try {
      const tool = createRunCheckTool(new Workspace(dir), {
        recipes: { build: { command: [process.execPath, '-e', 'process.exit(0)'] } },
      });
      const result = await Promise.resolve(tool.run({ recipe: 'lint' }));
      expect(result.ok).toBe(false);
      expect(result.stderr).toMatch(/Unknown verify recipe/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run_tests appends filter via -- for npm-style recipes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-tests-filter-'));
    try {
      const script = join(dir, 'echo-args.mjs');
      writeFileSync(
        script,
        `console.log(JSON.stringify(process.argv.slice(2))); process.exit(0);`,
      );
      // Pretend npm: use node as bin would not insert --; use a wrapper named via PATH is hard.
      // Instead assert appendVerifyArgs path by using recipes that go through createRunTestsTool
      // with a non-npm binary and check extraArgs; npm -- insertion is unit-tested above.
      const tool = createRunTestsTool(new Workspace(dir), {
        recipes: { test: { command: [process.execPath, script] } },
        timeoutMs: 5_000,
      });
      const result = await Promise.resolve(
        tool.run({ filter: 'suite.test.ts', extraArgs: ['-t', 'only'] }),
      );
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.stdout.trim())).toEqual(['suite.test.ts', '-t', 'only']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a >1MB verbose but green run as ok (no spawnSync maxBuffer kill)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-verbose-'));
    try {
      const script = join(dir, 'verbose.mjs');
      writeFileSync(
        script,
        `for (let i = 0; i < 20000; i++) console.log('line ' + i + ' '.repeat(80));`,
      );
      const tool = createRunTestsTool(new Workspace(dir), {
        command: [process.execPath, script],
        timeoutMs: 15_000,
        maxOutputChars: 10_000,
      });
      const result = await Promise.resolve(tool.run({}));
      // ~1.8MB of output would have tripped spawnSync's 1MB default maxBuffer
      // (killing the child and reporting a false failure).
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeLessThanOrEqual(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kills the whole process tree on timeout (grandchild does not survive)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-timeout-'));
    try {
      // Grandchild writes a marker only if it gets reparented (ppid === 1),
      // i.e. its parent died but IT survived the group kill — the orphan leak.
      const marker = join(dir, 'orphan-alive.txt');
      const grandchild = join(dir, 'grandchild.mjs');
      writeFileSync(
        grandchild,
        `import { writeFileSync } from 'node:fs';\n` +
          `setInterval(() => {\n` +
          `  if (process.ppid === 1) {\n` +
          `    try { writeFileSync(${JSON.stringify(marker)}, 'orphan'); } catch {}\n` +
          `  }\n` +
          `}, 50);\n`,
      );
      const parent = join(dir, 'parent.mjs');
      writeFileSync(
        parent,
        `import { spawn } from 'node:child_process';\n` +
          `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });\n` +
          `setInterval(() => {}, 1000);\n`,
      );
      const tool = createRunTestsTool(new Workspace(dir), {
        command: [process.execPath, parent],
        timeoutMs: 300,
      });
      await expect(Promise.resolve(tool.run({}))).rejects.toBeInstanceOf(TransientError);
      // Give the SIGTERM -> SIGKILL escalation time, then confirm no orphan.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

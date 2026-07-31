/**
 * Whitelisted verify recipes — argv append + run_check / run_tests behavior.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
});

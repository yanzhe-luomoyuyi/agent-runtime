/**
 * run_tests — throw TransientError on npm/network blips so RetryingToolInvoker can retry.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TransientError } from '@agent/harness';
import { describe, expect, it } from 'vitest';

import { createRunTestsTool } from '../src/tools/run-tests.js';
import { Workspace } from '../src/workspace.js';

describe('createRunTestsTool transient failures', () => {
  it('throws TransientError when the command prints an npm network blip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-tests-blip-'));
    try {
      // Cross-platform: node script that exits 1 with npm-like network noise.
      const script = join(dir, 'blip.mjs');
      writeFileSync(
        script,
        `console.error('npm ERR! network This is a socket hang up error'); process.exit(1);`,
      );
      const tool = createRunTestsTool(new Workspace(dir), {
        command: [process.execPath, script],
        timeoutMs: 5_000,
      });
      await expect(Promise.resolve().then(() => tool.run({}))).rejects.toBeInstanceOf(TransientError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns ok:false for ordinary test failures (no throw)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-tests-fail-'));
    try {
      const script = join(dir, 'fail.mjs');
      writeFileSync(script, `console.error('AssertionError: expected true'); process.exit(1);`);
      const tool = createRunTestsTool(new Workspace(dir), {
        command: [process.execPath, script],
        timeoutMs: 5_000,
      });
      const result = await Promise.resolve(tool.run({}));
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli-args.js';

describe('parseArgs', () => {
  it('extracts --workspace before goal', () => {
    const { workspace, args } = parseArgs(['--workspace', '/tmp/repo', 'fix the bug']);
    expect(workspace).toBe('/tmp/repo');
    expect(args).toEqual(['fix the bug']);
  });

  it('supports --workspace= and -W', () => {
    expect(parseArgs(['--workspace=/a', 'run', 'g']).workspace).toBe('/a');
    expect(parseArgs(['-W', '/b', 'g']).workspace).toBe('/b');
  });

  it('leaves resume args intact', () => {
    const { workspace, args } = parseArgs(['--workspace', '/x', 'resume', 'run_1']);
    expect(workspace).toBe('/x');
    expect(args).toEqual(['resume', 'run_1']);
  });
});

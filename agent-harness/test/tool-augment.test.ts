import type { ToolInvoker, ToolSpec } from '@agent/contracts';
import { describe, expect, it } from 'vitest';

import { AugmentedToolInvoker } from '../src/context/tool-augment.js';
import { MockToolInvoker, makeTool } from '../src/testkit/index.js';

describe('AugmentedToolInvoker', () => {
  const inner: ToolInvoker = new MockToolInvoker([
    makeTool('getIssue', '', { type: 'object' }, () => ({ ok: true })),
  ]);

  it('advertises inner + extra tools and dispatches accordingly', async () => {
    const aug = new AugmentedToolInvoker(inner, [
      { name: 'extra', description: 'e', inputSchema: { type: 'object' }, handler: () => 'from-extra' },
    ]);
    const names = aug.list().map((s: ToolSpec) => s.name);
    expect(names).toEqual(['getIssue', 'extra']);
    expect(await aug.call('extra', {})).toBe('from-extra');
    expect(await aug.call('getIssue', {})).toEqual({ ok: true }); // delegated to inner
  });

  it('passes call options through to extra handlers', async () => {
    let seenKey: string | undefined;
    const aug = new AugmentedToolInvoker(inner, [
      { name: 'echo', description: 'e', inputSchema: { type: 'object' }, handler: (_args, opts) => { seenKey = opts?.key; return 'ok'; } },
    ]);
    await aug.call('echo', {}, { key: 't1:c1' });
    expect(seenKey).toBe('t1:c1');
  });
});

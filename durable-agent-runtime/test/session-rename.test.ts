import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { ModelProvider, ModelResult } from '../src/model/provider.js';
import { estimateTokens } from '../src/model/provider.js';
import { Runtime } from '../src/runtime.js';
import { SessionManager } from '../src/session.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createHarnessWorkflow } from '../src/app/harness-adapter.js';

class FinishModel implements ModelProvider {
  readonly name = 'finish';
  async complete(prompt: string): Promise<ModelResult> {
    const text = JSON.stringify({ action: 'finish', answer: 'done' });
    return { text, promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(text) };
  }
}

describe('SessionManager.rename', () => {
  let baseDir: string;
  let sessions: SessionManager;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'sess-rename-'));
    const rt = new Runtime({
      baseDir,
      model: new FinishModel(),
      tools: new ToolRegistry(),
      workflow: createHarnessWorkflow(),
    });
    sessions = new SessionManager(rt, baseDir);
  });

  it('updates the manifest title', () => {
    const m = sessions.create('original goal title');
    expect(m.title).toContain('original');
    const renamed = sessions.rename(m.sessionId, 'My named session');
    expect(renamed.title).toBe('My named session');
    expect(sessions.get(m.sessionId)?.manifest.title).toBe('My named session');
  });

  it('rejects empty titles', () => {
    const m = sessions.create('x');
    expect(() => sessions.rename(m.sessionId, '   ')).toThrow(/non-empty/);
  });
});

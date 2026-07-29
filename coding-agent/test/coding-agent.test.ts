/**
 * Offline E2E: scripted model drives analyze → fix session.js → write ANALYSIS.md.
 */

import { mkdtempSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoApprove } from '@agent/harness';
import { describe, expect, it } from 'vitest';

import { createCodingRuntime, DEFAULT_WORKSPACE } from '../src/runtime-factory.js';
import { finalTurn, ScriptedChatProvider, toolTurn } from './scripted-chat.js';

const FIXED_SESSION = `/**
 * Toy session helper — null-safe getUserName.
 */

export function getUserName(session) {
  if (session == null || session.user == null) return 'anonymous';
  return session.user.name;
}

export function createSession(user) {
  return { user };
}
`;

describe('coding-agent scripted e2e', () => {
  it('fixes the sandbox bug and writes ANALYSIS.md', async () => {
    const work = mkdtempSync(join(tmpdir(), 'coding-e2e-'));
    const runs = mkdtempSync(join(tmpdir(), 'coding-runs-'));
    cpSync(DEFAULT_WORKSPACE, work, { recursive: true });

    const chatModel = new ScriptedChatProvider([
      toolTurn([{ name: 'list_dir', arguments: { path: '.' } }]),
      toolTurn([{ name: 'read_file', arguments: { path: 'src/session.js' } }]),
      toolTurn([{ name: 'write_file', arguments: { path: 'src/session.js', content: FIXED_SESSION } }]),
      toolTurn([{ name: 'run_tests', arguments: {} }]),
      toolTurn([
        {
          name: 'write_file',
          arguments: {
            path: 'ANALYSIS.md',
            content: '# Analysis\n\nRoot cause: missing null check in getUserName.\n',
          },
        },
      ]),
      finalTurn('Fixed null session handling. See ANALYSIS.md.'),
    ]);

    try {
      const rt = createCodingRuntime({
        baseDir: runs,
        workspaceRoot: work,
        chatModel,
        approver: autoApprove,
        autoApproveWrites: true,
        maxTurns: 12,
      });
      const state = await rt.run(
        'Fix getUserName to return anonymous for null session, run tests, write ANALYSIS.md',
      );
      expect(state.status).toBe('completed');
      expect(readFileSync(join(work, 'ANALYSIS.md'), 'utf8')).toContain('Root cause');
      expect(readFileSync(join(work, 'src/session.js'), 'utf8')).toContain('anonymous');
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
    }
  }, 60_000);
});

/**
 * Reset the default coding-sandbox fixture to the intentional buggy state.
 */

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BUGGY_SESSION = `/**
 * Toy session helper — intentional bug: getUserName crashes when session is null.
 */

export function getUserName(session) {
  // BUG: missing null/undefined guard — should return 'anonymous'
  return session.user.name;
}

export function createSession(user) {
  return { user };
}
`;

export function resetCodingSandbox(workspaceRoot: string): void {
  writeFileSync(join(workspaceRoot, 'src', 'session.js'), BUGGY_SESSION, 'utf8');
  const analysis = join(workspaceRoot, 'ANALYSIS.md');
  if (existsSync(analysis)) unlinkSync(analysis);
}

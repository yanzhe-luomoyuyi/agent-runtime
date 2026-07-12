/**
 * SessionManager — multi-turn conversation sessions built on top of the
 * single-run Runtime.
 *
 * A Session links multiple runs into a conversation thread. Each subsequent
 * run receives the full user↔assistant history from all prior runs, so the
 * model can reference earlier context naturally.
 *
 * Storage
 * -------
 * Sessions are stored as plain JSON manifests under `<baseDir>/sessions/`.
 * Each manifest records the ordered list of run IDs. The runs themselves are
 * unchanged — still event-sourced, resumable, and independent.
 *
 *   .agent-runs/
 *     sessions/
 *       <sessionId>.json   ← { sessionId, runIds[], title, ... }
 *     runs/
 *       <runId>/           ← existing event log (unchanged)
 *
 * Why not event-source sessions too? A session is a lightweight pointer
 * structure — there's no state to replay, and JSON is simpler to introspect
 * and repair. If we ever need session-level audit trails we can upgrade later.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Runtime } from './runtime.js';
import type { RunState } from './types.js';

// ── Types ───────────────────────────────────────────────────────────

export interface SessionManifest {
  sessionId: string;
  /** Ordered list of run IDs in this conversation (oldest first). */
  runIds: string[];
  /** First user prompt — used as the default title. */
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Full session state with resolved run summaries. */
export interface SessionState {
  manifest: SessionManifest;
  runs: Array<{
    runId: string;
    status: string;
    answer: string;
    turns: number;
    toolsUsed: string[];
  }>;
}

export interface ContinueResult {
  sessionId: string;
  runId: string;
  state: RunState;
}

// ── Implementation ──────────────────────────────────────────────────

export class SessionManager {
  private readonly sessionsDir: string;

  constructor(
    private readonly runtime: Runtime,
    private readonly baseDir: string,
  ) {
    this.sessionsDir = join(baseDir, 'sessions');
    if (!existsSync(this.sessionsDir)) mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** Start a new session with an initial prompt. Returns the session id and first run result. */
  async start(prompt: string): Promise<ContinueResult> {
    const sessionId = `sess-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const state = await this.runtime.run(prompt);

    const manifest: SessionManifest = {
      sessionId,
      runIds: [state.runId],
      title: truncate(prompt, 80),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.writeManifest(manifest);

    return { sessionId, runId: state.runId, state };
  }

  /** Add a follow-up prompt to an existing session. */
  async continue(sessionId: string, prompt: string): Promise<ContinueResult> {
    const manifest = this.readManifest(sessionId);
    if (!manifest) throw new Error(`Session not found: ${sessionId}`);

    // Build conversation history from all prior runs.
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const runId of manifest.runIds) {
      const s = this.runtime.status(runId);
      history.push({ role: 'user', content: s.input?.issue ?? '(unknown)' });
      history.push({ role: 'assistant', content: extractAnswer(s) });
    }

    const state = await this.runtime.run(prompt, { conversationHistory: history });

    manifest.runIds.push(state.runId);
    manifest.updatedAt = new Date().toISOString();
    this.writeManifest(manifest);

    return { sessionId, runId: state.runId, state };
  }

  /** List all session manifests (newest first). */
  list(): SessionManifest[] {
    const results: SessionManifest[] = [];
    for (const name of readdirSync(this.sessionsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const m = JSON.parse(readFileSync(join(this.sessionsDir, name), 'utf8')) as SessionManifest;
        if (m.sessionId && Array.isArray(m.runIds)) results.push(m);
      } catch { /* skip malformed */ }
    }
    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return results;
  }

  /** Get full session state with resolved run details. */
  get(sessionId: string): SessionState | undefined {
    const manifest = this.readManifest(sessionId);
    if (!manifest) return undefined;

    const runs = manifest.runIds.map((runId) => {
      const s = this.runtime.status(runId);
      return {
        runId,
        status: s.status,
        answer: extractAnswer(s),
        turns: (s.summary as any)?.turns ?? 0,
        toolsUsed: (s.summary as any)?.toolsUsed ?? [],
      };
    });

    return { manifest, runs };
  }

  /** Delete a session manifest (does NOT delete the underlying runs). */
  delete(sessionId: string): boolean {
    const path = this.manifestPath(sessionId);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  // ── Internal helpers ─────────────────────────────────────────────

  private manifestPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }

  private readManifest(sessionId: string): SessionManifest | undefined {
    const path = this.manifestPath(sessionId);
    if (!existsSync(path)) return undefined;
    try {
      const m = JSON.parse(readFileSync(path, 'utf8')) as SessionManifest;
      if (!m.sessionId || !Array.isArray(m.runIds)) return undefined;
      return m;
    } catch {
      return undefined;
    }
  }

  private writeManifest(m: SessionManifest): void {
    writeFileSync(this.manifestPath(m.sessionId), JSON.stringify(m, null, 2));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Extract the best-effort final answer from a RunState. */
function extractAnswer(state: RunState): string {
  const summary = state.summary as { proposal?: string; answer?: string } | undefined;
  if (summary?.answer) return summary.answer;
  if (summary?.proposal) return summary.proposal;
  // Fallback: read the last step output that looks like a result.
  const keys = Object.keys(state.stepOutputs);
  for (let i = keys.length - 1; i >= 0; i--) {
    const v = state.stepOutputs[keys[i]!];
    if (v && typeof v === 'object' && 'answer' in v) return (v as any).answer as string;
  }
  return state.error ?? '(no answer)';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

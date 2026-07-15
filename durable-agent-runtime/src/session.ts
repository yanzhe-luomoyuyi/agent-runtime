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
  /**
   * Cached per-run summaries. When a run's full messages have been summarised,
   * the result is stored here keyed by runId. On subsequent continues, only
   * un-summarised runs trigger a new LLM call — already-summarised runs are
   * re-used from cache.
   */
  runSummaries?: Record<string, string>;
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

// ── History mode ────────────────────────────────────────────────────

/**
 * Controls what prior-run context is passed to the next run.
 *
 * - `'qa-pairs'` (default): extract only user-prompt + assistant-answer per run.
 *   Lightweight, no LLM summarisation overhead.
 * - `'full-summary'`: extract the FULL message transcript for each older run,
 *   summarise it once via LLM (cached), and pass the accumulated summaries as a
 *   system message. The most recent run stays verbatim. Summaries are cached in
 *   the session manifest so they are never recomputed.
 */
export type HistoryMode = 'qa-pairs' | 'full-summary';

/**
 * Async summarizer for cross-run conversation history. Receives a list of
 * per-run entries (each containing the run's user prompt, assistant answer,
 * and optionally the full message transcript), and returns a summary string.
 *
 * The summary is inserted as a system message in the next run's
 * conversationHistory so the model sees compressed context instead of the
 * full verbatim history.
 */
export type ConversationSummarizer = (
  entries: Array<{
    runId: string;
    issue: string;
    answer: string;
    /** Full message transcript text, when mode is 'full-summary'. */
    fullTranscript?: string;
  }>,
) => Promise<string>;

export interface SessionManagerOptions {
  /**
   * Controls what prior-run context is passed to the next run.
   * - `'qa-pairs'` (default): user prompt + assistant answer per prior run.
   * - `'full-summary'`: full message transcript summarised via LLM, cached
   *   per-run so each run is summarised at most once. The most recent run
   *   stays verbatim (as Q&A or full messages, depending on `verbatimMode`).
   */
  historyMode?: HistoryMode;
  /**
   * Optional cross-run summarizer. Required when `historyMode` is `'full-summary'`.
   * Ignored for `'qa-pairs'` mode.
   */
  summarizeHistory?: ConversationSummarizer;
  /**
   * Number of most recent prior runs kept verbatim (not summarised).
   * Default 1. Only meaningful for `'full-summary'` mode.
   */
  keepRecentRunsVerbatim?: number;
  /**
   * When `historyMode` is `'full-summary'`, controls what the most recent
   * run contributes verbatim.
   * - `'qa'` (default): just user prompt + assistant answer.
   * - `'full-messages'`: the run's full Message[] transcript.
   */
  verbatimMode?: 'qa' | 'full-messages';
  /**
   * Extracts the full message transcript from a RunState as a plain-text
   * string suitable for the summarizer. Required when `historyMode` is
   * `'full-summary'` and `verbatimMode` is `'full-messages'`, or when you
   * want summarization to see tool calls/results.
   *
   * Receives the RunState; returns undefined if messages aren't available
   * (falls back to Q&A-only summarization for that run).
   */
  extractMessages?: (state: RunState) => string | undefined;
}

export class SessionManager {
  private readonly sessionsDir: string;
  private readonly historyMode: HistoryMode;
  private readonly summarizeHistory?: ConversationSummarizer;
  private readonly keepRecent: number;
  private readonly verbatimMode: 'qa' | 'full-messages';
  private readonly extractMessages?: (state: RunState) => string | undefined;

  constructor(
    private readonly runtime: Runtime,
    private readonly baseDir: string,
    opts: SessionManagerOptions = {},
  ) {
    this.sessionsDir = join(baseDir, 'sessions');
    if (!existsSync(this.sessionsDir)) mkdirSync(this.sessionsDir, { recursive: true });
    this.historyMode = opts.historyMode ?? 'qa-pairs';
    this.summarizeHistory = opts.summarizeHistory;
    this.keepRecent = opts.keepRecentRunsVerbatim ?? 1;
    this.verbatimMode = opts.verbatimMode ?? 'qa';
    this.extractMessages = opts.extractMessages;
    if (this.historyMode === 'full-summary' && !this.summarizeHistory) {
      throw new Error('SessionManager: summarizeHistory is required when historyMode is "full-summary"');
    }
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

    const history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];

    if (this.historyMode === 'full-summary' && this.summarizeHistory) {
      // ── Full-summary mode with incremental, cached summarisation ──
      manifest.runSummaries ??= {};
      const totalRuns = manifest.runIds.length;
      const keepVerbatim = Math.min(this.keepRecent, totalRuns);

      // Split: older runs get summarised, the last keepVerbatim stay verbatim.
      const olderRunIds = manifest.runIds.slice(0, totalRuns - keepVerbatim);
      const recentRunIds = manifest.runIds.slice(totalRuns - keepVerbatim);

      // ── Incremental summarisation: only summarise runs that aren't cached ──
      const newSummaries: Array<{ runId: string; summary: string }> = [];
      const uncachedEntries: Array<{ runId: string; issue: string; answer: string; fullTranscript?: string }> = [];

      for (const runId of olderRunIds) {
        if (manifest.runSummaries[runId]) continue; // already cached — skip
        const s = this.runtime.status(runId);
        const issue = s.input?.issue ?? '(unknown)';
        const answer = extractAnswer(s);
        const fullTranscript = this.extractMessages?.(s);
        uncachedEntries.push({ runId, issue, answer, fullTranscript });
      }

      if (uncachedEntries.length > 0) {
        const summaryText = await this.summarizeHistory(uncachedEntries);
        // Store each summarised run's contribution. Since the summarizer
        // may return a single combined summary, we split it evenly: each
        // summarised run gets the same summary text. The accumulated
        // summaries are concatenated below — the summarizer should
        // produce a coherent multi-run narrative.
        for (const entry of uncachedEntries) {
          manifest.runSummaries[entry.runId] = summaryText;
          newSummaries.push({ runId: entry.runId, summary: summaryText });
        }
      }

      // ── Accumulate all cached summaries into one system message ──
      // Collect deduplicated summaries (multiple runs may share the same
      // summary text since the summarizer processes batches).
      const seen = new Set<string>();
      const uniqueSummaries: string[] = [];
      for (const runId of olderRunIds) {
        const s = manifest.runSummaries[runId];
        if (s && !seen.has(s)) {
          seen.add(s);
          uniqueSummaries.push(s);
        }
      }

      if (uniqueSummaries.length > 0) {
        const runCount = olderRunIds.length;
        history.push({
          role: 'system',
          content: `[Conversation summary of ${runCount} earlier exchange(s)]\n${uniqueSummaries.join('\n\n---\n\n')}`,
        });
      }

      // ── Recent runs: verbatim (QA or full messages) ──
      for (const runId of recentRunIds) {
        const s = this.runtime.status(runId);
        if (this.verbatimMode === 'full-messages') {
          const messagesText = this.extractMessages?.(s);
          if (messagesText) {
            history.push({ role: 'system', content: `[Full transcript of prior run ${runId}]\n${messagesText}` });
            continue;
          }
          // Fall through to QA fallback if extractMessages returns undefined.
        }
        history.push({ role: 'user', content: s.input?.issue ?? '(unknown)' });
        history.push({ role: 'assistant', content: extractAnswer(s) });
      }
    } else {
      // ── QA-pairs mode (default): full verbatim Q&A for all prior runs ──
      for (const runId of manifest.runIds) {
        const s = this.runtime.status(runId);
        history.push({ role: 'user', content: s.input?.issue ?? '(unknown)' });
        history.push({ role: 'assistant', content: extractAnswer(s) });
      }
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

// ── Summarizer factory ──────────────────────────────────────────────

const DEFAULT_SESSION_SUMMARIZE_INSTRUCTIONS =
  'You are a conversation summarizer. Given prior user↔assistant exchanges from an agent ' +
  'session, produce a concise summary that preserves: key decisions made, actions taken ' +
  '(files created/modified, commands run, tools called), errors encountered and how they were ' +
  'resolved, and any open threads or unresolved issues. Be specific — include ' +
  'file paths, function names, and error messages where relevant. The summary ' +
  'replaces the original messages in context, so the agent must be able to ' +
  'continue working from it alone. When full message transcripts are provided, ' +
  'pay special attention to tool calls, their results, and the agent\'s reasoning chain.';

/**
 * Build a `ConversationSummarizer` from a plain text-completion function
 * (e.g. `ModelProvider.complete`). Uses a deterministic system prompt so
 * summaries are consistent across calls.
 *
 * @param complete  A function that takes a prompt string and returns the
 *                  model's completion text. Typically the runtime's model.
 * @param options   Optional custom instructions and input length cap.
 */
export function createConversationSummarizer(
  complete: (prompt: string) => Promise<string>,
  options: { instructions?: string; maxInputChars?: number } = {},
): ConversationSummarizer {
  const instructions = options.instructions ?? DEFAULT_SESSION_SUMMARIZE_INSTRUCTIONS;
  const maxInputChars = options.maxInputChars ?? 16_000;

  return async (entries) => {
    // Build the transcript from entries, preferring full transcripts when available.
    const parts: string[] = [];
    for (const entry of entries) {
      if (entry.fullTranscript) {
        parts.push(`## Run ${entry.runId}\n${entry.fullTranscript}`);
      } else {
        parts.push(`## Run ${entry.runId}\nUser: ${entry.issue}\nAssistant: ${entry.answer}`);
      }
    }
    const transcript = parts.join('\n\n');

    // Truncate if excessively long.
    const truncated =
      transcript.length > maxInputChars
        ? transcript.slice(0, maxInputChars) +
          `\n\n[... ${transcript.length - maxInputChars} more chars omitted]`
        : transcript;

    const prompt = [
      instructions,
      '',
      'Summarize the following conversation history:',
      '',
      truncated,
      '',
      'Concise summary:',
    ].join('\n');

    const summary = await complete(prompt);
    return summary.trim();
  };
}

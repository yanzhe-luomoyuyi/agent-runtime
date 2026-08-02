/**
 * Local workbench UI for coding-agent — run / resume / session / pause / HITL,
 * stream progress over SSE, show ANALYSIS.md + diffs + Trace.
 *
 *   npm run ui -w @agent/coding-agent
 *   open http://127.0.0.1:8787
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';

import {
  autoApprove,
  FALLBACK_PRICING,
  requireApprovalFor,
  TraceCollector,
} from '@agent/harness';
import {
  extractAnswer,
  extractCritiques,
  extractPlan,
  extractThinking,
  listRunIds,
  SessionManager,
  type ChatModelProvider,
  type HarnessLoopMode,
  type Runtime,
} from 'durable-agent-runtime';

import { loadCodingConfig, type CodingConfig } from './config.js';
import { loadEnvFile } from './load-env.js';
import { resolveCodingMaxPromptTokens, resolveModelIdFromEnv } from './prompt-budget.js';
import { createCodingRuntime, DEFAULT_WORKSPACE, PACKAGE_ROOT, resolveWorkspaceRoot } from './runtime-factory.js';
import { MUTATING_FS_TOOLS } from './tools/fs-tools.js';
import {
  compareSessionTraces,
  loadHarnessTrace,
  loadSessionTraceBundle,
  saveHarnessTrace,
} from './session-trace.js';
import { createUiApprover } from './ui-approver.js';
import {
  bindRunId,
  clearApproval,
  controlAbort,
  controlContinue,
  controlPause,
  controlSteer,
  endActiveRun,
  getActiveByRunId,
  hasDrivingRun,
  listActiveRuns,
  registerApproval,
  resolveApproval,
  setPhase,
  sseInterrupter,
  tryBeginActiveRun,
  type SseSend,
} from './workbench-runs.js';
import {
  diffSnapshots,
  readAnalysisMd,
  snapshotWorkspace,
  type FileDiff,
  type FileSnapshot,
} from './workspace-diff.js';

loadEnvFile(join(PACKAGE_ROOT, '.env'));
loadEnvFile(join(PACKAGE_ROOT, '.env.local'));

const HOST = process.env.CODING_AGENT_UI_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CODING_AGENT_UI_PORT ?? 8787);
const STATIC_DIR = join(PACKAGE_ROOT, 'ui', 'static');

function main(): void {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        json(res, 500, { error: msg });
      } else {
        res.end();
      }
    }
  });

  const cfg = loadCodingConfig();
  const modelId = resolveModelIdFromEnv(process.env, cfg.model.model);
  const maxPromptTokens = resolveCodingMaxPromptTokens({
    model: modelId,
    softCap: cfg.run.compaction.softCapTokens,
  });
  server.listen(PORT, HOST, () => {
    process.stderr.write(`coding-agent UI  http://${HOST}:${PORT}\n`);
    process.stderr.write(`workspace         ${resolveWorkspaceRoot(undefined, process.env, cfg)}\n`);
    process.stderr.write(`model             ${modelId}\n`);
    process.stderr.write(`maxPromptTokens   ${maxPromptTokens}\n`);
    process.stderr.write(`config            agent.config.json\n`);
    const keySet = [cfg.model.apiKeyEnv, ...cfg.model.apiKeyEnvFallbacks].some((k) => Boolean(process.env[k]));
    process.stderr.write(`${cfg.model.apiKeyEnv}  ${keySet ? 'set' : 'MISSING'}\n`);
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    return sendFile(res, join(STATIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && path.startsWith('/static/')) {
    const name = path.slice('/static/'.length).replace(/\.\./g, '');
    const file = join(STATIC_DIR, name);
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    return sendFile(res, file, contentType(file));
  }

  if (req.method === 'GET' && path === '/api/status') {
    const cfg = loadCodingConfig();
    const workspace = resolveWorkspaceRoot(undefined, process.env, cfg);
    const modelId = resolveModelIdFromEnv(process.env, cfg.model.model);
    const keyEnvs = [cfg.model.apiKeyEnv, ...cfg.model.apiKeyEnvFallbacks];
    return json(res, 200, {
      workspace,
      defaultWorkspace: DEFAULT_WORKSPACE,
      hasApiKey: keyEnvs.some((k) => Boolean(process.env[k])),
      busy: hasDrivingRun(),
      activeRuns: listActiveRuns(),
      autoApproveWrites: cfg.run.autoApproveWrites,
      longTermMemory: cfg.run.memory.enabled,
      loopMode: cfg.run.loopMode,
      modelId,
      maxTurns: cfg.run.maxTurns,
      maxPromptTokens: resolveCodingMaxPromptTokens({
        model: modelId,
        softCap: cfg.run.compaction.softCapTokens,
      }),
    });
  }

  // ── Runs: list / status / trace ──────────────────────────────────
  if (req.method === 'GET' && path === '/api/runs') {
    const cfg = loadCodingConfig();
    const runsDir = resolveRunsDir(cfg);
    try {
      const rt = openReadonlyRuntime(runsDir, cfg);
      const runs = listRunIds(runsDir).map((runId) => {
        try {
          const s = rt.status(runId);
          return {
            runId,
            status: s.status,
            issue: s.input?.issue ?? '',
            error: s.error,
            workflow: s.workflow,
          };
        } catch {
          return { runId, status: 'unknown', issue: '', error: 'unreadable' };
        }
      });
      return json(res, 200, { runs });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  const runStatusMatch = path.match(/^\/api\/runs\/([^/]+)\/status$/);
  if (req.method === 'GET' && runStatusMatch) {
    const runId = decodeURIComponent(runStatusMatch[1]!);
    const cfg = loadCodingConfig();
    try {
      const rt = openReadonlyRuntime(resolveRunsDir(cfg), cfg);
      const state = rt.status(runId);
      const active = getActiveByRunId(runId);
      return json(res, 200, {
        ...state,
        activePhase: active?.phase,
        answer: extractAnswer(state),
        thinking: extractThinking(state),
        plan: extractPlan(state),
        critiques: extractCritiques(state),
      });
    } catch (e) {
      return json(res, 404, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  const runTraceMatch = path.match(/^\/api\/runs\/([^/]+)\/trace$/);
  if (req.method === 'GET' && runTraceMatch) {
    const runId = decodeURIComponent(runTraceMatch[1]!);
    const cfg = loadCodingConfig();
    try {
      const runsDir = resolveRunsDir(cfg);
      const rt = openReadonlyRuntime(runsDir, cfg);
      return json(res, 200, {
        runId,
        runtimeTrace: rt.trace(runId),
        harnessTrace: loadHarnessTrace(runsDir, runId),
      });
    } catch (e) {
      return json(res, 404, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Run control (pause / continue / steer / abort / approve) ─────
  const pauseMatch = path.match(/^\/api\/runs\/([^/]+)\/pause$/);
  if (req.method === 'POST' && pauseMatch) {
    return jsonResult(res, controlPause(decodeURIComponent(pauseMatch[1]!)));
  }
  const continueMatch = path.match(/^\/api\/runs\/([^/]+)\/continue$/);
  if (req.method === 'POST' && continueMatch) {
    return jsonResult(res, controlContinue(decodeURIComponent(continueMatch[1]!)));
  }
  const steerMatch = path.match(/^\/api\/runs\/([^/]+)\/steer$/);
  if (req.method === 'POST' && steerMatch) {
    const body = await readJson(req);
    return jsonResult(
      res,
      controlSteer(decodeURIComponent(steerMatch[1]!), {
        inject: typeof body.inject === 'string' ? body.inject : undefined,
        goal: typeof body.goal === 'string' ? body.goal : undefined,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      }),
    );
  }
  const abortMatch = path.match(/^\/api\/runs\/([^/]+)\/abort$/);
  if (req.method === 'POST' && abortMatch) {
    const body = await readJson(req);
    return jsonResult(
      res,
      controlAbort(
        decodeURIComponent(abortMatch[1]!),
        typeof body.reason === 'string' ? body.reason : undefined,
      ),
    );
  }
  const approveMatch = path.match(/^\/api\/runs\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const runId = decodeURIComponent(approveMatch[1]!);
    const body = await readJson(req);
    const callId = typeof body.callId === 'string' ? body.callId : '';
    if (!callId) return json(res, 400, { error: 'callId is required' });
    if (typeof body.approved !== 'boolean') return json(res, 400, { error: 'approved is required' });
    return jsonResult(
      res,
      resolveApproval(runId, callId, {
        approved: body.approved,
        reason: typeof body.reason === 'string' ? body.reason : body.approved ? 'ui yes' : 'ui no',
        modifiedArgs: body.modifiedArgs,
      }),
    );
  }

  // ── Sessions ─────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/api/sessions') {
    const cfg = loadCodingConfig();
    try {
      const sessions = openSessions(resolveRunsDir(cfg), cfg);
      return json(res, 200, { sessions: sessions.list() });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === 'POST' && path === '/api/sessions/compare') {
    const body = await readJson(req);
    const baselineId = typeof body.baselineSessionId === 'string' ? body.baselineSessionId.trim() : '';
    const candidateId = typeof body.candidateSessionId === 'string' ? body.candidateSessionId.trim() : '';
    if (!baselineId || !candidateId) {
      return json(res, 400, { error: 'baselineSessionId and candidateSessionId are required' });
    }
    if (baselineId === candidateId) {
      return json(res, 400, { error: 'Pick two different sessions to compare' });
    }
    const cfg = loadCodingConfig();
    try {
      const runsDir = resolveRunsDir(cfg);
      const sessions = openSessions(runsDir, cfg);
      const rt = openReadonlyRuntime(runsDir, cfg);
      const baselineState = sessions.get(baselineId);
      const candidateState = sessions.get(candidateId);
      if (!baselineState) return json(res, 404, { error: `Session not found: ${baselineId}` });
      if (!candidateState) return json(res, 404, { error: `Session not found: ${candidateId}` });
      const baseline = loadSessionTraceBundle(runsDir, rt, baselineState);
      const candidate = loadSessionTraceBundle(runsDir, rt, candidateState);
      return json(res, 200, compareSessionTraces(baseline, candidate));
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  const sessionTracesMatch = path.match(/^\/api\/sessions\/([^/]+)\/traces$/);
  if (req.method === 'GET' && sessionTracesMatch) {
    const sessionId = decodeURIComponent(sessionTracesMatch[1]!);
    const cfg = loadCodingConfig();
    try {
      const runsDir = resolveRunsDir(cfg);
      const sessions = openSessions(runsDir, cfg);
      const state = sessions.get(sessionId);
      if (!state) return json(res, 404, { error: `Session not found: ${sessionId}` });
      const rt = openReadonlyRuntime(runsDir, cfg);
      return json(res, 200, loadSessionTraceBundle(runsDir, rt, state));
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  const sessionGetMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (req.method === 'GET' && sessionGetMatch) {
    const sessionId = decodeURIComponent(sessionGetMatch[1]!);
    const cfg = loadCodingConfig();
    try {
      const sessions = openSessions(resolveRunsDir(cfg), cfg);
      const state = sessions.get(sessionId);
      if (!state) return json(res, 404, { error: `Session not found: ${sessionId}` });
      return json(res, 200, state);
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === 'PATCH' && sessionGetMatch) {
    const sessionId = decodeURIComponent(sessionGetMatch[1]!);
    const body = await readJson(req);
    const title = typeof body.title === 'string' ? body.title : '';
    const cfg = loadCodingConfig();
    try {
      const sessions = openSessions(resolveRunsDir(cfg), cfg);
      const manifest = sessions.rename(sessionId, title);
      return json(res, 200, { ok: true, manifest });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /not found/i.test(msg) ? 404 : 400;
      return json(res, status, { error: msg });
    }
  }

  if (req.method === 'DELETE' && sessionGetMatch) {
    const sessionId = decodeURIComponent(sessionGetMatch[1]!);
    const cfg = loadCodingConfig();
    try {
      const sessions = openSessions(resolveRunsDir(cfg), cfg);
      const ok = sessions.delete(sessionId);
      return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: `Session not found: ${sessionId}` });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Drive: new run / session continue / durable resume ───────────
  if (req.method === 'POST' && path === '/api/run') {
    return driveSse(req, res, { mode: 'new' });
  }

  const resumeMatch = path.match(/^\/api\/runs\/([^/]+)\/resume$/);
  if (req.method === 'POST' && resumeMatch) {
    return driveSse(req, res, { mode: 'resume', runId: decodeURIComponent(resumeMatch[1]!) });
  }

  const sessionContinueMatch = path.match(/^\/api\/sessions\/([^/]+)\/continue$/);
  if (req.method === 'POST' && sessionContinueMatch) {
    return driveSse(req, res, {
      mode: 'continue',
      sessionId: decodeURIComponent(sessionContinueMatch[1]!),
    });
  }

  json(res, 404, { error: 'not found' });
}

type DriveMode =
  | { mode: 'new' }
  | { mode: 'resume'; runId: string }
  | { mode: 'continue'; sessionId: string };

async function driveSse(
  req: IncomingMessage,
  res: ServerResponse,
  mode: DriveMode,
): Promise<void> {
  // Reserve the driving slot synchronously before any await (TOCTOU guard).
  const reserved = tryBeginActiveRun({
    workspace: 'pending',
    knownRunId: mode.mode === 'resume' ? mode.runId : undefined,
    sessionId: mode.mode === 'continue' ? mode.sessionId : undefined,
  });
  if (!reserved) return json(res, 409, { error: 'A run is already in progress' });
  const { key, run: active } = reserved;

  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (e) {
    endActiveRun(key);
    const msg = e instanceof Error ? e.message : String(e);
    return json(res, msg.includes('too large') ? 413 : 400, { error: msg });
  }

  const cfg = loadCodingConfig();
  const keyEnvs = [cfg.model.apiKeyEnv, ...cfg.model.apiKeyEnvFallbacks];
  if (!keyEnvs.some((k) => Boolean(process.env[k]))) {
    endActiveRun(key);
    return json(res, 400, {
      error: `Set ${cfg.model.apiKeyEnv} in coding-agent/.env (or the environment)`,
    });
  }

  let workspace: string;
  try {
    workspace = pickWorkspace(typeof body.workspace === 'string' ? body.workspace : undefined);
  } catch (e) {
    endActiveRun(key);
    return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }

  const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
  if (mode.mode !== 'resume' && !goal) {
    endActiveRun(key);
    return json(res, 400, { error: 'goal is required' });
  }

  const crashAfterTurn =
    typeof body.crashAfterTurn === 'number' && body.crashAfterTurn > 0
      ? Math.floor(body.crashAfterTurn)
      : undefined;

  // hitlWrites: true → require UI approval for mutating FS tools; false → auto; omit → config
  const hitlWrites =
    typeof body.hitlWrites === 'boolean' ? body.hitlWrites : !cfg.run.autoApproveWrites;

  // longTermMemory: per-run override for memory_* tools; omit → config.run.memory.enabled
  const longTermMemory =
    typeof body.longTermMemory === 'boolean' ? body.longTermMemory : cfg.run.memory.enabled;

  const loopMode = parseLoopMode(body.loopMode) ?? cfg.run.loopMode;

  const newSession = body.newSession === true;
  let sessionId =
    mode.mode === 'continue'
      ? mode.sessionId
      : typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : undefined;

  active.workspace = workspace;
  active.sessionId = sessionId;

  const runsDir = resolveRunsDir(cfg);
  const before = snapshotWorkspace(workspace);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // A client refresh / tab-close destroys the socket mid-stream. Without these
  // handlers the next res.write() emits an uncaught 'error' event that takes
  // down the whole UI server; with them, sends after disconnect are no-ops.
  // (res 'close' = underlying connection terminated, incl. premature — the
  // reliable disconnect signal; req 'close' can fire when the body finishes.)
  let clientGone = false;
  res.on('error', () => { clientGone = true; });
  res.on('close', () => { clientGone = true; });

  const send: SseSend = (event, data) => {
    if (clientGone) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('status', {
    phase: 'starting',
    workspace,
    mode: mode.mode,
    sessionId,
    crashAfterTurn,
    hitlWrites,
    longTermMemory,
    loopMode,
  });

  const harnessTrace = new TraceCollector({
    promptUsdPerToken: cfg.pricing?.promptUsdPerToken ?? FALLBACK_PRICING.promptUsdPerToken,
    completionUsdPerToken: cfg.pricing?.completionUsdPerToken ?? FALLBACK_PRICING.completionUsdPerToken,
    cachedPromptUsdPerToken: cfg.pricing?.cachedPromptUsdPerToken,
  });
  const runStartedAt = Date.now();

  const uiApprover = createUiApprover({
    onRequest: (approvalReq) => {
      send('needs_input', {
        runId: active.runId,
        kind: 'approval',
        callId: approvalReq.callId,
        tool: approvalReq.tool,
        args: approvalReq.args,
        turn: approvalReq.turn,
      });
    },
    registerPending: (pending) => registerApproval(active, pending),
    clearPending: (callId) => clearApproval(active, callId),
  });

  try {
    let liveSessions: SessionManager | undefined;

    const rt = createCodingRuntime({
      baseDir: runsDir,
      workspaceRoot: workspace,
      config: cfg,
      pricing: cfg.pricing,
      policy: cfg.policy,
      autoApproveWrites: !hitlWrites,
      longTermMemory,
      loopMode,
      approver: hitlWrites ? requireApprovalFor([...MUTATING_FS_TOOLS], uiApprover) : autoApprove,
      maxTurns: cfg.run.maxTurns,
      crashAfterTurn,
      interrupter: sseInterrupter(active, send),
      harnessTrace,
      onEvent: (e) => {
        if (e.type === 'RunStarted') {
          bindRunId(key, e.runId);
          send('run', { runId: e.runId, sessionId: active.sessionId });
          if (active.sessionId && liveSessions) {
            try {
              liveSessions.attachRun(active.sessionId, e.runId);
            } catch (err) {
              console.warn(
                `[ui] session attach deferred: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        if (e.type === 'ToolCallRequested') send('tool', { tool: e.tool, args: e.args, status: 'start' });
        if (e.type === 'ToolCallSucceeded') send('tool', { tool: e.tool, status: 'ok' });
        if (e.type === 'ToolCallFailed') send('tool', { tool: e.tool, status: 'error', error: e.error });
        if (e.type === 'ModelCalled') {
          send('model', {
            callId: e.callId,
            phase: e.phase,
            promptTokens: e.promptTokens,
            completionTokens: e.completionTokens,
            cachedPromptTokens: e.cachedPromptTokens ?? 0,
            tokens: e.promptTokens + e.completionTokens,
            costUsd: e.costUsd,
            latencyMs: e.latencyMs,
          });
        }
        if (e.type === 'PolicyDenied') {
          send('policy', { scope: e.scope, target: e.target, code: e.code, reason: e.reason });
        }
        if (e.type === 'HumanIntervention') {
          send('intervention', {
            action: e.action,
            turn: e.turn,
            inject: e.inject,
            goal: e.goal,
            reason: e.reason,
          });
        }
      },
      onStreamEvent: (e) => {
        if (e.type === 'turn_start') {
          send('turn_start', { turn: e.turn, lane: e.lane ?? 'agent' });
        } else if (e.type === 'model_token') {
          send('model_token', { turn: e.turn, token: e.token, lane: e.lane ?? 'agent' });
        } else if (e.type === 'thinking_token') {
          send('thinking_token', { turn: e.turn, token: e.token, lane: e.lane ?? 'agent' });
        }
      },
    });

    liveSessions = new SessionManager(rt, runsDir);

    if (mode.mode === 'resume') {
      const linked = liveSessions.list().find((m) => m.runIds.includes(mode.runId));
      if (linked) {
        active.sessionId = linked.sessionId;
        send('session', { sessionId: linked.sessionId, title: linked.title });
      }
      const state = await rt.resume(mode.runId);
      return finishDone(send, rt, state, workspace, before, harnessTrace, runStartedAt, runsDir, active.sessionId);
    }

    // new run or session continue — optionally bind / create a session
    const continueSessionId = mode.mode === 'continue' ? mode.sessionId : sessionId;
    let history: Awaited<ReturnType<SessionManager['buildHistory']>> | undefined;

    if (mode.mode === 'continue' || (continueSessionId && !newSession)) {
      const sid = continueSessionId!;
      const existing = liveSessions.get(sid);
      if (!existing) throw new Error(`Session not found: ${sid}`);
      active.sessionId = sid;
      sessionId = sid;
      send('session', { sessionId: sid, title: existing.manifest.title });
      history = await liveSessions.buildHistory(sid);
    } else {
      const manifest = liveSessions.create(goal);
      sessionId = manifest.sessionId;
      active.sessionId = sessionId;
      send('session', { sessionId, title: manifest.title });
    }

    const state = await rt.run(goal, history ? { conversationHistory: history } : undefined);
    if (sessionId && active.runId) {
      try {
        liveSessions.attachRun(sessionId, active.runId);
      } catch (err) {
        console.warn(`[ui] session attach failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return finishDone(send, rt, state, workspace, before, harnessTrace, runStartedAt, runsDir, sessionId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('__CRASH__') && active.runId) {
      setPhase(active.runId, 'crashed');
      send('crashed', { runId: active.runId, message: msg, sessionId: active.sessionId });
    } else {
      if (active.runId) setPhase(active.runId, 'failed');
      send('error', { message: msg, runId: active.runId, sessionId: active.sessionId });
    }
  } finally {
    endActiveRun(active.runId ?? key);
    res.end();
  }
}

function finishDone(
  send: SseSend,
  rt: Runtime,
  state: Awaited<ReturnType<Runtime['run']>>,
  workspace: string,
  before: FileSnapshot,
  harnessTrace: TraceCollector,
  runStartedAt: number,
  runsDir: string,
  sessionId?: string,
): void {
  const after = snapshotWorkspace(workspace);
  const diffs: FileDiff[] = diffSnapshots(before, after);
  const analysis = readAnalysisMd(workspace);
  const answer = extractAnswer(state);
  const thinking = extractThinking(state);
  const runtimeTrace = rt.trace(state.runId);
  const agentTrace = harnessTrace.snapshot(Date.now() - runStartedAt);
  try {
    saveHarnessTrace(runsDir, state.runId, agentTrace);
  } catch {
    /* sidecar is best-effort — live SSE still carries the harness snapshot */
  }
  setPhase(state.runId, state.status === 'completed' ? 'completed' : 'failed');

  send('done', {
    runId: state.runId,
    sessionId,
    status: state.status,
    error: state.error,
    answer,
    thinking,
    analysis,
    plan: extractPlan(state),
    critiques: extractCritiques(state),
    diffs: diffs.map((d) => ({
      path: d.path,
      status: d.status,
      unified: d.unified,
      before: d.before,
      after: d.after,
    })),
    runtimeTrace,
    harnessTrace: agentTrace,
  });
}

function parseLoopMode(raw: unknown): HarnessLoopMode | undefined {
  if (raw === 'agent' || raw === 'planner' || raw === 'reflection') return raw;
  return undefined;
}

function resolveRunsDir(cfg: CodingConfig): string {
  return isAbsolute(cfg.run.runsDir) ? cfg.run.runsDir : join(PACKAGE_ROOT, cfg.run.runsDir);
}

function openReadonlyRuntime(runsDir: string, cfg: CodingConfig): Runtime {
  // Status / list / session manifests only need the event log — inject a stub chat model
  // so Workbench can inspect history without an API key.
  const stubChat: ChatModelProvider = {
    name: 'stub-readonly',
    async chat() {
      throw new Error('readonly runtime: chat not available');
    },
  };
  return createCodingRuntime({
    baseDir: runsDir,
    workspaceRoot: resolveWorkspaceRoot(undefined, process.env, cfg),
    config: cfg,
    pricing: cfg.pricing,
    policy: cfg.policy,
    autoApproveWrites: true,
    approver: autoApprove,
    chatModel: stubChat,
  });
}

function openSessions(runsDir: string, cfg: CodingConfig): SessionManager {
  return new SessionManager(openReadonlyRuntime(runsDir, cfg), runsDir);
}

function jsonResult(res: ServerResponse, result: { ok: true } | { ok: false; error: string }): void {
  if (result.ok) return json(res, 200, { ok: true });
  return json(res, 404, { error: result.error });
}

/** Resolve and validate a workspace directory. */
function pickWorkspace(override?: string): string {
  const raw = (override?.trim() || resolveWorkspaceRoot()).trim();
  const abs = resolve(raw);
  if (!existsSync(abs)) throw new Error(`Workspace does not exist: ${abs}`);
  if (!statSync(abs).isDirectory()) throw new Error(`Workspace is not a directory: ${abs}`);
  return abs;
}

function contentType(file: string): string {
  switch (extname(file)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function sendFile(res: ServerResponse, file: string, type: string): void {
  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(file));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error(`request body too large (max ${maxBytes} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolvePromise(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

main();

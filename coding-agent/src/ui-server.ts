/**
 * Local workbench UI for coding-agent — run goals, stream progress, show
 * ANALYSIS.md + code diffs without using the CLI.
 *
 *   npm run ui -w @agent/coding-agent
 *   open http://127.0.0.1:8787
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { autoApprove, FALLBACK_PRICING, TraceCollector } from '@agent/harness';
import { extractAnswer } from 'durable-agent-runtime';

import { resetCodingSandbox } from './fixture-reset.js';
import { loadCodingConfig } from './config.js';
import { createCodingRuntime, DEFAULT_WORKSPACE, PACKAGE_ROOT, resolveWorkspaceRoot } from './runtime-factory.js';
import { loadEnvFile } from './load-env.js';
import { resolveCodingMaxPromptTokens, resolveModelIdFromEnv } from './prompt-budget.js';
import {
  diffSnapshots,
  readAnalysisMd,
  snapshotWorkspace,
  type FileDiff,
} from './workspace-diff.js';

loadEnvFile(join(PACKAGE_ROOT, '.env'));
loadEnvFile(join(PACKAGE_ROOT, '.env.local'));

const HOST = process.env.CODING_AGENT_UI_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CODING_AGENT_UI_PORT ?? 8787);
const STATIC_DIR = join(PACKAGE_ROOT, 'ui', 'static');

let busy = false;

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
      busy,
      defaultGoal: defaultGoal(workspace),
      modelId,
      maxPromptTokens: resolveCodingMaxPromptTokens({
        model: modelId,
        softCap: cfg.run.compaction.softCapTokens,
      }),
    });
  }

  if (req.method === 'POST' && path === '/api/reset') {
    const body = await readJson(req);
    const workspace = pickWorkspace(typeof body.workspace === 'string' ? body.workspace : undefined);
    if (resolve(workspace) !== resolve(DEFAULT_WORKSPACE)) {
      return json(res, 400, { error: 'Reset is only allowed for the built-in coding-sandbox fixture' });
    }
    resetCodingSandbox(workspace);
    return json(res, 200, { ok: true, workspace });
  }

  if (req.method === 'POST' && path === '/api/run') {
    if (busy) return json(res, 409, { error: 'A run is already in progress' });
    const body = await readJson(req);
    const goal = typeof body.goal === 'string' ? body.goal.trim() : '';
    if (!goal) return json(res, 400, { error: 'goal is required' });
    const cfg = loadCodingConfig();
    const keyEnvs = [cfg.model.apiKeyEnv, ...cfg.model.apiKeyEnvFallbacks];
    if (!keyEnvs.some((k) => Boolean(process.env[k]))) {
      return json(res, 400, {
        error: `Set ${cfg.model.apiKeyEnv} in coding-agent/.env (or the environment)`,
      });
    }

    let workspace: string;
    try {
      workspace = pickWorkspace(typeof body.workspace === 'string' ? body.workspace : undefined);
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }

    busy = true;
    const before = snapshotWorkspace(workspace);
    const runsDir = isAbsolute(cfg.run.runsDir)
      ? cfg.run.runsDir
      : join(PACKAGE_ROOT, cfg.run.runsDir);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('status', { phase: 'starting', workspace });

    const harnessTrace = new TraceCollector({
      promptUsdPerToken: cfg.pricing?.promptUsdPerToken ?? FALLBACK_PRICING.promptUsdPerToken,
      completionUsdPerToken: cfg.pricing?.completionUsdPerToken ?? FALLBACK_PRICING.completionUsdPerToken,
    });
    const runStartedAt = Date.now();

    try {
      const rt = createCodingRuntime({
        baseDir: runsDir,
        workspaceRoot: workspace,
        config: cfg,
        pricing: cfg.pricing,
        policy: cfg.policy,
        autoApproveWrites: true,
        approver: autoApprove,
        maxTurns: cfg.run.maxTurns,
        harnessTrace,
        onEvent: (e) => {
          if (e.type === 'RunStarted') send('run', { runId: e.runId });
          if (e.type === 'ToolCallRequested') send('tool', { tool: e.tool, args: e.args, status: 'start' });
          if (e.type === 'ToolCallSucceeded') send('tool', { tool: e.tool, status: 'ok' });
          if (e.type === 'ToolCallFailed') send('tool', { tool: e.tool, status: 'error', error: e.error });
          if (e.type === 'ModelCalled') {
            send('model', {
              callId: e.callId,
              phase: e.phase,
              promptTokens: e.promptTokens,
              completionTokens: e.completionTokens,
              tokens: e.promptTokens + e.completionTokens,
              costUsd: e.costUsd,
              latencyMs: e.latencyMs,
              cached: Boolean(e.cached),
            });
          }
          if (e.type === 'PolicyDenied') {
            send('policy', { scope: e.scope, target: e.target, code: e.code, reason: e.reason });
          }
        },
      });

      const state = await rt.run(goal);
      const after = snapshotWorkspace(workspace);
      const diffs: FileDiff[] = diffSnapshots(before, after);
      const analysis = readAnalysisMd(workspace);
      const answer = extractAnswer(state);
      const runtimeTrace = rt.trace(state.runId);
      const agentTrace = harnessTrace.snapshot(Date.now() - runStartedAt);

      send('done', {
        runId: state.runId,
        status: state.status,
        error: state.error,
        answer,
        analysis,
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
    } catch (e) {
      send('error', { message: e instanceof Error ? e.message : String(e) });
    } finally {
      busy = false;
      res.end();
    }
    return;
  }

  json(res, 404, { error: 'not found' });
}

/** Resolve and validate a workspace directory (custom path or default sandbox). */
function pickWorkspace(override?: string): string {
  const raw = (override?.trim() || resolveWorkspaceRoot()).trim();
  const abs = resolve(raw);
  if (!existsSync(abs)) throw new Error(`Workspace does not exist: ${abs}`);
  if (!statSync(abs).isDirectory()) throw new Error(`Workspace is not a directory: ${abs}`);
  return abs;
}

function defaultGoal(workspace: string): string {
  const req = join(workspace, 'REQUIREMENT.md');
  if (existsSync(req)) {
    return readFileSync(req, 'utf8').trim();
  }
  return 'Fix getUserName null session, run tests, write ANALYSIS.md';
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Keep import.meta.url referenced so tsx resolves correctly when run as main.
void fileURLToPath;
main();

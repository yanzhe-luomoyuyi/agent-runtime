/**
 * CLI entrypoint.
 *
 *   agent run "<issue text>"     Start a new run.
 *   agent resume <runId>         Continue an interrupted run from its event log.
 *   agent status <runId>         Print the derived state of a run.
 *   agent recover                Drive any interrupted runs to completion.
 *   agent trace <runId>          Print the run's timeline + token/cost/replay totals.
 *   agent trace <runId> --otel   Also export the run's spans via OpenTelemetry.
 *   agent eval                   Score the demo scenarios (exit 1 on regression).
 *   agent chat                   Start an interactive multi-turn conversation.
 *   agent chat --list            List all saved conversations.
 *   agent chat --history <id>    Print a conversation's full history.
 *   agent chat --resume <id>     Continue a saved conversation.
 *   agent chat "<prompt>"        One-shot: start session, run prompt, print result.
 *
 * Set CRASH_AFTER=<stepId> (e.g. CRASH_AFTER=locate.1) to inject a crash and
 * demo resume. Run logs live under AGENT_RUNS_DIR (default: .agent-runs).
 * Set AGENT_REGRESS=1 to degrade the propose step and demo an eval regression.
 * Set HARNESS=1 to run the standalone @agent/harness loop over the runtime seam
 * (src/app/harness-adapter.ts); HARNESS_CRASH_TURN=<n> injects a mid-loop crash.
 * `agent trace <runId> --otel` exports the run's spans via OpenTelemetry. Set
 * OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) to ship
 * spans to a real collector (Jaeger/Tempo/Honeycomb/...); with neither set,
 * spans print to stdout via the console exporter so it works fully offline.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as readline from 'node:readline';

import { createDemoRuntime, toolSourceFromEnv } from './app/demo-runtime.js';
import { extractHarnessMessages } from './app/harness-adapter.js';
import { demoScenarios } from './app/scenarios.js';
import { renderReport, runEval, type Scenario } from './eval.js';
import { type Policy, type RateLimitRule, resolveRedactions } from './policy.js';
import { DEFAULT_PRICING, type ModelPricing } from './pricing.js';
import { Runtime } from './runtime.js';
import { SessionManager, createConversationSummarizer, type HistoryMode, type SessionManagerOptions } from './session.js';
import { renderTimeline } from './trace.js';
import { exportTrace, initOtel, shutdownOtel } from './otel.js';
import type { AgentEvent, RunState } from './types.js';

const BASE_DIR = process.env.AGENT_RUNS_DIR ?? '.agent-runs';

interface AgentConfigFile {
  pricing?: Partial<ModelPricing>;
  policy?: {
    allowedTools?: string[];
    maxCostUsd?: number;
    redactions?: string[];
    rateLimits?: Record<string, RateLimitRule>;
  };
}

function loadConfig(): AgentConfigFile {
  const path = process.env.AGENT_CONFIG ?? 'agent.config.json';
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentConfigFile;
  } catch {
    return {}; // malformed config — fall back rather than crash
  }
}

function loadPricing(): ModelPricing {
  return { ...DEFAULT_PRICING, ...loadConfig().pricing };
}

function loadPolicy(): Policy | undefined {
  const raw = loadConfig().policy;
  if (!raw) return undefined;
  return {
    allowedTools: raw.allowedTools,
    maxCostUsd: raw.maxCostUsd,
    redactions: raw.redactions ? resolveRedactions(raw.redactions) : undefined,
    rateLimits: raw.rateLimits,
  };
}

/**
 * Evals use the same factory as `run` (same tool source / workflow modes) but
 * skip the response cache so a stale hit can't mask a regression. Scenarios may
 * override policy or select the harness loop (`harness: true`).
 */
function buildEvalRuntime(baseDir: string, scenario: Scenario): Promise<Runtime> {
  return createDemoRuntime({
    baseDir,
    harness: Boolean(scenario.harness || scenario.approver),
    toolSource: toolSourceFromEnv(),
    quiet: true,
    pricing: loadPricing(),
    policy: scenario.policy ?? loadPolicy(),
    approver: scenario.approver,
  });
}

async function makeRuntime(baseDir: string = BASE_DIR): Promise<Runtime> {
  const harness = process.env.HARNESS === '1';
  return createDemoRuntime({
    baseDir,
    harness,
    toolSource: toolSourceFromEnv(),
    cache: !harness,
    pricing: loadPricing(),
    policy: loadPolicy(),
    maxTurns: numFromEnv('AGENT_MAX_TURNS'),
    crashAfterTurn: numFromEnv('HARNESS_CRASH_TURN'),
    crashAfter: process.env.CRASH_AFTER,
    onEvent: (event) => progressOnEvent(event, harness),
  });
}

function numFromEnv(name: string): number | undefined {
  const v = process.env[name];
  return v ? Number(v) : undefined;
}

/** Progress logging for both fixed-workflow and harness runs. */
function progressOnEvent(event: AgentEvent, harness: boolean): void {
  if (event.type === 'RunStarted') {
    process.stderr.write(`\u25b6 ${harness ? 'agent ' : ''}run ${event.runId}\n`);
  } else if (harness && event.type === 'ModelCalled') {
    process.stderr.write(
      `  \u00b7 ${event.callId.split(':')[1] ?? 'turn'} \u2192 model decides (${event.promptTokens}+${event.completionTokens} tok)\n`,
    );
  } else if (event.type === 'ToolCallSucceeded') {
    process.stderr.write(`  \u00b7 tool ${event.tool} \u2192 ok\n`);
  } else if (event.type === 'PolicyDenied') {
    process.stderr.write(`  \u2716 policy denied ${event.scope} "${event.target}" (${event.code})\n`);
  } else if (!harness && event.type === 'StepCompleted') {
    process.stderr.write(`  \u2713 ${event.stepId}\n`);
  } else if (!harness && event.type === 'PhaseCompleted') {
    process.stderr.write(`\u2713 phase ${event.phase}\n`);
  } else if (harness && event.type === 'RunCompleted') {
    process.stderr.write(`\u2713 agent finished\n`);
  }
}

// ── Chat (multi-turn session) ───────────────────────────────────────

async function handleChat(sessions: SessionManager, args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === '--list') {
    const list = sessions.list();
    if (list.length === 0) { process.stdout.write('No saved conversations.\n'); return; }
    for (const m of list) {
      process.stdout.write(`${m.sessionId}  ${m.updatedAt.slice(0, 19)}  ${m.title}\n`);
    }
    return;
  }

  if (sub === '--history') {
    const id = args[1];
    if (!id) throw new Error('Usage: agent chat --history <sessionId>');
    const s = sessions.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    process.stdout.write(`\n=== Session ${s.manifest.sessionId} ===\n`);
    process.stdout.write(`Title: ${s.manifest.title}\n\n`);
    for (const r of s.runs) {
      process.stdout.write(`[${r.status}] ${r.answer.slice(0, 120)}${r.answer.length > 120 ? '…' : ''}\n`);
    }
    return;
  }

  if (sub === '--resume') {
    const id = args[1];
    if (!id) throw new Error('Usage: agent chat --resume <sessionId>');
    const s = sessions.get(id);
    if (!s) throw new Error(`Session not found: ${id}`);
    process.stderr.write(`\u25b6 Resuming session ${id} (${s.runs.length} prior turns)\n`);
    await chatRepl(sessions, id);
    return;
  }

  // `agent chat "prompt"` — one-shot non-interactive.
  if (sub && !sub.startsWith('--')) {
    const prompt = args.join(' ');
    const { sessionId, state } = await sessions.start(prompt);
    process.stderr.write(`\u25b6 session ${sessionId}\n`);
    printResult(state);
    return;
  }

  // `agent chat` — interactive REPL (new session).
  await chatRepl(sessions);
}

async function chatRepl(sessions: SessionManager, sessionId?: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => { rl.setPrompt('You: '); rl.prompt(); };

  let sid = sessionId;
  let turn = 0;

  const header = sid
    ? `\u250c\u2500 Session ${sid} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`
    : `\u250c\u2500 New session \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`;
  process.stdout.write(`${header}\n\u2502 Type /exit to quit, /history to review.\n\u2514\n`);

  prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) { prompt(); continue; }

    if (trimmed === '/exit') {
      process.stdout.write(sid ? `Session saved: ${sid}\n` : 'Goodbye.\n');
      rl.close();
      return;
    }

    if (trimmed === '/history') {
      if (!sid) { process.stdout.write('(no session yet — send a message first)\n'); prompt(); continue; }
      const s = sessions.get(sid);
      if (!s) { process.stdout.write('(session not found)\n'); prompt(); continue; }
      for (let i = 0; i < s.runs.length; i++) {
        process.stdout.write(`\n  [${i + 1}] ${s.runs[i]!.answer.slice(0, 150)}${s.runs[i]!.answer.length > 150 ? '…' : ''}\n`);
      }
      process.stdout.write('\n');
      prompt();
      continue;
    }

    const userPrompt = trimmed;
    process.stderr.write(`  \u00b7 thinking...\n`);

    try {
      let result: { sessionId: string; state: import('./types.js').RunState };
      if (!sid) {
        result = await sessions.start(userPrompt);
        sid = result.sessionId;
        turn = 1;
      } else {
        result = await sessions.continue(sid, userPrompt);
        turn++;
      }

      const answer = extractChatAnswer(result.state);
      process.stdout.write(`\nAgent: ${answer}\n\n`);
    } catch (e) {
      process.stdout.write(`\n\u2716 Error: ${e instanceof Error ? e.message : String(e)}\n\n`);
    }

    prompt();
  }
}

function extractChatAnswer(state: import('./types.js').RunState): string {
  const summary = state.summary as { proposal?: string; answer?: string } | undefined;
  if (summary?.answer) return summary.answer;
  if (summary?.proposal) return summary.proposal;
  return state.error ?? '(no answer)';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, arg] = args;
  const runtime = await makeRuntime();
  const sessionOpts: SessionManagerOptions = {};
  // SESSION_HISTORY_MODE controls what prior-run context is passed to each run:
  //   'qa-pairs' (default) — user prompt + assistant answer per prior run.
  //   'full-summary'      — full message transcripts summarised via LLM, cached incrementally.
  // When 'full-summary', also set SESSION_VERBATIM_MODE=full-messages to keep the most
  // recent run's full transcript verbatim (default: qa).
  const historyMode = (process.env.SESSION_HISTORY_MODE ?? 'qa-pairs') as HistoryMode;
  if (historyMode === 'full-summary') {
    sessionOpts.historyMode = 'full-summary';
    sessionOpts.summarizeHistory = createConversationSummarizer(
      (prompt) => runtime.completeText(prompt),
    );
    sessionOpts.keepRecentRunsVerbatim = numFromEnv('SESSION_KEEP_RECENT') ?? 1;
    sessionOpts.verbatimMode = (process.env.SESSION_VERBATIM_MODE as 'qa' | 'full-messages') ?? 'qa';
    // When harness mode is active, wire full-message extraction so the summarizer
    // sees tool calls, tool results, and the agent's reasoning chain.
    if (process.env.HARNESS === '1') {
      sessionOpts.extractMessages = extractHarnessMessages;
    }
  }
  const sessions = new SessionManager(runtime, BASE_DIR, sessionOpts);

  switch (command) {
    case 'run': {
      const state = await runtime.run(arg ?? 'Login page crashes with a null session');
      printResult(state);
      break;
    }
    case 'resume': {
      if (!arg) throw new Error('Usage: agent resume <runId>');
      printResult(await runtime.resume(arg));
      break;
    }
    case 'status': {
      if (!arg) throw new Error('Usage: agent status <runId>');
      printResult(runtime.status(arg));
      break;
    }
    case 'recover': {
      const recovered = await runtime.recover();
      if (recovered.length === 0) process.stdout.write('No interrupted runs to recover.\n');
      for (const r of recovered) {
        if (r.conflict) process.stdout.write(`~ ${r.runId} skipped (another worker owns it)\n`);
        else process.stdout.write(`\u2713 ${r.runId} \u2192 ${r.state!.status}\n`);
      }
      break;
    }
    case 'trace': {
      if (!arg) throw new Error('Usage: agent trace <runId> [--otel]');
      const trace = runtime.trace(arg);
      process.stdout.write(renderTimeline(trace) + '\n');
      if (args.includes('--otel')) {
        initOtel();
        exportTrace(trace);
        await shutdownOtel();
        process.stdout.write(`Exported ${trace.spans.length} span(s) via OpenTelemetry.\n`);
      }
      break;
    }
    case 'eval': {
      const report = await runEval(demoScenarios, buildEvalRuntime);
      process.stdout.write(renderReport(report) + '\n');
      process.exitCode = report.allPassed ? 0 : 1;
      break;
    }
    case 'chat': {
      await handleChat(sessions, args.slice(1));
      break;
    }
    default:
      process.stdout.write('Usage: agent <run|resume|status|recover|trace|eval|chat> [issue|runId] [--otel]\n');
      process.exit(1);
  }
}

function printResult(state: RunState): void {
  process.stdout.write(`\n=== Run ${state.runId} \u2192 ${state.status} ===\n`);
  for (const [name, phase] of Object.entries(state.phases)) {
    process.stdout.write(`  ${name.padEnd(10)} ${phase.status.padEnd(12)} steps=[${phase.stepsCompleted.join(',')}]\n`);
  }
  const summary = state.summary as { proposal?: string; files?: string[]; turns?: number; toolsUsed?: string[] } | undefined;
  if (summary?.turns) {
    process.stdout.write(`\nAgent: ${summary.turns} turns, tools=[${(summary.toolsUsed ?? []).join(', ')}]\n`);
  }
  if (summary?.proposal) {
    process.stdout.write(`\nProposal: ${summary.proposal}\n`);
    if (summary.files?.length) process.stdout.write(`Files:    ${summary.files.join(', ')}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`\n\u2716 ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

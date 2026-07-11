/**
 * Runnable demo (no network, fully deterministic):  tsx src/demo.ts
 *
 * Five scenarios, each swap-compatible with a live tool-calling model:
 *   1. Happy path — the model fetches the issue, searches code, then answers.
 *   2. Resilience — the primary model is "down"; a resilient model (circuit
 *      breaker + fallback tier) escalates to a backup so the run still finishes.
 *   3. Compensation — a side effect commits, the run then fails, and the
 *      opt-in saga decorator rolls the side effect back.
 *   4. Scratchpad — an oversized tool result is auto-offloaded to the scratchpad;
 *      the model retrieves the full content on demand instead of losing it.
 *   5. Model compaction — once the transcript crosses the budget threshold, older
 *      messages are folded into a keyed LLM summary (durable-replay safe).
 */

import type { ChatModel, ChatRequest, ChatResponse } from '@agent/contracts';

import { createAgent } from './agent.js';
import { ContextManager, createModelSummarizer } from './context/manager.js';
import { ScratchpadToolInvoker } from './context/scratchpad.js';
import { runAgent } from './control/loop.js';
import { CompensatingToolInvoker } from './recovery/compensation.js';
import { createResilientModel } from './recovery/fallback.js';
import { TransientError } from './recovery/retry.js';
import { MockToolInvoker, RuleChatModel, finalResponse, makeTool, toolCall, toolCallResponse } from './testkit/index.js';

const GOAL = 'Login page crashes with a null session';

async function main(): Promise<void> {
  await demoHappyPath();
  await demoResilientModel();
  await demoCompensation();
  await demoScratchpad();
  await demoModelCompaction();
}

async function demoHappyPath(): Promise<void> {
  console.log('\n########## 1. happy path ##########');
  const tools = new MockToolInvoker([
    makeTool(
      'getIssue',
      'Fetch issue title/labels for a described problem.',
      { type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'] },
      (args) => {
        const issue = (args as { issue: string }).issue;
        return { title: issue.slice(0, 40), labels: ['bug'] };
      },
    ),
    makeTool(
      'searchCode',
      'Search the codebase for files relevant to a query.',
      { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      () => ({ files: ['src/auth/login.ts', 'src/auth/session.ts'] }),
    ),
  ]);

  // Deterministic "brain": decide from which tool results are already present.
  const model = new RuleChatModel((req) => {
    const called = new Set(req.messages.filter((m) => m.role === 'tool').map((m) => m.name));
    if (!called.has('getIssue')) return toolCallResponse([toolCall('c1', 'getIssue', { issue: GOAL })]);
    if (!called.has('searchCode')) return toolCallResponse([toolCall('c2', 'searchCode', { query: 'login null session' })]);
    return finalResponse('Guard against a null session in src/auth/login.ts before reading user.token.');
  });

  // ── NEW: define the agent as a configuration bundle ──
  const devAgent = createAgent({
    name: 'dev-agent',
    instructions: 'You are a senior engineer debugging a production issue.',
    model,
    tools,
  });

  const res = await runAgent({
    agent: devAgent,
    goal: GOAL,
    hooks: {
      onModelResponse: (t, m) =>
        console.log(`turn ${t}: assistant ${m.toolCalls ? '-> ' + m.toolCalls.map((c) => `${c.name}()`).join(', ') : '(final answer)'}`),
      onToolResult: (t, name, obs) => console.log(`turn ${t}:   ${name} -> ${obs}`),
    },
  });

  console.log('\n=== result ===');
  console.log(`finished: ${res.finished} | turns: ${res.turns} | stop: ${res.stopReason}`);
  console.log(`toolsUsed: ${res.toolsUsed.join(' -> ')}`);
  console.log(`answer: ${res.answer}`);
}

// ---------------------------------------------------------------------------
// 2. Resilient model: primary is "down" → circuit breaker + fallback tier.
// ---------------------------------------------------------------------------
async function demoResilientModel(): Promise<void> {
  console.log('\n########## 2. resilient model (fallback + circuit breaker) ##########');

  const tools = new MockToolInvoker([
    makeTool(
      'searchCode',
      'Search the codebase for files relevant to a query.',
      { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      () => ({ files: ['src/auth/login.ts'] }),
    ),
  ]);

  // Primary provider is unhealthy: every call throws a transient failure.
  const primary: ChatModel = {
    name: 'gpt-primary',
    chat: () => Promise.reject(new TransientError('provider overloaded (503)')),
  };

  // Backup provider works — the same rule-based brain as scenario 1.
  const backup = new RuleChatModel((req) => {
    const called = new Set(req.messages.filter((m) => m.role === 'tool').map((m) => m.name));
    if (!called.has('searchCode')) return toolCallResponse([toolCall('c1', 'searchCode', { query: 'login null session' })]);
    return finalResponse('Guard against a null session in src/auth/login.ts.');
  });

  // The resilient model is itself a ChatModel — it drops straight into runAgent.
  const model = createResilientModel({
    tiers: [
      { model: primary, retry: { retries: 1, jitter: 'none', sleep: () => Promise.resolve() }, breaker: { failureThreshold: 1 } },
      { model: backup },
    ],
    onEscalate: ({ from, to }) => console.log(`escalate: ${from} -> ${to} (primary unhealthy)`),
  });

  const res = await runAgent({
    goal: GOAL,
    model,
    tools,
    retry: { retries: 0 }, // each tier already retries; don't multiply at the loop level
    hooks: {
      onModelResponse: (t, m) =>
        console.log(`turn ${t}: assistant ${m.toolCalls ? '-> ' + m.toolCalls.map((c) => `${c.name}()`).join(', ') : '(final answer)'}`),
    },
  });

  console.log('\n=== result ===');
  console.log(`finished: ${res.finished} | turns: ${res.turns} | stop: ${res.stopReason} (answered by backup)`);
  console.log(`answer: ${res.answer}`);
}

// ---------------------------------------------------------------------------
// 3. Compensation: a side effect commits, the run fails, saga rolls it back.
// ---------------------------------------------------------------------------
async function demoCompensation(): Promise<void> {
  console.log('\n########## 3. compensation (saga rollback on failure) ##########');

  const base = new MockToolInvoker([
    makeTool(
      'createOrder',
      'Create an order (side effect).',
      { type: 'object', properties: {}, additionalProperties: true },
      () => ({ id: 'ORD-1' }),
    ),
    makeTool(
      'chargeCard',
      'Charge the customer (fails in this demo).',
      { type: 'object', properties: {}, additionalProperties: true },
      () => { throw new Error('payment gateway declined'); },
    ),
    makeTool(
      'deleteOrder',
      'Delete a previously created order (compensating action).',
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      (args) => ({ deleted: (args as { id: string }).id }),
    ),
  ]);

  // Wrap the tools: a successful createOrder is recorded so it can be undone.
  const tools = new CompensatingToolInvoker(base, {
    compensators: {
      createOrder: async ({ result }) => {
        await base.call('deleteOrder', { id: (result as { id: string }).id });
      },
    },
    onCompensate: (o) => console.log(`compensate: ${o.name} -> ${o.ok ? 'undone' : `FAILED (${o.error})`}`),
  });

  // Brain: create the order, then keep trying to charge (which always fails).
  const model = new RuleChatModel((req) => {
    const called = req.messages.filter((m) => m.role === 'tool').map((m) => m.name);
    if (!called.includes('createOrder')) return toolCallResponse([toolCall('c1', 'createOrder', {})]);
    return toolCallResponse([toolCall('c2', 'chargeCard', {})]); // repeated → loop detected
  });

  const res = await runAgent({
    goal: 'Place an order and charge the customer',
    model,
    tools,
    loopLimit: 2, // the repeated failing chargeCard trips the loop detector
    hooks: {
      onToolResult: (t, name, obs, ok) => console.log(`turn ${t}: ${name} -> ${ok ? obs : obs}`),
    },
  });

  console.log(`\nrun finished: ${res.finished} | stop: ${res.stopReason}`);

  // The run failed with a committed side effect — roll it back.
  if (!res.finished && tools.pending.length > 0) {
    console.log(`rolling back ${tools.pending.length} committed side effect(s): ${tools.pending.map((p) => p.name).join(', ')}`);
    await tools.compensate();
  }
  console.log(`pending after compensation: ${tools.pending.length}`);
}

// ---------------------------------------------------------------------------
// 4. Scratchpad: an oversized tool result is offloaded; the model reads it back.
// ---------------------------------------------------------------------------
async function demoScratchpad(): Promise<void> {
  console.log('\n########## 4. scratchpad (offload + read-back) ##########');

  const base = new MockToolInvoker([
    makeTool(
      'fetchLog',
      'Fetch the full server log for an incident (can be very large).',
      { type: 'object', properties: {}, additionalProperties: true },
      () => `LOGSTART ${'x'.repeat(6000)} NULL_SESSION at auth/login.ts:42 LOGEND`,
    ),
  ]);

  // Wrap tools: results over 4000 chars are offloaded, leaving only a pointer.
  const tools = new ScratchpadToolInvoker(base, { offloadThreshold: 4000, previewChars: 40 });

  // Brain: fetch the (huge) log → see a pointer → read it back → answer.
  const model = new RuleChatModel((req) => {
    const toolMsgs = req.messages.filter((m) => m.role === 'tool');
    const called = new Set(toolMsgs.map((m) => m.name));
    if (!called.has('fetchLog')) return toolCallResponse([toolCall('c1', 'fetchLog', {})]);
    if (!called.has('scratchpad_read')) {
      // The offload pointer is in the fetchLog observation — pull the id out of it.
      const ptr = toolMsgs.find((m) => m.name === 'fetchLog')?.content ?? '';
      const id = /id="([^"]+)"/.exec(ptr)?.[1] ?? 'sp-0';
      return toolCallResponse([toolCall('c2', 'scratchpad_read', { id })]);
    }
    return finalResponse('Null session originates at auth/login.ts:42 (found in the full log).');
  });

  const res = await runAgent({
    goal: GOAL,
    model,
    tools,
    hooks: {
      onToolResult: (t, name, obs) => console.log(`turn ${t}: ${name} -> ${obs.slice(0, 90)}${obs.length > 90 ? '…' : ''}`),
    },
  });

  console.log(`\nscratchpad entries: ${tools.store.size} | ${JSON.stringify(tools.store.list())}`);
  console.log(`finished: ${res.finished} | answer: ${res.answer}`);
}

// ---------------------------------------------------------------------------
// 5. Model compaction: cross the budget threshold → keyed LLM summary.
// ---------------------------------------------------------------------------
async function demoModelCompaction(): Promise<void> {
  console.log('\n########## 5. model-summarizer compaction ##########');

  // A dedicated summarizer model (separate from the agent brain). Records its
  // keyed calls so we can show that compaction fired deterministically.
  const summarizerCalls: string[] = [];
  const summarizer: ChatModel = {
    name: 'summarizer',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      summarizerCalls.push(req.key ?? '(no key)');
      return {
        message: { role: 'assistant', content: 'Earlier: the agent searched code and inspected several files.' },
        stopReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 10 },
      };
    },
  };

  // Small budget + low threshold so compaction triggers after a couple of turns.
  const context = new ContextManager({
    maxPromptTokens: 300,
    outputReserveTokens: 0,
    keepRecentMessages: 3,
    compactionThreshold: 0.6,
    modelSummarize: createModelSummarizer(summarizer),
  });

  const tools = new MockToolInvoker([
    makeTool('searchCode', 'Search the codebase.', { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      (args) => `matches for ${(args as { q: string }).q}: ${'file.ts '.repeat(20)}`),
  ]);

  // Brain: keep searching (growing the transcript) for several turns, then finish.
  let searches = 0;
  const model = new RuleChatModel(() => {
    if (searches++ < 5) return toolCallResponse([toolCall(`c${searches}`, 'searchCode', { q: `term${searches}` })]);
    return finalResponse('Done investigating.');
  });

  const res = await runAgent({
    goal: GOAL,
    model,
    tools,
    context,
    maxTurns: 8,
    hooks: {
      onModelResponse: (t, m) =>
        console.log(`turn ${t}: assistant ${m.toolCalls ? '-> ' + m.toolCalls.map((c) => `${c.name}()`).join(', ') : '(final answer)'}`),
    },
  });

  console.log(`\ncompaction fired ${summarizerCalls.length} time(s), keys: ${JSON.stringify(summarizerCalls)}`);
  console.log(`finished: ${res.finished} | turns: ${res.turns}`);
}

void main();

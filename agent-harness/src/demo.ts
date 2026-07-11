/**
 * Runnable demo (no network, fully deterministic):  tsx src/demo.ts
 *
 * Wires a rule-based mock brain and two in-memory tools into `runAgent` and
 * prints the model-driven trajectory: the model decides to fetch the issue,
 * search the code, then answer — the harness runs each tool and feeds the
 * observation back. Swap the mock for a live tool-calling model (same ChatModel
 * contract) and nothing else changes.
 */

import { createAgent } from './agent.js';
import { runAgent } from './control/loop.js';
import { MockToolInvoker, RuleChatModel, finalResponse, makeTool, toolCall, toolCallResponse } from './testkit/index.js';

const GOAL = 'Login page crashes with a null session';

async function main(): Promise<void> {
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

void main();

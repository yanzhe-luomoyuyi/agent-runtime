# @agent/harness

A **model-driven agent harness**: the model decides what to do each turn (call a
tool, or answer), and the harness runs the loop around it — validating tool
calls, recovering from failures, managing context, and coordinating richer
control flow.

It is **runtime-agnostic**. It depends only on [`@agent/contracts`](../agent-contracts)
(messages, tool specs, and the `ChatModel` / `ToolInvoker` interfaces) and knows
nothing about how a host runs it. A plain host calls `runAgent` directly; a
durable host (the [`durable-agent-runtime`](../durable-agent-runtime)) implements
those same contracts over its idempotent `ctx.callModel` / `ctx.callTool` so every
turn becomes replayable.

> Contrast with the runtime's demo *workflow* (`analyze -> locate -> propose`),
> whose control flow is fixed in code. Here the **model** drives; the harness is
> the platform around it.

## What's in it (the four layers)

| Layer | Folder | What it does |
| --- | --- | --- |
| **A** — tool-calling protocol | `src/protocol`, `src/schema` | Interpret a `ChatResponse` into validated tool calls or a final answer. Arguments are checked against each tool's `inputSchema` **before** execution; a bad call becomes a structured error, not a crash. Includes a tolerant text parser for models without native tool calling. |
| **B** — recovery / self-healing | `src/recovery` | Retry only *transient* model/tool failures with backoff (`withRetry`); turn a thrown tool into an observation the model can react to; detect no-progress loops of identical calls. |
| **C** — context / memory | `src/context` | Token-budgeted prompt assembly with rolling compaction (keep system + recent, summarize the rest), observation truncation, and **untrusted-output isolation** — tool results are fenced as "data only" so a poisoned result can't hijack the agent. |
| **D** — control flow | `src/control` | The core `runAgent` loop, plus `runPlannedAgent` (plan-then-execute), `runReflectiveAgent` (self-critique & revise), `makeSubagentTool` (delegation as a tool), and a human-in-the-loop `Approver`. |

## The seam & durability

Both contract methods carry an idempotency `key`:

```ts
model.chat({ messages, tools, key })      // key = `${prefix}t${turn}`
tools.call(name, args, { key })           // key = `${prefix}t${turn}:${callId}`
```

The harness generates these deterministically. A durable host maps each `key`
onto its event-log call id, so on resume completed turns replay from the log
without re-issuing side effects. Sub-agents extend the `keyPrefix`, keeping keys
globally unique across nesting (`t1:p1:t1:s1`, …).

## Layout

```
src/
  schema/validate.ts        # A: minimal JSON-Schema arg validator
  protocol/tool-calling.ts  # A: response -> validated calls | final
  context/manager.ts        # C: budgeting, compaction, untrusted fencing
  recovery/retry.ts         # B: transient retry + backoff
  recovery/loop-detector.ts # B: no-progress detection
  control/loop.ts           # D: the core agentic loop (composes A/B/C)
  control/planner.ts        # D: plan-then-execute
  control/reflection.ts     # D: self-critique & revise
  control/subagent.ts       # D: delegation as a tool
  control/human.ts          # D: approval seam
  testkit/index.ts          # deterministic ChatModel / ToolInvoker doubles
  demo.ts                   # runnable offline demo
```

## Use

```powershell
# from the workspace root (c:\Users\yadu\Desktop\agent)
npm install                 # links @agent/contracts into this package
npm run build               # builds @agent/contracts then @agent/harness
npm test                    # builds contracts, then runs vitest here

# just this package
npm test -w @agent/harness
npm run dev -w @agent/harness   # runs the offline demo (tsx src/demo.ts)
```

### Minimal example

```ts
import { runAgent } from '@agent/harness';
import { MockToolInvoker, RuleChatModel, makeTool, toolCall, toolCallResponse, finalResponse } from '@agent/harness/testkit';

const tools = new MockToolInvoker([
  makeTool('searchCode', 'search', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    () => ({ files: ['src/auth/login.ts'] })),
]);

const model = new RuleChatModel((req) => {
  const done = req.messages.some((m) => m.role === 'tool');
  return done
    ? finalResponse('Guard the null session in src/auth/login.ts.')
    : toolCallResponse([toolCall('c1', 'searchCode', { query: 'login null session' })]);
});

const res = await runAgent({ goal: 'Login crashes on a null session', model, tools });
console.log(res.answer, res.toolsUsed);
```

## Running on the durable runtime (next step)

The integration is a thin adapter (to live in the runtime's `app/` layer) that
implements `ChatModel` + `ToolInvoker` by delegating to `ctx.callModel` /
`ctx.callTool` and forwarding the `key`. The harness code does not change — that
is the point of keeping it runtime-agnostic behind `@agent/contracts`.

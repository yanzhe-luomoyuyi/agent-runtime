# durable-agent-runtime

A small, dependency-light **agent runtime** that makes multi-phase LLM agents
**durable and resumable** — inspired by studying a production agent, then
rebuilding the *platform layer* underneath it with stronger guarantees.

> The demo workload (an issue → fix agent) is deliberately thin. The point of
> this project is the **runtime**: event-sourced state, crash-safe resume,
> idempotent tool calls, and a pluggable model provider.

---

## Why this exists

Many agents persist progress by **overwriting a single snapshot** file (a
"checkpoint"). That works until two things happen: a crash mid-write, or a tool
side effect that you don't want to repeat on resume. This runtime takes the
event-sourcing approach instead:

| Concern | Snapshot / overwrite checkpoint | This runtime (event-sourced) |
|---|---|---|
| Persistence | Overwrite one JSON blob | Append-only event log, one exclusively-created file per event |
| State | Stored directly (can be half-written) | **Derived** by folding events through a pure reducer |
| Crash safety | Partial write can corrupt state | A crash leaves a valid, replayable **prefix** |
| Resume | Re-run from a coarse "phase/step" marker | Replay log → continue at first incomplete step |
| Repeated side effects | Tools re-run on resume | **Idempotent**: completed tool calls are replayed, not re-executed |
| Auditability | Last state only | Full ordered history (time-travel / debugging) |

---

## Architecture

```mermaid
flowchart LR
    CLI[cli.ts] --> RT[Runtime]
    RT -->|append| LOG[(Event Log<br/>one file per event)]
    LOG -->|reduce| ST[RunState]
    ST --> RT
    RT --> WF[Workflow<br/>phases + steps]
    WF -->|callTool / callModel| POL{{Policy<br/>allow-list · budget · PII}}
    POL -->|tool| TR[Tool Registry]
    POL -->|model| MP[Caching Model Provider]
    TR --> LOCAL[Local ToolDefs]
    TR --> ADP[MCP adapter] --> SDK[MCP base SDK<br/>JSON-RPC · transport · token cache] --> SRV[(MCP servers)]
    MP --> BASE[Base Model]
    RT -.onEvent.-> OBS[[trace: spans + tokens + cost + denials]]
    LOG -.project.-> EVAL[[eval: scorers + LLM-judge]]
```

The boundary is deliberate: everything under `src/` is the **runtime (platform)** and knows nothing about "issues" or "fixes"; everything under `src/app/` is the **demo workload** and can be swapped without touching the runtime.

**Runtime — the platform (`src/`)**

- **Event log** ([src/eventlog.ts](src/eventlog.ts)) — append-only; one exclusively-created file per event (optimistic concurrency).
- **Reducer** ([src/reducer.ts](src/reducer.ts)) — pure `(state, event) => state`; the only way state is built.
- **Runtime** ([src/runtime.ts](src/runtime.ts)) — drives the workflow, appends events, resumes from the log, and makes tool calls idempotent via deterministic `callId`s.
- **Workflow contract** ([src/workflow.ts](src/workflow.ts)) — the `WorkflowDef`/`PhaseDef`/`StepDef`/`StepContext` types describing *what a workflow looks like*. The runtime drives any workflow of this shape; it has no knowledge of the demo.
- **Model provider** ([src/model/provider.ts](src/model/provider.ts)) — swappable LLM; the mock is deterministic for offline dev and stable tests.
- **Response cache** ([src/model/caching.ts](src/model/caching.ts)) — `CachingModelProvider` decorator: content-keyed (normalized prompt → sha256), LRU-bounded, optionally file-backed. Cuts tokens/cost on repeated prompts across runs.
- **Pricing** ([src/pricing.ts](src/pricing.ts)) — config-driven token pricing (`agent.config.json`); feeds the cost totals in the trace.
- **Tool registry** ([src/tools/registry.ts](src/tools/registry.ts)) — the MCP-shaped `ToolDef`/`ToolRegistry` contract, so a local tool and a remote MCP tool look identical to the runtime.
- **Declarative policy layer** ([src/policy.ts](src/policy.ts)) — reusable guardrail middleware on the single tool/model funnel: a data-defined `Policy` (tool allow-list · cost budget · PII redaction). Denials are recorded as `PolicyDenied` events, so guardrails are observable and eval-testable — not hardcoded inside a server.
- **Shared MCP base SDK** ([src/mcp/](src/mcp/)) — the cross-cutting plumbing every MCP server would otherwise duplicate, factored out once: JSON-RPC framing, a swappable transport, and a **shared** token cache. An adapter projects a server's tools into the `ToolRegistry`, so N servers converge onto one client + one auth cache instead of re-implementing curl/JSON-RPC/token caching N times.
- **Eval harness** ([src/eval.ts](src/eval.ts)) — composable scorers (programmatic + LLM-as-judge) + a runner that grade the derived RunState/trace; `agent eval` exits non-zero on a regression.

**Demo workload — the agent (`src/app/`)**

- **Workflow** ([src/app/issue-workflow.ts](src/app/issue-workflow.ts)) — the `issue → fix` agent as declarative phases/steps (`analyze → locate → propose`).
- **Tools** ([src/app/tools.ts](src/app/tools.ts)) — deterministic mock `getIssue`/`searchCode`. Run with `AGENT_MCP=1` to serve the very same tools through the MCP base SDK ([src/app/mcp-servers.ts](src/app/mcp-servers.ts)) instead — the runtime can't tell the difference.
- **Model responses** ([src/app/responses.ts](src/app/responses.ts)) — canned, deterministic outputs for the mock model.
- **Eval scenarios** ([src/app/scenarios.ts](src/app/scenarios.ts)) — the demo fixtures + expected outcomes the harness grades.

---

## Quickstart

```bash
npm install
npm run build
npm test          # includes the crash-and-resume durability test

# Run the agent
npm run dev -- run "Login page crashes with a null session"
```

### Demo: crash, then resume (the whole point)

```bash
# 1. Force a crash right after the code-search step. Note the printed run id.
CRASH_AFTER=locate.1 npm run dev -- run "Login page crashes with a null session"

# 2. Resume — it replays the log, skips completed work, does NOT re-run the
#    already-successful searchCode tool, and finishes.
npm run dev -- resume <run-id>

# 3. Inspect the derived state at any time.
npm run dev -- status <run-id>
```

Each run is a directory of sequence-numbered event files (one JSON per event):

```bash
ls .agent-runs/<run-id>/   # 000000000000.json, 000000000001.json, ...
```

### Demo: declarative guardrails (allow-list · budget · PII)

```bash
# Policy is data in agent.config.json. The eval includes a guardrail scenario that
# shrinks the budget to prove the runtime *refuses* the overspending call (records a
# PolicyDenied event and fails the run) — not just that a budget is configured.
npm run dev -- eval        # "cost-budget guardrail halts a runaway agent" -> PASS
```

### Demo: tools over the shared MCP base SDK

```bash
# Serve the same getIssue/searchCode tools through JSON-RPC + a shared token cache.
# Identical result to the local path — the runtime can't tell them apart.
AGENT_MCP=1 npm run dev -- run "Login page crashes with a null session"
# > tools via MCP base SDK — 2 servers sharing 1 auth fetch
```

---

## Design decisions worth explaining (interview notes)

1. **State is derived, never stored.** The reducer is pure, so the same log
   always rebuilds the same state. Resume is "replay to head, continue."
2. **Idempotent tool calls.** Each call gets a deterministic id
   (`<phase>.<step>:<tool>`). If the log already has its result, the runtime
   replays it instead of re-invoking the tool — so resuming never repeats a side
   effect that already happened.
3. **The crash is injected *between* the side effect and the completion event.**
   That is the exact window a naive checkpoint gets wrong; the test asserts we
   get it right.
4. **The model is a dependency, not a hardcoded call.** A deterministic mock
   enables offline runs, reproducible logs, and non-flaky evals.
5. **`onEvent` is an observability seam.** Every state transition flows through
   one place — the natural hook for tracing, token/cost accounting, and metrics.
6. **Two cache layers, on purpose.** Durable *replay* (per-run, keyed by log
   position) guarantees resume never repeats work; a separate *content* cache
   (cross-run, keyed by a normalized prompt hash) cuts cost on repeated prompts.
   They solve different problems and compose.
7. **Eval is just another projection.** Scorers read the same event-sourced
   RunState/trace a run already produces, so grading is "read the history." Evals
   run on a fresh, un-cached model so a stale cache can't mask a regression.
8. **Guardrails are a declarative layer, not server code.** Tool allow-list,
   cost budget, and PII redaction live as *data* on the one tool/model funnel, so
   the same policy composes over any workflow and any tool. Every denial is a
   durable `PolicyDenied` event — which is why the eval can assert a guardrail
   actually *fires*, not merely that it's configured.
9. **One MCP base SDK; servers converge onto it.** JSON-RPC, transport, and a
   shared token cache are factored out once. Adding a server is "point a client at
   a transport," not "re-implement curl + JSON-RPC + token caching" — and the
   adapter makes remote tools indistinguishable from local ones to the runtime.

---

## Roadmap

- **D2 — Durability core** ✅ event log + reducer + resume + idempotency (this commit).
- **D3 — Concurrency safety** ✅ optimistic-concurrency append (exclusive-create) + `ConflictError` + a `recover()` supervisor.
- **D4 — Observability** ✅ per phase/step/tool/model spans + token/cost/latency totals via `agent trace`; model calls now flow through the runtime (recorded as `ModelCalled` events + idempotent on resume).
- **D5 — Eval harness** ✅ scenario fixtures + composable scorers (programmatic + LLM-as-judge) grading the RunState/trace; `agent eval` (exits non-zero on failure). Demo: `AGENT_REGRESS=1 agent eval` degrades a prompt → the harness catches the regression.
- **D6 — Polish** ✅ architecture write-up (this file) + refreshed [TESTING.md](TESTING.md) + a scripted end-to-end walkthrough ([demo.ps1](demo.ps1): run → crash → resume → recover → trace → eval).
- **D7 — Shared MCP base SDK** ✅ JSON-RPC + swappable transport + a shared, refreshing token cache ([src/mcp/](src/mcp/)); an adapter projects remote tools into the `ToolRegistry`. `AGENT_MCP=1 agent run` serves the demo tools through it with identical results (one auth fetch shared across servers).
- **D8 — Declarative policy layer** ✅ tool allow-list / cost budget / PII redaction ([src/policy.ts](src/policy.ts)) enforced on the tool/model funnel, recorded as `PolicyDenied` events and surfaced in `agent trace`. The eval includes a guardrail-regression scenario asserting the budget actually halts a run.

## License

MIT

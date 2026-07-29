# Testing & Verification

How to verify the runtime works — one automated command, plus manual CLI checks.

> Run everything from the `durable-agent-runtime/` directory (or `npm test -w durable-agent-runtime` from the repo root).

## 1. Automated tests (one command)

```bash
npm test
```

Expected: **115 passed** across 15 files. Core areas:

| File | What it covers |
| --- | --- |
| `resume.test.ts` | Clean run, event-sourcing invariant, crash resume + tool idempotency |
| `concurrency.test.ts` | Optimistic concurrency, `recover()`, side-effect-free `status()` |
| `trace.test.ts` | Span timeline, replay hit rate, injected pricing |
| `caching.test.ts` | Content-addressed model cache hit/miss/LRU |
| `eval.test.ts` | Demo scenarios pass; regression + LLM-judge catch degraded proposals |
| `harness-integration.test.ts` | `@agent/harness` as a durable step; mid-loop resume |
| `policy.test.ts` | Allow-list, budget, PII redaction, rate limits |
| `snapshot.test.ts` | Checkpoint write/load + fall back to full replay |
| `durability.test.ts` | Critical/relaxed event tiers, batching, replay-cost benchmark |
| `dead-letter.test.ts` | File DLQ + runtime funnel enqueue |
| `mcp.test.ts` | Shared MCP base SDK + adapter |
| `retrieval.test.ts` / `memory-*.test.ts` | RAG + cross-session memory |
| `harness-compaction.test.ts` | Model-driven compaction bridge |

## 2. Type check / build

```bash
npm run build
```

Expected: no output, no errors (TypeScript compiles clean).

## 3. Manual CLI verification (see it actually run)

Optional — make the symbols render on Windows PowerShell:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

### a. A clean run
```bash
npm run dev -- run "Login page crashes with a null session"
```
Expect: `analyze → locate → propose` each complete, then `→ completed` and a Proposal. Note the printed `run-...` id.

### b. Inject a crash (durability)
```bash
CRASH_AFTER=locate.1 npm run dev -- run "Token not refreshed on focus"
```
Expect: it stops with `__CRASH__ injected after locate.1`. The run is left resumable.

### c. Auto-recover interrupted runs
```bash
npm run dev -- recover
```
Expect: `✓ run-... → completed`. Crucially, **no `tool searchCode` line** appears during recovery — the tool result is replayed from the log (idempotency), not re-executed.

### d. Inspect a run's state
```bash
npm run dev -- status <run-id>          # full id, including the run- prefix
```
Expect: all phases `COMPLETED`. An unknown id fails loudly with `Run not found` (and creates nothing).

### e. Inspect the event log (the durability evidence)
```bash
ls .agent-runs/<run-id>/                # 000000000000.json, 000000000001.json, ...
cat .agent-runs/<run-id>/*.json         # the full event stream
```
Expect: `RunStarted → PhaseStarted → StepStarted → ToolCall… → StepCompleted → … → RunCompleted`.

### f. Inspect the trace (observability)
```bash
npm run dev -- trace <run-id>
```
Expect: a per-span timeline plus totals — model/tool calls, prompt/completion tokens, cost (USD), wall time, and a durable-replay hit rate (`>0` if the run was resumed).

### g. Run the eval harness (quality gate)
```bash
npm run dev -- eval
```
Expect: each scenario prints its scorer checks and **5/5 scenarios passed**, exit code `0`. Simulate a regression:
```bash
AGENT_REGRESS=1 npm run dev -- eval    # PowerShell: $env:AGENT_REGRESS='1'; npm run dev -- eval
```
Expect: the login scenario's proposal + judge checks fail → non-zero exit.

### h. Harness mode (model-driven loop)
```bash
HARNESS=1 npm run dev -- run "Login page crashes with a null session"
```

### i. One command that runs the whole story
```powershell
pwsh ./demo.ps1            # pauses between sections (good for screen recording)
pwsh ./demo.ps1 -NoPause   # straight through
```

## One-line summary

> `npm test` verifies the durability/policy/eval/harness surface; `run` / `recover` demo crash-recovery + idempotency live; `trace` shows cost/latency/replay; `eval` gates quality (and catches a simulated regression); the files under `.agent-runs/<id>/` are the persisted proof.

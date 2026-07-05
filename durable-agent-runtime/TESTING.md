# Testing & Verification

How to verify the runtime works — one automated command, plus manual CLI checks.

> Run everything from the `durable-agent-runtime/` directory.

## 1. Automated tests (one command)

```bash
npm test
```

Expected: **20 passed**. The suite covers every core guarantee:

**`test/resume.test.ts` — durability (4)**
1. Completes a clean run end to end.
2. Keeps in-memory state equal to `reduce(log)` — the event-sourcing invariant.
3. Resumes after a mid-run crash **without re-executing completed tool calls** (idempotency).
4. Deterministic: a resumed run yields the same final state as a clean run.

**`test/concurrency.test.ts` — concurrency & recovery (4)**
5. Rejects a second writer that claims an already-taken version (optimistic concurrency → `ConflictError`).
6. `recover()` finds an interrupted run and drives it to completion.
7. `status()` on an unknown run throws and creates nothing (reads are side-effect-free).
8. `recover()` ignores stray empty directories.

**`test/trace.test.ts` — observability (4)**
9. Builds a timeline of 12 spans (run/phase/step/tool/model) with token/cost/wall totals.
10. Model calls are idempotent across a crash + resume — replayed from the log, not re-issued.
11. Cost is computed from **injected** pricing (configurable, not hardcoded).
12. Reports a durable-replay hit rate: `0` on a clean run, `>0` after a resume.

**`test/caching.test.ts` — content cache (5)**
13. Identical prompts are served from cache; distinct prompts miss (hit/miss counters).
14. A second run with the same issue serves every model call from the cache (`costSavedUsd > 0`).
15. Normalizes whitespace so trivial formatting differences still hit.
16. Evicts least-recently-used entries when the store is full (LRU bound).
17. Accepts a custom key function (keying is decoupled/injectable).

**`test/eval.test.ts` — eval harness (3)**
18. Every scenario passes on a good model config.
19. Catches a regression when the prompt/model degrades (a proposal check fails).
20. LLM-as-judge scorer passes a good proposal and fails a degraded one.

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

### c. Auto-recover the interrupted run
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
Expect: each scenario prints its scorer checks (including an LLM-as-judge line) and `2/2 scenarios passed`, exit code `0`. Simulate a regression:
```bash
AGENT_REGRESS=1 npm run dev -- eval    # PowerShell: $env:AGENT_REGRESS='1'; npm run dev -- eval
```
Expect: the login scenario's proposal + judge checks fail → `1/2 scenarios passed — REGRESSION`, exit code `1`.

### h. One command that runs the whole story
```powershell
pwsh ./demo.ps1            # pauses between sections (good for screen recording)
pwsh ./demo.ps1 -NoPause   # straight through
```

## One-line summary

> `npm test` verifies twenty invariants in ~1s; `run` / `recover` demo crash-recovery + idempotency live; `trace` shows cost/latency/replay; `eval` gates quality (and catches a simulated regression); the files under `.agent-runs/<id>/` are the persisted proof.

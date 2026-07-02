# Testing & Verification

How to verify the runtime works — one automated command, plus manual CLI checks.

> Run everything from the `durable-agent-runtime/` directory.

## 1. Automated tests (one command)

```bash
npm test
```

Expected: **8 passed**. The suite covers every core guarantee:

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

## One-line summary

> `npm test` verifies eight invariants in ~1s; `run` / `recover` demo crash-recovery + idempotency live; the files under `.agent-runs/<id>/` are the persisted proof.

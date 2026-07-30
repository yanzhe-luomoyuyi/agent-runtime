# coding-agent run artifacts (reference)

## Event log

Files `NNNNNNNNNNNN.json` under the run dir are append-only shards. Each file is either one event object or an array of events.

Common `type` values:

| type | Role |
|---|---|
| `RunStarted` | `input`, `workflow`, `runId` |
| `PhaseStarted` / `PhaseCompleted` | phase boundaries |
| `StepStarted` / `StepCompleted` | step boundaries; `StepCompleted.output` often has `answer` |
| `ModelCalled` | idempotent model result: `callId`, `prompt`, `response`, tokens, `costUsd`, `latencyMs`, `cached?` |
| `ToolCallRequested` | pending tool |
| `ToolCallSucceeded` / `ToolCallFailed` | tool outcome |
| `RunCompleted` / `RunFailed` | terminal; `summary` or error |

`ModelCalled.callId` looks like `agent.1:t:N:model` (turn index in the id).

## harness-trace.json

Sidecar written when a run finishes (`session-trace.ts`). Shape is harness `AgentTrace`:

- Totals: `runDurationMs`, `totalTurns`, `totalRetries`, token/cost fields, tool ok/fail
- `turns[]`: each has `model` (`durationMs`, `usage`, `ok`, `retries`) and `tools[]` (`tool`, `args`, `ok`, `durationMs`, `error?`) plus optional `context` compact/assemble stats

**Note:** wall `runDurationMs` ≈ sequential model + tool time; model sum can dominate when the last completion is long.

## snapshot.json

```json
{ "version": 1, "state": { /* RunState */ }, "spentUsd": 0.01 }
```

Useful `state` fields: `status`, `input`, `summary`, `stepOutputs`, `modelResults`, `toolResults`.

## sessions/

`sessions/sess-*.json` maps a chat session to `runIds` and `title`. Match by timestamp prefix of the run id when needed.

---
name: analyze-coding-agent-run
description: >-
  Analyze a coding-agent run from local trace/event data under
  coding-agent/.coding-agent-runs (harness-trace.json, event log, snapshot).
  Use when the user asks why a run was slow, what model calls did, final answer
  content, token/cost breakdown, tool failures, or to inspect a run id like
  run-… / Run run-….
---

# Analyze coding-agent run

## Data root

All runs live under:

```text
coding-agent/.coding-agent-runs/
├── run-<id>/
│   ├── 000000000000.json …     # event log shards (single event or event[])
│   ├── harness-trace.json      # harness AgentTrace sidecar (latency / tokens / tools)
│   └── snapshot.json           # reduced RunState (+ spentUsd)
└── sessions/sess-*.json        # session → runIds / title
```

Resolve `run-<id>` (accept bare id or `run-…`). If missing, list `coding-agent/.coding-agent-runs/run-*` and ask.

## First step (always)

Run the summarizer (do not hand-parse the whole log first):

```bash
python3 .agents/skills/analyze-coding-agent-run/scripts/summarize_run.py <run-id>
```

Optional:

```bash
python3 .agents/skills/analyze-coding-agent-run/scripts/summarize_run.py <run-id> --answer-chars 4000
python3 .agents/skills/analyze-coding-agent-run/scripts/summarize_run.py <run-id> --json
```

Use its output as the spine of the analysis.

## What each artifact answers

| Question | Source |
|---|---|
| Wall time, turns, tool ok/fail, cost | `harness-trace.json` top-level |
| Per-turn model latency / tokens | `harness-trace.json` → `turns[].model` |
| Why model time is high | Sum `turns[].model.durationMs`; call out outliers (often last turn writing a long answer) |
| Exact model outputs / thinking | Event `ModelCalled` → `response` (JSON string envelope) |
| Final user-visible answer | Last `ModelCalled` with `content` and no toolCalls; or `StepCompleted.output.answer`; or `snapshot.state.summary` / `RunCompleted.summary` |
| User prompt | `RunStarted.input` or `snapshot.state.input` |
| Tool errors | `harness-trace.json` tools with `ok:false`, or `ToolCallFailed` events |
| Session title / siblings | `sessions/sess-*.json` (`runIds`) |

## `ModelCalled.response` shape

`response` is a **stringified** chat envelope:

```json
{
  "v": 1,
  "kind": "chat",
  "response": {
    "message": {
      "role": "assistant",
      "content": "...",
      "toolCalls": [...],
      "thinking": "..."
    }
  }
}
```

Parse with `json.loads` twice if needed (outer event, then `response` string). Prefer `content` for the answer; `thinking` is internal.

## Analysis checklist

When the user asks about slowness / model time:

1. Report harness `runDurationMs` vs **sum of** `turns[].model.durationMs`.
2. Table each turn: `durationMs`, prompt/completion tokens, tool names.
3. Identify the dominant turn(s) and open that turn’s `ModelCalled` event for content length / toolCalls vs final prose.
4. Note tool failures that forced extra turns.
5. Quote or summarize **final answer** (truncate long bodies; offer full path to the event file).

When the user asks “最后都是什么内容”:

1. Print final answer from summarizer / last text-only `ModelCalled`.
2. Briefly list prior turns as tool-loop (names only), unless they ask for full transcript.

## Response style

- Lead with the verdict (e.g. “70s almost all last model call writing the architecture answer”).
- Numbers first; then content excerpt.
- Do not dump entire multi-KB prompts unless requested.
- Cite concrete files under `coding-agent/.coding-agent-runs/<run-id>/…`.

## Additional detail

Event type catalog and field notes: [reference.md](reference.md)

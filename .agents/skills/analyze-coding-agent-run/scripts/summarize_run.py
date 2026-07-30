#!/usr/bin/env python3
"""Summarize a coding-agent run from coding-agent/.coding-agent-runs/<run-id>/."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable


def repo_root() -> Path:
    # .../.agents/skills/analyze-coding-agent-run/scripts/summarize_run.py → repo root
    return Path(__file__).resolve().parents[4]


def runs_root() -> Path:
    return repo_root() / "coding-agent" / ".coding-agent-runs"


def normalize_run_id(raw: str) -> str:
    raw = raw.strip().rstrip("/")
    if raw.startswith("Run "):
        raw = raw[4:].strip()
    name = Path(raw).name
    return name if name.startswith("run-") else f"run-{name}"


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def iter_events(run_dir: Path) -> Iterable[dict[str, Any]]:
    for path in sorted(run_dir.glob("*.json")):
        if path.name in ("harness-trace.json", "snapshot.json"):
            continue
        data = load_json(path)
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and "type" in item:
                    yield item
        elif isinstance(data, dict) and "type" in data:
            yield data


def parse_chat_message(response_field: Any) -> dict[str, Any] | None:
    if response_field is None:
        return None
    try:
        envelope = json.loads(response_field) if isinstance(response_field, str) else response_field
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(envelope, dict):
        return None
    inner = envelope.get("response")
    if isinstance(inner, dict):
        msg = inner.get("message")
        if isinstance(msg, dict):
            return msg
    msg = envelope.get("message")
    return msg if isinstance(msg, dict) else None


def truncate(text: str, limit: int) -> str:
    if limit <= 0 or len(text) <= limit:
        return text
    return text[:limit] + f"\n… [{len(text) - limit} more chars]"


def find_session(run_id: str) -> dict[str, Any] | None:
    sessions = runs_root() / "sessions"
    if not sessions.is_dir():
        return None
    for path in sessions.glob("sess-*.json"):
        try:
            data = load_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        ids = data.get("runIds") or []
        if run_id in ids:
            return {"path": str(path), **{k: data.get(k) for k in ("sessionId", "title", "runIds", "createdAt")}}
    return None


def extract_final_answer(
    events: list[dict[str, Any]],
    snapshot: dict[str, Any] | None,
) -> tuple[str | None, str]:
    """Return (answer, source_label)."""
    for ev in reversed(events):
        if ev.get("type") == "StepCompleted":
            out = ev.get("output")
            if isinstance(out, dict) and isinstance(out.get("answer"), str) and out["answer"].strip():
                return out["answer"], "StepCompleted.output.answer"
    for ev in reversed(events):
        if ev.get("type") != "ModelCalled":
            continue
        msg = parse_chat_message(ev.get("response"))
        if not msg:
            continue
        content = msg.get("content")
        tools = msg.get("toolCalls") or []
        if isinstance(content, str) and content.strip() and not tools:
            return content, f"ModelCalled[{ev.get('callId')}]"
    if snapshot:
        state = snapshot.get("state") if isinstance(snapshot, dict) else None
        if isinstance(state, dict):
            summary = state.get("summary")
            if isinstance(summary, dict) and isinstance(summary.get("proposal"), str):
                return summary["proposal"], "snapshot.state.summary.proposal"
            if isinstance(summary, str) and summary.strip():
                return summary, "snapshot.state.summary"
    for ev in reversed(events):
        if ev.get("type") == "RunCompleted":
            summary = ev.get("summary")
            if isinstance(summary, dict) and isinstance(summary.get("proposal"), str):
                return summary["proposal"], "RunCompleted.summary.proposal"
            if isinstance(summary, str) and summary.strip():
                return summary, "RunCompleted.summary"
    return None, "missing"


def summarize(run_id: str, answer_chars: int) -> dict[str, Any]:
    run_dir = runs_root() / run_id
    if not run_dir.is_dir():
        raise FileNotFoundError(f"run dir not found: {run_dir}")

    events = list(iter_events(run_dir))
    harness_path = run_dir / "harness-trace.json"
    snapshot_path = run_dir / "snapshot.json"
    harness = load_json(harness_path) if harness_path.exists() else None
    snapshot = load_json(snapshot_path) if snapshot_path.exists() else None

    run_started = next((e for e in events if e.get("type") == "RunStarted"), None)
    input_payload = (run_started or {}).get("input")
    if input_payload is None and isinstance(snapshot, dict):
        state = snapshot.get("state")
        if isinstance(state, dict):
            input_payload = state.get("input")

    model_events = [e for e in events if e.get("type") == "ModelCalled"]
    model_rows = []
    for e in model_events:
        msg = parse_chat_message(e.get("response"))
        tools = []
        content_len = 0
        thinking_len = 0
        if msg:
            tools = [t.get("name") for t in (msg.get("toolCalls") or []) if isinstance(t, dict)]
            if isinstance(msg.get("content"), str):
                content_len = len(msg["content"])
            if isinstance(msg.get("thinking"), str):
                thinking_len = len(msg["thinking"])
        model_rows.append(
            {
                "callId": e.get("callId"),
                "latencyMs": e.get("latencyMs"),
                "promptTokens": e.get("promptTokens"),
                "completionTokens": e.get("completionTokens"),
                "costUsd": e.get("costUsd"),
                "cached": bool(e.get("cached")),
                "toolNames": tools,
                "contentChars": content_len,
                "thinkingChars": thinking_len,
            }
        )

    turns = []
    if isinstance(harness, dict):
        for t in harness.get("turns") or []:
            model = t.get("model") or {}
            usage = model.get("usage") or {}
            tools = t.get("tools") or []
            turns.append(
                {
                    "turn": t.get("turn"),
                    "modelDurationMs": model.get("durationMs"),
                    "modelOk": model.get("ok"),
                    "retries": model.get("retries"),
                    "promptTokens": usage.get("promptTokens"),
                    "completionTokens": usage.get("completionTokens"),
                    "tools": [
                        {
                            "tool": x.get("tool"),
                            "ok": x.get("ok"),
                            "durationMs": x.get("durationMs"),
                            "error": x.get("error"),
                            "args": x.get("args"),
                        }
                        for x in tools
                    ],
                }
            )

    answer, answer_source = extract_final_answer(events, snapshot if isinstance(snapshot, dict) else None)
    status = None
    if isinstance(snapshot, dict) and isinstance(snapshot.get("state"), dict):
        status = snapshot["state"].get("status")

    model_latency_sum = sum(int(r["latencyMs"] or 0) for r in model_rows)
    harness_model_sum = sum(int(t.get("modelDurationMs") or 0) for t in turns)

    return {
        "runId": run_id,
        "runDir": str(run_dir),
        "session": find_session(run_id),
        "status": status,
        "input": input_payload,
        "eventCounts": _count_types(events),
        "harness": None
        if not isinstance(harness, dict)
        else {
            "runDurationMs": harness.get("runDurationMs"),
            "totalTurns": harness.get("totalTurns"),
            "totalRetries": harness.get("totalRetries"),
            "totalToolCalls": harness.get("totalToolCalls"),
            "toolOk": harness.get("toolOk"),
            "toolFail": harness.get("toolFail"),
            "totalPromptTokens": harness.get("totalPromptTokens"),
            "totalCompletionTokens": harness.get("totalCompletionTokens"),
            "totalCachedPromptTokens": harness.get("totalCachedPromptTokens"),
            "estimatedCostUsd": harness.get("estimatedCostUsd"),
        },
        "modelLatencySumMs": model_latency_sum,
        "harnessModelDurationSumMs": harness_model_sum,
        "turns": turns,
        "modelCalls": model_rows,
        "finalAnswerSource": answer_source,
        "finalAnswer": answer,
        "finalAnswerPreview": truncate(answer, answer_chars) if answer else None,
    }


def _count_types(events: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for e in events:
        t = str(e.get("type", "?"))
        out[t] = out.get(t, 0) + 1
    return out


def format_text(data: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"run: {data['runId']}")
    lines.append(f"dir: {data['runDir']}")
    if data.get("session"):
        s = data["session"]
        lines.append(f"session: {s.get('sessionId')}  title={s.get('title')!r}")
    lines.append(f"status: {data.get('status')}")
    lines.append(f"input: {json.dumps(data.get('input'), ensure_ascii=False)}")
    lines.append(f"events: {json.dumps(data.get('eventCounts'), ensure_ascii=False)}")

    h = data.get("harness")
    if h:
        lines.append("")
        lines.append("## harness totals")
        for k, v in h.items():
            lines.append(f"  {k}: {v}")
        lines.append(f"  sum(turns.model.durationMs): {data.get('harnessModelDurationSumMs')}")
    lines.append(f"sum(ModelCalled.latencyMs): {data.get('modelLatencySumMs')}")

    lines.append("")
    lines.append("## turns (harness)")
    for t in data.get("turns") or []:
        tools = t.get("tools") or []
        tool_bits = []
        for x in tools:
            mark = "ok" if x.get("ok") else "FAIL"
            tool_bits.append(f"{x.get('tool')}[{mark}]")
        lines.append(
            f"  turn {t.get('turn')}: model={t.get('modelDurationMs')}ms "
            f"prompt={t.get('promptTokens')} completion={t.get('completionTokens')} "
            f"tools={', '.join(tool_bits) or '-'}"
        )
        for x in tools:
            if not x.get("ok") and x.get("error"):
                lines.append(f"    ! {x.get('tool')}: {x.get('error')}")

    lines.append("")
    lines.append("## model calls (events)")
    for r in data.get("modelCalls") or []:
        lines.append(
            f"  {r.get('callId')}: latency={r.get('latencyMs')}ms "
            f"prompt={r.get('promptTokens')} completion={r.get('completionTokens')} "
            f"contentChars={r.get('contentChars')} thinkingChars={r.get('thinkingChars')} "
            f"tools={r.get('toolNames') or []}"
        )

    lines.append("")
    lines.append(f"## final answer (source={data.get('finalAnswerSource')})")
    preview = data.get("finalAnswerPreview")
    if preview is None:
        lines.append("  (none)")
    else:
        for line in preview.splitlines() or [preview]:
            lines.append(f"  {line}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_id", help="run id, e.g. run-1785380433759-48d1c784")
    parser.add_argument("--answer-chars", type=int, default=2000, help="final answer preview length")
    parser.add_argument("--json", action="store_true", help="print full JSON (includes full finalAnswer)")
    args = parser.parse_args()

    run_id = normalize_run_id(args.run_id)
    try:
        data = summarize(run_id, answer_chars=args.answer_chars)
    except FileNotFoundError as e:
        print(f"error: {e}", file=sys.stderr)
        root = runs_root()
        if root.is_dir():
            available = sorted(p.name for p in root.glob("run-*") if p.is_dir())
            print("available runs:", ", ".join(available) or "(none)", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(format_text(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

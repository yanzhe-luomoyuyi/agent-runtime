---
name: repo-agent-instructions
description: >-
  Repo-scoped working rules for the agent-runtime monorepo: comment style,
  which docs to update after a feature, and when to update docs (only after
  user review). Use at the start of any coding, refactor, docs, or commit work
  in this repository.
---

# Repo Agent Instructions

Read and follow these rules before implementing, refactoring, documenting, or committing in this repo.

## 1. Comments: key points only

When writing code comments, capture only the essential design rationale / "why".
Do NOT log the human–agent communication process (e.g. "user asked X, I replied Y,
then we decided Z"). Comments should read like engineering notes, not chat transcripts.

## 2. Feature-complete = doc update

After implementing or modifying a feature (code complete), update these files as needed:

- `./README.md` (root)
- `./agent-harness/README.md`
- `./durable-agent-runtime/README.md`
- `./docs/agent-architecture-notes-full.md` (agent-harness: current vs production-grade gap)
- `./docs/agent-modules-cheatsheet.md` (key-points summary)
- `./docs/runtime-caching-and-policy.md` (durable-agent-runtime: current vs production-grade gap)
- `./docs/observability-trace-and-eval.md` (harness TraceCollector vs runtime Trace + eval design)

## 3. Docs AFTER review, not before

Do NOT update the files listed in rule 2 immediately after changing code.
Wait for the user to review the code diff and confirm it's correct.
Only update docs after the user has signed off on the implementation —
this avoids wasted doc-revert/edit work when code changes during review.

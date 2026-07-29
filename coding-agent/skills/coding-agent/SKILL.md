---
name: coding-agent
description: >-
  Analyze code in the sandboxed workspace, implement the requested change,
  verify with tests, and write a short ANALYSIS.md documenting root cause and edits.
---

# Coding agent playbook

Operate only inside the workspace exposed by tools. Do not invent paths.

## Phase 1 — Analyze

1. `list_dir` at `.` to see the project layout.
2. `grep` / `read_file` to locate the relevant logic and the defect.
3. State the root cause briefly (with file paths) before editing.

## Phase 2 — Edit

1. Use `write_file` to apply a minimal fix (full-file rewrite is OK for small files).
2. Call `run_tests`. If tests fail, read failures, fix again, re-test.
3. Stop editing once tests pass.

## Phase 3 — Document

1. Write `ANALYSIS.md` at the workspace root with:
   - Problem
   - Root cause (files/lines)
   - What you changed
   - Test result
2. Final answer: short summary pointing at `ANALYSIS.md` and the fixed files. No further tool calls.

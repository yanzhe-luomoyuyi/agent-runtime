---
name: file-scout
description: >-
  Use extract_top_comments to preview a source file's top descriptive comments
  before deciding whether to read the full file. Saves context.
---

# File scout playbook

When you need to understand what a source file does but do not yet want to load its
entire contents, use this playbook.

1. **Extract** — call `extract_top_comments` with the file path to get the top
   descriptive comments (block comments, JSDoc, line-comments, hash-comments).
2. **Summarize** — read the `comments` field in the result. It usually explains
   the file's purpose, exports, and key logic. The `totalLines` and
   `consumedLines` fields tell you how much of the file the comments cover.
3. **Decide** —
   - If the comments clearly indicate the file is relevant to your goal, proceed
     to `read_file` (use `offset`/`limit` slices when possible).
   - If the comments show the file is unrelated, skip it and move on.
   - If the comments are empty or ambiguous, fall back to `read_file` with a
     small `limit` (e.g. 50 lines) to get an initial look.

This approach reduces context window pressure when exploring large codebases.

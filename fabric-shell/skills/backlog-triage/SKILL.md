---
name: backlog-triage
description: Triage Shell-and-Growth Features in ADO via a 4-layer funnel (text, linked docs, images, code) into ai-suitable / ai-unsuitable tags + rationale comment per item
---

# Backlog Triage

Triage Features owned by the **"Shell and Growth"** team in the `Trident` ADO project, in stack-rank order, whose state is in `New` / `Definition` / `Planning`. Skip `Execution`, `Shipping`, `Closed`, `Removed`. Team areas (exact match, no descendants): `Trident\Fabric Growth and Retention`, `Trident\Shared Experience`. Current team config: `GET https://dev.azure.com/powerbi/Trident/Shell%20and%20Growth/_apis/work/teamsettings/teamfieldvalues`.

This is a **signal, not a gate** — humans own the final triage decision.

## Output per triaged item

Each item written to ADO gets exactly:

- **One primary tag** — `ai-suitable-high` / `ai-suitable-medium` / `ai-suitable-low` / `ai-unsuitable`, replacing any prior `ai-*` primary tag.
- **One marker comment** delimited by `<!-- ai-triage:v1 -->`. Suitable items get the full template; unsuitable items get a one-liner. See [`references/templates.md`](references/templates.md).

The marker comment is the **re-run diff anchor** — state lives in ADO, not in this repo. Sub-agents at L2/L3/L4 have no write tools; the orchestrator does all writes in Step 9.

## Inputs

| Parameter | Default | Effect |
|---|---|---|
| `mode` (required) | — | `default` = full run with marker diff and writes. `dry-run` = same pipeline, pass `dryRun: true` to every write tool, touch no ADO state. `re-evaluate-all` = skip diff partitioning, process every in-scope item; writes enabled. |
| `N` | `1000` | Scope window cap — how far down the stack rank to look. |
| `B` | `100` | Per-invocation batch size. If the diff finds more than `B` items needing work, the first `B` are processed; the rest is automatic on the next invocation. |

Invoked from `fabric-shell-backlog-triage-agent`, which maps user phrasing to these inputs. Do not interpret natural language here.

## Funnel

Each layer reads more sources only for survivors of the previous layer.

```
L1 (rules)    title, desc, area, state, type, tags, custom status
L2 (LLM)      + ALL comments + classified URL list
L3 (LLM+)     + linked-doc text + inline images + Figma presence
L4 (explore)  + local PowerBIClients clone via grep / glob / view
Write back    $batch tag deltas + one marker comment per item
```

Apply rules and scoring per item — do not aim for a particular funnel shape.

## Sub-agent dispatch (applies to L2, L3 phase b, L4)

Sub-agents are dispatched via the host runtime's `task(agent_type, prompt, model, ...)` tool. Each chunk runs in an isolated context. **Sub-agents do not inherit plugin MCP servers** — content they need must be in their prompt or on disk.

| Layer | agent_type | Tools available | Per-item budget |
|---|---|---|---|
| L2 | `general-purpose` | Text reasoning only. | n/a |
| L3 (phase b) | `general-purpose` | Built-in `view` (docs and images from `evidenceManifest` paths) + `web_fetch` (fabric-docs URLs). | ≤5 reads |
| L4 | `explore` | Native `grep`, `glob`, `view` against the local PowerBIClients clone. | ≤20 calls (see `references/layer4.md`) |

Always set `model` to the parent session's id (read once from `~/.copilot/settings.json` `model` field). Concurrency cap: 6 sub-agents at a time across all layers.

## Steps

### 1. Enumerate scope

Call `work-item/queryWorkItems` (Trident is the default project):

```sql
SELECT [System.Id]
FROM WorkItems
WHERE [System.AreaPath] IN (
    'Trident\Fabric Growth and Retention',
    'Trident\Shared Experience'
  )
  AND [System.WorkItemType] = 'Feature'
  AND [System.State] IN ('New', 'Definition', 'Planning')
  AND NOT [System.Tags] CONTAINS 'ai-skip-triage'
ORDER BY [Microsoft.VSTS.Common.StackRank] ASC
```

with `top: N + 50` (buffer for the sentinel slice).

The WIQL excludes any item carrying the **`ai-skip-triage`** tag — that's the human opt-out mechanism. The skill never adds, modifies, or removes that tag.

**Scope-start sentinel.** Items above this Feature ID are pre-prioritization human-review territory:

```javascript
const SCOPE_START_SENTINEL_ID = 1569385;
const sentinelIdx = results.findIndex(r => r.id === SCOPE_START_SENTINEL_ID);
const scope = (sentinelIdx >= 0 ? results.slice(sentinelIdx + 1) : results).slice(0, N).map(r => r.id);
// If sentinelIdx < 0, the sentinel was deleted or renumbered — record in run summary
// errors and fall back to top:N from rank 1.
```

Update only that constant when the team rotates the sentinel.

### 2. Diff against prior triage; clamp to B

Call in parallel:

```
work-item/getWorkItems({ ids: scope, fields: ["System.Id", "System.ChangedDate"] })
work-item/getWorkItemComments({ ids: scope })
```

For each item, locally partition its comments into **marker** (text contains `<!-- ai-triage:v1 -->`) and **non-marker**. Compute:
- `lastTriagedAt` = latest marker comment's `modifiedDate || createdDate` (or `null`)
- `lastNonTriageCommentDate` = same for non-marker comments

**Partition into process / skip:**

- `mode === 're-evaluate-all'` → every in-scope id is process.
- otherwise → process if `lastTriagedAt` is `null` OR `lastTriagedAt < max(changedDate, lastNonTriageCommentDate)`; skip otherwise.

**Clamp to B.** Take the first `B` items of the process set (stack-rank order). Remember the tail count as `itemsRemaining` for Step 9.

Keep the per-item comment list — Step 5 reuses it for L2 inputs, and Step 9 uses it to identify prior marker comments to delete.

### 3. Bulk-fetch the working set

`work-item/getWorkItems({ ids: workingSet })` (omit `fields` to get all). Step 4 reads the fields.

### 4. Layer 1 — deterministic filter

Run the node snippet from [`references/layer1.md`](references/layer1.md) over the bulk JSON. Pure data-shape checks (area, state, type, custom status, tags, regex, length). Record rejects with their reason sub-tag.

### 5. Layer 2 — text-only LLM

For L1 survivors, follow [`references/layer2.md`](references/layer2.md). Reuse Step 2's comments. For each chunk of ~20 ids:

1. Extract every URL from description + comments; classify each as `pm-spec`, `dev-design`, `ux-design`, `figma`, `wiki`, `pr`, `build`, `image`, `video`, `other`.
2. Dispatch the chunk via `task`.

Collect JSON. `hardReject != null` exits as `ai-unsuitable` + reason; survivors carry their scores + `signalsExtracted` to L3.

### 6. Layer 3a — orchestrator fetches linked content to disk

For L2 survivors, in chunks of ~10, issue MCP calls in parallel and write everything to `/tmp/ai-triage/<runId>/<itemId>/`:

| URL classification | Tool | What the orchestrator gets back |
|---|---|---|
| SharePoint doc (any `pm-spec` / `dev-design` / `ux-design`) | `sharepoint/downloadSharePointFile` | `{ filePath }` |
| Downloaded `.docx` | `docx/readDocx({ filePath, outputPath: '<dir>/doc-<n>.txt' })` | `{ outputPath, wordCount }` — **no content**, because `outputPath` writes text to disk. |
| Inline image | `work-item/downloadWorkItemAttachments` | File paths |
| `fabric-docs` URL | (no MCP call) | Pass URL through; sub-agent uses `web_fetch`. |
| Figma URL | (no MCP call) | Pass URL through; L2 already counted presence. |

Per-item cap: 2 docs + 3 images. Record fetch failures in `fetchErrors`; do not abort the run. Build an `evidenceManifest` per item (paths + metadata only). Schema is in [`references/layer3.md`](references/layer3.md).

### 7. Layer 3b — sub-agent reads from disk and re-scores

Dispatch chunks of ~10 via `task` (defaults from "Sub-agent dispatch"). Sub-agent receives L2 inputs + `evidenceManifest` and follows the prompt in [`references/layer3.md`](references/layer3.md).

Strong L2 (`clarity ≥ 4` AND `designReadiness ≥ 4`) advances to L4 even when nothing was fetched — L3 confirms or upgrades, it does not gate on rich docs.

### 8. Layer 4 — code feasibility

Dispatch L3 survivors in chunks of ~5 via `task` (`explore` agent type). Sub-agent uses local code search per [`references/layer4.md`](references/layer4.md), scores `codeScope` + `patternAvailability`, computes the final tier per [`references/scoring.md`](references/scoring.md), and emits **structured fields only**. The Step 9 orchestrator renders the comment from those fields.

### 9. Write back

Aggregate verdicts across L1–L4. Render comment bodies from [`references/templates.md`](references/templates.md) using the structured fields. Then:

1. **Tags.** For each item, build deltas: `removeTags` = every existing tag matching `^ai-suitable` / `^ai-unsuitable` / `^ai-rejected:`; `addTags` = new primary tag + any reason sub-tags. Drop reason sub-tags not in the [allowlist](references/templates.md#reason-sub-tag-allowlist). Call `work-item/updateWorkItems({ updates, dryRun })` once.
2. **Comments.** For each item, using the comment list from Step 2:
   - For each existing comment containing `<!-- ai-triage:v1 -->`, call `work-item/deleteWorkItemComment({ workItemId, commentId, dryRun })`.
   - Call `work-item/addWorkItemComment({ workItemId, text: <rendered body>, format: 'markdown', dryRun })`. The rendered body starts with the marker so future runs find it. The `format: 'markdown'` flag tells the MCP to convert to HTML before posting — ADO comments render HTML, not markdown.
   - Concurrency 2.

If `mode === 'dry-run'`, pass `dryRun: true` to all three write tools.

### 10. Print the run summary

Print the run summary template from [`references/templates.md`](references/templates.md) to chat. Nothing is written to local files.

If `itemsRemaining > 0`, end with: "**Items remaining: N.** If continuing, run `/compact` then re-invoke this skill for the next batch."

## Tools called by the orchestrator

| Tool | Step | Writes ADO? |
|---|---|:--:|
| `work-item/queryWorkItems` | 1 | — |
| `work-item/getWorkItems` | 2, 3 | — |
| `work-item/getWorkItemComments` | 2 | — |
| `sharepoint/downloadSharePointFile` | 6 | — |
| `docx/readDocx` (with `outputPath`) | 6 | — |
| `work-item/downloadWorkItemAttachments` | 6 | — |
| `task` (host primitive) | 5, 7, 8 | — |
| `work-item/updateWorkItems` | 9 | **yes** if not dry-run |
| `work-item/deleteWorkItemComment` | 9 | **yes** if not dry-run |
| `work-item/addWorkItemComment` | 9 | **yes** if not dry-run |

Plus inline node (Step 4) and template rendering (Step 9) — orchestrator-local, no tool call.

## Guardrails

- **Sub-agent output style.** Sub-agent prompts apply [`references/templates.md` § Sub-agent output style](references/templates.md) — no chat / user / model / process references; public ADO comment voice; redact PII before content reaches ADO. Verify the first generated comment of every run.
- **Reason sub-tag allowlist.** Step 9 validates every reason sub-tag against [`references/templates.md` § Reason sub-tag allowlist](references/templates.md) and drops off-list values silently.
- **Idempotent marker replace.** Step 9 must delete every prior marker comment before adding the new one. Verify on a re-run: at least one delete should fire when a prior marker existed.
- **429 / 5xx backoff** lives in the MCP server (`withRetry`). The skill does not retry.

# Layer 3 — linked content investigation

Confirm or upgrade Layer 2 scores by reading the actual content of linked artifacts. **Strong L2 (`clarity ≥ 4` AND `designReadiness ≥ 4`) advances to L4 even with no linked content** — L3 confirms or upgrades, it does not gate on rich docs.

Layer 3 runs in two phases.

## Phase 6 — orchestrator-side fetch

For each L2 survivor, chunk size ~10, fan-out MCP calls in parallel. Output everything to `/tmp/ai-triage/<runId>/<itemId>/`.

| URL classification | Tool | Response (orchestrator-visible) |
|---|---|---|
| SharePoint `pm-spec` / `dev-design` / `ux-design` | `sharepoint/downloadSharePointFile({ url, outputDir, fileName })` | `{ filePath, sizeBytes, fileName }` |
| Downloaded `.docx` | `docx/readDocx({ filePath, outputPath: '<dir>/doc-<n>.txt' })` | `{ outputPath, wordCount, paragraphs }` (no content body) |
| Inline image URL | `work-item/downloadWorkItemAttachments({ urls, outputDir })` | `{ files: [{ url, outputPath, sizeBytes, fileName }] }` |
| `fabric-docs` URL | — (no call) | Pass through. Sub-agent uses `web_fetch`. |
| Figma URL | — (no call) | Pass through. L2 already counted presence. |

Per-item cap: **2 docs + 3 images**. On any fetch error, record `{ url, error }` and continue — never abort the run.

Build an `evidenceManifest` per item, paths and metadata only:

```json
{ "id": <n>,
  "docs": [
    { "url": "...",
      "type": "pm-spec" | "dev-design" | "ux-design",
      "textPath": "/tmp/ai-triage/<runId>/<itemId>/doc-<n>.txt",
      "originalPath": "/tmp/ai-triage/<runId>/<itemId>/doc-<n>.docx",
      "wordCount": <n> }
  ],
  "images": [
    { "url": "...", "path": "/tmp/ai-triage/<runId>/<itemId>/img-<n>.png", "sizeBytes": <n> }
  ],
  "figmaUrls": ["..."],
  "fabricDocsUrls": ["..."],
  "fetchErrors": [{ "url": "...", "error": "..." }]
}
```

## Phase 7 — sub-agent re-score

Dispatch chunks of ~10 to `task` sub-agents (`SKILL.md` § Sub-agent dispatch defaults). Sub-agent receives the L2 inputs + `evidenceManifest`.

### Sub-agent prompt

> Layer 2 has already scored the item from text alone. The orchestrator has pre-fetched all linked content to disk. Read the content, then confirm or upgrade Layer 2's scores. **Strong L2 alone is sufficient — do not downgrade for lack of links.**
>
> Tools (built-in, no MCPs):
>
> - `view` — read `evidenceManifest.docs[].textPath` for parsed doc text; read `evidenceManifest.images[].path` for vision.
> - `web_fetch` — fetch `evidenceManifest.fabricDocsUrls[]` if relevant.
>
> Re-evaluate `clarity` and `designReadiness`. Keep `depScope` and `prCloseability` from L2 unless the linked content gives clear evidence to change them.
>
> Budget: ≤5 reads per item across `view` / `web_fetch`. If a doc is huge, skim and move on.
>
> Emit per item JSON:
>
> ```json
> { "id": <n>,
>   "scoresUpdated": { "clarity": <n>, "designReadiness": <n>, "depScope": <n>, "prCloseability": <n> },
>   "evidence": {
>     "docsRead": [{ "type": "pm-spec" | "dev-design" | "ux-design", "url": "...", "summary": "..." }],
>     "imagesAnalyzed": <n>,
>     "imageSummaries": ["..."],
>     "figmaPresent": <bool>,
>     "fabricDocsFetched": [{ "url": "...", "summary": "..." }]
>   },
>   "hardReject": "<reason-sub-tag>" | null,
>   "rationale": "<3–5 sentences>"
> }
> ```
>
> Apply [`templates.md` § Sub-agent output style](templates.md) and [`templates.md` § Reason sub-tag allowlist](templates.md).

## Hard-reject thresholds

| Trigger | `hardReject` |
|---|---|
| Linked docs reveal another team owns the work | `ai-rejected:cross-team` |
| Linked docs reveal multi-PR multi-team scope | `ai-rejected:too-large` |
| Linked docs reveal the work is already done, duplicate, or deprecated | `ai-rejected:already-blocked` |

Survivors (`hardReject == null`) carry the merged score set to Layer 4.

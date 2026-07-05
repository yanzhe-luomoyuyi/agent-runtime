---
name: work-item-analysis
description: 'Deep analysis of an Azure DevOps work item — extracts text, images, videos, attachments, and walks the Feature/User Story/Task hierarchy to locate PM specs, UX designs, and dev designs'
---

# Work Item Analysis

Deeply analyze an Azure DevOps work item to extract all context needed for resolution. Walks the Feature/User Story/Task hierarchy, downloads and analyzes images/videos/audio, and locates PM specs, UX designs, and dev designs.

## Required context

None — this is the first phase.

## Checkpoint data model

This skill populates `workItemAnalysis` in the checkpoint. See [`checkpoint-schema.json`](../../checkpoint-schema.json) for the authoritative field definitions. Steps build on each other:

- **Step 1** fetches the raw work item and its comments → `workItemRaw`, `comments`
- **Step 2** locates the Feature and builds the hierarchy context → `hierarchyItems`, `relatedItems`
- **Step 3** downloads all images from description, comments, and attachments → `images`
- **Step 4** downloads all videos/GIFs from the same sources, extracts frames, extracts and transcribes audio, and produces a unified timeline analysis → `videos`
- **Steps 5–7** scan the current item AND `hierarchyItems` for spec/design documents → `pmSpecs`, `uxDesigns`, `devDesigns`
- **Step 8** produces a structured summary from everything above → `structuredSummary`

## Execution rules

Follow the phase protocol from `fabric-shell-dev-agent.md` section 3: execute steps in order (1 → 2 → 3 → 4 → 5 → 6 → 7 → 8), checkpoint after each step, wait for the response, then proceed to the next step.

## Steps

### 1. Fetch work item `[workItemAnalysis.1]`

This step fetches the work item text and comments only. Do NOT download images or attachments — that is step 3.

1. Call `getWorkItems({ ids: [<ID>], expand: "relations" })` and store `workItems[0]` in `workItemAnalysis.workItemRaw`.
2. Call `getWorkItemComments({ workItemId: <ID> })`. Store in `workItemAnalysis.comments`. Comments often contain important decisions, clarifications, repro details, and screenshots — treat them as first-class context alongside the description.
3. Check the work item state field. If state is "New", set it to "Active": `pnpm pbi devops workitem update <ID> --state Active`.

Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to step 2.**

### 2. Build hierarchy context `[workItemAnalysis.2]`

**Why**: PM specs, UX designs, and dev designs live at the **Feature** or **User Story** level. Depending on what the input work item is, specs/designs could be **above** it (on a parent Feature or User Story) or **below** it (on a child User Story if the input is a Feature). We must locate the Feature that owns this work and then scan both the Feature and its child User Stories.

**What to do**:

#### 2a. Locate the Feature (walk up)

Determine the work item type from `workItemRaw`. Walk up the parent chain to find the Feature:

| Input type | Action |
|---|---|
| **Task** | Fetch parent (User Story), then fetch its parent (Feature). |
| **User Story** | Fetch parent (Feature). |
| **Feature** | Already at Feature level — skip this step. |
| **Bug** | Usually no parent. If a parent exists, fetch it. Otherwise skip. |

For each ancestor, call `getWorkItems` and `getWorkItemComments`. Walk up at most 2 levels (Task → User Story → Feature). Stop as soon as you reach a Feature, or run out of parents.

#### 2b. Fetch the Feature's child User Stories (walk down)

If a Feature was found (either the input itself or an ancestor), parse the Feature's `relations` for **Child** links and fetch each child User Story:
1. Call `getWorkItems({ ids: [<childId>], expand: "relations" })` to fetch it. Use `workItems[0]`.
2. Call `getWorkItemComments({ workItemId: <childId> })` to fetch its comments.

Skip children that are the same as the input item or were already fetched as ancestors (avoid duplicates).

Store all hierarchy items in `workItemAnalysis.hierarchyItems` as `[{ id, type, relationship, title, description, comments, rawJson }]` where `relationship` is `"parent"`, `"grandparent"`, or `"featureChild"`.

#### 2c. Fetch related items (for dependency context only)

Parse `relations` from `workItemRaw` for **Related** links. For each:
1. Call `getWorkItems({ ids: [<linkedId>] })` to fetch basic info. Use `workItems[0]`.
2. Optionally call `getWorkItemComments({ workItemId: <linkedId> })` if the related item seems relevant.

Store in `workItemAnalysis.relatedItems` as `[{ id, type, relationKind, title, description, comments, rawJson }]`.

**Note**: Related items are dependencies or similar work — useful for understanding the broader context but **NOT** primary sources for specs/designs. Steps 5–7 should prioritize the current item and `hierarchyItems`.

Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 3. Download images `[workItemAnalysis.3]`

Collect image URLs from **all sources** on the current work item:

1. **Attachments** (`relations` with `rel: "AttachedFile"`): filter for image file extensions (`.png`, `.jpg`, `.jpeg`, `.gif`, `.bmp`, `.svg`, `.webp`).
2. **Inline images in description**: parse description HTML for `<img>` tags, collect `src` URLs.
3. **Inline images in comments**: use the pre-extracted `inlineImageUrls` from the `getWorkItemComments` response, plus parse comment HTML for any `<img>` tags.

Download everything in a single call:
```
downloadWorkItemAttachments({ urls: [{ url: "<url>", fileName: "wi-<ID>-img-1.png" }, ...], outputDir: "/tmp/wi-<ID>" })
```

Analyze each downloaded image. Store in `workItemAnalysis.images` as `[{ url, localPath, source, analysis }]` where `source` is one of `"attachment"`, `"description"`, or `"comment"`.

Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 4. Download and analyze videos/GIFs `[workItemAnalysis.4]`

**Important**: This step involves multiple expensive operations (download, frame extraction, frame analysis, audio extraction, transcription). To prevent data loss during context compaction, write an intermediate checkpoint after each sub-step below. Store partial results in `workItemAnalysis.videos` incrementally — each checkpoint adds to the previous data.

#### 4a. Download videos/GIFs

Collect video/GIF URLs from **all sources** on the current work item:

1. **Attachments** (`relations` with `rel: "AttachedFile"`): filter for video extensions (`.mp4`, `.webm`, `.mov`, `.gif`).
2. **Inline links in description and comments**: parse HTML for `<a href>` or `<video src>` tags pointing to video/GIF files.

Download using:
```
downloadWorkItemAttachments({ urls: [{ url: "<url>", fileName: "wi-<ID>-video-1.mp4" }, ...], outputDir: "/tmp/wi-<ID>" })
```

Initialize `workItemAnalysis.videos` as `[{ url, localPath, source }]`. Call `uploadCheckpoint`. Continue immediately (no STOP — sub-steps within step 4 flow continuously).

#### 4b. Extract frames

For each downloaded file, extract frames:

**Videos** (`.mp4`, `.webm`, `.mov`): call the `extractVideoFrames` MCP tool:
```
extractVideoFrames({ filePath: "/tmp/wi-<ID>/wi-<ID>-video-1.mp4", outputDir: "/tmp/wi-<ID>/video-1-frames" })
```

**GIFs** (`.gif`): call the `extractGifFrames` MCP tool:
```
extractGifFrames({ filePath: "/tmp/wi-<ID>/wi-<ID>-anim-1.gif", outputDir: "/tmp/wi-<ID>/gif-1-frames" })
```

Both tools auto-install ffmpeg cross-platform (Linux, macOS, Windows) if not already present. They extract frames at 1 FPS by default, capped at 100 frames max (FPS is auto-reduced for long media). Each returns `{ frames: [{ path, index, timestampSec }], totalFrames, durationSec }`.

Update `workItemAnalysis.videos[].frames` with frame paths (analysis pending). Call `uploadCheckpoint`. Continue immediately.

#### 4c. Analyze frames

**Use subagents** — viewing PNG images consumes context that is never released. Delegate to subagents so image data is released when each returns.

Pick **at most 10 key frames** evenly spaced across the video duration (for short videos ≤10 frames, use all). Process in **5 sequential subagent batches of 2 frames each** using the `Explore` agent. Each subagent should view the 2 PNG files, describe UI state/focus/screen reader output/errors/changes, and return a JSON array of `[{ path, analysis }]`.

Call `uploadCheckpoint` after each subagent returns. For unsampled frames, add them with `analysis: null`.

Update `workItemAnalysis.videos[].frames`. Continue immediately after the last subagent.

#### 4d. Extract and transcribe audio (videos only — GIFs have no audio)

For each **video** file (`.mp4`, `.webm`, `.mov`), also extract and transcribe audio:

1. Call the `extractAudio` MCP tool to get the audio track:
```
extractAudio({ filePath: "/tmp/wi-<ID>/wi-<ID>-video-1.mp4", outputDir: "/tmp/wi-<ID>/audio" })
```
This returns `{ hasAudio, audioPath, durationSec }`. If `hasAudio` is `false`, skip transcription for this video.

2. If audio exists, call the `transcribeAudio` MCP tool:
```
transcribeAudio({ filePath: "/tmp/wi-<ID>/audio/wi-<ID>-video-1.wav" })
```
This auto-installs OpenAI Whisper (local, offline) if not present. It returns `{ transcript, segments: [{ start, end, text }], language }` with timestamped segments.

Update `workItemAnalysis.videos[].audio`. Call `uploadCheckpoint`. Continue immediately.

#### 4e. Produce unified timeline summary

For each video with both frames and transcript, produce a **unified timeline summary** in the `summary` field. Correlate frame `analysis` with transcript `segments` by timestamp:

> At 0:05 [frame shows login page] narrator says "First I navigate to the login page"

For videos without audio, produce a timeline from frame analysis alone:

> 0-3s: User is on My Workspace page, +New item button visible in toolbar

**Do NOT leave `summary` empty or null.** If you have frames, you have enough data for a timeline.

#### Storage format

**IMPORTANT**: Use EXACTLY the field names from [`checkpoint-schema.json`](../../checkpoint-schema.json) under `workItemAnalysis.videos`. The MCP server validates and strips unknown fields.

Store as `[{ url, localPath, source, frames, audio, summary }]` where:
- `frames` — `[{ path, analysis }]` per analyzed frame
- `audio` — `{ transcript, segments: [{ start, end, text }], language }` or `null` for GIFs
- `summary` — multi-line unified timeline

**Fallback**: if extraction fails, ask the user. Store as `[{ url, localPath, source, extractionFailed: true, userDescription: "..." }]`.

Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 5. Check for PM specs `[workItemAnalysis.5]`

Scan for PM spec documents: current work item (always), then `hierarchyItems`, then `relatedItems`. Check description HTML, comments, and attachments for `.docx`, `.pdf`, `.pptx` links. See [find-pm-specs.md](./references/find-pm-specs.md).

Store in `workItemAnalysis.pmSpecs` as `[{ url, source, sourceWorkItemId, summary, fullContent }]` (empty array if none). Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 6. Check for UX designs `[workItemAnalysis.6]`

Scan for UX design links (Figma, etc.): current work item (always), then `hierarchyItems`, then `relatedItems`. Check description HTML, comments, and attachments. See [find-ux-designs.md](./references/find-ux-designs.md).

Store in `workItemAnalysis.uxDesigns` as `[{ url, sourceWorkItemId, mcpAvailable, extractedSpecs }]` (empty array if none). Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 7. Check for dev designs `[workItemAnalysis.7]`

Scan for dev design documents: current work item (always), then `hierarchyItems`, then `relatedItems`. Check description HTML, comments, and attachments for `.docx`, `.pdf`, `.md` links. See [find-dev-designs.md](./references/find-dev-designs.md).

Store in `workItemAnalysis.devDesigns` as `[{ url, source, sourceWorkItemId, summary, fullContent }]` (empty array if none). Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 8. Produce structured summary `[workItemAnalysis.8]`

Store in `workItemAnalysis.structuredSummary`: type, title, description, reproSteps, acceptanceCriteria, hierarchyItems (Feature + User Stories context), relatedItems, pmSpecs, uxDesigns, devDesigns, ambiguities (as questions).

Append a reasoning trace entry with your overall assessment. Set `workItemAnalysis.status = "COMPLETED"`, `completedAt`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

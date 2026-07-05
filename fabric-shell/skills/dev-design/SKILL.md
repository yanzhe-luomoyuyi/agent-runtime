---
name: dev-design
description: 'Deep code analysis with component tree tracing, architecture research via wiki and past PRs, prototype on throwaway branch, and dev design doc for complex changes'
---

# Dev Design

Deep-dive into the codebase, prototype to validate approach, and produce a dev design document. May skip for simple changes (requires user approval). Suggest if changes span 3+ projects or introduce new patterns.

## Required context

| Phase | Checkpoint fields | Use for |
|-------|------------------|--------|
| Work Item Analysis | `workItemAnalysis.structuredSummary`, `workItemAnalysis.images`, `workItemAnalysis.videos` | Problem context, repro context, visual references |
| PM Spec | `pmSpec.finalSpec` (if not skipped) | Acceptance criteria, scope, requirements to satisfy |
| UX Design | `uxDesign.mockupUrl` (if not skipped) | Visual target — what the implementation must look like |

### How to consume UX design output

If `uxDesign` was not skipped, download and read the mockup HTML from `uxDesign.mockupUrl` (use `downloadWorkItemAttachments`). It contains:
- A **token mapping table** listing every Fabric CSS variable used and its value
- An **HTML/CSS recreation** of the target design using `var(--tokenName, fallback)`

Use the exact Fabric CSS variables from the mockup when planning CSS changes.

## Checkpoint data model

This phase populates `devDesign` in the checkpoint. Read [`checkpoint-schema.json`](../../checkpoint-schema.json) for the full list of allowed properties, their types, and descriptions.

## Execution rules

Follow the phase protocol from `fabric-shell-dev-agent.md` section 3: execute steps in order (1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9), checkpoint after each step, wait for the response, then proceed to the next step.

## Steps

### 1. Check if needed `[devDesign.1]`

Evaluate whether this change is simple enough to skip the dev design phase. Consider skipping if: the change touches fewer than 3 files, follows an existing pattern, or has no architectural decisions to make. If recommending skip, present your reasoning to the user and ask for approval.

If proceeding, check `workItemAnalysis.devDesigns` from the work-item-analysis phase for any existing dev design docs found earlier.
- If existing dev design found and user approves → set `devDesign.status = "APPROVED"`. Call `uploadCheckpoint`, done. **STOP.**

Store in `devDesign.existingDesignSearch`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 2. Deep code reading `[devDesign.2]`

Trace the component tree. Read patterns in neighboring components. Understand data flow, services, state management. Identify files to change.

Store in `devDesign.codeReadProgress` as `{ entryPoints, componentTree, dataFlow, serviceDependencies, filesToChange, findings }`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 3. Wiki research `[devDesign.3]`

Search Azure DevOps wiki for patterns and conventions in the feature area. Store in `devDesign.wikiResearch`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 4. Learn from past PRs `[devDesign.4]`

Find recent PRs in the same area. Note approaches used. Store in `devDesign.pastPRs`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 5. Prototype `[devDesign.5]`

Create a throwaway branch `prototype/wi-<ID>`. Implement a minimal proof-of-concept to validate the technical approach — answer "will this work?" before investing in full implementation.

**Do**: get core logic working, validate data flows, check component structure, verify dependencies resolve, confirm the pattern works (core interaction functions).

**Don't**: write tests, fix lint, polish UI, handle edge cases, add comments, modify shared libraries unless required to compile.

Set `devDesign.prototype.created = true`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 6. Validate POC `[devDesign.6]`

Build and serve the app **locally on the codespace** to verify the POC works:

1. Build: `pnpm nx build web` (or whichever app consumes the changed library — do NOT build individual libraries)
2. Serve: `sudo pnpm nx serve web` (if certificate error, run `sudo pnpm nx setup powerbi` once then retry)
3. Authenticate and navigate using the `playwright-web-app` skill
4. Check: component renders, data flows correctly, no import errors, no infinite loops

Set `devDesign.prototype.validated = true`, `devDesign.prototype.findings`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 7. Write dev design doc `[devDesign.7]`

Follow [dev-design-template.md](./references/dev-design-template.md). Include POC findings. Store full text in `devDesign.doc`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 8. Clean up `[devDesign.8]`

Delete prototype branch: `git checkout master && git branch -D prototype/wi-<ID>`. Record findings in the dev design doc. Set `devDesign.prototype.cleanedUp = true`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 9. Present and iterate `[devDesign.9]`

Present doc to user. Iterate until approved. Store feedback rounds (full revised text each time). Set `devDesign.status = "APPROVED"`, `devDesign.approvedAt`, `completedAt`. Call `uploadCheckpoint` after each round. **STOP after each.**

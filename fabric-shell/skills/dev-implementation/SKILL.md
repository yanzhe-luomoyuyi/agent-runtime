---
name: dev-implementation
description: 'Implement code changes, verify with build/lint/test and Playwright, capture screenshots'
---

# Implement Work Item

Implement code changes based on the approved PM spec, UX design, and dev design. Follow existing codebase patterns. Validate with build, lint, tests, and live Playwright verification.

## Required context

| Phase | Checkpoint fields | Use for |
|-------|------------------|---------|
| Work Item Analysis | `workItemAnalysis.structuredSummary`, `workItemAnalysis.images`, `workItemAnalysis.videos` | Problem context, repro steps, visual references |
| PM Spec | `pmSpec.finalSpec` (if not skipped) | Acceptance criteria, requirements |
| UX Design | `uxDesign.mockupUrl` (if not skipped) | Visual target |
| Dev Design | `devDesign.doc`, `devDesign.codeReadProgress`, `devDesign.prototype.findings` (if not skipped) | Architecture, file list, validated approach |

### How to consume UX design output

If `uxDesign` was not skipped, download and read the mockup HTML from `uxDesign.mockupUrl` (use `downloadWorkItemAttachments`). It contains:
- A **token mapping table** listing every Fabric CSS variable used and its value
- An **HTML/CSS recreation** of the target design using `var(--tokenName, fallback)`

**Use the exact Fabric CSS variables** from the mockup (e.g., `var(--colorNeutralForeground1)`, `var(--spacingHorizontalM)`) — do not substitute raw hex/px values.

## Checkpoint data model

This phase populates `devImplementation` in the checkpoint. Read [`checkpoint-schema.json`](../../checkpoint-schema.json) for the full list of allowed properties, their types, and descriptions.

## Execution rules

Follow the phase protocol from `fabric-shell-dev-agent.md` section 3: execute steps in order (1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9), checkpoint after each step, wait for the response, then proceed to the next step.

## Steps

### 1. Read conventions `[devImplementation.1]`

Read `.github/copilot-instructions.md` and relevant `@lazy-instructions/` files (angular.md, react.md, testing.md). Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 2. Search Azure DevOps wiki `[devImplementation.2]`

Search for coding patterns and conventions in the feature area. Store in `devImplementation.wikiFindings` as an **array of strings** — one entry per finding. Example: `["Wiki 'Accessibility' says: use semantic HTML <button> instead of <div>"]`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 3. Locate files `[devImplementation.3]`

Use the dev design doc's file list if available. Otherwise search by feature name, string keys, or component names. **Identify the framework** — this repo has both Angular and React implementations. Check file extensions: `.component.ts` / `.component.html` / `.component.scss` = Angular, `.tsx` = React. Ensure you are locating the correct framework's files, not a similarly-named component in the other framework.

Store in `devImplementation.filesPlanned`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 4. Implement changes `[devImplementation.4]`

Make all code changes following repo conventions. Store completed files in `devImplementation.filesCompleted` as `[{ path, changeDescription, diffSummary }]`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 5. Build, serve, and verify `[devImplementation.5]`

**MANDATORY — never skip** (only exception: pure test-only changes). Build and serve the app **locally on the codespace**, then verify your changes with Playwright:

1. Build: `pnpm nx build web` (or whichever app consumes the changed library — do NOT build individual libraries)
2. Serve: `sudo pnpm nx serve web` (if certificate error, run `sudo pnpm nx setup powerbi` once then retry)
3. Authenticate and navigate using the `playwright-web-app` skill
4. Interact with changed elements — click, tab, toggle, inspect DOM attributes
5. Verify: component renders without errors, change is applied in actual DOM, related functionality works

If something doesn't work, debug with Playwright:
- `playwright-cli console` — JS errors and warnings
- `playwright-cli network` — HTTP requests/responses
- `playwright-cli run-code "async page => { ... }"` — evaluate expressions in page context

Store in `devImplementation.validationResults`. Call `uploadCheckpoint`.

**Before proceeding:** Present the verification results to the user and ask: "Verification complete — does this look correct? Should I proceed to screenshots?" Wait for explicit user approval. Do NOT continue to step 6 without user confirmation.

**STOP — wait for user approval and the checkpoint response before proceeding to the next step.**

### 6. Capture screenshots `[devImplementation.6]`

Capture screenshots of the affected UI (app should still be running from step 5):

1. Navigate to the affected page using `playwright-web-app` skill
2. Screenshot each relevant view → `/tmp/pr-wi-<ID>-<name>.png`
3. Upload each as an Azure DevOps attachment on the work item

Only skip for pure test-only changes. Store in `devImplementation.screenshots` as `[{ name, url }]`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 7. Update related files `[devImplementation.7]`

Update storybooks, READMEs, and snapshots if needed. Store in `devImplementation.relatedFilesUpdated`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 8. Lint `[devImplementation.8]`

Run `pnpm nx lint <project>` and fix any issues. Store result in `devImplementation.validationResults.lintClean`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 9. Add/fix tests `[devImplementation.9]`

Follow `@lazy-instructions/testing.md`. Run `pnpm nx test <project>`. Target 85% coverage for new code.

Set `devImplementation.status = "COMPLETED"`, `completedAt`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

## Rules

- Do NOT create a branch in this phase — branch creation happens in the PR Submission phase.

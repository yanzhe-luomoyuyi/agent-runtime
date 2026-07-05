---
name: pr-iteration
description: Address PR review comments, resolve feedback threads, and fix build failures for an existing pull request
---

# Resolve PR Feedback

Address unresolved review comments and fix build errors.

## Required context

| Phase | Checkpoint fields | Use for |
|-------|------------------|--------|
| Work Item Analysis | `workItemAnalysis.structuredSummary` | Original problem context |
| PM Spec | `pmSpec.finalSpec` (if not skipped) | Acceptance criteria — ensure fixes don't violate spec |
| UX Design | `uxDesign.mockupUrl` (if not skipped) | Visual target — ensure fixes maintain design fidelity |
| Dev Design | `devDesign.doc` (if not skipped) | Architecture decisions — ensure fixes stay consistent with design |
| PR Submission | `prSubmission.prId`, `prSubmission.branch` | PR to iterate on |

## Checkpoint data model

This phase populates `prIteration` in the checkpoint. Read [`checkpoint-schema.json`](../../checkpoint-schema.json) for the full list of allowed properties, their types, and descriptions.

## Execution rules

Follow the phase protocol from `fabric-shell-dev-agent.md` section 3: execute steps in order (1 → 2 → 3 → 4 → 5 → 6), checkpoint after each step, wait for the response, then proceed to the next step.

## Steps

### 1. Fetch PR state `[prIteration.1]`

```bash
pnpm pbi devops pr get <ID>
pnpm pbi devops pr threads <ID>
pnpm pbi devops build get --pr <ID> --errors-only --logs --format pretty
```

Store in `prIteration.fetchedPRState`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 2. Address review comments `[prIteration.2]`

List every active (non-closed) thread from step 1. Ensure **every** thread is addressed — do not skip any, even if they appear related to another thread. A "summary thread" (e.g., MerlinBot overview) and its individual code suggestion threads are SEPARATE threads that each require their own action.

For each active thread:
- **Code change request** → implement the fix, note the code change
- **Question** → prepare a reply with explanation
- **Style/convention** → fix code, note the change
- **Non-actionable** (praise, FYI, summary-only) → mark as acknowledged, no code change needed

Store each in `prIteration.threadsAddressed` as `{ threadId, commentSummary, feedbackType, action, codeChange, replySent, timestamp }`. Call `uploadCheckpoint` after each thread. **STOP after each.**

### 3. Fix build errors `[prIteration.3]`

Diagnose from error logs, fix locally, rebuild + test to verify. Store in `prIteration.buildFixes` as `{ error, rootCause, fix, verified, timestamp }`. Call `uploadCheckpoint` after each fix. **STOP after each.**

### 4. Validate before pushing `[prIteration.4]`

**MANDATORY.** Re-run full validation to confirm fixes resolve feedback AND don't regress the original work:

1. `pnpm nx lint <project>` — must pass
2. `pnpm nx test <project>` — all tests pass
3. Build and serve the app **locally on the codespace**, then verify with Playwright:
   - Build: `pnpm nx build web` (or whichever app consumes the changed library — do NOT build individual libraries)
   - Serve: `sudo pnpm nx serve web` (if certificate error, run `sudo pnpm nx setup powerbi` once then retry)
   - Authenticate and navigate using the `playwright-web-app` skill
   - Interact with changed elements — click, tab, toggle, inspect DOM attributes
   - Verify both the feedback fix and the original implementation still work

   If something doesn't work, debug with Playwright:
   - `playwright-cli console` — JS errors and warnings
   - `playwright-cli network` — HTTP requests/responses
   - `playwright-cli run-code "async page => { ... }"` — evaluate expressions in page context
4. Retake screenshots with iteration suffix → `/tmp/pr-wi-<ID>-<name>-iter<N>.png` (where N is the PR iteration round, starting at 1). Upload as new Azure DevOps attachments, update `devImplementation.screenshots[].url` in the checkpoint with the new URLs, then update the PR description to reference the new screenshot URLs. Only skip for pure test-only or config-only changes.

   **Shell-safe description**: Azure DevOps attachment URLs contain `?` and `=` characters that get mangled by shell expansion. Write the updated description to a temp file first:
   ```bash
   cat > /tmp/pr-description-wi-<ID>.md << 'DESCRIPTION_EOF'
   <full updated PR description markdown here, including ![image](url) lines>
   DESCRIPTION_EOF

   pnpm pbi devops pr update <prId> --description "$(cat /tmp/pr-description-wi-<ID>.md)"
   ```

Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 5. Push fixes `[prIteration.5]`

Commit: `fix: address PR review feedback`, push to same branch. Store `prIteration.pushCommitSha`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 6. Reply to threads `[prIteration.6]`

Reply to **every** thread recorded in `prIteration.threadsAddressed` — not just the ones with code changes. For each thread:

```bash
pnpm pbi devops pr thread-reply <prId> <threadId> "<reply>"
```

Cross-check: the number of `pr thread-reply` commands executed must equal the number of entries in `prIteration.threadsAddressed` (excluding entries marked as non-actionable with no reply needed). If any thread was missed, reply before completing.

Set `prIteration.status = "COMPLETED"`, `completedAt`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

## Rules

- Do NOT mark review threads as resolved — let the reviewer do that.
- Do NOT attempt to build individual libraries — build the consuming app instead.
- Step 4 (validate before pushing) is **MANDATORY**.
- Use iteration suffixes for retaken screenshots: `pr-wi-<ID>-<name>-iter<N>.png`.

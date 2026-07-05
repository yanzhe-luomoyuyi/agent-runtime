---
name: pr-submission
description: Create branch, commit, push, and create Azure DevOps pull request with rich description
---

# Submit for Review

Create a branch, commit, push, and create an Azure DevOps PR.

## Required context

| Phase | Checkpoint fields | Use for |
|-------|------------------|--------|
| Dev Implementation | `devImplementation.screenshots`, `devImplementation.validationResults` | Screenshot URLs for PR description, validation evidence |
| All prior phases | `pmSpec.finalSpec`, `uxDesign`, `devDesign.doc` | Context for PR description |

## Checkpoint data model

This phase populates `prSubmission` in the checkpoint. Read [`checkpoint-schema.json`](../../checkpoint-schema.json) for the full list of allowed properties, their types, and descriptions.

## Execution rules

Follow the phase protocol from `fabric-shell-dev-agent.md` section 3: execute steps in order (1 → 2 → 3 → 4 → 5 → 6), checkpoint after each step, wait for the response, then proceed to the next step.

## Steps

### 1. Create branch `[prSubmission.1]`

```bash
git checkout -b user/<alias>/wi-<ID>-<short-description>
```

Use git user email for alias. Keep description 3-5 words, kebab-case. Store in `prSubmission.branch`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 2. Stage files `[prSubmission.2]`

Stage only relevant files (explicit paths, not `git add .`). Verify with `git diff --cached --stat`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 3. Commit `[prSubmission.3]`

Follow project commit conventions (check copilot-instructions.md or existing commits for the format):
```bash
git commit -m "<type>: <description>

Fixes WI #<ID>"
```

Store `prSubmission.commitSha`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 4. Push `[prSubmission.4]`

```bash
git push origin <branch-name>
```

Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 5. Create PR `[prSubmission.5]`

Get the user's first name from git: `git config user.name` → extract the first word. Use it in the PR title prefix: `⚡ [<FirstName>'s AI Agent] <original title>`.

Default to `master` when creating PRs. The default branch of this repository is `master`, not `main` — using `main` produces a massive diff of unrelated changes. If the user explicitly requests a different target branch, use that instead.

Build description following [pr-description-template.md](./references/pr-description-template.md). Include screenshots from `devImplementation.screenshots` (Azure DevOps attachment URLs) — do NOT retake screenshots, use the URLs already stored in the checkpoint.

**Shell-safe description**: Azure DevOps attachment URLs contain `?` and `=` characters that get mangled by shell expansion. To avoid this, write the full description to a temp file first, then pass it to the CLI:

```bash
# 1. Write description to a temp file (use heredoc to preserve special chars)
cat > /tmp/pr-description-wi-<ID>.md << 'DESCRIPTION_EOF'
<full PR description markdown here, including ![image](url) lines>
DESCRIPTION_EOF

# 2. Create PR using the file content
pnpm pbi devops pr create <source-branch> master "⚡ [<FirstName>'s AI Agent] <title>" --description "$(cat /tmp/pr-description-wi-<ID>.md)"
```

Ask user for permission before creating. Store `prSubmission.prDescription`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 6. Link work item and report `[prSubmission.6]`

Link the work item to the PR:
```bash
pnpm pbi devops pr update <prId> --add-work-item <ID>
```

Post comment on WI: `pnpm pbi devops workitem update <ID> --comment "PR !<prId> created: <url>"`.

Report PR URL to user. Set `prSubmission.status = "COMPLETED"`, `prSubmission.prId`, `prSubmission.prUrl`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

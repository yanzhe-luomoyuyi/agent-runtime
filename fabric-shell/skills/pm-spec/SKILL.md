---
name: pm-spec
description: Draft a PM specification with requirements and acceptance criteria for feature or user story work items — iterate with user until approved
---

# PM Spec

Draft a PM spec for feature or user story work items. Bugs and simple tasks may skip this phase (requires user approval).

## Required context

| Phase | Checkpoint fields | Use for |
|-------|------------------|--------|
| Work Item Analysis | `workItemAnalysis.structuredSummary`, `workItemAnalysis.pmSpecs` | Problem context, any existing specs found |

## Checkpoint data model

This phase populates `pmSpec` in the checkpoint. Read [`checkpoint-schema.json`](../../checkpoint-schema.json) for the full list of allowed properties, their types, and descriptions.

## Execution rules

Follow the phase protocol from `fabric-shell-dev-agent.md` section 3: execute steps in order (1 → 2 → 3 → 4), checkpoint after each step, wait for the response, then proceed to the next step.

## Steps

### 1. Check if needed `[pmSpec.1]`

Check `workItemType` from the checkpoint. If it is a **Bug** or **Task**, this phase can be skipped — present your reasoning to the user and ask for approval before skipping.

If proceeding, search for an existing spec:
- Check `workItemAnalysis.pmSpecs` for any spec URLs found during work item analysis. If found, fetch and summarize.
- Search Azure DevOps wiki: `pnpm pbi devops wiki search "<keywords>"`.
- If existing spec found and user approves → set `pmSpec.status = "APPROVED"`. Call `uploadCheckpoint`, done. **STOP.**

Store in `pmSpec.existingSpecSearch`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 2. Draft spec `[pmSpec.2]`

Write a spec using the template from [pm-spec-template.md](./references/pm-spec-template.md).

Store the full draft in `pmSpec.draft`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 3. Present and iterate `[pmSpec.3]`

Present to the user. Incorporate feedback. After each round, store in `pmSpec.feedbackRounds` as `{ round, userFeedback, agentRevision (full text), timestamp }`. Update `pmSpec.draft`. Repeat until approved.

Call `uploadCheckpoint` after each round. **STOP after each.**

### 4. Finalize `[pmSpec.4]`

Optionally post spec as WI comment: `pnpm pbi devops workitem update <ID> --comment "<spec>"`.

Set `pmSpec.status = "APPROVED"`, `pmSpec.finalSpec`, `pmSpec.approvedAt`, `completedAt`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

---
name: clarification
description: Review ambiguities from work item analysis — ask targeted questions, record decisions, and resolve open questions before proceeding
---

# Clarification

Review ambiguities identified during work item analysis. Ask the user targeted questions to resolve any open issues before proceeding to spec, design, and implementation phases.

## Required context

| Phase | Checkpoint fields | Use for |
|-------|------------------|--------|
| Work Item Analysis | `workItemAnalysis.structuredSummary.ambiguities` | Open questions to resolve |
| Work Item Analysis | `workItemAnalysis.structuredSummary` | Full context of the work item |

## Checkpoint data model

This phase populates `clarification` in the checkpoint. Read [`checkpoint-schema.json`](../../checkpoint-schema.json) for the full list of allowed properties, their types, and descriptions.

## Execution rules

Follow the phase protocol from `fabric-shell-dev-agent.md` section 3: execute steps in order (1 → 2 → 3), checkpoint after each step, wait for the response, then proceed to the next step.

## Steps

### 1. Review ambiguities `[clarification.1]`

Read `workItemAnalysis.structuredSummary.ambiguities`. If empty, confirm with the user: "No open questions found — proceeding." Set `clarification.status = "COMPLETED"`. Call `uploadCheckpoint`, done. **STOP.**

If ambiguities exist, proceed to step 2.

Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

### 2. Ask questions `[clarification.2]`

For each ambiguity, ask the user a **specific, targeted question** (not open-ended). Wait for the answer.

Record each Q&A in `clarification.questionsAsked` as `{ question, answer, timestamp }`.

If the answer results in a decision that affects later phases (e.g., scope change, approach choice, priority), also record it in `clarification.decisions` as `{ topic, decision, rationale, timestamp }`.

Call `uploadCheckpoint` after each Q&A round. **STOP after each.**

### 3. Confirm and complete `[clarification.3]`

Summarize all decisions made during clarification. Confirm with the user that all questions are resolved.

Set `clarification.status = "COMPLETED"`, `completedAt`. Call `uploadCheckpoint`. **STOP — wait for the checkpoint response before proceeding to the next step.**

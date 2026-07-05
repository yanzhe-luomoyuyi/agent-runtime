# Scoring

Score each Feature on 6 dimensions, 1–5. Scoring happens across Layers 2–4; do not lock a dimension's score until its layer has produced new evidence.

| # | Dimension | Locked in | "5" anchor | "1" anchor |
|---|-----------|-----------|------------|------------|
| 1 | Requirements clarity | Layer 2 (may rise in L3) | Concrete deliverable + comments converge OR linked PM spec resolves ambiguity | One-line title; conflicting comments; no spec hint anywhere |
| 2 | Design readiness | Layer 2 (locks in L3) | No UX needed, OR named existing pattern, OR linked Figma / mockup present | Net-new UX with no design hint anywhere |
| 3 | Apparent dependency scope | Layer 2 | Single team owns it; no other teams named in comments | Multiple teams named as owners of distinct parts |
| 4 | PR-closeability | Layer 2 | One PR plausible from the description | Obviously multi-PR, multi-team |
| 5 | Code scope | Layer 4 | All work in one PowerBIClients module | Many modules or multiple repos |
| 6 | Pattern availability | Layer 4 | Code search finds near-identical existing implementation | Greenfield; no precedent |

## Tier thresholds

Compute the total across all 6 dimensions (max 30) after Layer 4. Apply the first matching rule:

| Verdict | Condition |
|---|---|
| `ai-suitable-high` | total ≥ 24 AND no dimension == 1 |
| `ai-suitable-medium` | total 18–23 AND no hard blocker (see layer prompts) |
| `ai-suitable-low` | total 12–17 AND no hard blocker |
| `ai-unsuitable` | total < 12, OR `patternAvailability == 1` for a UI feature with no precedent (use `ai-rejected:no-pattern`) |

A **hard blocker** is any `hardReject` value emitted by any layer (L1 — deterministic rules; L2 — text-only LLM; L3 — linked content; L4 — code feasibility, e.g. `ai-rejected:no-pattern`). A hard blocker forces `ai-unsuitable` regardless of the numeric score. Reason sub-tags from earlier layers persist into the final tag set.

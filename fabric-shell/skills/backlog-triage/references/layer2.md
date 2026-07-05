# Layer 2 — text-only scoring

Decide whether each Feature is legible from text alone — title, description, and comments of the item itself. No parent/child walking. No external fetching.

## Inputs per item

- `id`
- `title` — `System.Title`
- `descriptionText` — HTML stripped from `System.Description`
- `comments[]` — from `work-item/getWorkItemComments` (text + inline image URLs)
- `linkedUrls[]` — every URL from description + comments, each pre-classified as `pm-spec` / `dev-design` / `ux-design` / `figma` / `wiki` / `pr` / `build` / `image` / `video` / `other`. URLs only; do not fetch content at this layer.

## Sub-agent prompt

> Score each Azure DevOps Feature item on 4 dimensions on a 1–5 scale based ONLY on the title, description, comments, and the list of linked URL types. Do not fetch any links. A linked PM spec / dev design / Figma URL (even unread) is a strong clarity positive — sparse description is fine when the link is there.
>
> 1. **clarity** — concrete deliverable? Comments converge?
> 2. **designReadiness** — Net-new UX with no design hint = 1. Linked Figma OR named existing pattern OR no-UX-needed = 5.
> 3. **depScope** — Single team in evidence = 5. Comments name ≥ 2 other teams as owners = 1.
> 4. **prCloseability** — One PR plausible = 5. Multi-PR multi-team obvious = 1.
>
> Emit per item JSON:
>
> ```json
> { "id": <n>,
>   "scores": { "clarity": <n>, "designReadiness": <n>, "depScope": <n>, "prCloseability": <n> },
>   "signalsExtracted": {
>     "hasPmSpec": <bool>, "hasDevDesign": <bool>, "hasUxDesign": <bool>, "hasFigma": <bool>,
>     "linkedTeams": [<string>], "linkedRepos": [<string>],
>     "discussionState": "converged" | "open" | "stale"
>   },
>   "hardReject": "<reason-sub-tag>" | null,
>   "rationale": "<2–3 sentences>"
> }
> ```
>
> Apply [`templates.md` § Sub-agent output style](templates.md) and [`templates.md` § Reason sub-tag allowlist](templates.md). Set `hardReject: null` when not hard-rejecting.

## Hard-reject thresholds

| Trigger | `hardReject` |
|---|---|
| `clarity == 1` AND no useful linked URLs | `ai-rejected:unclear` |
| `designReadiness == 1` (net-new UX, zero hint) | `ai-rejected:needs-design` |
| Comments / description name ≥ 2 other teams as owners | `ai-rejected:cross-team` |
| `prCloseability == 1` | `ai-rejected:too-large` |
| Backend signals dominate FE signals | `ai-rejected:backend-heavy` |

## Dispatch

Chunks of ~20 ids per sub-agent. `task` dispatch defaults from `SKILL.md`. Survivors (`hardReject == null`) carry their scores + `signalsExtracted` to Layer 3.

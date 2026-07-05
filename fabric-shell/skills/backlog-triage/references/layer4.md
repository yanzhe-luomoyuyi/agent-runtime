# Layer 4 — code feasibility

Assess whether the codebase has the structure and precedent to make the Feature implementable in one focused effort. Scores `codeScope` and `patternAvailability`, then assigns the final tier and emits the structured fields Step 9 renders the comment from.

Sub-agent type is `explore` (see SKILL.md § Sub-agent dispatch). It runs in the host's working directory — the locally cloned PowerBIClients repo — and searches with native `grep`, `glob`, `view`. The sub-agent inherits repo-level guidance from `.github` (monorepo layout, directory roles, import conventions); do not duplicate that here.

## Inputs per item

- `title` + `descriptionText` (one paragraph).
- L2 + L3 merged `scores` and `signalsExtracted` / `evidence`.
- `searchHints` — module / repo / component names mentioned in comments or docs.

## Per-item budget

- **Cap: 20 tool calls.** Local reads are fast wall-clock but every result eats context — keep queries focused.
- **Early stop**: if ~15 calls turn up nothing relevant on what's clearly UI work, score `patternAvailability = 1`, flag `ai-rejected:no-pattern`, and stop.

## Sub-agent prompt

> Evaluate the code-side feasibility of an Azure DevOps Feature using local code search (`grep` / `glob` / `view` on the cloned PowerBIClients repo at your current working directory).
>
> Score:
>
> - **codeScope** (1–5) — where the code likely lives. One PowerBIClients module = 5; many modules = 3; multiple repos / cross-stack = 1.
> - **patternAvailability** (1–5) — near-identical existing implementation = 5; some related code = 3; greenfield = 1.
>
> Be honest. If searches find no precedent for clearly UI work, score `patternAvailability = 1` and flag `ai-rejected:no-pattern`.
>
> Compute `total = clarity + designReadiness + depScope + prCloseability + codeScope + patternAvailability`. Apply tier rules from [`scoring.md`](scoring.md) to get the verdict.
>
> **Do NOT pre-render comment markdown.** Step 9 of SKILL.md renders the comment deterministically from the structured fields below using templates in [`templates.md`](templates.md).
>
> For suitable verdicts, `reasonSubTags` is `[]`. For unsuitable verdicts, pick exactly one value from the allowlist.
>
> ```json
> { "id": <n>,
>   "scoresFinal": { "clarity": <n>, "designReadiness": <n>, "depScope": <n>,
>                    "prCloseability": <n>, "codeScope": <n>, "patternAvailability": <n> },
>   "perDimensionNotes": {
>     "clarity": "<one-liner>", "designReadiness": "<one-liner>",
>     "depScope": "<one-liner>", "prCloseability": "<one-liner>",
>     "codeScope": "<one-liner, name the module>",
>     "patternAvailability": "<name a similar file or 'no precedent'>"
>   },
>   "total": <n>,
>   "verdict": "ai-suitable-high" | "ai-suitable-medium" | "ai-suitable-low" | "ai-unsuitable",
>   "reasonSubTags": ["ai-rejected:..."],
>   "codeEvidence": {
>     "searchQueries": ["<grep / glob query>", "..."],
>     "topMatch": { "file": "<path from repo root>", "lineRange": "<L1–L2>" } | null
>   },
>   "whySuitable": "<2–3 sentences>",
>   "risks": ["<bullet>", ...],
>   "suggestedFirstStep": "<one concrete action>"
> }
> ```
>
> Apply [`templates.md` § Sub-agent output style](templates.md) and [`templates.md` § Reason sub-tag allowlist](templates.md).

## Dispatch

Chunks of ~5 ids. `task` dispatch defaults from `SKILL.md`. Layer 4 is the final scoring layer — its output drives Step 9.

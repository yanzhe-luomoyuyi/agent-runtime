# PR Description Template

Use this template for all pull request descriptions.

```markdown
## Problem Statement
{Work item title and description — what's broken or needed. Include WI link.}

## Solution
{Approach taken and rationale — not just a file list, but WHY this approach.
Reference the dev design doc if one was created.}

## Validation
- [ ] Build passes: `pnpm nx build <project>`
- [ ] Lint passes: `pnpm nx lint <project>`
- [ ] Unit tests pass: `pnpm nx test <project>` (N tests, N new)
- [ ] New unit tests added for changed behavior
- [ ] Functional validation via Playwright (screenshots below)

### Screenshots
{For each screenshot from `devImplementation.screenshots`, include:

**<name>**
![<name>](<url>)

If non-visual change: "No visual changes — screenshots not applicable."}

## Out of Scope Observations
{Any related issues discovered during implementation but NOT fixed.
"None" if nothing discovered.}
```

## Azure DevOps link prefixes

In Azure DevOps markdown, `#` and `!` have different meanings. Using the wrong prefix creates broken or misleading links.

| Prefix | Links to | Example |
|--------|----------|---------|
| `#123` | **Work item** | `Fixes #1976284` |
| `!123` | **Pull request** | `See !54321 for prior art` |

- When referencing the **work item** this PR addresses → use `#<workItemId>`
- When referencing **other PRs** (related, prior, follow-up) → use `!<prId>`
- Never use `#` to reference a PR or `!` to reference a work item

## Tips

- Keep Problem Statement concise — 2-3 sentences max
- Solution should explain the "why" not just the "what"

## When Screenshots Are Expected

- Any change that modifies HTML templates, CSS/SCSS, or component rendering
- Accessibility changes that affect visual indicators (focus rings, etc.)
- Layout or spacing changes

## When Screenshots Are NOT Expected

- Configuration, build, or tooling changes
- Test-only changes
- Pure logic changes with no rendered output

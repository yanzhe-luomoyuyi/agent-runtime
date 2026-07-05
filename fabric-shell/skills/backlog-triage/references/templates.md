# Output templates

State lives in ADO via the marker comment. Every triaged item — suitable or unsuitable — gets a marker comment so the re-run diff anchor is uniform. Step 9 of SKILL.md is the only place that renders comment markdown.

## Marker

```
<!-- ai-triage:v1 -->
```

The skill matches against this substring (locally, after fetching comments via `work-item/getWorkItemComments`) to find prior triage comments to delete.

## Comment — suitable items

```markdown
<!-- ai-triage:v1 -->
**AI Triage: `<tier>`** _(YYYY-MM-DD)_ &nbsp; **Score:** <total>/30

| Dimension | Score | Note |
|---|--:|---|
| Requirements clarity | <n> | <one-liner> |
| Design readiness | <n> | <one-liner> |
| Dependency scope | <n> | <one-liner> |
| PR-closeability | <n> | <one-liner> |
| Code scope | <n> | <one-liner, name the module> |
| Pattern availability | <n> | <name a similar file, or "no precedent"> |

**Why suitable:** <2–3 sentences>
**Risks:** <bullets, or "none flagged">
**Suggested first step:** <one concrete action>
```

## Comment — unsuitable items

```markdown
<!-- ai-triage:v1 -->
**AI Triage: `ai-unsuitable`** _(YYYY-MM-DD)_ &nbsp; **Reason:** `<reason-sub-tag>`

<one sentence explaining what would need to change for this to become a candidate>
```

Keep under 50 words. Purpose: the marker + a quick pointer for PM. Not a full rationale.

## Run summary — printed to chat at end of run

Nothing is written to local files.

```markdown
# Triage Run <YYYY-MM-DD HH:mm>

- Scope: top <N> Features owned by the "Shell and Growth" team, state ∈ {New, Definition, Planning}, stack-rank ascending.
- Mode: <default | dry-run | re-evaluate-all>
- Batch size: B=<n>; processed this invocation: <n>; **items remaining in scope: <n>**.

## Diff (vs. existing marker comments)
- New (no prior triage marker): <n>
- Changed since last triage: <n>
- Skipped (unchanged): <n>
- Clamped to B (tail not processed this invocation): <n>

## Funnel
| Stage | In | Out | Rejected by |
|---|--:|--:|---|
| Layer 1 | <n> | <n> | <reason counts> |
| Layer 2 | <n> | <n> | <reason counts> |
| Layer 3 | <n> | <n> | <reason counts> |
| Layer 4 | <n> | <n> | <reason counts> |

## Verdicts
- `ai-suitable-high`: <n>; `-medium`: <n>; `-low`: <n>; `ai-unsuitable`: <n>

## ADO writes
- Tag PATCHes: <ok>/<attempted>, retries <r>
- Comment replacements: <ok>/<attempted>, retries <r>

## Errors
<list>

## Next steps
<Only when items remaining > 0:>
**Items remaining: <n>.** If continuing, run `/compact` then re-invoke this skill for the next batch. State lives in ADO marker comments — no checkpoint needed.
```

## Sub-agent output style

Every sub-agent prompt (L2 / L3 / L4) applies these rules:

- **Public ADO comment voice.** Write rationale as if it will be pasted into a public ADO comment. Do NOT reference the user, the chat session, the model, the triage process, or any internal tool name.
- **No private discussion quotes.** Do not quote chat threads or internal discussions.
- **Plain engineering language.** No marketing speak, no apology, no hedging meta-commentary.
- **PII redaction.** Redact customer names, support ticket IDs, partner identifiers before the content reaches ADO.

## Tag taxonomy

**Primary verdicts** (exactly one per triaged item):

- `ai-suitable-high`
- `ai-suitable-medium`
- `ai-suitable-low`
- `ai-unsuitable`

**Manual opt-out** (applied by humans, never by the skill):

- `ai-skip-triage` — items carrying this tag are filtered out at Step 1's WIQL and never enter the funnel. Survives any future triage run because Step 9's `removeTags` regex (`^ai-suitable` / `^ai-unsuitable` / `^ai-rejected:`) does not match it.

### Reason sub-tag allowlist

These are the only valid values for `hardReject` (L2 / L3) and `reasonSubTags` (L4), and the only sub-tags Step 9 writes. Sub-agents must not invent new values; Step 9 silently drops anything off-list.

- `ai-rejected:thin-spec`
- `ai-rejected:unclear`
- `ai-rejected:needs-design`
- `ai-rejected:cross-team`
- `ai-rejected:backend-heavy`
- `ai-rejected:non-impl`
- `ai-rejected:non-feature`
- `ai-rejected:already-blocked`
- `ai-rejected:too-large`
- `ai-rejected:no-pattern`
- `ai-rejected:out-of-scope`

Reason sub-tags pair with `ai-unsuitable` only — never with a `ai-suitable-*` primary verdict.

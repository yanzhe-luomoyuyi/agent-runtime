# PM Spec Template

Template for writing PM specifications for feature work items. Only features and user stories need a PM spec — bugs and simple tasks skip this phase.

## Template

```markdown
## Problem Statement
{What is missing or needed? Include user impact and context.}

## Goals
- {Goal 1: specific, measurable outcome}
- {Goal 2}

## Non-Goals
- {What is explicitly out of scope}

## Functional Requirements
1. {Requirement 1 — concrete, testable}
2. {Requirement 2}

## Acceptance Criteria
- [ ] {Criterion 1 — how to verify it works}
- [ ] {Criterion 2}

## Dependencies
- {External dependencies, other teams, APIs, shared libraries}

## Open Questions
- {Unresolved questions — empty if all clarified}
```

## Structure

Feature specs should cover:

1. **User value** — why this matters, who benefits
2. **Functional requirements** — what the feature does, step by step
3. **Interaction design** — user flow, states, transitions (reference Figma if available)
4. **Edge cases** — error states, empty states, loading states
5. **Dependencies** — APIs, shared services, other teams
6. **Rollout** — feature switch name, phased rollout plan if applicable

## Example: New Feature

```markdown
## Problem Statement
Users cannot sort items in the workspace list by date modified, making it hard
to find recently edited reports in workspaces with many items.

## Goals
- Add a "Date modified" sort option to the workspace list view
- Persist the user's sort preference across sessions

## Non-Goals
- Adding sort options beyond date modified (e.g., size, type)
- Changing the default sort order
- Adding sort to other list views (Recent, Favorites)

## Functional Requirements
1. Add "Date modified" option to the existing sort dropdown in workspace list
2. Sort items descending (newest first) when selected
3. Persist sort selection in user settings via existing preference service
4. Show a visual indicator on the active sort column header
5. Handle items with no modification date by sorting them last

## Acceptance Criteria
- [ ] Sort dropdown shows "Date modified" option
- [ ] Clicking it sorts items by modification date, newest first
- [ ] Refreshing the page preserves the sort selection
- [ ] Works with both list and grid view modes
- [ ] Sort indicator visible on column header (list view)

## Dependencies
- Workspace API already returns `lastModifiedDate` — no backend changes needed
- Uses existing `UserPreferenceService` for persistence
```

## Tips

- Reference Figma designs for visual requirements
- If the feature needs a feature switch, note the switch name
- List API dependencies — are backend changes needed or is data already available?
- Consider telemetry — what events should be logged?

# Dev Design Document Template

```markdown
## Dev Design: WI #<ID> — <title>

### Background
{Context: what problem does this solve, why now, who is affected}

### Goals / Non-Goals

**Goals:**
- {Goal 1}
- {Goal 2}

**Non-Goals:**
- {What is explicitly out of scope}

### Solution
{Describe the approach. Prefer diagrams + text over long prose.

Include:
- Architecture diagram (Mermaid, ASCII)
- Data flow: where data comes from, how it's transformed, where it's stored
- Component hierarchy: parent → child relationships
- Key implementation details}

### Rollout Plan
{How will this be rolled out?
- Feature switch name (if applicable)
- Phased rollout tiers (e.g., DXT → MSIT → Prod)
- Monitoring / telemetry for success metrics
- Rollback plan}
```

## Optional Sections

Add only if relevant to the feature:

- **Files to Change** — table of path, change type, description
- **POC Findings** — what worked/didn’t in the prototype
- **Risks & Considerations** — edge cases, perf, a11y, backward compatibility
- **Dependencies** — other teams, backend APIs, shared libs

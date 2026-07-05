# Find Linked Dev Designs

How to find existing dev design documents linked to a work item.

## Where to Look

All data referenced below was already fetched in earlier steps. Scan these sources — do NOT make additional API calls unless searching the wiki or PRs.

1. **Hierarchy items** — stored in `workItemAnalysis.hierarchyItems` (fetched in Step 2). Check the **description**, **comments**, and **attachments** of each item — this includes the Feature and all its child User Stories. Dev designs are most commonly found at the Feature or User Story level.
2. **Current work item description** — search HTML for `<a href>` tags linking to `.docx`, SharePoint, wiki pages with "design" in the title
3. **Current work item comments** — stored in `workItemAnalysis.comments`, search comment text for URLs to design docs
4. **Current work item attachments** — `AttachedFile` relations from `workItemAnalysis.workItemRaw`, look for design documents
5. **Related items** — stored in `workItemAnalysis.relatedItems` (fetched in Step 2). Only check if nothing found in sources 1–4.
6. **Azure DevOps wiki pages** — `pnpm pbi devops wiki search "<feature keywords> design"`, then `pnpm pbi devops wiki get "<path>"`
7. **Recent PRs in the same area** — `pnpm pbi devops pr list` and search by title keywords — PR descriptions sometimes contain dev design summaries

## How to Extract Content

| Source | Method |
|--------|--------|
| SharePoint `.docx` | Download via `downloadSharePointFile` MCP tool (authenticates via Azure CLI), then extract text via `readDocx` MCP tool |
| Azure DevOps attachment `.docx` | Download via `downloadWorkItemAttachments` MCP tool, then extract text via `readDocx` MCP tool |
| Wiki page | `pnpm pbi devops wiki get "<path>"` |
| PR description | `pnpm pbi devops pr get <id>` — extract the description text |

## Best Practices

- Always attempt to fetch before asking the user
- If behind auth, ask user to paste the relevant section
- Focus on: architecture decisions, component hierarchy, data flow, files changed, patterns used

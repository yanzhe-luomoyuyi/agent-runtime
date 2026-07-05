# Find Linked PM Specs

How to find and extract PM specifications, requirements documents, and other spec artifacts linked to a work item.

## Where to Look

All data referenced below was already fetched in earlier steps. Scan these sources — do NOT make additional API calls unless following a URL to extract content.

1. **Hierarchy items** — stored in `workItemAnalysis.hierarchyItems` (fetched in Step 2). Check the **description**, **comments**, and **attachments** of each item — this includes the Feature and all its child User Stories. Specs are most commonly found at the Feature or User Story level.
2. **Current work item description** — search HTML for `<a href>` tags linking to `.docx`, SharePoint, or wiki pages
3. **Current work item comments** — stored in `workItemAnalysis.comments`, search comment text for URLs
4. **Current work item attachments** — `AttachedFile` relations from `workItemAnalysis.workItemRaw`, look for `.docx`, `.pdf` files
5. **Related items** — stored in `workItemAnalysis.relatedItems` (fetched in Step 2). Only check if nothing found in sources 1–4.
6. **Azure DevOps wiki pages** — `pnpm pbi devops wiki search "<feature keywords>"`, then `pnpm pbi devops wiki get "<path>"`

## How to Extract Content

| Source | Method |
|--------|--------|
| SharePoint `.docx` | Download via `downloadSharePointFile` MCP tool (authenticates via Azure CLI), then extract text via `readDocx` MCP tool |
| Azure DevOps attachment `.docx` | Download via `downloadWorkItemAttachments` MCP tool, then extract text via `readDocx` MCP tool |
| PDF | Ask user to summarize relevant sections — not reliably parseable |
| Wiki page | `pnpm pbi devops wiki get "<path>"` |
| Inline HTML | Decode entities (`&lt;`, `&gt;`), extract text from `<div>`, `<p>`, `<li>` tags |

## Best Practices

- Always attempt to fetch before asking the user
- If behind auth, ask user to paste the relevant section
- Summarize long documents — focus on requirements, acceptance criteria, and design decisions

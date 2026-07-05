# Find Linked UX Designs

How to find Figma UX design references linked to a work item. This step only **finds and records** Figma URLs — extraction of specs happens later in the UX Design phase.

## Where to Look

All data referenced below was already fetched in earlier steps. Scan these sources — do NOT make additional API calls unless searching the wiki.

1. **Hierarchy items** — stored in `workItemAnalysis.hierarchyItems` (fetched in Step 2). Check the **description** and **comments** of each item — this includes the Feature and all its child User Stories. Figma links are most commonly found at the Feature or User Story level.
2. **Current work item description** — search HTML for `figma.com` in `<a href>` tags
3. **Current work item comments** — stored in `workItemAnalysis.comments`, search comment text for Figma URLs
4. **Current work item attachments** — check linked URLs in `relations`
5. **Related items** — stored in `workItemAnalysis.relatedItems` (fetched in Step 2). Only check if nothing found in sources 1–4.
6. **Azure DevOps wiki pages** — search wiki for the feature name, check for Figma links

## Figma URL Patterns

| Pattern | Type |
|---------|------|
| `figma.com/file/<key>` | Legacy file URL |
| `figma.com/design/<key>` | New design URL |
| `figma.com/proto/<key>` | Prototype (clickable, less useful for specs) |
| `figma.com/board/<key>` | FigJam board (planning, not design specs) |

URLs may include `?node-id=<id>` pointing to a specific frame/component.

## What to Store

Store each found URL in `workItemAnalysis.uxDesigns` as `{ url, sourceWorkItemId, extractedSpecs: null }` where `sourceWorkItemId` is the ID of the work item where the URL was found. The UX Design phase will obtain a Figma API token and extract specs via the REST API later.

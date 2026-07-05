---
name: ux-design
description: Establish the UX design target — from Figma if available, or generate an HTML mockup as alternative
---

# UX Design

Establish the visual design target for implementation. Extract specs from an existing Figma design or generate an HTML mockup. May skip if purely non-visual (requires user approval).

## Required context

| Phase | Checkpoint fields | Use for |
|-------|------------------|--------|
| Work Item Analysis | `workItemAnalysis.structuredSummary`, `workItemAnalysis.images`, `workItemAnalysis.videos`, `workItemAnalysis.uxDesigns` | Problem context, visual references, Figma URLs |
| PM Spec | `pmSpec.finalSpec` (if not skipped) | Acceptance criteria, scope |

## Checkpoint data model

This phase populates `uxDesign` in the checkpoint. Read [`checkpoint-schema.json`](../../checkpoint-schema.json) for the full schema.

## Execution rules

Follow the phase protocol from `fabric-shell-dev-agent.md` section 3: execute steps in order (1 → 2 → 3 → 4 → 5), checkpoint after each step, wait for the response, then proceed.

## References

| File | Purpose |
|------|---------|
| [`references/fabric-token-mapping.md`](references/fabric-token-mapping.md) | Fabric design token mapping table — maps CSS values to `@fabric-msft/theme` tokens. **Read this before building any mockup.** |
| [`references/figma-extract.py`](references/figma-extract.py) | Python script to extract visual properties from Figma API JSON. Run: `python3 figma-extract.py /tmp/figma-full.json` |
| [`references/mockup-template.html`](references/mockup-template.html) | Mockup HTML template with Fabric CSS variables and token mapping table |

## Mockup rules (apply to ALL mockups — Figma and non-Figma paths)

- **Token-based**: all visual values must use Fabric CSS variables with fallbacks — `var(--tokenName, fallback)`. Never raw hex/px. Read [`references/fabric-token-mapping.md`](references/fabric-token-mapping.md) for the mapping table.
- **Self-contained**: all styles inline in `<style>` — no external dependencies
- **Accurate**: use real extracted data, don't fabricate markup
- **Focused**: only the affected component and its immediate surroundings
- **Annotated**: token mapping table + change description at the top
- **Dark mode**: include light/dark variants if the change affects theming
- Use [`references/mockup-template.html`](references/mockup-template.html) as the starting template

## Steps

### 1. Determine if needed `[uxDesign.1]`

Skip if non-visual (logic, API, config, a11y attributes-only). Set `uxDesign.status = "SKIPPED"`, `uxDesign.skipReason`. Call `uploadCheckpoint`. **STOP.**

### 2. Check for Figma design `[uxDesign.2]`

Check `workItemAnalysis.uxDesigns` for Figma URLs.

**If no Figma URL found** → proceed to step 3.

**If Figma URL found** → obtain API access, then extract specs:

#### 2a. Obtain Figma API token

If `FIGMA_API_KEY` env var is not set:
1. Ask user for a personal access token (Settings → Personal access tokens → Generate)
2. `export FIGMA_API_KEY="<token>"`
3. Verify: `curl -s -H "X-Figma-Token: $FIGMA_API_KEY" "https://api.figma.com/v1/me" | jq '.handle'`
4. **Never** store the token in any file or checkpoint — env var only.

If user declines or token fails → fallback: check `workItemAnalysis.images` for Figma screenshots, ask user for specs manually. Set `uxDesign.designSource = "figma-manual"`. Checkpoint. Skip to step 5.

#### 2b. Fetch and extract from Figma API

Parse the URL: `https://www.figma.com/design/<FILE_KEY>/<name>?node-id=<NODE_ID>` (replace `-` with `:` in node ID).

```bash
# Download full node tree
curl -s -H "X-Figma-Token: $FIGMA_API_KEY" \
  "https://api.figma.com/v1/files/$FILE_KEY/nodes?ids=$NODE_ID&depth=15" \
  > /tmp/figma-full.json

# Extract visual properties (colors, typography, spacing, radii, effects)
python3 .github/plugins/fabric-shell/skills/ux-design/references/figma-extract.py /tmp/figma-full.json

# Export frame images
curl -s -H "X-Figma-Token: $FIGMA_API_KEY" \
  "https://api.figma.com/v1/images/$FILE_KEY?ids=$FRAME_IDS&format=png&scale=2" | jq '.images'
# Download each: curl -sL "<url>" -o /tmp/figma-<name>.png
```

#### 2c. Build reference mockup

Map extracted Figma values to Fabric tokens using [`references/fabric-token-mapping.md`](references/fabric-token-mapping.md). Generate `/tmp/figma-spec-wi-<ID>.html` from [`references/mockup-template.html`](references/mockup-template.html):
- `:root` block with all Fabric token declarations
- Token mapping spec table (Element → Property → Figma Value → Fabric Token → CSS Variable)
- Embedded Figma frame images (base64) for reference
- TARGET DESIGN section: HTML/CSS recreation of the Figma design using `var(--token, fallback)`

Upload: `uploadWorkItemAttachment({ workItemId, filePath, fileName: "figma-spec-wi-<ID>.html" })`

Set `uxDesign.mockupUrl` to the **Azure DevOps attachment URL returned by `uploadWorkItemAttachment`** (not a local file path — local paths don't survive session changes). Set `uxDesign.designSource = "figma"`. Call `uploadCheckpoint`. **STOP.** Skip to step 5.

### 3. Capture current UI (no Figma path) `[uxDesign.3]`

1. Build: `pnpm nx build web` (or the consuming app — not individual libraries)
2. Serve: `sudo pnpm nx serve web` (if cert error, `sudo pnpm nx setup powerbi` first)
3. Navigate using the `playwright-web-app` skill
4. Capture: screenshot, accessibility tree, extract HTML/CSS of target area
5. Map captured CSS values to Fabric tokens using [`references/fabric-token-mapping.md`](references/fabric-token-mapping.md)

Store in `uxDesign.currentUICapture` (include token inventory). Call `uploadCheckpoint`. **STOP.**

### 4. Generate HTML mockup (no Figma path) `[uxDesign.4]`

Create `/tmp/mockup-wi-<ID>.html` using [`references/mockup-template.html`](references/mockup-template.html):

- Start from the captured HTML in step 3, apply the work item's changes, replace raw values with `var(--token, fallback)`
- The "current" state is already preserved in `uxDesign.currentUICapture` — the mockup only shows the **target design**
- Token mapping table listing all Fabric tokens used

Upload: `uploadWorkItemAttachment({ workItemId, filePath, fileName: "mockup-wi-<ID>.html" })`

Set `uxDesign.mockupUrl` to the **Azure DevOps attachment URL returned by `uploadWorkItemAttachment`** (not a local file path — local paths don't survive session changes). Set `uxDesign.designSource = "mockup"`. Call `uploadCheckpoint`. **STOP.**

### 5. Present and iterate `[uxDesign.5]`

Present the design (Figma specs or mockup) to the user. Iterate until approved. Store feedback rounds. Set `uxDesign.status = "APPROVED"`, `uxDesign.approvedAt`, `completedAt`. Call `uploadCheckpoint`. **STOP after each round.**

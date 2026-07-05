# Layer 1 — deterministic filter

Pure data-shape rules over the Step 3 bulk JSON. No LLM, no network, no MCP call.

## Rules (first match wins)

| Check | Reason sub-tag |
|---|---|
| Missing `System.AreaPath`, or area path NOT in `Trident\Fabric Growth and Retention` / `Trident\Shared Experience` | `ai-rejected:out-of-scope` |
| Missing `System.State`, or state NOT in `New` / `Definition` / `Planning` | `ai-rejected:out-of-scope` |
| `System.WorkItemType` is `Epic` | `ai-rejected:too-large` |
| `System.WorkItemType` is anything other than `Feature` | `ai-rejected:non-feature` |
| `Custom.Status` equals `Blocked` (case-insensitive) | `ai-rejected:already-blocked` |
| `Custom.CommitmentStatus` in `Deferred` / `Rejected` | `ai-rejected:already-blocked` |
| Tags include `blocked` or `on-hold` (case-insensitive) | `ai-rejected:already-blocked` |
| Title OR description matches `\b(spike\|investigation\|research\|data analysis\|proposal)\b` | `ai-rejected:non-impl` |
| Description text (HTML stripped) length < 100 chars | `ai-rejected:thin-spec` |

Notes:

- `needs-design` is intentionally NOT a blocking tag.
- `Custom.Status === Blocked` and `Custom.CommitmentStatus` capture PM's explicit verdict — when a human has already flagged the item, the AI has no business re-assessing implementability.
- The Epic / non-Feature checks are belt-and-suspenders against direct callers that bypass the Step 1 WIQL.
- Acceptance Criteria is not consulted; description length alone is the test.

## Evaluation

Pipe the bulk JSON through `node` on stdin. Output is `{ count, surviveCount, rejectByReason, decisions }`.

```bash
echo "$BULK_JSON" | node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const items = data.workItems || data;
const NON_IMPL = /\b(spike|investigation|research|data analysis|proposal)\b/i;
const BLOCKED_TAGS = new Set(["blocked", "on-hold"]);
const STATES = new Set(["New", "Definition", "Planning"]);
const SCOPE_AREAS = new Set(["Trident\\Fabric Growth and Retention", "Trident\\Shared Experience"]);
const DEFERRED = new Set(["deferred", "rejected"]);
const stripHtml = s => (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
const decisions = items.map(wi => {
  const f = wi.fields || {};
  const title = f["System.Title"] || "";
  const descText = stripHtml(f["System.Description"]);
  const area = f["System.AreaPath"];
  const type = f["System.WorkItemType"] || "";
  const state = f["System.State"];
  const customStatus = (f["Custom.Status"] || "").toString().trim().toLowerCase();
  const commitment = (f["Custom.CommitmentStatus"] || "").toString().trim().toLowerCase();
  const tags = new Set((f["System.Tags"] || "").split(";").map(t => t.trim().toLowerCase()).filter(Boolean));
  if (!area || !SCOPE_AREAS.has(area)) return { id: wi.id, decision: "reject", reason: "ai-rejected:out-of-scope" };
  if (!state || !STATES.has(state)) return { id: wi.id, decision: "reject", reason: "ai-rejected:out-of-scope" };
  if (type === "Epic") return { id: wi.id, decision: "reject", reason: "ai-rejected:too-large" };
  if (type !== "Feature") return { id: wi.id, decision: "reject", reason: "ai-rejected:non-feature" };
  if (customStatus === "blocked") return { id: wi.id, decision: "reject", reason: "ai-rejected:already-blocked" };
  if (DEFERRED.has(commitment)) return { id: wi.id, decision: "reject", reason: "ai-rejected:already-blocked" };
  for (const t of BLOCKED_TAGS) if (tags.has(t)) return { id: wi.id, decision: "reject", reason: "ai-rejected:already-blocked" };
  if (NON_IMPL.test(title) || NON_IMPL.test(descText)) return { id: wi.id, decision: "reject", reason: "ai-rejected:non-impl" };
  if (descText.length < 100) return { id: wi.id, decision: "reject", reason: "ai-rejected:thin-spec" };
  return { id: wi.id, decision: "survive" };
});
const rejectByReason = {};
for (const d of decisions) if (d.decision === "reject") rejectByReason[d.reason] = (rejectByReason[d.reason] || 0) + 1;
console.log(JSON.stringify({
  count: decisions.length,
  surviveCount: decisions.filter(d => d.decision === "survive").length,
  rejectByReason,
  decisions,
}));
'
```

Pass survivors to Layer 2.

#!/usr/bin/env node
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
// </copyright>
//-----------------------------------------------------------------------

/**
 * MCP Server for Azure DevOps work item operations.
 *
 * Tools: queryWorkItems, getWorkItems, getWorkItemComments,
 *        downloadWorkItemAttachments, uploadWorkItemAttachment,
 *        addWorkItemComment, deleteWorkItemComment, updateWorkItems
 *
 * Protocol: MCP over stdio (JSON-RPC 2.0)
 * No external dependencies — uses Node.js built-in modules only.
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Azure DevOps Configuration ---
const AZURE_DEVOPS_ORG = 'https://dev.azure.com/powerbi';
const AZURE_DEVOPS_PROJECT = 'Trident';
const AZURE_DEVOPS_API_VERSION = '7.1';

// --- Helpers ---

let _cachedToken = null;
let _tokenExpiry = 0;

function getAzureDevOpsToken(force = false) {
    const now = Date.now();
    if (!force && _cachedToken && now < _tokenExpiry) {
        return _cachedToken;
    }
    try {
        const output = execSync(
            'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 2>&1',
            { encoding: 'utf8', timeout: 30000 }
        );
        const parsed = JSON.parse(output);
        _cachedToken = parsed.accessToken;
        // Trust the actual expiresOn from az with a 5-minute safety buffer.
        // The previous "now + 50min" was wrong because az may hand out a token
        // that's already mid-lifetime, leading to mid-run 401 / signin redirects.
        const expiresOnMs = parsed.expiresOn ? Date.parse(parsed.expiresOn) : (now + 50 * 60 * 1000);
        _tokenExpiry = expiresOnMs - 5 * 60 * 1000;
        return _cachedToken;
    } catch (e) {
        throw new Error(`Failed to get Azure DevOps token: ${e.message}`);
    }
}

function invalidateTokenCache() {
    _cachedToken = null;
    _tokenExpiry = 0;
}

function sendRequest(method, url, body, contentType = 'application/json') {
    const token = getAzureDevOpsToken();
    const args = ['-s', '-X', method, url, '-H', `Authorization: Bearer ${token}`];

    if (body && contentType === 'application/octet-stream') {
        args.push('-H', `Content-Type: ${contentType}`, '--data-binary', `@${body}`);
    } else if (body) {
        args.push('-H', `Content-Type: ${contentType}`, '-d', typeof body === 'string' ? body : JSON.stringify(body));
    }

    try {
        const result = execFileSync('curl', args, {
            encoding: 'utf8',
            timeout: 60000,
        });
        return result ? JSON.parse(result) : {};
    } catch (e) {
        throw new Error(`Azure DevOps API request failed: ${method} ${url} — ${e.message}`);
    }
}

// Like sendRequest but exposes HTTP status code (needed for 429 backoff).
// Returns { status, body }. Throws only on transport-level failures.
// On auth failure (401, or any redirect to a *visualstudio.com/_signin URL),
// invalidates the cached token and retries once with a fresh one.
function sendRequestWithStatus(method, url, body, contentType = 'application/json', _retriedAuth = false) {
    const token = getAzureDevOpsToken();
    const args = [
        '-s', '-o', '/dev/stdout', '-w', '\n__STATUS__:%{http_code}\n__REDIRECT__:%{redirect_url}',
        '-X', method, url, '-H', `Authorization: Bearer ${token}`,
    ];
    if (body) {
        args.push('-H', `Content-Type: ${contentType}`, '-d', typeof body === 'string' ? body : JSON.stringify(body));
    }
    let raw;
    try {
        raw = execFileSync('curl', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
        throw new Error(`Azure DevOps API request failed: ${method} ${url} — ${e.message}`);
    }
    // Parse footers: __STATUS__ first, then __REDIRECT__.
    const redirectIdx = raw.lastIndexOf('\n__REDIRECT__:');
    let redirectUrl = '';
    if (redirectIdx !== -1) {
        redirectUrl = raw.slice(redirectIdx + '\n__REDIRECT__:'.length).trim();
        raw = raw.slice(0, redirectIdx);
    }
    const statusIdx = raw.lastIndexOf('\n__STATUS__:');
    let status = 0;
    let bodyText = raw;
    if (statusIdx !== -1) {
        status = parseInt(raw.slice(statusIdx + '\n__STATUS__:'.length).trim(), 10) || 0;
        bodyText = raw.slice(0, statusIdx);
    }
    let parsed = null;
    if (bodyText && bodyText.trim().length > 0) {
        try { parsed = JSON.parse(bodyText); } catch { parsed = { raw: bodyText }; }
    }

    // Auth-failure detection: HTTP 401, or a redirect to a *_signin URL on
    // *.visualstudio.com (ADO returns a 302 → signin when the bearer is rejected).
    const isAuthFailure = status === 401 ||
        (status >= 300 && status < 400 && /visualstudio\.com\/_signin|login\.microsoftonline\.com/i.test(redirectUrl));

    if (isAuthFailure && !_retriedAuth) {
        invalidateTokenCache();
        // Force-refresh on the next call inside the recursive invocation.
        getAzureDevOpsToken(true);
        return sendRequestWithStatus(method, url, body, contentType, true);
    }

    return { status, body: parsed };
}

async function withRetry(fn, { attempts = 5, baseDelayMs = 500 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const result = await fn();
            if (result && result.status === 429) {
                const delay = baseDelayMs * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                lastErr = new Error('429 Too Many Requests');
                continue;
            }
            if (result && result.status >= 500 && result.status < 600) {
                const delay = baseDelayMs * Math.pow(2, attempt);
                await new Promise(r => setTimeout(r, delay));
                lastErr = new Error(`HTTP ${result.status}`);
                continue;
            }
            return result;
        } catch (e) {
            lastErr = e;
            const delay = baseDelayMs * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr || new Error('retry attempts exhausted');
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function mapConcurrent(items, concurrency, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    async function worker() {
        while (cursor < items.length) {
            const idx = cursor++;
            try {
                results[idx] = await fn(items[idx], idx);
            } catch (e) {
                results[idx] = { __error: e.message };
            }
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

// --- Tool Implementations ---

const DEFAULT_WORKITEM_FIELDS = null; // null = fetch all fields (workitemsbatch returns all when omitted)

// Bulk read by id. Accepts 1..N ids. Returns { workItems: [...] }.
//   ids:     [number]
//   fields:  optional array of System.* / Microsoft.VSTS.Common.* field references
//   expand:  optional "relations" | "all" | "links" — uses per-id endpoint when set
//   project: optional ADO project name; defaults to AZURE_DEVOPS_PROJECT (Trident)
async function getWorkItems({ ids, fields, expand, project }) {
    if (!Array.isArray(ids) || ids.length === 0) return { workItems: [] };
    const proj = project || AZURE_DEVOPS_PROJECT;
    const numericIds = ids.map(Number);

    // workitemsbatch does NOT support $expand, so when expand is requested we
    // fall back to per-id GET (concurrent).
    if (expand) {
        const items = await mapConcurrent(numericIds, 10, async (id) => {
            const url = `${AZURE_DEVOPS_ORG}/${proj}/_apis/wit/workitems/${id}?$expand=${encodeURIComponent(expand)}&api-version=${AZURE_DEVOPS_API_VERSION}`;
            const resp = await withRetry(() => sendRequestWithStatus('GET', url));
            if (resp.status < 200 || resp.status >= 300) {
                return { id, __error: `HTTP ${resp.status}` };
            }
            return resp.body;
        });
        return { workItems: items };
    }

    const url = `${AZURE_DEVOPS_ORG}/${proj}/_apis/wit/workitemsbatch?api-version=${AZURE_DEVOPS_API_VERSION}`;
    const chunks = chunk(numericIds, 200);
    const all = [];
    for (const c of chunks) {
        const body = { ids: c };
        if (fields && fields.length > 0) body.fields = fields;
        else if (DEFAULT_WORKITEM_FIELDS) body.fields = DEFAULT_WORKITEM_FIELDS;
        const resp = await withRetry(() => sendRequestWithStatus('POST', url, body));
        if (resp.status < 200 || resp.status >= 300) {
            throw new Error(`workitemsbatch failed (HTTP ${resp.status}): ${JSON.stringify(resp.body).slice(0, 500)}`);
        }
        const items = (resp.body && resp.body.value) || [];
        all.push(...items);
    }
    return { workItems: all };
}

// Run a WIQL query. Returns { count, ids } — does not bulk-fetch fields
// (call getWorkItems for that).
async function queryWorkItems({ wiql, top, project }) {
    if (!wiql) throw new Error('wiql is required');
    const proj = project || AZURE_DEVOPS_PROJECT;
    const url = `${AZURE_DEVOPS_ORG}/${proj}/_apis/wit/wiql?api-version=${AZURE_DEVOPS_API_VERSION}${top ? `&$top=${top}` : ''}`;
    const resp = await withRetry(() => sendRequestWithStatus('POST', url, { query: wiql }));
    if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`WIQL query failed (HTTP ${resp.status}): ${JSON.stringify(resp.body).slice(0, 500)}`);
    }
    const refs = (resp.body && resp.body.workItems) || [];
    return { count: refs.length, ids: refs.map(r => r.id) };
}

// Read comments for 1..N work items. With `top`, returns only the latest N
// comments per item (cheap probe). Returns `{ results: [{ id, totalCount, comments, inlineImageUrls }] }`.
// Backward compat: when called with singular `workItemId`, returns the legacy
// flat shape `{ totalCount, comments, inlineImageUrls }` directly.
async function getWorkItemComments({ ids, workItemId, top, project }) {
    const legacyMode = !ids && workItemId !== undefined;
    let normIds = ids;
    if (legacyMode) normIds = [workItemId];
    if (!Array.isArray(normIds) || normIds.length === 0) throw new Error('ids (or workItemId) is required');

    const proj = project || AZURE_DEVOPS_PROJECT;
    const htmlImgRegex = /<img[^>]+src=["']([^"']+)["']/g;
    const mdImgRegex = /!\[[^\]]*\]\(([^)]+)\)/g;

    const results = await mapConcurrent(normIds.map(Number), 10, async (id) => {
        const qs = top ? `?$top=${top}&order=desc&api-version=${AZURE_DEVOPS_API_VERSION}-preview` : `?api-version=${AZURE_DEVOPS_API_VERSION}-preview`;
        const url = `${AZURE_DEVOPS_ORG}/${proj}/_apis/wit/workitems/${id}/comments${qs}`;
        const resp = await withRetry(() => sendRequestWithStatus('GET', url));
        if (resp.status < 200 || resp.status >= 300) {
            return { id, error: `HTTP ${resp.status}`, totalCount: 0, comments: [], inlineImageUrls: [] };
        }
        const parsed = resp.body || {};
        const comments = (parsed.comments || []).map(c => ({
            id: c.id,
            text: c.text,
            createdBy: c.createdBy?.displayName || c.createdBy?.uniqueName || 'unknown',
            createdDate: c.createdDate,
            modifiedDate: c.modifiedDate,
        }));
        const inlineImageUrls = [];
        for (const comment of comments) {
            let match;
            while ((match = htmlImgRegex.exec(comment.text || '')) !== null) inlineImageUrls.push({ url: match[1], commentId: comment.id });
            while ((match = mdImgRegex.exec(comment.text || '')) !== null) inlineImageUrls.push({ url: match[1], commentId: comment.id });
        }
        return { id, totalCount: parsed.totalCount || comments.length, comments, inlineImageUrls };
    });

    if (legacyMode) {
        const r = results[0];
        return { totalCount: r.totalCount, comments: r.comments, inlineImageUrls: r.inlineImageUrls };
    }
    return { results };
}

// Add a single comment.
// Minimal, dependency-free markdown → HTML converter. Covers the subset our
// triage templates use: headings, **bold**, *italic*, `code`, paragraphs, line
// breaks, GitHub-flavored tables (| col | col |), unordered/ordered lists,
// links [text](url), HTML comments. Anything not on this list is escaped and
// passed through as a paragraph.
//
// ADO work-item comments are rendered as HTML; the API does not honor a
// `format: 'markdown'` field. So callers that send markdown bodies (e.g. the
// backlog-triage skill's Step 9) ask this server to convert before posting via
// the `format: 'markdown'` argument on addWorkItemComment.
function markdownToHtml(md) {
    if (!md) return '';
    const escapeHtml = s => s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    // Preserve HTML comment delimiters (we use them as markers) verbatim.
    const HTML_COMMENT = /<!--[\s\S]*?-->/g;
    const comments = [];
    md = md.replace(HTML_COMMENT, m => {
        comments.push(m);
        return `\x00CMT${comments.length - 1}\x00`;
    });

    const lines = md.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // Blank line → paragraph break.
        if (line.trim() === '') { i++; continue; }

        // Heading
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            out.push(`<h${h[1].length}>${renderInline(escapeHtml(h[2]))}</h${h[1].length}>`);
            i++; continue;
        }

        // Table — starts with `|` and is followed by a separator row of `---`.
        if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*[-:| ]+\|/.test(lines[i + 1])) {
            const header = parseTableRow(line);
            i += 2; // skip separator
            const rows = [];
            while (i < lines.length && /^\s*\|/.test(lines[i])) {
                rows.push(parseTableRow(lines[i]));
                i++;
            }
            const headHtml = '<tr>' + header.map(c => `<th>${renderInline(escapeHtml(c))}</th>`).join('') + '</tr>';
            const bodyHtml = rows.map(r => '<tr>' + r.map(c => `<td>${renderInline(escapeHtml(c))}</td>`).join('') + '</tr>').join('');
            out.push(`<table><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table>`);
            continue;
        }

        // Unordered list
        if (/^\s*[-*]\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
                i++;
            }
            out.push('<ul>' + items.map(it => `<li>${renderInline(escapeHtml(it))}</li>`).join('') + '</ul>');
            continue;
        }

        // Ordered list
        if (/^\s*\d+\.\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
                i++;
            }
            out.push('<ol>' + items.map(it => `<li>${renderInline(escapeHtml(it))}</li>`).join('') + '</ol>');
            continue;
        }

        // Paragraph — gather contiguous non-blank, non-block lines.
        const para = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== '' &&
               !/^(#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) {
            para.push(lines[i]);
            i++;
        }
        out.push(`<p>${renderInline(escapeHtml(para.join(' ').trim()))}</p>`);
    }

    let html = out.join('\n');
    // Restore HTML comments.
    html = html.replace(/\x00CMT(\d+)\x00/g, (_, n) => comments[Number(n)]);
    return html;
}

function parseTableRow(line) {
    // Drop leading/trailing | then split on | (no escape handling — overkill for our templates).
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function renderInline(s) {
    // Order matters: code first (so its contents aren't bolded), then bold, italic, links.
    return s
        .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
        .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
        .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, c) => `<em>${c}</em>`)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
}

async function addWorkItemComment({ workItemId, text, format, dryRun, project }) {
    if (!workItemId) throw new Error('workItemId is required');
    if (!text) throw new Error('text is required');
    const proj = project || AZURE_DEVOPS_PROJECT;
    const body = format === 'markdown' ? markdownToHtml(text) : text;
    if (dryRun) return { workItemId, dryRun: true, wouldAddBytes: body.length, format: format || 'html' };
    const url = `${AZURE_DEVOPS_ORG}/${proj}/_apis/wit/workitems/${workItemId}/comments?api-version=${AZURE_DEVOPS_API_VERSION}-preview`;
    const resp = await withRetry(() => sendRequestWithStatus('POST', url, { text: body }));
    if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Add comment failed (HTTP ${resp.status}): ${JSON.stringify(resp.body).slice(0, 500)}`);
    }
    return { workItemId, dryRun: false, commentId: resp.body && resp.body.id, format: format || 'html' };
}

// Delete a single comment by id.
async function deleteWorkItemComment({ workItemId, commentId, dryRun, project }) {
    if (!workItemId) throw new Error('workItemId is required');
    if (!commentId) throw new Error('commentId is required');
    const proj = project || AZURE_DEVOPS_PROJECT;
    if (dryRun) return { workItemId, commentId, dryRun: true };
    const url = `${AZURE_DEVOPS_ORG}/${proj}/_apis/wit/workitems/${workItemId}/comments/${commentId}?api-version=${AZURE_DEVOPS_API_VERSION}-preview`;
    const resp = await withRetry(() => sendRequestWithStatus('DELETE', url));
    if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Delete comment failed (HTTP ${resp.status}): ${JSON.stringify(resp.body).slice(0, 500)}`);
    }
    return { workItemId, commentId, dryRun: false };
}

// Batch update work items via the ADO $batch endpoint. Each update applies
// any field PATCH ops + optional tag deltas (which the tool resolves into a
// single System.Tags PATCH after reading current tags).
//
//   updates: [{ id, fields?: { 'System.X': value, ... }, addTags?: [string], removeTags?: [string] }]
//   dryRun:  preview only — returns the resolved PATCH ops without sending.
//
// Auto-chunks at 100 ops per $batch call with exponential 429 backoff.
async function updateWorkItems({ updates, dryRun, project }) {
    if (!Array.isArray(updates) || updates.length === 0) {
        return { updated: 0, skipped: 0, dryRun: !!dryRun, results: [] };
    }
    const proj = project || AZURE_DEVOPS_PROJECT;
    const ids = updates.map(u => Number(u.id));

    // If any update has tag deltas, read current tags so we can merge them.
    const tagDeltaUpdates = updates.filter(u => (u.addTags && u.addTags.length) || (u.removeTags && u.removeTags.length));
    let currentTagsById = new Map();
    if (tagDeltaUpdates.length > 0) {
        const cur = await getWorkItems({ ids: tagDeltaUpdates.map(u => Number(u.id)), fields: ['System.Id', 'System.Tags'], project: proj });
        for (const wi of cur.workItems) {
            const raw = (wi.fields && wi.fields['System.Tags']) || '';
            currentTagsById.set(Number(wi.id), new Set(raw.split(';').map(t => t.trim()).filter(Boolean)));
        }
    }

    // Resolve each update into a sequence of PATCH ops.
    const resolved = updates.map(u => {
        const id = Number(u.id);
        const ops = [];
        for (const [field, value] of Object.entries(u.fields || {})) {
            ops.push({ op: 'add', path: `/fields/${field}`, value });
        }
        if ((u.addTags && u.addTags.length) || (u.removeTags && u.removeTags.length)) {
            const cur = new Set(currentTagsById.get(id) || []);
            for (const t of (u.removeTags || [])) cur.delete(t);
            for (const t of (u.addTags || [])) cur.add(t);
            ops.push({ op: 'add', path: '/fields/System.Tags', value: Array.from(cur).join('; ') });
        }
        return { id, ops };
    }).filter(r => r.ops.length > 0);

    if (dryRun) {
        return { updated: 0, skipped: resolved.length, dryRun: true, preview: resolved };
    }

    // ADO $batch is org-scoped; do NOT include the project segment.
    // (Per-batch entry uris below also stay org-scoped — work item IDs are
    // globally unique within the org.)
    const batchUrl = `${AZURE_DEVOPS_ORG}/_apis/wit/$batch?api-version=${AZURE_DEVOPS_API_VERSION}`;
    const batchEntries = resolved.map(r => ({
        method: 'PATCH',
        uri: `/_apis/wit/workitems/${r.id}?api-version=${AZURE_DEVOPS_API_VERSION}`,
        headers: { 'Content-Type': 'application/json-patch+json' },
        body: r.ops,
    }));

    const chunks = chunk(batchEntries, 100);
    const results = [];
    for (const c of chunks) {
        const resp = await withRetry(() => sendRequestWithStatus('PATCH', batchUrl, c));
        if (resp.status < 200 || resp.status >= 300) {
            results.push({ status: resp.status, error: JSON.stringify(resp.body).slice(0, 500), count: c.length });
        } else {
            results.push({ status: resp.status, count: c.length });
        }
    }
    const okCount = results.filter(r => r.status >= 200 && r.status < 300).reduce((n, r) => n + r.count, 0);
    return { updated: okCount, skipped: batchEntries.length - okCount, dryRun: false, results };
}

function downloadWorkItemAttachments(urls, outputDir) {
    const token = getAzureDevOpsToken();
    const dir = outputDir || '/tmp';

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const results = [];
    for (const entry of urls) {
        const url = typeof entry === 'string' ? entry : entry.url;
        const customName = typeof entry === 'string' ? null : entry.fileName;

        let fileName = customName;
        if (!fileName) {
            try {
                const parsed = new URL(url);
                fileName = parsed.searchParams.get('fileName');
                if (!fileName) {
                    const segments = parsed.pathname.split('/').filter(Boolean);
                    fileName = segments[segments.length - 1] || 'attachment';
                }
            } catch {
                fileName = 'attachment';
            }
        }

        let outputPath = path.join(dir, fileName);
        if (fs.existsSync(outputPath)) {
            const ext = path.extname(fileName);
            const base = path.basename(fileName, ext);
            let counter = 1;
            while (fs.existsSync(outputPath)) {
                outputPath = path.join(dir, `${base}_${counter}${ext}`);
                counter++;
            }
        }

        try {
            execFileSync('curl', ['-sL', '--max-time', '30', '-o', outputPath, url, '-H', `Authorization: Bearer ${token}`], {
                encoding: 'utf8',
                timeout: 45000,
            });

            const stats = fs.statSync(outputPath);
            if (stats.size < 2000) {
                const content = fs.readFileSync(outputPath, 'utf8');
                if (content.includes('<!DOCTYPE') || content.includes('<html') || content.includes('"message"')) {
                    results.push({ url, outputPath, success: false, error: `Server returned HTML/JSON error (${stats.size} bytes): ${content.slice(0, 200)}` });
                    fs.unlinkSync(outputPath);
                    continue;
                }
            }

            results.push({ url, outputPath, success: true, sizeBytes: stats.size, fileName: path.basename(outputPath) });
        } catch (e) {
            results.push({ url, outputPath, success: false, error: e.message });
        }
    }

    return { downloaded: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, files: results };
}

function uploadWorkItemAttachment(workItemId, filePath, fileName, comment) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const uploadFileName = fileName || path.basename(filePath);
    const uploadUrl = `${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis/wit/attachments?fileName=${encodeURIComponent(uploadFileName)}&api-version=${AZURE_DEVOPS_API_VERSION}`;
    const uploadResult = sendRequest('POST', uploadUrl, filePath, 'application/octet-stream');
    const attachmentUrl = uploadResult.url;
    if (!attachmentUrl) {
        throw new Error('Upload succeeded but no URL returned');
    }

    const token = getAzureDevOpsToken();
    const patchUrl = `${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis/wit/workitems/${workItemId}?api-version=${AZURE_DEVOPS_API_VERSION}`;
    const linkBody = JSON.stringify([{
        op: 'add',
        path: '/relations/-',
        value: { rel: 'AttachedFile', url: attachmentUrl, attributes: { comment: comment || uploadFileName } },
    }]);

    execFileSync('curl', [
        '-s', '-X', 'PATCH', patchUrl,
        '-H', `Authorization: Bearer ${token}`,
        '-H', 'Content-Type: application/json-patch+json',
        '-d', linkBody,
    ], { encoding: 'utf8', timeout: 30000 });

    return { success: true, attachmentUrl, fileName: uploadFileName, message: `Uploaded ${uploadFileName} to WI #${workItemId}` };
}

// --- MCP Protocol Handler ---

const TOOLS = [
    {
        name: 'queryWorkItems',
        description: 'Run a WIQL query and return matching work item IDs. Returns only `{ count, ids }` — call getWorkItems for field values.',
        inputSchema: {
            type: 'object',
            properties: {
                wiql: { type: 'string', description: 'WIQL query (e.g. "SELECT [System.Id] FROM WorkItems WHERE ...").' },
                top: { type: 'number', description: 'Optional max number of results.' },
                project: { type: 'string', description: 'Optional ADO project. Defaults to Trident.' },
            },
            required: ['wiql'],
        },
    },
    {
        name: 'getWorkItems',
        description: 'Read 1..N Azure DevOps work items by id. Use `fields` to project specific fields via the bulk workitemsbatch endpoint (auto-chunked at 200 per call). Use `expand` (e.g. "relations") for a per-id fetch that includes relations / links. Returns `{ workItems: [<wi>...] }`.',
        inputSchema: {
            type: 'object',
            properties: {
                ids: { type: 'array', items: { type: 'number' }, description: 'Work item IDs.' },
                fields: { type: 'array', items: { type: 'string' }, description: 'Optional field references (e.g. ["System.Title", "System.ChangedDate"]). Omit to get all fields.' },
                expand: { type: 'string', description: 'Optional ADO $expand value (e.g. "relations", "all"). When set, uses per-id GET; `fields` is ignored.' },
                project: { type: 'string', description: 'Optional ADO project. Defaults to Trident.' },
            },
            required: ['ids'],
        },
    },
    {
        name: 'getWorkItemComments',
        description: 'Read comments for 1..N work items. With `top`, returns only the latest N comments per item (cheap "latest comment" probe). Returns `{ results: [{ id, totalCount, comments, inlineImageUrls }] }`. For backward compatibility, a singular `workItemId` is also accepted.',
        inputSchema: {
            type: 'object',
            properties: {
                ids: { type: 'array', items: { type: 'number' }, description: 'Work item IDs. Either this or workItemId must be provided.' },
                workItemId: { type: 'number', description: 'Singular work item ID (backward-compat).' },
                top: { type: 'number', description: 'Optional max number of comments per item, latest first.' },
                project: { type: 'string', description: 'Optional ADO project. Defaults to Trident.' },
            },
        },
    },
    {
        name: 'downloadWorkItemAttachments',
        description: 'Download one or more Azure DevOps attachment files (images, documents, videos) by URL. Handles authentication automatically.',
        inputSchema: {
            type: 'object',
            properties: {
                urls: {
                    type: 'array',
                    description: 'Array of attachment URLs. Each element can be a URL string or { url, fileName }.',
                    items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { url: { type: 'string' }, fileName: { type: 'string' } }, required: ['url'] }] },
                },
                outputDir: { type: 'string', description: 'Directory to save files to. Defaults to /tmp.' },
            },
            required: ['urls'],
        },
    },
    {
        name: 'uploadWorkItemAttachment',
        description: 'Upload a local file to an Azure DevOps work item as an attachment. Returns the Azure DevOps attachment URL. Use this to persist files so they survive across sessions.',
        inputSchema: {
            type: 'object',
            properties: {
                workItemId: { type: 'number', description: 'Azure DevOps work item ID' },
                filePath: { type: 'string', description: 'Absolute path to the local file to upload' },
                fileName: { type: 'string', description: 'File name in Azure DevOps. Defaults to local file name.' },
                comment: { type: 'string', description: 'Comment for the attachment. Defaults to the file name.' },
            },
            required: ['workItemId', 'filePath'],
        },
    },
    {
        name: 'addWorkItemComment',
        description: 'Add a single comment to a work item. ADO work-item comments are rendered as HTML — markdown is shown literally. Set `format: "markdown"` to have the server convert your markdown body to HTML before posting (covers headings, **bold**, *italic*, `code`, tables, lists, links, paragraphs). Default format is `"html"`, which posts the body verbatim.',
        inputSchema: {
            type: 'object',
            properties: {
                workItemId: { type: 'number' },
                text: { type: 'string', description: 'Comment body. Interpreted per `format`.' },
                format: { type: 'string', enum: ['html', 'markdown'], description: 'Body format. Default `"html"`. Use `"markdown"` to let the server convert.' },
                dryRun: { type: 'boolean' },
                project: { type: 'string', description: 'Optional ADO project. Defaults to Trident.' },
            },
            required: ['workItemId', 'text'],
        },
    },
    {
        name: 'deleteWorkItemComment',
        description: 'Delete a single comment by id from a work item.',
        inputSchema: {
            type: 'object',
            properties: {
                workItemId: { type: 'number' },
                commentId: { type: 'number' },
                dryRun: { type: 'boolean' },
                project: { type: 'string', description: 'Optional ADO project. Defaults to Trident.' },
            },
            required: ['workItemId', 'commentId'],
        },
    },
    {
        name: 'updateWorkItems',
        description: 'Batch update work items via the ADO $batch endpoint. Each update can set arbitrary fields and/or add/remove tags. Tag deltas are resolved server-side (the tool reads current tags, merges, and PATCHes System.Tags). Auto-chunks at 100 ops per $batch call with exponential 429 backoff. With dryRun=true, returns the resolved PATCH ops without writing.',
        inputSchema: {
            type: 'object',
            properties: {
                updates: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'number' },
                            fields: { type: 'object', description: 'Map of field reference name -> new value (e.g. { "System.State": "Active" }).' },
                            addTags: { type: 'array', items: { type: 'string' } },
                            removeTags: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['id'],
                    },
                },
                dryRun: { type: 'boolean' },
                project: { type: 'string', description: 'Optional ADO project. Defaults to Trident.' },
            },
            required: ['updates'],
        },
    },
];

function handleRequest(request) {
    const { method, params, id } = request;

    switch (method) {
        case 'initialize':
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'work-item-server', version: '1.0.0' },
                },
            };

        case 'notifications/initialized':
            return null;

        case 'tools/list':
            return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

        case 'tools/call': {
            const { name, arguments: args } = params;
            return (async () => {
                try {
                    let result;
                    if (name === 'queryWorkItems') {
                        result = await queryWorkItems(args);
                    } else if (name === 'getWorkItems') {
                        result = await getWorkItems(args);
                    } else if (name === 'getWorkItemComments') {
                        result = await getWorkItemComments(args || {});
                    } else if (name === 'downloadWorkItemAttachments') {
                        result = downloadWorkItemAttachments(args.urls, args.outputDir);
                    } else if (name === 'uploadWorkItemAttachment') {
                        result = uploadWorkItemAttachment(args.workItemId, args.filePath, args.fileName, args.comment);
                    } else if (name === 'addWorkItemComment') {
                        result = await addWorkItemComment(args);
                    } else if (name === 'deleteWorkItemComment') {
                        result = await deleteWorkItemComment(args);
                    } else if (name === 'updateWorkItems') {
                        result = await updateWorkItems(args);
                    } else {
                        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
                    }
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
                } catch (e) {
                    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true } };
                }
            })();
        }

        default:
            if (method?.startsWith('notifications/')) return null;
            return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
}

// --- stdio transport ---

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
            const request = JSON.parse(line);
            const response = handleRequest(request);
            if (response && typeof response.then === 'function') {
                response.then(r => {
                    if (r) process.stdout.write(JSON.stringify(r) + '\n');
                }).catch(e => {
                    process.stderr.write(`Handler error: ${e.message}\n`);
                });
            } else if (response) {
                process.stdout.write(JSON.stringify(response) + '\n');
            }
        } catch (e) {
            process.stderr.write(`Parse error: ${e.message}\n`);
        }
    }
});

process.stdin.on('end', () => process.exit(0));

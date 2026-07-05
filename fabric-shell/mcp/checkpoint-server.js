#!/usr/bin/env node
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
// </copyright>
//-----------------------------------------------------------------------

/**
 * MCP Server for agent checkpoint persistence.
 *
 * Tools: downloadCheckpoint, uploadCheckpoint
 *
 * Stores checkpoint state in-memory with local file backup and background
 * sync to Azure DevOps work item attachments. Validates against
 * checkpoint-schema.json, deep-merges partial updates, auto-fills timestamps,
 * and rejects writes that violate phase ordering rules.
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

function getAzureDevOpsToken() {
    const now = Date.now();
    if (_cachedToken && now < _tokenExpiry) {
        return _cachedToken;
    }
    try {
        const output = execSync(
            'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 2>&1',
            { encoding: 'utf8', timeout: 30000 }
        );
        const parsed = JSON.parse(output);
        _cachedToken = parsed.accessToken;
        // Cache for 50 minutes (tokens last ~60 min)
        _tokenExpiry = now + 50 * 60 * 1000;
        return _cachedToken;
    } catch (e) {
        throw new Error(`Failed to get Azure DevOps token: ${e.message}`);
    }
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

function fetchWorkItem(workItemId) {
    const token = getAzureDevOpsToken();
    const url = `${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis/wit/workitems/${workItemId}?$expand=relations&api-version=${AZURE_DEVOPS_API_VERSION}`;
    const result = execFileSync('curl', ['-s', url, '-H', `Authorization: Bearer ${token}`], {
        encoding: 'utf8',
        timeout: 30000,
    });
    return JSON.parse(result);
}

function findCheckpointAttachment(wi) {
    const relations = wi.relations || [];
    for (let i = 0; i < relations.length; i++) {
        const r = relations[i];
        if (r.rel === 'AttachedFile' && (r.attributes?.name || '').includes('agent-checkpoint-wi-')) {
            return { index: i, url: r.url };
        }
    }
    return null;
}

// --- Checkpoint Validation & Auto-fill ---

const CHECKPOINT_PHASES = ['workItemAnalysis', 'clarification', 'pmSpec', 'uxDesign', 'devDesign', 'devImplementation', 'prSubmission', 'prIteration'];
const TERMINAL_STATUSES = new Set(['COMPLETED', 'APPROVED', 'SKIPPED']);

// --- Checkpoint Schema ---
// Single source of truth: checkpoint-schema.json (sibling of mcp/ directory).
// Consumed here for runtime validation. Also referenced by fabric-shell-dev-agent.md and skill files.
const CHECKPOINT_SCHEMA = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'checkpoint-schema.json'), 'utf8')
);

/**
 * Recursively validate a value against a schema node.
 * Returns an array of { path, message, severity } where severity is 'warn' or 'error'.
 * 'error' = unknown key (will be stripped). 'warn' = type mismatch or missing required field.
 */
function validateSchema(value, schema, path) {
    const issues = [];
    if (!schema || schema.type === 'any' || value === undefined || value === null) return issues;

    // Type check
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (schema.type !== 'any' && schema.type !== actualType) {
        // Empty string/0/false are okay for initialized fields
        if (!(actualType === 'string' && value === '') && !(actualType === 'number' && value === 0) && !(actualType === 'boolean' && value === false)) {
            issues.push({ path, message: `Expected type "${schema.type}" but got "${actualType}".`, severity: 'warn' });
        }
        return issues; // Don't recurse into wrong type
    }

    // Enum check
    if (schema.enum && !schema.enum.includes(value)) {
        issues.push({ path, message: `Value "${value}" is not one of: ${schema.enum.join(', ')}.`, severity: 'warn' });
    }

    // Object: check properties
    if (schema.type === 'object' && schema.properties && actualType === 'object') {
        const knownKeys = new Set(Object.keys(schema.properties));

        // Check for unknown keys
        for (const key of Object.keys(value)) {
            if (!knownKeys.has(key)) {
                issues.push({ path: `${path}.${key}`, message: `Unknown property "${key}". Expected one of: ${[...knownKeys].join(', ')}.`, severity: 'error' });
            }
        }

        // Recurse into known keys
        for (const [key, subSchema] of Object.entries(schema.properties)) {
            if (value[key] !== undefined && value[key] !== null) {
                issues.push(...validateSchema(value[key], subSchema, `${path}.${key}`));
            }
        }

        // Check required fields
        if (schema.required) {
            for (const req of schema.required) {
                if (value[req] === undefined || value[req] === null) {
                    issues.push({ path: `${path}.${req}`, message: `Required property "${req}" is missing.`, severity: 'warn' });
                }
            }
        }
    }

    // Array: validate each item
    if (schema.type === 'array' && schema.items && actualType === 'array') {
        for (let i = 0; i < value.length; i++) {
            issues.push(...validateSchema(value[i], schema.items, `${path}[${i}]`));
        }
    }

    return issues;
}

/**
 * Validate and auto-fill checkpoint fields after deep merge.
 * Returns { warnings: string[], errors: string[] }.
 * Errors are hard blockers — the checkpoint write will be REJECTED if errors exist.
 * Warnings are informational — the write proceeds but the agent should fix them.
 */
function validateAndAutoFillCheckpoint(checkpoint) {
    const warnings = [];
    const errors = [];
    const now = new Date().toISOString();

    // 1. Always set lastUpdated to current time
    checkpoint.lastUpdated = now;

    // 2. Recursive schema validation — checks all nesting levels
    const schemaIssues = validateSchema(checkpoint, CHECKPOINT_SCHEMA, 'checkpoint');

    for (const issue of schemaIssues) {
        if (issue.severity === 'error') {
            // Strip unknown properties by navigating to parent and deleting
            const parts = issue.path.replace(/\[(\d+)\]/g, '.$1').split('.');
            const propName = parts[parts.length - 1];
            let parent = checkpoint;
            for (let i = 1; i < parts.length - 1; i++) {
                if (parent == null) break;
                parent = parent[parts[i]];
            }
            if (parent && typeof parent === 'object' && propName in parent) {
                delete parent[propName];
                warnings.push(`Removed ${issue.path}: ${issue.message}`);
            }
        } else {
            warnings.push(`${issue.path}: ${issue.message}`);
        }
    }

    // 3. Auto-fill startedAt/completedAt on status transitions for each phase
    for (const phase of CHECKPOINT_PHASES) {
        const phaseData = checkpoint[phase];
        if (!phaseData || typeof phaseData !== 'object') continue;

        const status = phaseData.status;

        if (status === 'IN_PROGRESS' && !phaseData.startedAt) {
            phaseData.startedAt = now;
        }

        if (TERMINAL_STATUSES.has(status) && !phaseData.completedAt) {
            phaseData.completedAt = now;
        }

        if (TERMINAL_STATUSES.has(status) && !phaseData.startedAt) {
            phaseData.startedAt = phaseData.completedAt;
        }
    }

    // 4. HARD ERROR: activePhase must match an IN_PROGRESS phase
    if (checkpoint.activePhase) {
        const activePhaseData = checkpoint[checkpoint.activePhase];
        if (activePhaseData && activePhaseData.status !== 'IN_PROGRESS') {
            errors.push(
                `REJECTED: activePhase="${checkpoint.activePhase}" but its status is "${activePhaseData.status}". ` +
                `You must set ${checkpoint.activePhase}.status to "IN_PROGRESS" before using it as activePhase. ` +
                `If you are completing this phase, update activePhase to the next phase.`
            );
        }
    }

    // 5. HARD ERROR: all phases before activePhase must have terminal status
    if (checkpoint.activePhase) {
        const activeIdx = CHECKPOINT_PHASES.indexOf(checkpoint.activePhase);
        if (activeIdx > 0) {
            const notStarted = [];
            const stuck = [];
            for (let i = 0; i < activeIdx; i++) {
                const phase = CHECKPOINT_PHASES[i];
                const phaseData = checkpoint[phase];
                const status = phaseData?.status;
                if (!status || status === 'NOT_STARTED') {
                    notStarted.push(phase);
                } else if (!TERMINAL_STATUSES.has(status)) {
                    stuck.push(`${phase} (${status})`);
                }
            }
            if (notStarted.length > 0) {
                errors.push(
                    `REJECTED: Cannot set activePhase="${checkpoint.activePhase}" while prior phases are NOT_STARTED: ${notStarted.join(', ')}. ` +
                    `Each phase must be explicitly COMPLETED, APPROVED, or SKIPPED (with skipReason) before moving to the next phase. ` +
                    `Fix: set each of [${notStarted.join(', ')}] to status="SKIPPED" with a skipReason, then retry this checkpoint write.`
                );
            }
            if (stuck.length > 0) {
                errors.push(
                    `REJECTED: Prior phases are stuck in non-terminal status: ${stuck.join(', ')}. ` +
                    `Complete or skip them before proceeding to ${checkpoint.activePhase}.`
                );
            }
        }
    }

    // 6. HARD ERROR: stepsCompleted must grow sequentially (no skipping steps)
    if (checkpoint.activePhase) {
        const phase = checkpoint.activePhase;
        const phaseData = checkpoint[phase];
        if (phaseData && Array.isArray(phaseData.stepsCompleted) && phaseData.stepsCompleted.length > 0) {
            const steps = phaseData.stepsCompleted;
            // Validate sequential ordering: each step ID should be <phase>.N where N increments by 1
            let prevNum = 0;
            for (const stepId of steps) {
                const match = stepId.match(/^(.+)\.(\d+)$/);
                if (!match) continue;
                const stepNum = parseInt(match[2], 10);
                if (stepNum !== prevNum + 1) {
                    errors.push(
                        `REJECTED: Step "${stepId}" in ${phase}.stepsCompleted is out of order. ` +
                        `Expected step ${phase}.${prevNum + 1} but got ${phase}.${stepNum}. ` +
                        `You must complete each step sequentially — no skipping. ` +
                        `Go back and execute step ${phase}.${prevNum + 1} first.`
                    );
                    break;
                }
                prevNum = stepNum;
            }
        }
    }

    return { warnings, errors };
}

// --- Checkpoint State (in-memory + local file + background ADO sync) ---

/**
 * Deep merge source into target. Arrays in source replace arrays in target
 * (not concatenated) to allow the caller to update array fields intentionally.
 * Scalar values in source overwrite target. Nested objects are merged recursively.
 */
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        const srcVal = source[key];
        const tgtVal = result[key];
        if (
            srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
            tgtVal !== null && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
        ) {
            result[key] = deepMerge(tgtVal, srcVal);
        } else {
            result[key] = srcVal;
        }
    }
    return result;
}

let _checkpoint = null;
let _checkpointWorkItemId = null;
let _checkpointDirty = false;
let _checkpointUploading = false;

function getCheckpointLocalPath(workItemId) {
    return `/tmp/agent-checkpoint-wi-${workItemId}.json`;
}

function flushCheckpointToLocal() {
    if (_checkpoint && _checkpointWorkItemId) {
        fs.writeFileSync(
            getCheckpointLocalPath(_checkpointWorkItemId),
            JSON.stringify(_checkpoint, null, 2)
        );
    }
}

function pushCheckpointToADO() {
    if (!_checkpoint || !_checkpointWorkItemId || _checkpointUploading) return;
    _checkpointUploading = true;

    try {
        const workItemId = _checkpointWorkItemId;
        const fileName = `agent-checkpoint-wi-${workItemId}.json`;
        const tmpPath = getCheckpointLocalPath(workItemId);

        // Ensure local file is current
        fs.writeFileSync(tmpPath, JSON.stringify(_checkpoint, null, 2));

        const uploadUrl = `${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis/wit/attachments?fileName=${fileName}&api-version=${AZURE_DEVOPS_API_VERSION}`;
        const uploadResult = sendRequest('POST', uploadUrl, tmpPath, 'application/octet-stream');
        const attachmentUrl = uploadResult.url;
        if (!attachmentUrl) {
            throw new Error('Upload succeeded but no URL returned');
        }

        const wi = fetchWorkItem(workItemId);
        const existing = findCheckpointAttachment(wi);
        const token = getAzureDevOpsToken();
        const patchUrl = `${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis/wit/workitems/${workItemId}?api-version=${AZURE_DEVOPS_API_VERSION}`;

        // Combine remove + add into minimal PATCH calls
        if (existing) {
            execFileSync('curl', [
                '-s', '-X', 'PATCH', patchUrl,
                '-H', `Authorization: Bearer ${token}`,
                '-H', 'Content-Type: application/json-patch+json',
                '-d', `[{"op":"remove","path":"/relations/${existing.index}"}]`,
            ], { encoding: 'utf8', timeout: 30000 });
        }

        const linkBody = JSON.stringify([{
            op: 'add',
            path: '/relations/-',
            value: { rel: 'AttachedFile', url: attachmentUrl, attributes: { comment: 'Agent checkpoint' } },
        }]);

        execFileSync('curl', [
            '-s', '-X', 'PATCH', patchUrl,
            '-H', `Authorization: Bearer ${token}`,
            '-H', 'Content-Type: application/json-patch+json',
            '-d', linkBody,
        ], { encoding: 'utf8', timeout: 30000 });

        _checkpointDirty = false;
    } catch (e) {
        process.stderr.write(`Checkpoint push failed: ${e.message}\n`);
    } finally {
        _checkpointUploading = false;
    }
}

// Background loop: push to ADO every 30 seconds if dirty
setInterval(() => {
    if (_checkpointDirty && !_checkpointUploading) {
        pushCheckpointToADO();
    }
}, 30 * 1000);

// --- Tool Implementations ---

function downloadCheckpoint(workItemId) {
    // Cache hit: same WI, already in memory
    if (_checkpoint && _checkpointWorkItemId === workItemId) {
        return {
            found: true,
            localPath: getCheckpointLocalPath(workItemId),
            checkpoint: _checkpoint,
            message: `Checkpoint loaded from memory for WI #${workItemId} (phase: ${_checkpoint.activePhase || 'none'}, step: ${_checkpoint.activeStep || 'none'})`,
        };
    }

    // Switching WI: flush current first
    if (_checkpoint && _checkpointWorkItemId !== workItemId) {
        flushCheckpointToLocal();
        if (_checkpointDirty) {
            pushCheckpointToADO();
        }
    }

    // Try loading from ADO
    const wi = fetchWorkItem(workItemId);
    const existing = findCheckpointAttachment(wi);

    if (!existing) {
        // No remote checkpoint — initialize empty in-memory
        _checkpoint = null;
        _checkpointWorkItemId = workItemId;
        _checkpointDirty = false;
        return { found: false, message: `No checkpoint found for WI #${workItemId}` };
    }

    const token = getAzureDevOpsToken();
    const tmpPath = getCheckpointLocalPath(workItemId);

    execFileSync('curl', ['-s', '-L', existing.url, '-H', `Authorization: Bearer ${token}`, '-o', tmpPath], {
        encoding: 'utf8',
        timeout: 30000,
    });

    const data = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));

    // Store in memory
    _checkpoint = data;
    _checkpointWorkItemId = workItemId;
    _checkpointDirty = false;

    return {
        found: true,
        localPath: tmpPath,
        checkpoint: data,
        message: `Checkpoint loaded for WI #${workItemId} (phase: ${data.activePhase || 'none'}, step: ${data.activeStep || 'none'})`,
    };
}

function uploadCheckpoint(workItemId, checkpointData) {
    if (_checkpointWorkItemId !== null && _checkpointWorkItemId !== workItemId) {
        throw new Error(`Checkpoint WI mismatch: expected ${_checkpointWorkItemId}, got ${workItemId}. Call downloadCheckpoint first.`);
    }

    // Save previous state for rollback if validation rejects
    const _previousCheckpoint = _checkpoint ? JSON.parse(JSON.stringify(_checkpoint)) : null;

    // Deep merge incoming data into existing checkpoint (if any),
    // so partial updates don't erase previously stored fields.
    if (_checkpoint && _checkpointWorkItemId === workItemId) {
        _checkpoint = deepMerge(_checkpoint, checkpointData);
    } else {
        _checkpoint = checkpointData;
    }

    // Validate and auto-fill fields (timestamps, schema compliance)
    const { warnings, errors } = validateAndAutoFillCheckpoint(_checkpoint);

    // If there are hard errors, REJECT the write — revert to previous checkpoint state
    if (errors.length > 0) {
        // Revert the merge — restore previous checkpoint
        if (_previousCheckpoint) {
            _checkpoint = _previousCheckpoint;
        }

        return {
            success: false,
            localPath: getCheckpointLocalPath(workItemId),
            errors,
            warnings,
            message: `CHECKPOINT REJECTED for WI #${workItemId}. Fix the errors below and retry.\n\nERRORS (${errors.length}):\n` +
                errors.map(e => `  ❌ ${e}`).join('\n') +
                (warnings.length > 0 ? `\n\nWARNINGS (${warnings.length}):\n` + warnings.map(w => `  ⚠ ${w}`).join('\n') : ''),
        };
    }

    _checkpointWorkItemId = workItemId;
    _checkpointDirty = true;
    flushCheckpointToLocal();

    let message = `Checkpoint saved locally for WI #${workItemId}. Background sync will upload to ADO.`;
    if (warnings.length > 0) {
        message += `\n\nWARNINGS (${warnings.length}):\n` + warnings.map(w => `  ⚠ ${w}`).join('\n');
    }

    return {
        success: true,
        localPath: getCheckpointLocalPath(workItemId),
        warnings,
        message,
    };
}

// --- MCP Protocol Handler ---

const TOOLS = [
    {
        name: 'downloadCheckpoint',
        description: 'Download an existing agent checkpoint from an Azure DevOps work item. Call this during rehydration to check if a previous session left a checkpoint. Returns the full checkpoint JSON if found.',
        inputSchema: { type: 'object', properties: { workItemId: { type: 'number', description: 'Azure DevOps work item ID' } }, required: ['workItemId'] },
    },
    {
        name: 'uploadCheckpoint',
        description: 'Save checkpoint data to an Azure DevOps work item. Deep-merges the provided fields into the existing checkpoint — you only need to pass the fields you want to update, not the entire checkpoint. Previously stored fields are preserved unless explicitly overwritten. IMPORTANT: deep merge REPLACES arrays (does not append). For array fields like reasoningTrace, stepsCompleted, questionsAsked — always send the FULL cumulative array, not just new entries. The server validates against checkpoint-schema.json and REJECTS writes (success=false) if: (1) activePhase points to a phase that is not IN_PROGRESS, or (2) any phase before activePhase is still NOT_STARTED (must be COMPLETED/APPROVED/SKIPPED first). When rejected, the checkpoint is NOT saved — fix the errors and retry. The server also automatically: sets lastUpdated, auto-fills startedAt/completedAt on status transitions, strips unknown properties.',
        inputSchema: {
            type: 'object',
            properties: {
                workItemId: { type: 'number', description: 'Azure DevOps work item ID' },
                checkpoint: { type: 'object', description: 'Checkpoint fields to merge. Only pass the fields you want to add or update — existing fields are preserved. Do NOT pass lastUpdated (auto-set). Warnings are returned if validation issues are detected — fix them before proceeding.' },
            },
            required: ['workItemId', 'checkpoint'],
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
                    serverInfo: { name: 'checkpoint-server', version: '1.0.0' },
                },
            };

        case 'notifications/initialized':
            return null;

        case 'tools/list':
            return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

        case 'tools/call': {
            const { name, arguments: args } = params;
            try {
                let result;
                if (name === 'downloadCheckpoint') {
                    result = downloadCheckpoint(args.workItemId);
                } else if (name === 'uploadCheckpoint') {
                    result = uploadCheckpoint(args.workItemId, args.checkpoint);
                } else {
                    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
                }
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
            } catch (e) {
                return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true } };
            }
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
            if (response) {
                process.stdout.write(JSON.stringify(response) + '\n');
            }
        } catch (e) {
            process.stderr.write(`Parse error: ${e.message}\n`);
        }
    }
});

process.stdin.on('end', () => {
    // Flush checkpoint to local file before exit (sessionEnd hook will upload to ADO)
    flushCheckpointToLocal();
    process.exit(0);
});

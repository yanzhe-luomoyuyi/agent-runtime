#!/usr/bin/env node
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
// </copyright>
//-----------------------------------------------------------------------

/**
 * Flush local checkpoint files to Azure DevOps on session end.
 * Called by the fabric-shell plugin's sessionEnd hook.
 *
 * Finds any /tmp/agent-checkpoint-wi-*.json files, uploads each to the
 * corresponding Azure DevOps work item as an attachment, and cleans up.
 *
 * Timeout: 5 seconds (enforced by hooks.json).
 * Cross-platform: Linux, macOS, Windows (uses Node.js only).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ADO_ORG = 'https://dev.azure.com/powerbi';
const ADO_PROJECT = 'Trident';
const API_VERSION = '7.1';

function getToken() {
    try {
        const output = execSync(
            'az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 2>&1',
            { encoding: 'utf8', timeout: 10000 }
        );
        return JSON.parse(output).accessToken;
    } catch {
        return null;
    }
}

function findCheckpointFiles() {
    const tmpDir = require('os').tmpdir();
    try {
        return fs.readdirSync(tmpDir)
            .filter(f => f.startsWith('agent-checkpoint-wi-') && f.endsWith('.json'))
            .map(f => path.join(tmpDir, f));
    } catch {
        return [];
    }
}

function uploadCheckpoint(filePath, token) {
    const basename = path.basename(filePath, '.json');
    const wiIdMatch = basename.match(/agent-checkpoint-wi-(\d+)/);
    if (!wiIdMatch) return;

    const workItemId = wiIdMatch[1];
    const fileName = path.basename(filePath);

    try {
        // Upload attachment blob
        const uploadUrl = `${ADO_ORG}/${ADO_PROJECT}/_apis/wit/attachments?fileName=${fileName}&api-version=${API_VERSION}`;
        const uploadResult = execSync(
            `curl -s -X POST '${uploadUrl}' -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/octet-stream' --data-binary '@${filePath}'`,
            { encoding: 'utf8', timeout: 10000 }
        );
        const attachmentUrl = JSON.parse(uploadResult).url;
        if (!attachmentUrl) return;

        // Find and remove old checkpoint attachment
        const wiUrl = `${ADO_ORG}/${ADO_PROJECT}/_apis/wit/workitems/${workItemId}?%24expand=relations&api-version=${API_VERSION}`;
        const wiResult = execSync(
            `curl -s '${wiUrl}' -H 'Authorization: Bearer ${token}'`,
            { encoding: 'utf8', timeout: 10000 }
        );
        const wi = JSON.parse(wiResult);
        const relations = wi.relations || [];

        const patchUrl = `${ADO_ORG}/${ADO_PROJECT}/_apis/wit/workitems/${workItemId}?api-version=${API_VERSION}`;

        for (let i = 0; i < relations.length; i++) {
            const r = relations[i];
            if (r.rel === 'AttachedFile' && (r.attributes?.name || '').includes('agent-checkpoint-wi-')) {
                execSync(
                    `curl -s -X PATCH '${patchUrl}' -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json-patch+json' -d '[{"op":"remove","path":"/relations/${i}"}]'`,
                    { encoding: 'utf8', timeout: 10000 }
                );
                break;
            }
        }

        // Link new attachment
        const linkBody = JSON.stringify([{
            op: 'add',
            path: '/relations/-',
            value: { rel: 'AttachedFile', url: attachmentUrl, attributes: { comment: 'Agent checkpoint' } },
        }]);
        execSync(
            `curl -s -X PATCH '${patchUrl}' -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json-patch+json' -d '${linkBody.replace(/'/g, "'\\''")}'`,
            { encoding: 'utf8', timeout: 10000 }
        );

        // Clean up local file
        fs.unlinkSync(filePath);
    } catch {
        // Best effort — timeout enforced by hook
    }
}

// --- Main ---
const files = findCheckpointFiles();
if (files.length === 0) process.exit(0);

const token = getToken();
if (!token) process.exit(1);

for (const file of files) {
    uploadCheckpoint(file, token);
}

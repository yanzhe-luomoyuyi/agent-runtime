#!/usr/bin/env node
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
// </copyright>
//-----------------------------------------------------------------------

/**
 * MCP Server for SharePoint/OneDrive file downloads via Microsoft Graph API.
 *
 * Tools: downloadSharePointFile
 *
 * Protocol: MCP over stdio (JSON-RPC 2.0)
 * No external dependencies — uses Node.js built-in modules only.
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Microsoft Graph Helpers ---

function getGraphToken() {
    let output;
    try {
        output = execSync(
            'az account get-access-token --resource https://graph.microsoft.com 2>&1',
            { encoding: 'utf8', timeout: 30000 }
        );
    } catch (e) {
        const stderr = (e.stdout || '') + (e.stderr || '') + (e.message || '');
        // AADSTS530084 = Token Protection / Continuous Access Evaluation conditional access.
        // The user's `az` session is valid for other resources (ADO etc.), but a fresh
        // interactive sign-in is required to issue a Graph-scoped session-bound token.
        if (/AADSTS530084|conditional access token protection/i.test(stderr)) {
            const tenantMatch = stderr.match(/tenant "([0-9a-f-]+)"|--tenant "([0-9a-f-]+)"/i);
            const tenant = tenantMatch ? (tenantMatch[1] || tenantMatch[2]) : '<your-tenant-id>';
            throw new Error(
                'Microsoft Graph token blocked by conditional access (AADSTS530084 — Token Protection / CAE). ' +
                'Your `az` session is valid for other resources but Graph requires a fresh interactive sign-in. ' +
                `Run:\n\n  az login --tenant "${tenant}" --scope "https://graph.microsoft.com/.default"\n\n` +
                'After completing the browser sign-in, retry the MCP call.'
            );
        }
        // No active az session at all.
        if (/Please run.*az login|not.*logged in|No subscription found/i.test(stderr)) {
            throw new Error(
                'No active `az` session. Run `az login` to authenticate, then retry the MCP call. ' +
                `Details: ${stderr.slice(0, 300)}`
            );
        }
        // Other failure modes — surface the raw az output so the operator can act.
        throw new Error(
            `Failed to get Microsoft Graph token from \`az\`. Details: ${stderr.slice(0, 500)}`
        );
    }
    try {
        return JSON.parse(output).accessToken;
    } catch (e) {
        throw new Error(`Got non-JSON response from \`az account get-access-token\`: ${output.slice(0, 300)}`);
    }
}

/**
 * Convert a SharePoint URL to a Microsoft Graph API download URL.
 *
 * Supported formats:
 *   - Direct file: https://tenant.sharepoint.com/sites/team/Shared Documents/file.docx
 *   - Sharing link: https://tenant.sharepoint.com/:w:/s/team/Exxxx
 *   - OneDrive for Business: https://tenant-my.sharepoint.com/personal/user/Documents/file.docx
 */
function sharePointUrlToGraphUrl(sharePointUrl) {
    const encodedUrl = Buffer.from(sharePointUrl).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `https://graph.microsoft.com/v1.0/shares/u!${encodedUrl}/driveItem/content`;
}

// --- Tool Implementation ---

function downloadSharePointFile(url, outputDir, fileName) {
    const token = getGraphToken();

    const dir = outputDir || path.join('/tmp', `sharepoint-${Date.now()}`);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    let outFileName = fileName;
    if (!outFileName) {
        try {
            const parsed = new URL(url);
            const segments = parsed.pathname.split('/').filter(Boolean);
            outFileName = decodeURIComponent(segments[segments.length - 1]) || 'document';
        } catch {
            outFileName = 'document';
        }
    }

    const outputPath = path.join(dir, outFileName);
    const graphUrl = sharePointUrlToGraphUrl(url);

    try {
        execFileSync('curl', ['-sL', '--max-time', '60', '-o', outputPath, graphUrl, '-H', `Authorization: Bearer ${token}`], {
            encoding: 'utf8',
            timeout: 75000,
        });
    } catch (e) {
        throw new Error(`Failed to download SharePoint file: ${e.message}`);
    }

    if (!fs.existsSync(outputPath)) {
        throw new Error('Download completed but file not found on disk.');
    }

    const stats = fs.statSync(outputPath);

    if (stats.size < 2000) {
        const content = fs.readFileSync(outputPath, 'utf8');
        if (content.includes('<!DOCTYPE') || content.includes('"error"') || content.includes('<html')) {
            fs.unlinkSync(outputPath);
            throw new Error(
                `SharePoint returned an error response (${stats.size} bytes): ${content.slice(0, 300)}. ` +
                'Check that the URL is correct and you have access. Try: az login'
            );
        }
    }

    return {
        success: true,
        filePath: outputPath,
        fileName: outFileName,
        sizeBytes: stats.size,
        message: `Downloaded ${outFileName} (${stats.size} bytes) from SharePoint. Use readDocx to extract text content.`,
    };
}

// --- MCP Protocol Handler ---

const TOOLS = [
    {
        name: 'downloadSharePointFile',
        description: 'Download a file from SharePoint or OneDrive for Business using Microsoft Graph API. Authenticates via Azure CLI (az login). Supports direct SharePoint URLs, sharing links, and OneDrive for Business paths. Use this to download .docx PM specs or dev design documents linked in work items. After downloading, use readDocx to extract text content.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'SharePoint or OneDrive for Business URL to download' },
                outputDir: { type: 'string', description: 'Directory to save the downloaded file. Defaults to /tmp/sharepoint-<timestamp>/' },
                fileName: { type: 'string', description: 'Custom file name for the downloaded file. Defaults to the file name from the URL.' },
            },
            required: ['url'],
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
                    serverInfo: { name: 'sharepoint-server', version: '1.0.0' },
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
                if (name === 'downloadSharePointFile') {
                    result = downloadSharePointFile(args.url, args.outputDir, args.fileName);
                } else {
                    return {
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32601, message: `Unknown tool: ${name}` },
                    };
                }
                return {
                    jsonrpc: '2.0',
                    id,
                    result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
                };
            } catch (e) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                        isError: true,
                    },
                };
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

process.stdin.on('end', () => process.exit(0));

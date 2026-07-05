#!/usr/bin/env node
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
// </copyright>
//-----------------------------------------------------------------------

/**
 * MCP Server for Azure DevOps code search and file reading.
 *
 * Tools: searchCode, getCodeFile
 *
 * Protocol: MCP over stdio (JSON-RPC 2.0)
 * No external dependencies — uses Node.js built-in modules only.
 */

const { execSync, execFileSync } = require('child_process');

// --- Azure DevOps Configuration ---
const AZURE_DEVOPS_ORG = 'https://dev.azure.com/powerbi';
const AZURE_DEVOPS_SEARCH_ORG = 'https://almsearch.dev.azure.com/powerbi';
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

    if (body) {
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

// --- Tool Implementations ---

function searchCode(query, project, repo, top) {
    const maxResults = top || 10;
    const body = { searchText: query, '$top': maxResults, filters: { Project: [project] } };
    if (repo) {
        body.filters.Repository = [repo];
    }

    const url = `${AZURE_DEVOPS_SEARCH_ORG}/${encodeURIComponent(project)}/_apis/search/codesearchresults?api-version=7.1-preview.1`;
    const data = sendRequest('POST', url, body);

    const results = (data.results || []).map(r => ({
        repo: r.repository?.name || '',
        path: r.path || '',
        fileName: r.fileName || '',
        matches: (r.matches || {}).content || [],
    }));

    return {
        query,
        project,
        repo: repo || '(all)',
        totalCount: data.count || 0,
        results,
        message: results.length > 0
            ? `Found ${data.count} results for "${query}" in ${project}/${repo || 'all repos'}. Use getCodeFile to read full file content.`
            : `No code found for "${query}" in ${project}/${repo || 'all repos'}. Try different keywords.`,
    };
}

function getCodeFile(project, repo, filePath, branch) {
    const token = getAzureDevOpsToken();
    const branchParam = branch ? `&versionDescriptor.version=${encodeURIComponent(branch)}&versionDescriptor.versionType=branch` : '';
    const url = `${AZURE_DEVOPS_ORG}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/items?path=${encodeURIComponent(filePath)}${branchParam}&api-version=${AZURE_DEVOPS_API_VERSION}`;

    const result = execFileSync('curl', ['-s', url, '-H', `Authorization: Bearer ${token}`], {
        encoding: 'utf8',
        timeout: 30000,
    });

    // Check if it's a JSON error response
    if (result.startsWith('{') && result.includes('"message"')) {
        const err = JSON.parse(result);
        throw new Error(err.message || `Failed to read ${filePath} from ${project}/${repo}`);
    }

    return {
        content: result,
        project,
        repo,
        path: filePath,
        branch: branch || 'default',
        message: `Read ${filePath} from ${project}/${repo} (${result.length} chars).`,
    };
}

// --- MCP Protocol Handler ---

const TOOLS = [
    {
        name: 'searchCode',
        description: 'Search for code across Azure DevOps Git repositories using Code Search API. Returns file paths and matched snippets. Use this to find API contracts, feature switch definitions, service implementations, or any code in connected repos.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Code search query — supports keywords, file names, extensions (e.g., "WorkspaceSettings ext:ts", "featureSwitchName")' },
                project: { type: 'string', description: 'Azure DevOps project name (e.g., "PowerBIClients", "Power BI", "MWC")' },
                repo: { type: 'string', description: 'Repository name to search within. Omit to search all repos in the project.' },
                top: { type: 'number', description: 'Maximum results to return. Defaults to 10.' },
            },
            required: ['query', 'project'],
        },
    },
    {
        name: 'getCodeFile',
        description: 'Read a file from any Azure DevOps Git repository. Use this to read API contracts, feature switch configs, copilot-instructions.md, or any source file from connected repos.',
        inputSchema: {
            type: 'object',
            properties: {
                project: { type: 'string', description: 'Azure DevOps project name (e.g., "PowerBIClients", "Power BI", "MWC")' },
                repo: { type: 'string', description: 'Repository name (e.g., "PowerBIClients", "powerbi", "aspaas", "FeatureManagement")' },
                path: { type: 'string', description: 'File path within the repo (e.g., ".github/copilot-instructions.md", "src/services/WorkspaceApi.cs")' },
                branch: { type: 'string', description: 'Branch name. Defaults to the repo default branch.' },
            },
            required: ['project', 'repo', 'path'],
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
                    serverInfo: { name: 'code-server', version: '1.0.0' },
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
                if (name === 'searchCode') {
                    result = searchCode(args.query, args.project, args.repo, args.top);
                } else if (name === 'getCodeFile') {
                    result = getCodeFile(args.project, args.repo, args.path, args.branch);
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

process.stdin.on('end', () => process.exit(0));

#!/usr/bin/env node
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
// </copyright>
//-----------------------------------------------------------------------

/**
 * MCP Server for searching Microsoft Fabric public documentation on learn.microsoft.com.
 *
 * Tools: searchFabricDocs
 *
 * Protocol: MCP over stdio (JSON-RPC 2.0)
 * No external dependencies — uses Node.js built-in modules only.
 * No authentication required — Microsoft Learn search API is public.
 */

const { execSync, execFileSync } = require('child_process');

// --- Tool Implementation ---

function searchFabricDocs(query, top) {
    const maxResults = top || 5;
    const encodedQuery = encodeURIComponent(query);
    const url = `https://learn.microsoft.com/api/search?search=${encodedQuery}&locale=en-us&scope=Fabric&%24top=${maxResults}`;

    let response;
    try {
        response = execFileSync('curl', ['-s', '--max-time', '15', url], {
            encoding: 'utf8',
            timeout: 20000,
        });
    } catch (e) {
        throw new Error(`Failed to search Microsoft Learn: ${e.message}`);
    }

    const data = JSON.parse(response);
    const results = (data.results || []).map(r => ({
        title: r.title || '',
        url: r.url || '',
        description: (r.description || '').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').slice(0, 300),
        category: r.category || '',
        lastUpdated: r.lastUpdatedDate || '',
    }));

    return {
        query,
        totalResults: results.length,
        results,
        message: results.length > 0
            ? `Found ${results.length} Fabric docs for "${query}". Use fetch_webpage to read the full content of any result URL.`
            : `No Fabric docs found for "${query}". Try different keywords.`,
    };
}

// --- MCP Protocol Handler ---

const TOOLS = [
    {
        name: 'searchFabricDocs',
        description: 'Search Microsoft Fabric public documentation on learn.microsoft.com. Returns titles, URLs, and snippets. No authentication required. Use this to understand expected product behavior, feature architecture, API contracts, or to verify that implementation matches documented behavior. After finding a relevant doc, use fetch_webpage to read the full page content.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query — use natural language or feature names (e.g., "Dataflow Gen2 error handling", "workspace settings API", "lakehouse shortcuts")' },
                top: { type: 'number', description: 'Maximum number of results to return. Defaults to 5.' },
            },
            required: ['query'],
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
                    serverInfo: { name: 'fabric-docs-server', version: '1.0.0' },
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
                if (name === 'searchFabricDocs') {
                    result = searchFabricDocs(args.query, args.top);
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

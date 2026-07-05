#!/usr/bin/env node
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
// </copyright>
//-----------------------------------------------------------------------

/**
 * MCP Server for reading .docx file content.
 *
 * Tools: readDocx
 *
 * Protocol: MCP over stdio (JSON-RPC 2.0)
 * No external dependencies — uses Node.js built-in modules + unzip CLI.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Tool Implementation ---

function readDocx(filePath, outputPath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const inputPath = filePath.replace(/'/g, "'\\''");

    // Extract word/document.xml from the .docx ZIP
    let documentXml;
    try {
        documentXml = execSync(
            `unzip -p '${inputPath}' word/document.xml`,
            { encoding: 'utf8', timeout: 15000 }
        );
    } catch (e) {
        throw new Error(
            `Failed to extract content from ${path.basename(filePath)}. ` +
            `Is this a valid .docx file? Details: ${e.message}`
        );
    }

    // Parse XML to extract text content
    const content = parseDocumentXml(documentXml);
    const paragraphs = content.split('\n').filter(line => line.trim().length > 0);
    const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;

    // outputPath: when provided, write the extracted text to disk and return
    // only metadata. Lets the orchestrator parse large docs without the content
    // landing in its context window — sub-agents can read the .txt later.
    if (outputPath) {
        const dir = path.dirname(outputPath);
        if (dir && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(outputPath, content, 'utf8');
        return {
            outputPath,
            wordCount,
            paragraphs: paragraphs.length,
            message: `Extracted ${wordCount} words in ${paragraphs.length} paragraphs from ${path.basename(filePath)} → ${outputPath}.`,
        };
    }

    return {
        content,
        wordCount,
        paragraphs: paragraphs.length,
        message: `Extracted ${wordCount} words in ${paragraphs.length} paragraphs from ${path.basename(filePath)}.`,
    };
}

/**
 * Parse Word document.xml and extract readable text.
 *
 * Handles:
 *   - <w:p> → paragraphs (newlines)
 *   - <w:t> → text runs
 *   - <w:tab/> → tab characters
 *   - <w:br/> → line breaks
 *   - <w:pStyle w:val="Heading1"/> etc. → markdown headings
 *   - <w:numPr> → list items (bullet prefix)
 *   - <w:tbl>/<w:tr>/<w:tc> → table rows with | separators
 */
function parseDocumentXml(xml) {
    const lines = [];

    const bodyMatch = xml.match(/<w:body[^>]*>([\s\S]*)<\/w:body>/);
    if (!bodyMatch) {
        return extractAllText(xml);
    }

    const body = bodyMatch[1];

    let pos = 0;
    const tblRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g;
    let tblMatch;

    while ((tblMatch = tblRegex.exec(body)) !== null) {
        const beforeTable = body.slice(pos, tblMatch.index);
        extractParagraphs(beforeTable, lines);
        extractTable(tblMatch[0], lines);
        pos = tblMatch.index + tblMatch[0].length;
    }

    const remaining = body.slice(pos);
    extractParagraphs(remaining, lines);

    return lines.join('\n');
}

function extractParagraphs(xml, lines) {
    const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
    let match;

    while ((match = pRegex.exec(xml)) !== null) {
        const pContent = match[1];

        const styleMatch = pContent.match(/<w:pStyle\s+w:val="([^"]+)"/);
        const style = styleMatch ? styleMatch[1] : '';

        const hasList = /<w:numPr>/.test(pContent);

        let text = extractRunText(pContent);
        if (!text.trim()) continue;

        if (style.match(/^Heading(\d)$/i)) {
            const level = parseInt(style.match(/\d/)[0], 10);
            text = '#'.repeat(Math.min(level, 6)) + ' ' + text;
        } else if (style === 'Title') {
            text = '# ' + text;
        } else if (style === 'Subtitle') {
            text = '## ' + text;
        } else if (hasList) {
            text = '- ' + text;
        }

        lines.push(text);
    }
}

function extractTable(tableXml, lines) {
    const rows = [];
    const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
    let trMatch;

    while ((trMatch = trRegex.exec(tableXml)) !== null) {
        const cells = [];
        const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
        let tcMatch;

        while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
            const cellText = extractRunText(tcMatch[1]).trim();
            cells.push(cellText);
        }

        rows.push(cells);
    }

    if (rows.length === 0) return;

    for (let i = 0; i < rows.length; i++) {
        lines.push('| ' + rows[i].join(' | ') + ' |');
        if (i === 0) {
            lines.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
        }
    }
}

function extractRunText(xml) {
    let processed = xml.replace(/<w:tab\/?\s*>/g, '\t');
    processed = processed.replace(/<w:br\/?\s*>/g, '\n');

    let ordered = processed.replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g, '$1');
    ordered = ordered.replace(/<[^>]+>/g, '');
    ordered = decodeXmlEntities(ordered);

    return ordered.trim();
}

function extractAllText(xml) {
    const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    const parts = [];
    let match;
    while ((match = tRegex.exec(xml)) !== null) {
        parts.push(match[1]);
    }
    return decodeXmlEntities(parts.join(''));
}

function decodeXmlEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// --- MCP Protocol Handler ---

const TOOLS = [
    {
        name: 'readDocx',
        description: 'Extract text content from a .docx file. Preserves document structure: headings become markdown headings, lists become bullet points, tables become markdown tables. Use after downloading via downloadSharePointFile or downloadWorkItemAttachments. **Pass `outputPath` to write the extracted text to disk and return only metadata (no content in the response)** — useful for orchestrators that don\'t want large document bodies landing in their context window.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Absolute path to the .docx file to read.' },
                outputPath: { type: 'string', description: 'Optional. Absolute path where the extracted text should be written. When provided, the response excludes the `content` field and only returns `{ outputPath, wordCount, paragraphs, message }`.' },
            },
            required: ['filePath'],
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
                    serverInfo: { name: 'docx-server', version: '1.0.0' },
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
                if (name === 'readDocx') {
                    result = readDocx(args.filePath, args.outputPath);
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

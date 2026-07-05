#!/usr/bin/env node
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
// </copyright>
//-----------------------------------------------------------------------

/**
 * MCP Server for audio transcription via OpenAI Whisper.
 *
 * Tools: transcribeAudio
 *
 * Protocol: MCP over stdio (JSON-RPC 2.0)
 * No external dependencies — uses Node.js built-in modules only.
 * Auto-installs ffmpeg and OpenAI Whisper cross-platform if not present.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- ffmpeg Helpers (required by Whisper) ---

let _ffmpegVerified = false;

function ensureFfmpeg() {
    if (_ffmpegVerified) return;

    const checkCmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    try {
        execSync(checkCmd, { stdio: 'pipe', timeout: 5000 });
        _ffmpegVerified = true;
        return;
    } catch {
        // not installed — attempt auto-install
    }

    const platform = process.platform;
    const installSteps = [];

    if (platform === 'linux') {
        installSteps.push(
            { cmd: 'sudo apt-get update && sudo apt-get install -y ffmpeg', label: 'sudo apt-get' },
            { cmd: 'apt-get update && apt-get install -y ffmpeg', label: 'apt-get (no sudo)' },
        );
    } else if (platform === 'darwin') {
        installSteps.push(
            { cmd: 'brew install ffmpeg', label: 'Homebrew' },
        );
    } else if (platform === 'win32') {
        installSteps.push(
            { cmd: 'winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements', label: 'winget' },
            { cmd: 'choco install ffmpeg -y', label: 'Chocolatey' },
        );
    } else {
        throw new Error(`Unsupported platform "${platform}". Install ffmpeg manually and ensure it is on PATH.`);
    }

    let lastError;
    for (const step of installSteps) {
        try {
            execSync(step.cmd, { stdio: 'pipe', timeout: 120000 });
            execSync(checkCmd, { stdio: 'pipe', timeout: 5000 });
            _ffmpegVerified = true;
            return;
        } catch (e) {
            lastError = e;
        }
    }

    const manualInstructions = {
        linux: 'Run: sudo apt-get install -y ffmpeg',
        darwin: 'Run: brew install ffmpeg',
        win32: 'Run: winget install -e --id Gyan.FFmpeg',
    };

    throw new Error(
        `Failed to auto-install ffmpeg on ${platform}. ` +
        `Last error: ${lastError?.message || 'unknown'}. ` +
        `Manual install: ${manualInstructions[platform] || 'Install ffmpeg and add to PATH.'}`
    );
}

// --- Whisper Helpers ---

let _whisperVerified = false;

function ensureWhisper() {
    if (_whisperVerified) return;

    const checkCmd = process.platform === 'win32' ? 'where whisper' : 'which whisper';
    try {
        execSync(checkCmd, { stdio: 'pipe', timeout: 5000 });
        _whisperVerified = true;
        return;
    } catch {
        // not installed — attempt auto-install
    }

    const platform = process.platform;

    // Ensure pip is available first
    const pipCmd = platform === 'win32' ? 'pip' : 'pip3';
    try {
        execSync(`${pipCmd} --version`, { stdio: 'pipe', timeout: 5000 });
    } catch {
        // pip not found — try to install Python/pip
        const pipInstallSteps = [];
        if (platform === 'linux') {
            pipInstallSteps.push(
                { cmd: 'sudo apt-get update && sudo apt-get install -y python3-pip', label: 'sudo apt-get' },
                { cmd: 'apt-get update && apt-get install -y python3-pip', label: 'apt-get (no sudo)' },
            );
        } else if (platform === 'darwin') {
            pipInstallSteps.push(
                { cmd: 'brew install python3', label: 'Homebrew' },
            );
        } else if (platform === 'win32') {
            pipInstallSteps.push(
                { cmd: 'winget install -e --id Python.Python.3 --accept-source-agreements --accept-package-agreements', label: 'winget' },
            );
        }

        let pipInstalled = false;
        for (const step of pipInstallSteps) {
            try {
                execSync(step.cmd, { stdio: 'pipe', timeout: 120000 });
                execSync(`${pipCmd} --version`, { stdio: 'pipe', timeout: 5000 });
                pipInstalled = true;
                break;
            } catch {
                // try next
            }
        }

        if (!pipInstalled) {
            throw new Error(
                `Python/pip not found and could not be installed on ${platform}. ` +
                `Install Python 3 manually, then run: ${pipCmd} install openai-whisper`
            );
        }
    }

    // Install whisper via pip
    const installSteps = [
        { cmd: `${pipCmd} install openai-whisper`, label: 'pip install' },
        { cmd: `${pipCmd} install --break-system-packages openai-whisper`, label: 'pip install --break-system-packages' },
        { cmd: `${pipCmd} install --user openai-whisper`, label: 'pip install --user' },
    ];

    let lastError;
    for (const step of installSteps) {
        try {
            execSync(step.cmd, { stdio: 'pipe', timeout: 300000 });
            execSync(checkCmd, { stdio: 'pipe', timeout: 5000 });
            _whisperVerified = true;
            return;
        } catch (e) {
            lastError = e;
        }
    }

    throw new Error(
        `Failed to install OpenAI Whisper on ${platform}. ` +
        `Last error: ${lastError?.message || 'unknown'}. ` +
        `Manual install: ${pipCmd} install openai-whisper`
    );
}

// --- Tool Implementation ---

function transcribeAudio(filePath, model, language) {
    ensureWhisper();
    ensureFfmpeg();

    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const whisperModel = model || 'tiny';
    const outputDir = path.join('/tmp', `transcribe-${Date.now()}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const inputPath = filePath.replace(/'/g, "'\\''");
    let cmd = `whisper '${inputPath}' --model ${whisperModel} --output_format json --output_dir '${outputDir}'`;
    if (language) {
        cmd += ` --language ${language}`;
    }

    execSync(cmd, { encoding: 'utf8', timeout: 300000 });

    // Find the output JSON file (whisper names it after the input file)
    const baseName = path.basename(filePath, path.extname(filePath));
    const jsonPath = path.join(outputDir, `${baseName}.json`);

    if (!fs.existsSync(jsonPath)) {
        throw new Error(`Whisper output not found at ${jsonPath}`);
    }

    const whisperOutput = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const fullText = whisperOutput.text || '';
    const segments = (whisperOutput.segments || []).map(s => ({
        start: Math.round(s.start * 100) / 100,
        end: Math.round(s.end * 100) / 100,
        text: s.text?.trim() || '',
    }));

    return {
        transcript: fullText.trim(),
        segments,
        language: whisperOutput.language || language || 'auto',
        model: whisperModel,
        message: `Transcribed ${segments.length} segments using Whisper ${whisperModel} model.`,
    };
}

// --- MCP Protocol Handler ---

const TOOLS = [
    {
        name: 'transcribeAudio',
        description: 'Transcribe an audio file to text using OpenAI Whisper (local, offline). Auto-installs Python + Whisper if not present (cross-platform). Returns the full transcript and timestamped segments [{ start, end, text }]. The tiny model (~39MB) is used by default for speed. Use this after extractAudio to get a transcript of video narration or spoken repro steps.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Absolute path to the audio file to transcribe (.wav, .mp3, etc.)' },
                model: { type: 'string', description: 'Whisper model to use: "tiny" (39MB, fast), "base" (140MB), "small" (466MB), "medium" (1.5GB), "large" (2.9GB). Defaults to "tiny".' },
                language: { type: 'string', description: 'Language code (e.g., "en", "zh"). Omit for auto-detection.' },
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
                    serverInfo: { name: 'openai-whisper-server', version: '1.0.0' },
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
                if (name === 'transcribeAudio') {
                    result = transcribeAudio(args.filePath, args.model, args.language);
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

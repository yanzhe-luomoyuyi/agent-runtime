#!/usr/bin/env node
//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
// </copyright>
//-----------------------------------------------------------------------

/**
 * MCP Server for media frame and audio extraction via ffmpeg.
 *
 * Tools: extractVideoFrames, extractGifFrames, extractAudio
 *
 * Protocol: MCP over stdio (JSON-RPC 2.0)
 * No external dependencies — uses Node.js built-in modules only.
 * Auto-installs ffmpeg cross-platform (Linux, macOS, Windows) if not present.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- ffmpeg Helpers ---

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

function getMediaDuration(filePath) {
    try {
        const output = execSync(
            `ffprobe -v error -show_entries format=duration -of csv=p=0 '${filePath.replace(/'/g, "'\\''")}'`,
            { encoding: 'utf8', timeout: 15000 }
        ).trim();
        const duration = parseFloat(output);
        return isNaN(duration) ? 0 : duration;
    } catch {
        return 0;
    }
}

function extractFrames(filePath, outputDir, fps, maxFrames) {
    ensureFfmpeg();

    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const dir = outputDir || path.join('/tmp', `frames-${Date.now()}`);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const requestedFps = fps || 1;
    const frameLimit = maxFrames || 100;

    // Get duration to auto-adjust FPS if needed
    const durationSec = getMediaDuration(filePath);
    let effectiveFps = requestedFps;

    if (durationSec > 0 && durationSec * requestedFps > frameLimit) {
        effectiveFps = Math.max(frameLimit / durationSec, 0.1);
    }

    const outputPattern = path.join(dir, 'frame_%04d.png');
    const inputPath = filePath.replace(/'/g, "'\\''");

    execSync(
        `ffmpeg -i '${inputPath}' -vf fps=${effectiveFps} -y '${outputPattern}' 2>&1`,
        { encoding: 'utf8', timeout: 120000 }
    );

    // Collect extracted frames
    let frameFiles = fs.readdirSync(dir)
        .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
        .sort();

    // Fallback: if no frames extracted (very short media), grab a single frame
    if (frameFiles.length === 0) {
        const singleFrame = path.join(dir, 'frame_0001.png');
        try {
            execSync(
                `ffmpeg -i '${inputPath}' -frames:v 1 -y '${singleFrame}' 2>&1`,
                { encoding: 'utf8', timeout: 30000 }
            );
            frameFiles = fs.readdirSync(dir)
                .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
                .sort();
        } catch {
            // genuinely empty — leave frameFiles as []
        }
    }

    const frames = frameFiles.map((f, i) => ({
        path: path.join(dir, f),
        index: i + 1,
        timestampSec: effectiveFps > 0 ? Math.round((i / effectiveFps) * 100) / 100 : 0,
    }));

    return {
        frames,
        totalFrames: frames.length,
        durationSec: Math.round(durationSec * 100) / 100,
        effectiveFps: Math.round(effectiveFps * 1000) / 1000,
        outputDir: dir,
    };
}

// --- Tool Implementations ---

function extractVideoFrames(filePath, outputDir, fps, maxFrames) {
    const result = extractFrames(filePath, outputDir, fps, maxFrames);
    return {
        ...result,
        message: `Extracted ${result.totalFrames} frames from video (${result.durationSec}s at ${result.effectiveFps} fps). Analyze each frame image to understand the video content.`,
    };
}

function extractGifFrames(filePath, outputDir, fps, maxFrames) {
    const result = extractFrames(filePath, outputDir, fps, maxFrames);
    const isStatic = result.totalFrames <= 1;
    return {
        ...result,
        isStatic,
        message: isStatic
            ? 'GIF is static (1 frame). Analyze the single frame image.'
            : `Extracted ${result.totalFrames} frames from animated GIF (${result.durationSec}s at ${result.effectiveFps} fps). Analyze each frame image to understand the GIF content.`,
    };
}

function extractAudio(filePath, outputDir, format) {
    ensureFfmpeg();

    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    // Check if the file has an audio track
    const inputPath = filePath.replace(/'/g, "'\\''");
    try {
        const probeOutput = execSync(
            `ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 '${inputPath}'`,
            { encoding: 'utf8', timeout: 15000 }
        ).trim();
        if (!probeOutput.includes('audio')) {
            return { hasAudio: false, message: 'No audio track found in this file.' };
        }
    } catch {
        return { hasAudio: false, message: 'Could not detect audio track (ffprobe failed).' };
    }

    const fmt = format || 'wav';
    const dir = outputDir || path.join('/tmp', `audio-${Date.now()}`);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const baseName = path.basename(filePath, path.extname(filePath));
    const audioPath = path.join(dir, `${baseName}.${fmt}`);

    execSync(
        `ffmpeg -i '${inputPath}' -acodec pcm_s16le -ar 16000 -ac 1 -y '${audioPath}' 2>&1`,
        { encoding: 'utf8', timeout: 120000 }
    );

    const durationSec = getMediaDuration(audioPath);

    return {
        hasAudio: true,
        audioPath,
        format: fmt,
        durationSec: Math.round(durationSec * 100) / 100,
        message: `Audio extracted (${Math.round(durationSec)}s, ${fmt}, 16kHz mono). Use transcribeAudio to get a transcript.`,
    };
}

// --- MCP Protocol Handler ---

const TOOLS = [
    {
        name: 'extractVideoFrames',
        description: 'Extract frames from a video file (.mp4, .webm, .mov) at a specified frame rate. Installs ffmpeg automatically if not present (cross-platform: Linux, macOS, Windows). Returns paths to extracted PNG frame images that can then be analyzed with vision. Use this after downloading video attachments from work items.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Absolute path to the video file to extract frames from' },
                outputDir: { type: 'string', description: 'Directory to save extracted frame images. Defaults to /tmp/frames-<timestamp>/' },
                fps: { type: 'number', description: 'Frames per second to extract. Defaults to 1 (one frame per second of video).' },
                maxFrames: { type: 'number', description: 'Maximum number of frames to extract. If the video is long, FPS is automatically reduced to stay within this limit. Defaults to 100.' },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'extractGifFrames',
        description: 'Extract frames from a GIF file at a specified frame rate. Installs ffmpeg automatically if not present (cross-platform: Linux, macOS, Windows). Returns paths to extracted PNG frame images that can then be analyzed with vision. Detects static (single-frame) GIFs automatically. Use this after downloading GIF attachments from work items.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Absolute path to the GIF file to extract frames from' },
                outputDir: { type: 'string', description: 'Directory to save extracted frame images. Defaults to /tmp/frames-<timestamp>/' },
                fps: { type: 'number', description: 'Frames per second to extract. Defaults to 1 (one frame per second of animation).' },
                maxFrames: { type: 'number', description: 'Maximum number of frames to extract. If the GIF is long, FPS is automatically reduced to stay within this limit. Defaults to 100.' },
            },
            required: ['filePath'],
        },
    },
    {
        name: 'extractAudio',
        description: 'Extract the audio track from a video file as a WAV file (16kHz mono, optimal for speech recognition). Uses ffmpeg (auto-installed). Returns the path to the extracted audio file. Detects videos with no audio track and returns { hasAudio: false } early. Use this before calling transcribeAudio.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'Absolute path to the video file to extract audio from' },
                outputDir: { type: 'string', description: 'Directory to save the extracted audio file. Defaults to /tmp/audio-<timestamp>/' },
                format: { type: 'string', description: 'Audio output format. Defaults to "wav". Other options: "mp3".' },
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
                    serverInfo: { name: 'ffmpeg-server', version: '1.0.0' },
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
                if (name === 'extractVideoFrames') {
                    result = extractVideoFrames(args.filePath, args.outputDir, args.fps, args.maxFrames);
                } else if (name === 'extractGifFrames') {
                    result = extractGifFrames(args.filePath, args.outputDir, args.fps, args.maxFrames);
                } else if (name === 'extractAudio') {
                    result = extractAudio(args.filePath, args.outputDir, args.format);
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

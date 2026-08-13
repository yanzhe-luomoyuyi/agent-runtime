/**
 * Shared fixtures for harness L2 eval scenarios (tokenizers, tools, ablation
 * transcripts). Kept deterministic — no network, no durable runtime.
 */

import type { ChatModel, Message } from '@agent/contracts';

import {
  ContextManager,
  createModelSummarizer,
  type ImportanceClass,
} from '../context/manager.js';
import { RuleChatModel, finalResponse, makeTool, type MockToolDef } from '../testkit/index.js';

/** Char-length tokenizer — same sizing contract as context-ablation tests. */
export const charTokenizer = {
  count: (t: string) => t.length,
  countMessage: (m: Message) => {
    const parts: string[] = [m.role, m.content ?? ''];
    if (m.toolCalls && m.toolCalls.length > 0) parts.push(JSON.stringify(m.toolCalls));
    if (m.name) parts.push(m.name);
    return parts.join(' ').length;
  },
  countMessages: (ms: Message[]) => ms.reduce((s, m) => s + charTokenizer.countMessage(m), 0),
};

/**
 * Transcript sized so importance+pin keeps the ERROR unit while pure recency
 * folds it (same fixture as `test/context-ablation.test.ts`).
 */
export function assembleAblationMessages(): Message[] {
  return [
    { role: 'system', content: 'S' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'e', name: 'deploy', arguments: {} }],
    },
    {
      role: 'tool',
      name: 'deploy',
      toolCallId: 'e',
      content: 'ERROR: x',
      untrusted: true,
    },
    {
      role: 'assistant',
      toolCalls: [{ id: 'r', name: 'read', arguments: {} }],
    },
    {
      role: 'tool',
      name: 'read',
      toolCallId: 'r',
      content: 'okxxxx',
      untrusted: true,
    },
    { role: 'user', content: 'now' },
  ];
}

export function makeAssembleContext(importanceScoring: boolean): ContextManager {
  return new ContextManager({
    maxPromptTokens: 100,
    keepRecentMessages: 1,
    outputReserveTokens: 0,
    goalProtected: false,
    importanceScoring,
    tokenizer: charTokenizer,
  });
}

/**
 * Compact protect fixture (mirrors `context-memory` protect unit test): ERROR
 * unit `d1` should survive default protectVerbatimClasses; mid-tier read folds.
 */
export function compactProtectMessages(): Message[] {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'Goal: ship', kind: 'goal' },
    {
      role: 'assistant',
      toolCalls: [{ id: 'd1', name: 'deploy', arguments: {} }],
    },
    {
      role: 'tool',
      name: 'deploy',
      toolCallId: 'd1',
      content: 'ERROR: x',
      untrusted: true,
    },
    {
      role: 'assistant',
      toolCalls: [{ id: 'r1', name: 'read', arguments: {} }],
    },
    {
      role: 'tool',
      name: 'read',
      toolCallId: 'r1',
      content: 'file-body-'.repeat(8),
      untrusted: true,
    },
    { role: 'assistant', content: 'recent-a' },
    { role: 'user', content: 'recent-u' },
  ];
}

/** Deterministic summarizer model for compactIfNeeded (always returns `text`). */
export function summarizerChatModel(text = 'folded history'): ChatModel {
  return new RuleChatModel(() => finalResponse(text));
}

export function makeCompactContext(opts?: {
  protectVerbatimClasses?: ImportanceClass[];
  withSummarizer?: boolean;
}): ContextManager {
  const withSummarizer = opts?.withSummarizer !== false;
  return new ContextManager({
    maxPromptTokens: 400,
    outputReserveTokens: 0,
    keepRecentMessages: 2,
    compactionThreshold: 0.1,
    importanceScoring: true,
    goalProtected: true,
    tokenizer: charTokenizer,
    ...(opts?.protectVerbatimClasses ? { protectVerbatimClasses: opts.protectVerbatimClasses } : {}),
    ...(withSummarizer ? { modelSummarize: createModelSummarizer(summarizerChatModel()) } : {}),
  });
}

export const demoGetIssue: MockToolDef = makeTool(
  'getIssue',
  'Fetch issue details.',
  { type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'] },
  (a) => ({ title: (a as { issue: string }).issue }),
);

export const demoSearchCode: MockToolDef = makeTool(
  'searchCode',
  'Search the codebase.',
  { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  () => ({ files: ['src/auth/login.ts'] }),
);

export const demoReadFile: MockToolDef = makeTool(
  'read_file',
  'Read a file.',
  { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  (a) => ({ content: `body-of-${(a as { path: string }).path}-${'x'.repeat(40)}` }),
);

export const demoDeploy: MockToolDef = makeTool(
  'deploy',
  'Deploy a service.',
  { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
  (a) => ({ ok: true, target: (a as { target: string }).target }),
);

/** Oversized string result — triggers ScratchpadToolInvoker offload above threshold. */
export const demoBigRead: MockToolDef = makeTool(
  'bigRead',
  'Read a huge blob.',
  { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  () => 'X'.repeat(5000),
);

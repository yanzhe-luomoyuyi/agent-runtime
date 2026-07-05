/**
 * Demo tools — deterministic, offline stand-ins for real integrations.
 *
 * Part of the demo *workload* (see ./issue-workflow.ts), not the runtime. The
 * platform only knows the `ToolDef`/`ToolRegistry` contract (../tools/registry.ts);
 * these concrete tools plug into it. `getIssue` mimics an issue-tracker fetch and
 * `searchCode` mimics a code search — both pure functions of their args so the
 * whole demo is reproducible. Swap these for MCP-backed tools (ADO, GitHub, a
 * real code index) later.
 */

import type { ToolDef } from '../tools/registry.js';

export interface IssueRecord {
  title: string;
  body: string;
  labels: string[];
}

export const getIssue: ToolDef<{ issue: string }, IssueRecord> = {
  name: 'getIssue',
  description: 'Fetch a (mock) issue by its text or id. Deterministic — no network.',
  inputSchema: {
    type: 'object',
    properties: { issue: { type: 'string' } },
    required: ['issue'],
  },
  run: ({ issue }) => ({
    title: issue.slice(0, 60),
    body: issue,
    labels: /crash|error|fail|null/i.test(issue) ? ['bug'] : ['task'],
  }),
};

export const searchCode: ToolDef<{ query: string }, { files: string[] }> = {
  name: 'searchCode',
  description: 'Search the (mock) codebase for candidate files. Deterministic — no network.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  run: ({ query }) => {
    const files: string[] = [];
    if (/login|auth|session/i.test(query)) files.push('src/auth/login.ts', 'src/auth/session.ts');
    if (/render|ui|button|component/i.test(query)) files.push('src/ui/Button.tsx');
    if (files.length === 0) files.push('src/index.ts');
    return { files };
  },
};

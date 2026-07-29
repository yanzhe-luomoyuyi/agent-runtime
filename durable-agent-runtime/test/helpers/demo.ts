/**
 * Shared test fixtures for the issue→fix demo — canned model + local tools +
 * counting wrappers used to prove idempotent resume.
 */

import { cannedResponses, registerDemoTools } from '../../src/app/demo-fixtures.js';
import { MockModelProvider } from '../../src/model/provider.js';
import { ToolRegistry, type ToolDef } from '../../src/tools/registry.js';

export function makeModel(overrides?: Record<string, string>): MockModelProvider {
  return new MockModelProvider({ ...cannedResponses(), ...overrides });
}

export function makeTools(): ToolRegistry {
  return registerDemoTools();
}

/** Tools that count real executions — used to prove idempotent replay on resume. */
export function makeCountingTools(): {
  tools: ToolRegistry;
  calls: { getIssue: number; searchCode: number };
} {
  const calls = { getIssue: 0, searchCode: 0 };
  const getIssue: ToolDef<{ issue: string }> = {
    name: 'getIssue',
    description: 'fetch issue',
    inputSchema: { type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'] },
    run: (args) => {
      calls.getIssue++;
      return { title: args.issue.slice(0, 40), body: args.issue, labels: ['bug'] };
    },
  };
  const searchCode: ToolDef<{ query: string }> = {
    name: 'searchCode',
    description: 'search code',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: (args) => {
      calls.searchCode++;
      return {
        files: /login|auth|session/i.test(args.query)
          ? ['src/auth/login.ts', 'src/auth/session.ts']
          : /render|ui|button|component/i.test(args.query)
            ? ['src/ui/Button.tsx']
            : ['src/index.ts'],
      };
    },
  };
  return { tools: new ToolRegistry().register(getIssue).register(searchCode), calls };
}

export const LOGIN_ISSUE = 'Login page crashes with a null session';

/**
 * On-disk fixture workspaces for eval scenarios — real repos with a real
 * failing test, so scoring is "did `npm test` actually go red -> green"
 * rather than string-matching the transcript.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface BugCase {
  /** Scenario name. */
  name: string;
  /** Goal text given to the agent. */
  goal: string;
  /** Workspace-relative path of the buggy source file. */
  srcPath: string;
  /** Buggy file contents — `npm test` must fail against this. */
  buggySrc: string;
  /** Exact `str_replace` patch that fixes the bug. */
  fix: { oldString: string; newString: string };
  /** Workspace-relative path of the test file. */
  testPath: string;
  /** Test file contents (plain Node script — throws/exits non-zero on failure). */
  testSrc: string;
}

function packageJsonFor(bug: BugCase): string {
  return JSON.stringify(
    { name: 'coding-eval-fixture', private: true, scripts: { test: `node ${bug.testPath}` } },
    null,
    2,
  );
}

/** Writes package.json + the buggy source + its test into a fresh temp workspace. */
export function createFixtureWorkspace(bug: BugCase): string {
  const dir = mkdtempSync(join(tmpdir(), 'coding-eval-ws-'));
  writeFileSync(join(dir, 'package.json'), packageJsonFor(bug), 'utf8');
  mkdirSync(join(dir, dirname(bug.srcPath)), { recursive: true });
  writeFileSync(join(dir, bug.srcPath), bug.buggySrc, 'utf8');
  mkdirSync(join(dir, dirname(bug.testPath)), { recursive: true });
  writeFileSync(join(dir, bug.testPath), bug.testSrc, 'utf8');
  return dir;
}

export const GREETER_BUG: BugCase = {
  name: 'greeter null-user crash',
  goal: 'Fix the crash when greet() is called with a null user.',
  srcPath: 'src/greeter.js',
  buggySrc: 'function greet(user) {\n' + '  return `Hello, ${user.name}!`;\n' + '}\n\nmodule.exports = { greet };\n',
  fix: {
    oldString: '  return `Hello, ${user.name}!`;',
    newString: '  return `Hello, ${user?.name ?? "there"}!`;',
  },
  testPath: 'test/greeter.test.js',
  testSrc:
    "const assert = require('node:assert/strict');\n" +
    "const { greet } = require('../src/greeter.js');\n\n" +
    "assert.equal(greet({ name: 'Ada' }), 'Hello, Ada!');\n" +
    "assert.equal(greet(null), 'Hello, there!'); // greet(null) currently throws\n" +
    "console.log('OK');\n",
};

export const SUM_BUG: BugCase = {
  name: 'sum off-by-one bug',
  goal: 'sumAll() returns the wrong total for a list of numbers — find and fix the bug.',
  srcPath: 'src/sum.js',
  buggySrc:
    'function sumAll(nums) {\n' +
    '  let total = 0;\n' +
    '  for (let i = 0; i < nums.length - 1; i++) {\n' +
    '    total += nums[i];\n' +
    '  }\n' +
    '  return total;\n' +
    '}\n\nmodule.exports = { sumAll };\n',
  fix: {
    oldString: '  for (let i = 0; i < nums.length - 1; i++) {',
    newString: '  for (let i = 0; i < nums.length; i++) {',
  },
  testPath: 'test/sum.test.js',
  testSrc:
    "const assert = require('node:assert/strict');\n" +
    "const { sumAll } = require('../src/sum.js');\n\n" +
    'assert.equal(sumAll([1, 2, 3]), 6);\n' +
    "console.log('OK');\n",
};

export const bugCases: BugCase[] = [GREETER_BUG, SUM_BUG];


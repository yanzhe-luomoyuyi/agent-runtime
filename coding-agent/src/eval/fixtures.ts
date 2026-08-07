/**
 * On-disk fixture workspaces for eval scenarios — real repos with a real
 * failing test, so scoring is "did `npm test` actually go red -> green"
 * rather than string-matching the transcript.
 *
 * Difficulty tiers (interview / scorecard):
 * - easy: goal names the symptom; one file; read → edit → test
 * - medium: goal omits the path; must locate (grep) among distractors
 * - hard: multi-file fix and/or public API hides the buggy module
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type BugDifficulty = 'easy' | 'medium' | 'hard';

export interface BugFix {
  path: string;
  oldString: string;
  newString: string;
}

export interface BugCase {
  /** Scenario name (also Scenario.name). */
  name: string;
  /** Goal text given to the agent. */
  goal: string;
  difficulty: BugDifficulty;
  /** Primary buggy source (also the first edit target). */
  srcPath: string;
  /** Buggy file contents — `npm test` must fail against this. */
  buggySrc: string;
  /** Exact `str_replace` patch that fixes the primary file. */
  fix: { oldString: string; newString: string };
  /** Extra edits for multi-file hard cases (scripted good model applies these too). */
  extraFixes?: BugFix[];
  /** Extra files written into the workspace (distractors or related modules). */
  extraFiles?: Array<{ path: string; content: string }>;
  /**
   * Prelude tool calls for the scripted good model (e.g. grep to locate).
   * Live models get the same goal and must discover the path themselves.
   */
  locateTools?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Workspace-relative path of the test file. */
  testPath: string;
  /** Test file contents (plain Node script — throws/exits non-zero on failure). */
  testSrc: string;
}

/** All paths the good model must edit (primary + extraFixes). */
export function editPaths(bug: BugCase): string[] {
  return [bug.srcPath, ...(bug.extraFixes?.map((f) => f.path) ?? [])];
}

function packageJsonFor(bug: BugCase): string {
  return JSON.stringify(
    { name: 'coding-eval-fixture', private: true, scripts: { test: `node ${bug.testPath}` } },
    null,
    2,
  );
}

function writeRel(root: string, rel: string, content: string): void {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), content, 'utf8');
}

/** Writes package.json + buggy sources + test into a fresh temp workspace. */
export function createFixtureWorkspace(bug: BugCase): string {
  const dir = mkdtempSync(join(tmpdir(), 'coding-eval-ws-'));
  writeFileSync(join(dir, 'package.json'), packageJsonFor(bug), 'utf8');
  writeRel(dir, bug.srcPath, bug.buggySrc);
  // extraFixes targets must appear in extraFiles (or be the primary srcPath).
  for (const f of bug.extraFiles ?? []) writeRel(dir, f.path, f.content);
  writeRel(dir, bug.testPath, bug.testSrc);
  return dir;
}

/** Apply every fix on disk — used by fixture sanity tests (red → green without the agent). */
export function applyBugFixes(root: string, bug: BugCase): void {
  const patches: BugFix[] = [
    { path: bug.srcPath, oldString: bug.fix.oldString, newString: bug.fix.newString },
    ...(bug.extraFixes ?? []),
  ];
  for (const p of patches) {
    const full = join(root, p.path);
    const before = readFileSync(full, 'utf8');
    if (!before.includes(p.oldString)) {
      throw new Error(`fix oldString not found in ${p.path}`);
    }
    writeFileSync(full, before.replace(p.oldString, p.newString), 'utf8');
  }
}

// --- easy ------------------------------------------------------------------

export const GREETER_BUG: BugCase = {
  name: 'greeter null-user crash',
  goal: 'Fix the crash when greet() is called with a null user.',
  difficulty: 'easy',
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
  difficulty: 'easy',
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

export const CLAMP_BUG: BugCase = {
  name: 'clamp upper-bound bug',
  goal: 'clamp() returns the wrong value when n is above max — fix it.',
  difficulty: 'easy',
  srcPath: 'src/clamp.js',
  buggySrc:
    'function clamp(n, min, max) {\n' +
    '  if (n < min) return min;\n' +
    '  if (n > max) return min;\n' +
    '  return n;\n' +
    '}\n\nmodule.exports = { clamp };\n',
  fix: {
    oldString: '  if (n > max) return min;',
    newString: '  if (n > max) return max;',
  },
  testPath: 'test/clamp.test.js',
  testSrc:
    "const assert = require('node:assert/strict');\n" +
    "const { clamp } = require('../src/clamp.js');\n\n" +
    'assert.equal(clamp(5, 0, 10), 5);\n' +
    'assert.equal(clamp(-1, 0, 10), 0);\n' +
    'assert.equal(clamp(99, 0, 10), 10);\n' +
    "console.log('OK');\n",
};

// --- medium ----------------------------------------------------------------

const TEXT_DISTRACTORS: Array<{ path: string; content: string }> = [
  {
    path: 'src/text/slug.js',
    content:
      "function slugify(s) {\n  return String(s).toLowerCase().trim().replace(/\\s+/g, '-');\n}\n\nmodule.exports = { slugify };\n",
  },
  {
    path: 'src/util/strings.js',
    content:
      "function trimAll(s) {\n  return String(s).trim();\n}\n\nmodule.exports = { trimAll };\n",
  },
];

export const TITLE_CASE_BUG: BugCase = {
  name: 'titleCase join bug',
  goal:
    'Multi-word strings that should be title-cased come out wrong (words stuck together oddly). Find the bug and fix it — the goal does not name the file.',
  difficulty: 'medium',
  srcPath: 'src/text/title.js',
  buggySrc:
    'function titleCase(s) {\n' +
    "  return s.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join('-');\n" +
    '}\n\nmodule.exports = { titleCase };\n',
  fix: {
    oldString: "  return s.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join('-');",
    newString: "  return s.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');",
  },
  extraFiles: TEXT_DISTRACTORS,
  locateTools: [{ name: 'grep', arguments: { query: 'titleCase' } }],
  testPath: 'test/title.test.js',
  testSrc:
    "const assert = require('node:assert/strict');\n" +
    "const { titleCase } = require('../src/text/title.js');\n\n" +
    "assert.equal(titleCase('hello world'), 'Hello World');\n" +
    "console.log('OK');\n",
};

export const PARSE_PORT_BUG: BugCase = {
  name: 'parsePort missing default',
  goal: 'When PORT is unset, the configured port is wrong (NaN / invalid). Locate and fix the parser.',
  difficulty: 'medium',
  srcPath: 'src/config/env.js',
  buggySrc:
    'function parsePort(env) {\n' +
    '  return Number(env.PORT);\n' +
    '}\n\nmodule.exports = { parsePort };\n',
  fix: {
    oldString: '  return Number(env.PORT);',
    newString: '  return Number(env.PORT ?? 3000);',
  },
  extraFiles: [
    {
      path: 'src/config/flags.js',
      content: "function isDebug(env) {\n  return env.DEBUG === '1';\n}\n\nmodule.exports = { isDebug };\n",
    },
    {
      path: 'src/server/listen.js',
      content:
        "const { parsePort } = require('../config/env.js');\n" +
        'function listen(env, app) {\n' +
        '  const port = parsePort(env);\n' +
        '  return { port, app };\n' +
        '}\n\nmodule.exports = { listen };\n',
    },
  ],
  locateTools: [{ name: 'grep', arguments: { query: 'parsePort' } }],
  testPath: 'test/env.test.js',
  testSrc:
    "const assert = require('node:assert/strict');\n" +
    "const { parsePort } = require('../src/config/env.js');\n\n" +
    "assert.equal(parsePort({ PORT: '8080' }), 8080);\n" +
    'assert.equal(parsePort({}), 3000);\n' +
    "console.log('OK');\n",
};

export const DISCOUNT_BUG: BugCase = {
  name: 'applyDiscount percent bug',
  goal: 'Percentage discounts are applied incorrectly (final price is way off). Find and fix applyDiscount.',
  difficulty: 'medium',
  srcPath: 'src/pricing/discount.js',
  buggySrc:
    'function applyDiscount(price, pct) {\n' +
    '  return price - pct;\n' +
    '}\n\nmodule.exports = { applyDiscount };\n',
  fix: {
    oldString: '  return price - pct;',
    newString: '  return price * (1 - pct / 100);',
  },
  extraFiles: [
    {
      path: 'src/pricing/currency.js',
      content: "function formatUsd(n) {\n  return `$${n.toFixed(2)}`;\n}\n\nmodule.exports = { formatUsd };\n",
    },
    {
      path: 'src/pricing/coupon.js',
      content:
        "function couponLabel(code) {\n  return String(code).toUpperCase();\n}\n\nmodule.exports = { couponLabel };\n",
    },
  ],
  locateTools: [{ name: 'grep', arguments: { query: 'applyDiscount' } }],
  testPath: 'test/discount.test.js',
  testSrc:
    "const assert = require('node:assert/strict');\n" +
    "const { applyDiscount } = require('../src/pricing/discount.js');\n\n" +
    // price - pct equals percent-off only when price === 100; use 200 to expose the bug.
    'assert.equal(applyDiscount(200, 10), 180);\n' +
    'assert.equal(applyDiscount(50, 0), 50);\n' +
    "console.log('OK');\n",
};

// --- hard ------------------------------------------------------------------

const NOISE_BLOB = Array.from({ length: 40 }, (_, i) => `// noise line ${i}: unused helper docs\n`).join('');

export const DISPLAY_NAME_BUG: BugCase = {
  name: 'displayName empty-middle spaces',
  goal:
    'User display names with no middle name end up with awkward extra spaces. The public API is displayName(user); find the root cause and fix it.',
  difficulty: 'hard',
  srcPath: 'src/names.js',
  buggySrc:
    'function formatName(first, middle, last) {\n' +
    '  return `${first} ${middle} ${last}`;\n' +
    '}\n\nmodule.exports = { formatName };\n',
  fix: {
    oldString: '  return `${first} ${middle} ${last}`;',
    newString: "  return [first, middle, last].filter(Boolean).join(' ');",
  },
  extraFiles: [
    {
      path: 'src/profile.js',
      content:
        "const { formatName } = require('./names.js');\n" +
        'function displayName(user) {\n' +
        '  return formatName(user.first, user.middle, user.last);\n' +
        '}\n\nmodule.exports = { displayName };\n',
    },
    { path: 'src/legacy/notes.js', content: NOISE_BLOB + 'module.exports = {};\n' },
  ],
  locateTools: [{ name: 'grep', arguments: { query: 'formatName' } }],
  testPath: 'test/profile.test.js',
  testSrc:
    "const assert = require('node:assert/strict');\n" +
    "const { displayName } = require('../src/profile.js');\n\n" +
    "assert.equal(displayName({ first: 'Ada', middle: 'Lovelace', last: 'King' }), 'Ada Lovelace King');\n" +
    "assert.equal(displayName({ first: 'Ada', middle: '', last: 'King' }), 'Ada King');\n" +
    "console.log('OK');\n",
};

export const CART_TAX_BUG: BugCase = {
  name: 'cart tax double-count and rate',
  goal:
    'Cart totals with tax are wrong. There may be more than one bug across pricing helpers — make the tests pass.',
  difficulty: 'hard',
  srcPath: 'src/tax.js',
  buggySrc:
    'function salesTax(amount) {\n' +
    '  return amount * 0.1;\n' +
    '}\n\nmodule.exports = { salesTax };\n',
  fix: {
    oldString: '  return amount * 0.1;',
    newString: '  return amount * 0.08;',
  },
  extraFixes: [
    {
      path: 'src/cart.js',
      oldString: '  return sub + taxFn(sub) + taxFn(sub);',
      newString: '  return sub + taxFn(sub);',
    },
  ],
  extraFiles: [
    {
      path: 'src/cart.js',
      content:
        "const { salesTax } = require('./tax.js');\n" +
        'function total(items) {\n' +
        '  const sub = items.reduce((a, b) => a + b, 0);\n' +
        '  const taxFn = salesTax;\n' +
        '  return sub + taxFn(sub) + taxFn(sub);\n' +
        '}\n\nmodule.exports = { total };\n',
    },
    {
      path: 'src/shipping.js',
      content: 'function flatShipping() {\n  return 5;\n}\n\nmodule.exports = { flatShipping };\n',
    },
  ],
  locateTools: [{ name: 'grep', arguments: { query: 'salesTax' } }],
  testPath: 'test/cart.test.js',
  testSrc:
    "const assert = require('node:assert/strict');\n" +
    "const { total } = require('../src/cart.js');\n\n" +
    // sub=100, tax 8% once → 108
    'assert.equal(total([40, 60]), 108);\n' +
    "console.log('OK');\n",
};

export const RETRY_BUG: BugCase = {
  name: 'retry attempts off-by-one',
  goal:
    'withRetry should attempt the operation up to maxAttempts times, but it gives up too early. Locate the helper and fix it.',
  difficulty: 'hard',
  srcPath: 'src/net/retry.js',
  buggySrc:
    'async function withRetry(fn, maxAttempts) {\n' +
    '  let lastErr;\n' +
    '  for (let i = 0; i < maxAttempts - 1; i++) {\n' +
    '    try {\n' +
    '      return await fn();\n' +
    '    } catch (err) {\n' +
    '      lastErr = err;\n' +
    '    }\n' +
    '  }\n' +
    '  throw lastErr;\n' +
    '}\n\nmodule.exports = { withRetry };\n',
  fix: {
    oldString: '  for (let i = 0; i < maxAttempts - 1; i++) {',
    newString: '  for (let i = 0; i < maxAttempts; i++) {',
  },
  extraFiles: [
    {
      path: 'src/net/http.js',
      content:
        "function okStatus(code) {\n  return code >= 200 && code < 300;\n}\n\nmodule.exports = { okStatus };\n",
    },
    { path: 'src/net/README.md', content: NOISE_BLOB },
  ],
  locateTools: [{ name: 'grep', arguments: { query: 'withRetry' } }],
  testPath: 'test/retry.test.js',
  testSrc:
    "const assert = require('node:assert/strict');\n" +
    "const { withRetry } = require('../src/net/retry.js');\n\n" +
    '(async () => {\n' +
    '  let n = 0;\n' +
    '  const out = await withRetry(async () => {\n' +
    '    n += 1;\n' +
    "    if (n < 3) throw new Error('fail');\n" +
    "    return 'ok';\n" +
    '  }, 3);\n' +
    "  assert.equal(out, 'ok');\n" +
    '  assert.equal(n, 3);\n' +
    "  console.log('OK');\n" +
    '})().catch((err) => {\n' +
    '  console.error(err);\n' +
    '  process.exit(1);\n' +
    '});\n',
};

export const bugCases: BugCase[] = [
  GREETER_BUG,
  SUM_BUG,
  CLAMP_BUG,
  TITLE_CASE_BUG,
  PARSE_PORT_BUG,
  DISCOUNT_BUG,
  DISPLAY_NAME_BUG,
  CART_TAX_BUG,
  RETRY_BUG,
];

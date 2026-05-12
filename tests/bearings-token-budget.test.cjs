'use strict';
/**
 * Plan 45-01-07: bearings token budget enforcement tests.
 *
 * Asserts:
 *   1. Default (600) renders more chars than terse (400)
 *   2. Terse mode ALWAYS includes ## Current Position (NEVER truncated)
 *   3. --token-budget 400 standalone enforces budget
 *
 * Run: node --test tests/bearings-token-budget.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

/**
 * Run bearings with given flags (Markdown mode, not --json).
 * @param {string[]} flags
 * @returns {{ stdout, stderr, status }}
 */
function runBearings(flags = []) {
  return spawnSync(
    process.execPath,
    [TOOLS, 'bearings', ...flags],
    {
      encoding: 'utf8',
      timeout: 15000,
      cwd: ROOT, // use repo dir so STATE.md is found
    }
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('Default mode (600) renders more chars than terse mode (400)', () => {
  const dflt = runBearings([]);
  const terse = runBearings(['--terse']);
  assert.equal(dflt.status, 0, 'default mode must exit 0');
  assert.equal(terse.status, 0, 'terse mode must exit 0');
  assert.ok(terse.stdout.length < dflt.stdout.length,
    `terse (${terse.stdout.length}) must be shorter than default (${dflt.stdout.length})`);
});

test('Terse mode preserves ## Current Position section (NEVER truncated)', () => {
  const terse = runBearings(['--terse']);
  assert.equal(terse.status, 0, 'terse mode must exit 0');
  assert.ok(terse.stdout.includes('## Current Position'),
    '## Current Position must always be present in terse output');
});

test('--token-budget 400 standalone enforces budget (char count <= budget*4 + 200 overhead)', () => {
  const result = runBearings(['--token-budget', '400']);
  assert.equal(result.status, 0, '--token-budget 400 must exit 0');
  // Token estimate: 400 tokens * 4 chars/token = 1600 chars; allow +200 for section headers
  const maxChars = 400 * 4 + 200;
  assert.ok(result.stdout.length <= maxChars,
    `output (${result.stdout.length} chars) must be <= ${maxChars} for token-budget 400`);
});

'use strict';
/**
 * Plan 45-01-07: bearings pattern_stats structure + graceful degradation tests.
 *
 * Asserts:
 *   1. Every pattern stat has 4 required keys (name, value, status, detail)
 *   2. Every status is in {pass, warn, unavailable}
 *   3. Exit 0 even when PG is unavailable (graceful degradation — all may be 'unavailable')
 *
 * Run: node --test tests/bearings-patterns.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

/**
 * Run bearings --json with optional env overrides and extra flags.
 */
function runBearingsJson(extraFlags = [], envOverrides = {}) {
  const result = spawnSync(
    process.execPath,
    [TOOLS, 'bearings', '--json', ...extraFlags],
    {
      encoding: 'utf8',
      timeout: 15000,
      cwd: ROOT,
      env: { ...process.env, ...envOverrides },
    }
  );
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch (_e) { /* handled per-test */ }
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, parsed };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('Every pattern stat has 4 required keys: name, value, status, detail', () => {
  const { parsed, status } = runBearingsJson();
  assert.equal(status, 0, 'bearings --json must exit 0');
  assert.ok(parsed !== null, 'stdout must be valid JSON');
  for (const stat of parsed.pattern_stats) {
    assert.ok('name' in stat, `stat ${JSON.stringify(stat)} must have key 'name'`);
    assert.ok('value' in stat, `stat ${stat.name} must have key 'value'`);
    assert.ok('status' in stat, `stat ${stat.name} must have key 'status'`);
    assert.ok('detail' in stat, `stat ${stat.name} must have key 'detail'`);
  }
});

test('Every pattern stat status is in {pass, warn, unavailable}', () => {
  const { parsed } = runBearingsJson();
  assert.ok(parsed !== null, 'stdout must be valid JSON');
  const validStatuses = new Set(['pass', 'warn', 'unavailable']);
  for (const stat of parsed.pattern_stats) {
    assert.ok(
      validStatuses.has(stat.status),
      `stat ${stat.name} has invalid status "${stat.status}" (must be pass|warn|unavailable)`
    );
  }
});

test('Graceful degradation — exit 0 even when PG is unavailable (invalid DSN)', () => {
  // Force PG connection to fail by providing an invalid DSN
  const { status, parsed } = runBearingsJson([], {
    GSD_PG_DSN: 'postgres://invalid:invalid@127.0.0.1:1/none',
  });
  assert.equal(status, 0, 'must exit 0 even when PG is unavailable');
  assert.ok(parsed !== null, 'stdout must be valid JSON even on PG failure');
  // At least one pattern stat must be 'unavailable' (PG-dependent stats degrade)
  const unavailableCount = parsed.pattern_stats.filter(s => s.status === 'unavailable').length;
  assert.ok(unavailableCount >= 1,
    `at least 1 pattern stat should be unavailable when PG is down (got ${unavailableCount})`);
});

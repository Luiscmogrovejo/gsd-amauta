'use strict';
/**
 * Plan 45-01-07: bearings --json schema integration tests.
 *
 * Invokes `node get-shit-done/bin/gsd-tools.cjs bearings --json` via spawnSync.
 * Asserts schema_version, 4 FROZEN pattern_stat names, all top-level keys,
 * and recommendation.action matches one of the FROZEN 6 patterns.
 *
 * Run: node --test tests/bearings-json-schema.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

/**
 * Run bearings --json and return parsed output.
 * @param {string[]} extraFlags
 * @returns {{ stdout, stderr, status, parsed }}
 */
function runBearingsJson(extraFlags = []) {
  const result = spawnSync(
    process.execPath,
    [TOOLS, 'bearings', '--json', ...extraFlags],
    {
      encoding: 'utf8',
      timeout: 15000,
      cwd: ROOT, // use repo dir so STATE.md is found
    }
  );
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch (_e) { /* parse failure handled per-test */ }
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, parsed };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('schema_version === "1.0"', () => {
  const { parsed, status } = runBearingsJson();
  assert.equal(status, 0, 'bearings --json must exit 0');
  assert.ok(parsed !== null, 'stdout must be valid JSON');
  assert.strictEqual(parsed.schema_version, '1.0');
});

test('pattern_stats length === 4 with FROZEN names in FROZEN order', () => {
  const { parsed } = runBearingsJson();
  assert.ok(parsed !== null, 'stdout must be valid JSON');
  assert.equal(parsed.pattern_stats.length, 4, 'must have exactly 4 pattern_stats');
  const names = parsed.pattern_stats.map(s => s.name);
  assert.deepEqual(names, [
    'avg_sessions_per_phase_type',
    'commits_since_last_test',
    'similar_feature_sessions',
    'plan_complexity_trend',
  ]);
});

test('all top-level keys present in FROZEN output schema', () => {
  const { parsed } = runBearingsJson();
  assert.ok(parsed !== null, 'stdout must be valid JSON');
  const keys = Object.keys(parsed).sort();
  assert.deepEqual(keys, [
    'generated_at',
    'pattern_stats',
    'plan_progress',
    'project_state',
    'recent_activity',
    'recommendation',
    'schema_version',
  ]);
});

test('recommendation.action matches one of the FROZEN 6 action patterns', () => {
  const { parsed } = runBearingsJson();
  assert.ok(parsed !== null, 'stdout must be valid JSON');
  const action = parsed.recommendation.action;
  const valid = (
    action === '/amauta:debug' ||
    action === 'git status / review STATE.md' ||
    action === '/amauta:progress' ||
    action.startsWith('/amauta:execute-phase ') ||
    action.startsWith('/amauta:plan-phase ') ||
    action.startsWith('/amauta:test-phase ')
  );
  assert.ok(valid, `recommendation.action "${action}" must match one of the FROZEN 6 patterns`);
});

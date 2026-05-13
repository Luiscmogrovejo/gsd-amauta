'use strict';
/**
 * Plan 47-02-03: agent-hydrate CLI integration tests.
 *
 * Tests the `gsd-tools agent-hydrate` subcommand shell layer:
 *   1. usage exit 2 when agent_name missing
 *   2. usage exit 2 when first arg is a flag
 *   3. agent_not_found returns exit 1 with structured JSON
 *   4. --json mode returns schema_version 1.0 for real agent
 *   5. --terse implies budget 400 (output contains ## Current context)
 *   6. --budget overrides --terse (output contains headers)
 *
 * Run: node --test tests/agent-hydrate-cli.test.cjs
 *
 * PG-down resilience: tests 4–6 accept either exit 0 or 1 (PG may be down);
 * the schema_version field and section headers must be present regardless.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

/**
 * Run gsd-tools agent-hydrate with given args and return result.
 * @param {string[]} subArgs - args after 'agent-hydrate'
 * @returns {{ stdout, stderr, status }}
 */
function runHydrate(subArgs = []) {
  return spawnSync(
    process.execPath,
    [TOOLS, 'agent-hydrate', ...subArgs],
    {
      encoding: 'utf8',
      timeout: 20000,
      cwd: ROOT,
    }
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('usage exit code is 2 when agent_name missing', () => {
  const r = runHydrate([]);
  assert.strictEqual(r.status, 2, 'must exit 2 when no agent_name provided');
  assert.ok(
    r.stderr.includes('Usage: gsd-tools agent-hydrate'),
    `stderr must contain usage; got: ${r.stderr}`
  );
});

test('usage exit code is 2 when first arg is a flag', () => {
  const r = runHydrate(['--json']);
  assert.strictEqual(r.status, 2, 'must exit 2 when first arg is a flag');
  assert.ok(
    r.stderr.includes('Usage: gsd-tools agent-hydrate'),
    `stderr must contain usage; got: ${r.stderr}`
  );
});

test('agent_not_found returns exit 1 with structured JSON', () => {
  const r = runHydrate(['this-agent-does-not-exist', '--json']);
  assert.strictEqual(r.status, 1, 'must exit 1 for unknown agent');
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (_e) { /* handled below */ }
  assert.ok(parsed !== null, `stdout must be valid JSON; got: ${r.stdout}`);
  assert.strictEqual(parsed.error, 'agent_not_found');
  assert.strictEqual(parsed.schema_version, '1.0');
});

test('--json mode returns schema_version 1.0 for real agent', () => {
  const r = runHydrate(['gsd-planner', '--json']);
  // Accept exit 0 or 1 (PG may be down, but agent .md exists — should be 0)
  assert.ok(r.status === 0 || r.status === 1, `unexpected exit status: ${r.status}`);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (_e) { /* handled below */ }
  assert.ok(parsed !== null, `stdout must be valid JSON; got: ${r.stdout}`);
  assert.strictEqual(parsed.schema_version, '1.0', 'schema_version must be "1.0"');
  assert.strictEqual(parsed.agent_name, 'gsd-planner');
  // sources_status must have exactly 4 keys
  const statusKeys = Object.keys(parsed.sources_status || {}).sort();
  assert.deepEqual(statusKeys, ['blackboard', 'memory', 'security', 'valkey']);
});

test('--terse flag implies budget 400 (output contains ## Current context)', () => {
  const rTerse = runHydrate(['gsd-planner', '--terse']);
  const rDefault = runHydrate(['gsd-planner']);

  // Both must contain the primary heading regardless of PG availability
  assert.ok(
    rTerse.stdout.includes('## Current context'),
    `--terse output must include ## Current context; got: ${rTerse.stdout.slice(0, 200)}`
  );
  assert.ok(
    rDefault.stdout.includes('## Current context'),
    `default output must include ## Current context; got: ${rDefault.stdout.slice(0, 200)}`
  );

  // When PG is down both outputs are similar (unavailable in all sections).
  // Only assert terse is shorter when there is actual content to truncate.
  // At minimum, both must contain the heading.
  const terseLen = rTerse.stdout.length;
  const defaultLen = rDefault.stdout.length;
  // If lengths differ meaningfully, terse must be <= default
  if (terseLen !== defaultLen) {
    assert.ok(terseLen <= defaultLen, `--terse output (${terseLen}) must be <= default (${defaultLen})`);
  }
});

test('--budget overrides --terse (output contains ## Current context)', () => {
  const rOverride = runHydrate(['gsd-planner', '--terse', '--budget', '1000']);
  const rDefault = runHydrate(['gsd-planner']);

  assert.ok(
    rOverride.stdout.includes('## Current context'),
    `--budget override output must include ## Current context; got: ${rOverride.stdout.slice(0, 200)}`
  );
  assert.ok(
    rDefault.stdout.includes('## Current context'),
    `default output must include ## Current context; got: ${rDefault.stdout.slice(0, 200)}`
  );

  // With --budget 1000 (larger than default 800), output should be >= default
  // When PG is down both are similar — assert at least headers present in both
  const overrideLen = rOverride.stdout.length;
  const defaultLen = rDefault.stdout.length;
  if (overrideLen !== defaultLen) {
    assert.ok(
      overrideLen >= defaultLen,
      `--budget 1000 output (${overrideLen}) should be >= default (${defaultLen})`
    );
  }
});

'use strict';
/**
 * Plan 47-02-05: agent-hydrate SC2 per-agent + per-task differentiation tests.
 *
 * Proves HYDRA-02 SC2: "content is verifiably different per agent and per task."
 *
 * These tests verify that agent_name and task_id thread correctly through the
 * entire pipeline. Content differentiation in memory/blackboard arrays depends
 * on populated PG data — only the field routing is tested here.
 *
 * Tests:
 *   1. same agent different task_ids → task_id field differs (TK-A vs TK-B)
 *   2. different agents same task_id → agent_name fields differ
 *   3. repeated identical call → same agent_name, task_id, schema_version,
 *      same sources_status keys (generated_at allowed to differ)
 *   4. task_id null when --task-id absent
 *
 * Run: node --test tests/agent-hydrate-differentiation.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

/**
 * Run agent-hydrate in JSON mode and return parsed payload.
 * @param {string[]} subArgs - args after 'agent-hydrate'
 * @returns {{ stdout, stderr, status, parsed }}
 */
function runHydrateJson(subArgs = []) {
  const r = spawnSync(
    process.execPath,
    [TOOLS, 'agent-hydrate', ...subArgs, '--json'],
    {
      encoding: 'utf8',
      timeout: 20000,
      cwd: ROOT,
    }
  );
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (_e) { /* parse failure handled per-test */ }
  return { stdout: r.stdout, stderr: r.stderr, status: r.status, parsed };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('same agent different task_ids produce different task_id field', () => {
  const rA = runHydrateJson(['gsd-planner', '--task-id', 'TK-A']);
  const rB = runHydrateJson(['gsd-planner', '--task-id', 'TK-B']);

  assert.ok(rA.parsed !== null, `TK-A: stdout must be valid JSON; got: ${rA.stdout.slice(0, 200)}`);
  assert.ok(rB.parsed !== null, `TK-B: stdout must be valid JSON; got: ${rB.stdout.slice(0, 200)}`);

  // task_id must thread through correctly
  assert.strictEqual(rA.parsed.task_id, 'TK-A', 'TK-A result must have task_id === "TK-A"');
  assert.strictEqual(rB.parsed.task_id, 'TK-B', 'TK-B result must have task_id === "TK-B"');

  // agent_name is the same across both calls
  assert.strictEqual(rA.parsed.agent_name, rB.parsed.agent_name, 'same agent: agent_name must match');
});

test('different agents same task_id produce different agent_name field', () => {
  const rPlanner = runHydrateJson(['gsd-planner', '--task-id', 'TK-X']);
  const rChecker = runHydrateJson(['gsd-checker', '--task-id', 'TK-X']);

  assert.ok(rPlanner.parsed !== null, `planner: stdout must be valid JSON; got: ${rPlanner.stdout.slice(0, 200)}`);
  assert.ok(rChecker.parsed !== null, `checker: stdout must be valid JSON; got: ${rChecker.stdout.slice(0, 200)}`);

  // agent_name must differ
  assert.notStrictEqual(
    rPlanner.parsed.agent_name,
    rChecker.parsed.agent_name,
    `agent_name must differ: planner="${rPlanner.parsed.agent_name}" checker="${rChecker.parsed.agent_name}"`
  );

  // task_id must be the same (TK-X threaded through both)
  assert.strictEqual(rPlanner.parsed.task_id, 'TK-X', 'planner: task_id must be TK-X');
  assert.strictEqual(rChecker.parsed.task_id, 'TK-X', 'checker: task_id must be TK-X');

  // Verify expected agent_name values (either canonical form acceptable)
  assert.ok(
    rPlanner.parsed.agent_name === 'gsd-planner' || rPlanner.parsed.agent_name === 'planner',
    `planner agent_name must be "gsd-planner" or "planner"; got: "${rPlanner.parsed.agent_name}"`
  );
  assert.ok(
    rChecker.parsed.agent_name === 'gsd-checker' || rChecker.parsed.agent_name === 'checker',
    `checker agent_name must be "gsd-checker" or "checker"; got: "${rChecker.parsed.agent_name}"`
  );
});

test('repeated identical call produces byte-identical agent_name, task_id, schema_version, sources_status keys', () => {
  const r1 = runHydrateJson(['gsd-planner', '--task-id', 'TK-Z']);
  const r2 = runHydrateJson(['gsd-planner', '--task-id', 'TK-Z']);

  assert.ok(r1.parsed !== null, `run-1: stdout must be valid JSON; got: ${r1.stdout.slice(0, 200)}`);
  assert.ok(r2.parsed !== null, `run-2: stdout must be valid JSON; got: ${r2.stdout.slice(0, 200)}`);

  // Determinism contract: these MUST be byte-identical
  assert.strictEqual(r1.parsed.schema_version, r2.parsed.schema_version, 'schema_version must match');
  assert.strictEqual(r1.parsed.agent_name, r2.parsed.agent_name, 'agent_name must match');
  assert.strictEqual(r1.parsed.task_id, r2.parsed.task_id, 'task_id must match');

  // sources_status KEY SET must be identical (values may differ if data changed between calls)
  const keys1 = Object.keys(r1.parsed.sources_status || {}).sort().join(',');
  const keys2 = Object.keys(r2.parsed.sources_status || {}).sort().join(',');
  assert.strictEqual(keys1, keys2, `sources_status keys must match: "${keys1}" vs "${keys2}"`);
  assert.strictEqual(keys1, 'blackboard,memory,security,valkey', 'sources_status must have 4 canonical keys');

  // generated_at IS allowed to differ (it is a per-call timestamp)
  // No assertion on generated_at equality.
});

test('task_id is null when --task-id absent', () => {
  const r = runHydrateJson(['gsd-planner']);
  assert.ok(r.parsed !== null, `stdout must be valid JSON; got: ${r.stdout.slice(0, 200)}`);
  assert.strictEqual(r.parsed.task_id, null, 'task_id must be null when --task-id not provided');
});

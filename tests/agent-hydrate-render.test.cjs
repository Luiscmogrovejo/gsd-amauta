'use strict';
/**
 * Plan 47-02-04: agent-hydrate Markdown renderer frozen template assertions.
 *
 * Verifies the rendered ## Current context block matches the frozen template
 * structure REGARDLESS of PG/Valkey availability. Tests catch regressions in
 * the render code even when all data sources are down.
 *
 * Tests:
 *   1. default render includes ## Current context heading
 *   2. default render includes all 4 section headers
 *   3. default render ends with trailing --- separator
 *   4. header line includes Generated and Agent
 *   5. Task field shows "general" when no --task-id
 *   6. Task field echoes provided --task-id
 *   7. Sources: 4/4 always rendered
 *   8. no template literals leak ({agent_name}, {task_id}, {cosine}, etc.)
 *
 * Run: node --test tests/agent-hydrate-render.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

/**
 * Run agent-hydrate in Markdown (default) mode.
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

// Cache a single default run for tests that share the same invocation
let _defaultOutput = null;
function getDefaultOutput() {
  if (_defaultOutput === null) {
    _defaultOutput = runHydrate(['gsd-planner']);
  }
  return _defaultOutput;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('default render includes ## Current context heading', () => {
  const r = getDefaultOutput();
  assert.ok(
    r.stdout.includes('## Current context'),
    `output must include "## Current context"; got: ${r.stdout.slice(0, 300)}`
  );
});

test('default render includes all 4 section headers', () => {
  const r = getDefaultOutput();
  assert.ok(
    r.stdout.includes('### Recent memory for'),
    'output must include "### Recent memory for"'
  );
  assert.ok(
    r.stdout.includes('### Blackboard findings'),
    'output must include "### Blackboard findings"'
  );
  assert.ok(
    r.stdout.includes('### Recent activity'),
    'output must include "### Recent activity"'
  );
  assert.ok(
    r.stdout.includes('### Security alerts (24h)'),
    'output must include "### Security alerts (24h)"'
  );
});

test('default render ends with trailing --- separator', () => {
  const r = getDefaultOutput();
  // Trim trailing whitespace/newlines and check last non-empty line is ---
  const lines = r.stdout.trimEnd().split('\n').filter(l => l.trim().length > 0);
  const lastLine = lines[lines.length - 1];
  assert.strictEqual(lastLine, '---', `last non-empty line must be "---"; got: "${lastLine}"`);
});

test('header line includes Generated and Agent', () => {
  const r = getDefaultOutput();
  assert.ok(
    r.stdout.includes('_Generated:'),
    'output must include "_Generated:" in the header line'
  );
  assert.ok(
    r.stdout.includes('· Agent:'),
    'output must include "· Agent:" in the header line'
  );
});

test('Task field shows "general" when no --task-id', () => {
  const r = getDefaultOutput();
  assert.ok(
    r.stdout.includes('· Task: general'),
    `output must include "· Task: general"; got snippet: ${r.stdout.slice(0, 300)}`
  );
});

test('Task field echoes provided --task-id', () => {
  const r = runHydrate(['gsd-planner', '--task-id', 'TK-9999']);
  assert.ok(
    r.stdout.includes('· Task: TK-9999'),
    `output must include "· Task: TK-9999"; got: ${r.stdout.slice(0, 300)}`
  );
});

test('Sources: 4/4 always rendered', () => {
  const r = getDefaultOutput();
  assert.ok(
    r.stdout.includes('· Sources: 4/4'),
    `output must include "· Sources: 4/4"; got: ${r.stdout.slice(0, 300)}`
  );
});

test('no template literals leak — no f-string placeholders in output', () => {
  const r = getDefaultOutput();
  // These are the literal f-string variable names from the template.
  // If they appear in output verbatim, the renderer has a bug.
  assert.ok(
    !r.stdout.includes('{agent_name}'),
    'output must NOT contain literal "{agent_name}" placeholder'
  );
  assert.ok(
    !r.stdout.includes('{task_id}'),
    'output must NOT contain literal "{task_id}" placeholder'
  );
  assert.ok(
    !r.stdout.includes('{cosine}'),
    'output must NOT contain literal "{cosine}" placeholder'
  );
  assert.ok(
    !r.stdout.includes('{age}'),
    'output must NOT contain literal "{age}" placeholder'
  );
});

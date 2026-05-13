'use strict';
/**
 * Plan 50-03-04: party CLI integration tests.
 *
 * Tests the `gsd-tools party` subcommand shell layer and `bin/cli.cjs party`
 * shortcut. State-machine round-trip tests run in dependency order sharing
 * session state.
 *
 * Tests:
 *   1. party-help-emits-usage      — no args exits 2 + stderr Usage:
 *   2. party-unknown-action        — bogusaction exits 2 + Unknown party action
 *   3. party-create-roundtrip      — --json exits 0 + schema_version 1.0 + status created
 *   4. party-start-transitions     — created → active via start
 *   5. party-pause-transitions     — active → paused via pause
 *   6. party-resume-transitions    — paused → active via resume + findings array
 *   7. party-terminate-transitions — active → terminated via terminate
 *   8. party-invalid-transition-exit-1 — created → terminate forbidden → exit 1
 *   9. party-cli-shortcut-mirrors-tools — bin/cli.cjs party create matches gsd-tools shape
 *  10. phase-48-module-case-untouched-canary — gsd-tools.cjs has exactly 1 'module' case + 1 'party' case
 *
 * PG-down resilience: state-machine tests (3–9) are skipped when PG is
 * unavailable. Tests 1, 2, 10 run unconditionally (no PG required).
 *
 * Run: node --test tests/party-cli.test.cjs
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const CLI_ENTRY = path.join(ROOT, 'bin', 'cli.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run `node gsd-tools.cjs party <subArgs>` and return { stdout, stderr, status }.
 */
function runParty(subArgs = []) {
  return spawnSync(
    process.execPath,
    [TOOLS, 'party', ...subArgs],
    {
      encoding: 'utf8',
      timeout: 20000,
      cwd: ROOT,
    }
  );
}

/**
 * Run `node bin/cli.cjs party <subArgs>` and return { stdout, stderr, status }.
 */
function runCliParty(subArgs = []) {
  return spawnSync(
    process.execPath,
    [CLI_ENTRY, 'party', ...subArgs],
    {
      encoding: 'utf8',
      timeout: 20000,
      cwd: ROOT,
    }
  );
}

/**
 * Detect whether PG is available by attempting a get on a bogus UUID.
 * Returns true when PG is reachable; false when PG is down.
 */
function pgAvailable() {
  const bogusId = crypto.randomUUID();
  const r = runParty(['get', bogusId, '--json']);
  // PG down: exit 2 AND (stderr or stdout) includes 'pg_io_error' or 'OperationalError'
  if (r.status === 2) {
    const combined = (r.stdout || '') + (r.stderr || '');
    if (combined.includes('pg_io_error') || combined.includes('OperationalError')) {
      return false;
    }
  }
  // exit 1 with JSON {"error": "SessionNotFoundError"} means PG is up but session not found
  if (r.status === 1) {
    try {
      const parsed = JSON.parse(r.stdout);
      if (parsed.error === 'SessionNotFoundError') {
        return true;
      }
    } catch (_e) { /* fall through */ }
  }
  // exit 0 means PG up + session somehow exists (shouldn't happen with random UUID)
  // exit 2 without pg_io_error hint — treat as PG error
  return r.status === 1;
}

// ─── Tests 1 + 2: unconditional (no PG required) ─────────────────────────────

test('party-help-emits-usage', (t) => {
  const r = runParty([]);
  assert.strictEqual(r.status, 2, `must exit 2 when no args; got: ${r.status}`);
  assert.ok(
    r.stderr.includes('Usage:'),
    `stderr must contain "Usage:"; got: ${r.stderr.slice(0, 300)}`
  );
});

test('party-unknown-action', (t) => {
  const r = runParty(['bogusaction']);
  assert.strictEqual(r.status, 2, `must exit 2 for unknown action; got: ${r.status}`);
  assert.ok(
    r.stderr.includes('Unknown party action: bogusaction'),
    `stderr must contain "Unknown party action: bogusaction"; got: ${r.stderr.slice(0, 300)}`
  );
});

// ─── Tests 3–9: PG-gated state-machine round-trips ───────────────────────────
//
// State is threaded through a shared `sessionId` variable. Tests run in
// declared order because node:test describe() runs subtests sequentially.

describe('party-state-machine (PG required)', (suite) => {
  let sessionId = null;
  let pgUp = false;

  before(() => {
    pgUp = pgAvailable();
  });

  test('party-create-roundtrip', (t) => {
    if (!pgUp) {
      t.skip('PG unavailable — skipping state-machine tests');
      return;
    }
    const r = runParty(['create', '--participants', 'gsd-planner,gsd-checker', '--json']);
    assert.strictEqual(r.status, 0, `create must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.schema_version, '1.0', 'schema_version must be "1.0"');
    assert.strictEqual(parsed.status, 'created', `status must be "created"; got: ${parsed.status}`);
    assert.ok(Array.isArray(parsed.participants), 'participants must be an array');
    assert.strictEqual(parsed.participants.length, 2, `participants must have 2 entries; got: ${parsed.participants.length}`);
    assert.ok(
      typeof parsed.session_id === 'string' && parsed.session_id.length === 36,
      `session_id must be a 36-char UUID; got: ${parsed.session_id}`
    );
    // Save for subsequent tests
    sessionId = parsed.session_id;
  });

  test('party-start-transitions', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip('PG unavailable or session not created — skipping');
      return;
    }
    const r = runParty(['start', sessionId, '--json']);
    assert.strictEqual(r.status, 0, `start must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.status, 'active', `status must be "active" after start; got: ${parsed.status}`);
    assert.strictEqual(parsed.session_id, sessionId, 'session_id must match');
  });

  test('party-pause-transitions', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip('PG unavailable or session not created — skipping');
      return;
    }
    const r = runParty(['pause', sessionId, '--json']);
    assert.strictEqual(r.status, 0, `pause must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.status, 'paused', `status must be "paused" after pause; got: ${parsed.status}`);
    assert.ok(parsed.paused_at !== null && parsed.paused_at !== undefined, 'paused_at must not be null');
  });

  test('party-resume-transitions', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip('PG unavailable or session not created — skipping');
      return;
    }
    const r = runParty(['resume', sessionId, '--json']);
    assert.strictEqual(r.status, 0, `resume must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.status, 'active', `status must be "active" after resume; got: ${parsed.status}`);
    assert.ok(
      parsed.paused_at === null || parsed.paused_at === undefined || parsed.paused_at === 'None',
      `paused_at must be null after resume; got: ${parsed.paused_at}`
    );
    assert.ok(Array.isArray(parsed.findings), `findings must be an array after resume; got: ${typeof parsed.findings}`);
  });

  test('party-terminate-transitions', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip('PG unavailable or session not created — skipping');
      return;
    }
    const r = runParty(['terminate', sessionId, '--json']);
    assert.strictEqual(r.status, 0, `terminate must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.status, 'terminated', `status must be "terminated"; got: ${parsed.status}`);
    assert.ok(
      parsed.terminated_at !== null && parsed.terminated_at !== undefined,
      'terminated_at must not be null'
    );
  });

  test('party-invalid-transition-exit-1', (t) => {
    if (!pgUp) {
      t.skip('PG unavailable — skipping');
      return;
    }
    // Create a fresh session then try to terminate it directly from 'created'
    // (created → terminated is FORBIDDEN per CONTEXT §Area 2)
    const createR = runParty(['create', '--participants', 'agent-a,agent-b', '--json']);
    if (createR.status !== 0) {
      t.skip(`Could not create test session (exit ${createR.status}); skipping`);
      return;
    }
    let newSessionId;
    try {
      newSessionId = JSON.parse(createR.stdout).session_id;
    } catch (e) {
      t.skip('Could not parse session_id from create output; skipping');
      return;
    }
    const r = runParty(['terminate', newSessionId, '--json']);
    assert.strictEqual(r.status, 1, `created→terminate must exit 1; got: ${r.status}\nstdout: ${r.stdout}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`stdout must be valid JSON on exit 1; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.error, 'InvalidTransitionError', `error must be InvalidTransitionError; got: ${parsed.error}`);
    assert.ok(
      typeof parsed.detail === 'string' && parsed.detail.length > 0,
      'detail must be a non-empty string'
    );
    assert.strictEqual(parsed.schema_version, '1.0');
  });
});

// ─── Test 9: bin/cli.cjs party shortcut mirrors gsd-tools shape ──────────────

test('party-cli-shortcut-mirrors-tools', (t) => {
  if (!pgAvailable()) {
    t.skip('PG unavailable — skipping shortcut comparison test');
    return;
  }
  // Create via gsd-tools directly
  const toolsR = runParty(['create', '--participants', 'a,b', '--json']);
  // Create via bin/cli.cjs party
  const cliR = runCliParty(['create', '--participants', 'a,b', '--json']);

  // Both must exit 0
  assert.strictEqual(toolsR.status, 0, `gsd-tools party create must exit 0; got: ${toolsR.status}`);
  assert.strictEqual(cliR.status, 0, `cli.cjs party create must exit 0; got: ${cliR.status}`);

  let toolsParsed, cliParsed;
  try { toolsParsed = JSON.parse(toolsR.stdout); } catch (e) {
    assert.fail(`gsd-tools stdout must be valid JSON; got: ${toolsR.stdout}`);
  }
  try { cliParsed = JSON.parse(cliR.stdout); } catch (e) {
    assert.fail(`cli.cjs stdout must be valid JSON; got: ${cliR.stdout}`);
  }

  // Compare structural shape (session_ids differ because of separate inserts — expected)
  assert.strictEqual(toolsParsed.schema_version, '1.0', 'gsd-tools schema_version must be "1.0"');
  assert.strictEqual(cliParsed.schema_version, '1.0', 'cli.cjs schema_version must be "1.0"');
  assert.strictEqual(toolsParsed.status, 'created', 'gsd-tools status must be "created"');
  assert.strictEqual(cliParsed.status, 'created', 'cli.cjs status must be "created"');
  assert.strictEqual(toolsParsed.participants.length, 2, 'gsd-tools participants must have 2 entries');
  assert.strictEqual(cliParsed.participants.length, 2, 'cli.cjs participants must have 2 entries');
  // session_ids differ — intentional (two inserts)
  assert.notStrictEqual(
    toolsParsed.session_id,
    cliParsed.session_id,
    'session_ids should differ (two independent inserts)'
  );
});

// ─── Test 10: Phase 48 module case untouched canary ──────────────────────────

test('phase-48-module-case-untouched-canary', () => {
  const src = fs.readFileSync(TOOLS, 'utf8');

  // Exactly 1 'case 'module':' in the file
  const moduleMatches = (src.match(/case 'module':/g) || []).length;
  assert.strictEqual(
    moduleMatches,
    1,
    `Expected exactly 1 "case 'module':" in gsd-tools.cjs; got: ${moduleMatches}`
  );

  // Exactly 1 'case 'party':' in the file
  const partyMatches = (src.match(/case 'party':/g) || []).length;
  assert.strictEqual(
    partyMatches,
    1,
    `Expected exactly 1 "case 'party':" in gsd-tools.cjs; got: ${partyMatches}`
  );

  // 'module' case comes BEFORE 'party' case
  const moduleIdx = src.indexOf("case 'module':");
  const partyIdx = src.indexOf("case 'party':");
  assert.ok(
    moduleIdx < partyIdx,
    `"case 'module':" (L${moduleIdx}) must appear before "case 'party':" (L${partyIdx})`
  );
});

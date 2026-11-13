'use strict';
/**
 * Plan 50-03-04: party CLI integration tests — converted by plan 89-13
 * (Phase 89 ORC-02 part 2) from state-machine round trips into container and
 * removed-verb tests. A party session is a container for recorded decisions:
 * `pause`, `resume` and `kill` are gone and nothing is refused because of a
 * status label. Each converted subtest says what it used to assert.
 *
 * Tests:
 *   1. party-help-emits-usage      — no args exits 2 + stderr Usage:, removed verbs not offered
 *   2. party-unknown-action        — bogusaction exits 2 + Unknown party action
 *   3. party-removed-verbs-answer-typed — pause/resume/kill: typed message, exit 2, both surfaces
 *   4. party-no-postgres-answers-requires-postgres — typed requires_postgres with no DSN
 *   5. party-create-roundtrip      — --json exits 0 + schema_version 1.0 + status created
 *   6. party-start-transitions     — start labels the session active
 *   7. party-pause-removed-session-untouched     — was party-pause-transitions
 *   8. party-resume-removed-findings-via-get     — was party-resume-transitions
 *   9. party-terminate-transitions — terminate labels the session terminated
 *  10. party-terminate-from-created-is-not-refused — was party-invalid-transition-exit-1
 *  11. party-cli-shortcut-mirrors-tools — bin/cli.cjs party create matches gsd-tools shape
 *  12. phase-48-module-case-untouched-canary — gsd-tools.cjs has exactly 1 'module' case + 1 'party' case
 *
 * PG-down resilience: tests 5–11 are skipped when PG is unavailable (developer
 * machines); they run on all CI cells. Tests 1–4 and 12 need no database.
 *
 * Run: node --test tests/party-cli.test.cjs
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

// Phase 88 plan 88-15: spawn Python through the shared resolver, never a literal name.
const platform = require('../get-shit-done/bin/lib/platform.cjs');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const CLI_ENTRY = path.join(ROOT, 'bin', 'cli.cjs');
const PARTY_CLI_PY = path.join(ROOT, 'services', 'party_session_cli.py');
const REMOVED_VERBS = ['pause', 'resume', 'kill'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Phase 88 plan 88-16-09: the party CLI reads its DSN from GSD_POSTGRES_URL /
// DATABASE_URL, which scripts/run-tests.cjs deletes from every child so that no
// test can inherit the operator's live database. `pgChildEnv()` puts the
// DISPOSABLE one back for these spawns, and only after refusing a DSN whose
// port is one of the live services. With no disposable database the probe
// reports PG down and the PG tests skip with the one standard reason, exactly
// as before.
const pg = require('./support/pg-fixture.cjs');

// Plan 88-16-09, isolation BY CONSTRUCTION: `node --test` runs files in
// parallel processes, so the four party suites were writing party_sessions
// rows into one database at the same time and
// `e2e-status-sorted-by-updated-at-desc` read a SIBLING FILE's session at the
// top of "most recently updated" (measured, run 43181201335: idx=5). Each file
// gets its own database, created from the disposable server with every
// migration applied, and drops it when the file ends.
const _ISOLATED_DSN = pg.createIsolatedDatabase('party_cli');

/** @returns {NodeJS.ProcessEnv} the child environment for a party CLI spawn */
function partyEnv() {
  if (!_ISOLATED_DSN) return process.env;
  const env = pg.pgChildEnv();
  env.GSD_POSTGRES_URL = _ISOLATED_DSN;
  env.DATABASE_URL = _ISOLATED_DSN;
  env.GSD_TEST_POSTGRES_URL = _ISOLATED_DSN;
  return env;
}

process.on('exit', () => pg.dropIsolatedDatabase(_ISOLATED_DSN));

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
      env: partyEnv(),
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
      env: partyEnv(),
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

/**
 * A child environment with NO PostgreSQL configured, whatever the cell provides.
 * @returns {NodeJS.ProcessEnv}
 */
function noPostgresEnv() {
  return {
    ...process.env,
    GSD_POSTGRES_URL: '',
    DATABASE_URL: '',
    GSD_TEST_POSTGRES_URL: '',
    GSD_FORCE_SQLITE: '1',
  };
}

/**
 * Assert `r` is the typed answer for the removed verb `verb`.
 * @param {{status: number|null, stdout: string, stderr: string}} r spawn result
 * @param {string} verb one of REMOVED_VERBS
 * @param {boolean} json whether --json was passed
 * @returns {object|null} the parsed payload when `json`
 */
function assertRemovedVerbAnswer(r, verb, json) {
  assert.strictEqual(r.status, 2, `party ${verb} must exit 2 (removed); got: ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`\`party ${verb}\` was removed`), `stderr must name the removed verb; got: ${r.stderr}`);
  assert.match(r.stderr, /ORC-02/, 'the message must name the requirement');
  assert.match(r.stderr, /recorded decisions/i, 'the message must say what a party session is now');
  for (const replacement of ['party status', 'party inspect', 'party terminate']) {
    assert.ok(r.stderr.includes(replacement), `the message must name ${replacement}; got: ${r.stderr}`);
  }
  assert.ok(!/Traceback|at Object\.|Unknown party action|invalid choice/.test(r.stdout + r.stderr),
    `a removed verb must not answer with a stack trace or an unknown-verb error; got: ${r.stdout}${r.stderr}`);
  if (!json) {
    assert.strictEqual(r.stdout, '', `without --json nothing goes to stdout; got: ${r.stdout}`);
    return null;
  }
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.error, 'party_verb_removed');
  assert.strictEqual(parsed.action, verb);
  assert.strictEqual(parsed.schema_version, '1.0');
  assert.match(parsed.detail, /recorded decisions/);
  assert.deepStrictEqual(parsed.replacement, [
    'party status', 'party inspect <session_id>', 'party get <session_id> --with-findings', 'party terminate <session_id>',
  ]);
  return parsed;
}

// ─── Tests 1–4: unconditional (no PG required) ───────────────────────────────

test('party-help-emits-usage', (t) => {
  const r = runParty([]);
  assert.strictEqual(r.status, 2, `must exit 2 when no args; got: ${r.status}`);
  assert.ok(
    r.stderr.includes('Usage:'),
    `stderr must contain "Usage:"; got: ${r.stderr.slice(0, 300)}`
  );
  // Plan 89-13: the usage text offers exactly the surviving verbs.
  for (const verb of REMOVED_VERBS) {
    assert.ok(!new RegExp(`party ${verb}\\b`).test(r.stderr),
      `the usage text still offers the removed verb "${verb}": ${r.stderr}`);
  }
});

test('party-unknown-action', (t) => {
  const r = runParty(['bogusaction']);
  assert.strictEqual(r.status, 2, `must exit 2 for unknown action; got: ${r.status}`);
  assert.ok(
    r.stderr.includes('Unknown party action: bogusaction'),
    `stderr must contain "Unknown party action: bogusaction"; got: ${r.stderr.slice(0, 300)}`
  );
});

// Plan 89-13: a removed verb answers, it does not crash. Needs no database: the
// answer is given before anything is spawned or connected, on every cell.
test('party-removed-verbs-answer-typed', () => {
  for (const verb of REMOVED_VERBS) {
    const env = noPostgresEnv();
    const spawnTools = (args) => spawnSync(process.execPath, [TOOLS, 'party', ...args],
      { encoding: 'utf8', timeout: 20000, cwd: ROOT, env });
    assertRemovedVerbAnswer(spawnTools([verb, 'some-session-id']), verb, false);
    const nodeJson = assertRemovedVerbAnswer(spawnTools([verb, 'some-session-id', '--json']), verb, true);

    // The bin/cli.cjs shortcut forwards to the same dispatch.
    const viaCli = spawnSync(process.execPath, [CLI_ENTRY, 'party', verb, 'some-session-id'],
      { encoding: 'utf8', timeout: 20000, cwd: ROOT, env });
    assert.strictEqual(viaCli.status, 2, `bin/cli.cjs party ${verb} must exit 2; got: ${viaCli.status}`);

    // The Python CLI, called directly, gives the SAME payload: two surfaces,
    // one answer. A drift between the two copies of the message fails here.
    const py = platform.spawnPython([PARTY_CLI_PY, verb, 'some-session-id', '--json'],
      { encoding: 'utf8', timeout: 20000, cwd: ROOT, env });
    const pyJson = assertRemovedVerbAnswer(py, verb, true);
    assert.deepStrictEqual(pyJson, nodeJson, `the Node and Python answers for "${verb}" differ`);
    const pyText = platform.spawnPython([PARTY_CLI_PY, verb, 'some-session-id'],
      { encoding: 'utf8', timeout: 20000, cwd: ROOT, env });
    const nodeText = spawnTools([verb, 'some-session-id']);
    assert.strictEqual(pyText.stderr.trim(), nodeText.stderr.trim(),
      `the Node and Python text answers for "${verb}" differ`);
  }
});

// Plan 89-13: party_sessions is PostgreSQL-only. With none configured the CLI
// answers a typed requires_postgres, as the daemon does for the same feature.
test('party-no-postgres-answers-requires-postgres', () => {
  const r = spawnSync(process.execPath, [TOOLS, 'party', 'status', '--json'],
    { encoding: 'utf8', timeout: 20000, cwd: ROOT, env: noPostgresEnv() });
  assert.strictEqual(r.status, 2, `party status with no PostgreSQL must exit 2; got: ${r.status}\nstderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.error, 'requires_postgres');
  assert.strictEqual(parsed.feature, 'party_sessions');
  assert.strictEqual(parsed.schema_version, '1.0');
  assert.match(parsed.detail, /GSD_POSTGRES_URL/, 'the answer must still name the variable to set');
  assert.ok(!/Traceback/.test(r.stdout + r.stderr), 'no stack trace');
});

// ─── Tests 5–10: PG-gated container round-trips ──────────────────────────────
//
// State is threaded through a shared `sessionId` variable. Tests run in
// declared order because node:test describe() runs subtests sequentially.

describe('party-container (PG required)', (suite) => {
  let sessionId = null;
  let pgUp = false;

  before(() => {
    pgUp = pgAvailable();
  });

  test('party-create-roundtrip', (t) => {
    if (!pgUp) {
      t.skip(pg.SKIP_REASON);
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
      t.skip(pg.SKIP_REASON);
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

  // Was `party-pause-transitions`.
  // used to assert: `pause` exits 0, status becomes "paused", paused_at is set.
  // asserts now: `pause` answers the typed removal and the session it named is
  // untouched — still "active", paused_at still null.
  test('party-pause-removed-session-untouched', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    assertRemovedVerbAnswer(runParty(['pause', sessionId, '--json']), 'pause', true);
    const getR = runParty(['get', sessionId, '--json']);
    assert.strictEqual(getR.status, 0, `get must exit 0; got: ${getR.status}\nstderr: ${getR.stderr}`);
    const parsed = JSON.parse(getR.stdout);
    assert.strictEqual(parsed.status, 'active', `the session must still be "active"; got: ${parsed.status}`);
    assert.ok(parsed.paused_at === null || parsed.paused_at === undefined,
      `paused_at must still be null; got: ${parsed.paused_at}`);
  });

  // Was `party-resume-transitions`.
  // used to assert: `resume` exits 0, status "active", paused_at null and a
  // `findings` array in the answer (the replay).
  // asserts now: `resume` answers the typed removal, and the findings array it
  // used to return is read with `get --with-findings`, with no transition.
  test('party-resume-removed-findings-via-get', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    assertRemovedVerbAnswer(runParty(['resume', sessionId, '--json']), 'resume', true);
    const r = runParty(['get', sessionId, '--json', '--with-findings']);
    assert.strictEqual(r.status, 0, `get --with-findings must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.status, 'active', `status must be "active"; got: ${parsed.status}`);
    assert.ok(Array.isArray(parsed.findings), `findings must be an array; got: ${typeof parsed.findings}`);
  });

  test('party-terminate-transitions', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
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

  // Was `party-invalid-transition-exit-1`.
  // used to assert: `terminate` on a session still "created" exits 1 with
  // InvalidTransitionError (created -> terminated was forbidden).
  // asserts now: nothing is refused because of the label. The session closes,
  // and closing it a second time is idempotent and keeps the closing time.
  test('party-terminate-from-created-is-not-refused', (t) => {
    if (!pgUp) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const createR = runParty(['create', '--participants', 'agent-a,agent-b', '--json']);
    assert.strictEqual(createR.status, 0, `create must exit 0; got: ${createR.status}\nstderr: ${createR.stderr}`);
    const newSessionId = JSON.parse(createR.stdout).session_id;

    const r = runParty(['terminate', newSessionId, '--json']);
    assert.strictEqual(r.status, 0, `created→terminate must exit 0; got: ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.strictEqual(parsed.status, 'terminated', `status must be "terminated"; got: ${parsed.status}`);
    assert.ok(parsed.terminated_at, 'terminated_at must be set');
    assert.strictEqual(parsed.schema_version, '1.0');
    assert.ok(!/InvalidTransitionError/.test(r.stdout + r.stderr), 'the transition error no longer exists');

    const again = runParty(['terminate', newSessionId, '--json']);
    assert.strictEqual(again.status, 0, `a second terminate must exit 0; got: ${again.status}\nstderr: ${again.stderr}`);
    assert.strictEqual(JSON.parse(again.stdout).terminated_at, parsed.terminated_at,
      'closing twice must not move the closing time');

    // A session id nobody created is still an error, typed and exit 1.
    const missing = runParty(['terminate', crypto.randomUUID(), '--json']);
    assert.strictEqual(missing.status, 1, `terminate on an unknown session must exit 1; got: ${missing.status}`);
    assert.strictEqual(JSON.parse(missing.stdout).error, 'SessionNotFoundError');
  });
});

// ─── Test 11: bin/cli.cjs party shortcut mirrors gsd-tools shape ──────────────

test('party-cli-shortcut-mirrors-tools', (t) => {
  if (!pgAvailable()) {
    t.skip(pg.SKIP_REASON);
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

// ─── Test 12: Phase 48 module case untouched canary ──────────────────────────

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

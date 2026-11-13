'use strict';
/**
 * Plan 50-04-01: party E2E test — converted by plan 89-13 (Phase 89 ORC-02
 * part 2) from a pause/resume lifecycle into a record-survives-restart test.
 *
 * End to end via the public CLI surface:
 *   create -> start -> post 3 findings -> an interruption (the removed `pause`
 *   answers typed and touches nothing) -> subprocess restart (SC4 Layer 2) ->
 *   read the record back with `get --with-findings` -> terminate ->
 *   the record is still readable + shortcut equivalence.
 *
 * SC4 Layer 2 evidence: the read-back is a FRESH node/python subprocess
 * (gsd-tools.cjs spawns party_session_cli.py). No in-memory state is carried
 * across the "daemon restart" boundary — persistence lives entirely in PG. It
 * asserts all 3 findings are returned with correct content, order, and agent
 * attribution, which is what `resume` used to return as its "replay".
 *
 * PG-down resilience: if PG is unavailable (detected via initial create probe)
 * the entire suite t.skip()'s cleanly. Canary test (50-04-02) has NO skip path.
 *
 * Run:
 *   node --test tests/party-e2e.test.cjs
 *
 * Phase 50 PARTY-01 + PARTY-02. Mirrors party-cli.test.cjs runner style.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');
const crypto = require('node:crypto');

// Phase 88 plan 88-15: spawn Python through the shared resolver (GSD_PYTHON,
// then py -3 / python / python3, each VERIFIED), never a literal name.
const platform = require('../get-shit-done/bin/lib/platform.cjs');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const CLI_ENTRY = path.join(ROOT, 'bin', 'cli.cjs');

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
const _ISOLATED_DSN = pg.createIsolatedDatabase('party_e2e');

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
      timeout: 30000,
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
      timeout: 30000,
      cwd: ROOT,
      env: partyEnv(),
    }
  );
}

/**
 * Detect whether PG is available by attempting a create call with a deterministic
 * participant list. Returns { pgUp: bool, sessionId: string | null }.
 * When PG is up, also returns the created session_id for re-use in the suite.
 */
function probeCreate() {
  const r = runParty([
    'create',
    '--participants', 'gsd-planner,gsd-checker,gsd-executor-backend',
    '--json',
  ]);

  // PG down: exit 2 with pg_io_error or OperationalError in output
  if (r.status === 2) {
    const combined = (r.stdout || '') + (r.stderr || '');
    if (combined.includes('pg_io_error') || combined.includes('OperationalError')) {
      return { pgUp: false, sessionId: null };
    }
  }

  // Unexpected failure
  if (r.status !== 0) {
    return { pgUp: false, sessionId: null };
  }

  // Parse session_id from JSON output
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (_e) {
    return { pgUp: false, sessionId: null };
  }

  if (
    parsed.schema_version === '1.0' &&
    parsed.status === 'created' &&
    typeof parsed.session_id === 'string' &&
    parsed.session_id.length === 36
  ) {
    return { pgUp: true, sessionId: parsed.session_id };
  }

  return { pgUp: false, sessionId: null };
}

/**
 * Post a finding via inline Python -c invocation. Returns the UUID string
 * of the inserted finding_id. Throws on failure.
 *
 * This invocation is a FRESH python3 subprocess — proving Python-level
 * import + PG connection is re-established per call (SC4 Layer 2 pattern).
 */
function postFinding(sessionId, agentName, findingType, content) {
  const script = [
    'import sys, os',
    `sys.path.insert(0, '${ROOT.replace(/'/g, "\\'")}')`,
    'from services.party_session import post_finding',
    `fid = post_finding(${JSON.stringify(sessionId)}, ${JSON.stringify(agentName)}, ${JSON.stringify(findingType)}, ${JSON.stringify(content)})`,
    'print(fid)',
  ].join('; ');

  const r = platform.spawnPython(['-c', script], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: ROOT,
    // Plan 88-16-09: these FRESH python children drive services/party_session.py,
    // which builds a PGStore and therefore needs the disposable DSN. The runner
    // deletes it from every child; partyEnv() reinstates the validated one.
    env: { ...partyEnv(), PYTHONPATH: ROOT },
  });

  if (r.status !== 0) {
    throw new Error(
      `post_finding failed (exit ${r.status}); stderr: ${r.stderr}; stdout: ${r.stdout}`
    );
  }

  const fid = (r.stdout || '').trim();
  if (!fid || fid.length !== 36) {
    throw new Error(
      `post_finding returned unexpected id: ${JSON.stringify(fid)}; stdout: ${r.stdout}`
    );
  }
  return fid;
}

// ─── E2E suite: all subtests share one session threaded via closure ────────────

describe('party-e2e (PG required)', (suite) => {
  let sessionId = null;
  let pgUp = false;
  let probeResult = null;

  before(() => {
    probeResult = probeCreate();
    pgUp = probeResult.pgUp;
    sessionId = probeResult.sessionId;
  });

  // ── 1. e2e-create-start ────────────────────────────────────────────────────
  // Note: session was already created by probeCreate() in before(). We capture
  // the session_id and then call start on it. This counts as the create step.

  test('e2e-create-start', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    // Verify the session created by probeCreate() has correct shape
    const getR = runParty(['get', sessionId, '--json']);
    assert.strictEqual(getR.status, 0, `get must exit 0; got: ${getR.status}\nstderr: ${getR.stderr}`);
    let createParsed;
    try { createParsed = JSON.parse(getR.stdout); } catch (e) {
      assert.fail(`get stdout must be valid JSON; got: ${getR.stdout}`);
    }
    assert.strictEqual(createParsed.status, 'created', `status must be "created"; got: ${createParsed.status}`);
    assert.ok(Array.isArray(createParsed.participants), 'participants must be an array');
    assert.strictEqual(createParsed.participants.length, 3,
      `participants must have 3 entries; got: ${createParsed.participants.length}`);

    // Now start the session
    const startR = runParty(['start', sessionId, '--json']);
    assert.strictEqual(startR.status, 0, `start must exit 0; got: ${startR.status}\nstderr: ${startR.stderr}`);
    let startParsed;
    try { startParsed = JSON.parse(startR.stdout); } catch (e) {
      assert.fail(`start stdout must be valid JSON; got: ${startR.stdout}`);
    }
    assert.strictEqual(startParsed.status, 'active',
      `status must be "active" after start; got: ${startParsed.status}`);
    assert.strictEqual(startParsed.session_id, sessionId, 'session_id must match after start');
  });

  // ── 2. e2e-post-three-findings ─────────────────────────────────────────────

  test('e2e-post-three-findings', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    // F1 from gsd-planner
    const f1 = postFinding(sessionId, 'gsd-planner', 'observation', 'Wave 1 done');
    assert.ok(typeof f1 === 'string' && f1.length === 36,
      `F1 finding_id must be 36-char UUID; got: ${JSON.stringify(f1)}`);

    // F2 from gsd-checker
    const f2 = postFinding(sessionId, 'gsd-checker', 'decision', 'Plan approved');
    assert.ok(typeof f2 === 'string' && f2.length === 36,
      `F2 finding_id must be 36-char UUID; got: ${JSON.stringify(f2)}`);

    // F3 from gsd-executor-backend
    const f3 = postFinding(sessionId, 'gsd-executor-backend', 'warning', 'Schema drift risk');
    assert.ok(typeof f3 === 'string' && f3.length === 36,
      `F3 finding_id must be 36-char UUID; got: ${JSON.stringify(f3)}`);

    // All 3 IDs must be distinct
    const ids = new Set([f1, f2, f3]);
    assert.strictEqual(ids.size, 3, `All 3 finding_ids must be distinct; got: ${f1}, ${f2}, ${f3}`);
  });

  // ── 3. e2e-interruption-leaves-session-intact ─────────────────────────────
  //
  // Was `e2e-pause`.
  // used to assert: `pause` exits 0, status "paused", paused_at set.
  // asserts now: work is interrupted with no verb at all. `pause` answers the
  // typed removal (exit 2) and the session is untouched: "active", paused_at null.

  test('e2e-interruption-leaves-session-intact', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const r = runParty(['pause', sessionId, '--json']);
    assert.strictEqual(r.status, 2, `pause must exit 2 (removed); got: ${r.status}\nstderr: ${r.stderr}`);
    const removed = JSON.parse(r.stdout);
    assert.strictEqual(removed.error, 'party_verb_removed', `error must be "party_verb_removed"; got: ${removed.error}`);
    assert.strictEqual(removed.action, 'pause');
    assert.match(removed.detail, /recorded decisions/);

    const getR = runParty(['get', sessionId, '--json']);
    assert.strictEqual(getR.status, 0, `get must exit 0; got: ${getR.status}\nstderr: ${getR.stderr}`);
    const parsed = JSON.parse(getR.stdout);
    assert.strictEqual(parsed.status, 'active',
      `status must still be "active"; got: ${parsed.status}`);
    assert.ok(
      parsed.paused_at === null || parsed.paused_at === undefined || parsed.paused_at === 'None',
      `paused_at must still be null; got: ${parsed.paused_at}`
    );
    assert.strictEqual(parsed.session_id, sessionId, 'session_id must match');
  });

  // ── 4. e2e-simulated-daemon-restart-read-back ─────────────────────────────
  //
  // Was `e2e-simulated-daemon-restart-resume`.
  // used to assert: a FRESH-process `resume` flips paused -> active and
  // replays the 3 findings in order with their agents.
  // asserts now: a FRESH node process -> FRESH python subprocess reads the
  // same 3 findings back, in order and attributed, with `get --with-findings`.
  // No in-memory state is shared with the processes that wrote them, and no
  // transition is needed to get the record.

  test('e2e-simulated-daemon-restart-read-back', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    // FRESH subprocess (node → gsd-tools.cjs → party_session_cli.py → psycopg2)
    const r = runParty(['get', sessionId, '--json', '--with-findings']);
    assert.strictEqual(r.status, 0, `get --with-findings must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`get stdout must be valid JSON; got: ${r.stdout}`);
    }

    assert.strictEqual(parsed.status, 'active',
      `status must be "active"; got: ${parsed.status}`);
    assert.strictEqual(parsed.session_id, sessionId, 'session_id must match');

    assert.ok(Array.isArray(parsed.findings),
      `findings must be an array; got: ${typeof parsed.findings}`);
    assert.strictEqual(parsed.findings.length, 3,
      `findings must have 3 entries; got: ${parsed.findings.length}`);

    // Order and content (ascending created_at order from PG)
    assert.strictEqual(parsed.findings[0].content, 'Wave 1 done',
      `findings[0].content must be "Wave 1 done"; got: ${parsed.findings[0].content}`);
    assert.strictEqual(parsed.findings[1].content, 'Plan approved',
      `findings[1].content must be "Plan approved"; got: ${parsed.findings[1].content}`);
    assert.strictEqual(parsed.findings[2].content, 'Schema drift risk',
      `findings[2].content must be "Schema drift risk"; got: ${parsed.findings[2].content}`);

    // Agent attribution
    assert.strictEqual(parsed.findings[0].agent_name, 'gsd-planner',
      `findings[0].agent_name must be "gsd-planner"; got: ${parsed.findings[0].agent_name}`);
    assert.strictEqual(parsed.findings[1].agent_name, 'gsd-checker',
      `findings[1].agent_name must be "gsd-checker"; got: ${parsed.findings[1].agent_name}`);
    assert.strictEqual(parsed.findings[2].agent_name, 'gsd-executor-backend',
      `findings[2].agent_name must be "gsd-executor-backend"; got: ${parsed.findings[2].agent_name}`);
  });

  // ── 5. e2e-terminate ──────────────────────────────────────────────────────

  test('e2e-terminate', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const r = runParty(['terminate', sessionId, '--json']);
    assert.strictEqual(r.status, 0, `terminate must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`terminate stdout must be valid JSON; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.status, 'terminated',
      `status must be "terminated"; got: ${parsed.status}`);
    assert.ok(
      parsed.terminated_at !== null && parsed.terminated_at !== undefined && parsed.terminated_at !== 'None',
      `terminated_at must not be null; got: ${parsed.terminated_at}`
    );
    assert.strictEqual(parsed.session_id, sessionId, 'session_id must match after terminate');
  });

  // ── 6. e2e-terminated-record-still-readable ──────────────────────────────
  //
  // Was `e2e-terminated-cannot-resume`.
  // used to assert: `resume` on the terminated session exits 1 with
  // InvalidTransitionError.
  // asserts now: `resume` answers the typed removal (exit 2) whatever the
  // session's label, the session stays "terminated", and `inspect` still
  // returns its 3 findings: closing a container deletes nothing.

  test('e2e-terminated-record-still-readable', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const r = runParty(['resume', sessionId, '--json']);
    assert.strictEqual(r.status, 2,
      `resume must exit 2 (removed); got: ${r.status}\nstdout: ${r.stdout}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`stdout must be valid JSON on exit 2; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.error, 'party_verb_removed',
      `error must be "party_verb_removed"; got: ${parsed.error}`);
    assert.ok(
      typeof parsed.detail === 'string' && parsed.detail.length > 0,
      `detail must be a non-empty string; got: ${parsed.detail}`
    );
    assert.strictEqual(parsed.schema_version, '1.0',
      `schema_version must be "1.0"; got: ${parsed.schema_version}`);

    const inspectR = runParty(['inspect', sessionId, '--json']);
    assert.strictEqual(inspectR.status, 0, `inspect must exit 0; got: ${inspectR.status}\nstderr: ${inspectR.stderr}`);
    const inspected = JSON.parse(inspectR.stdout);
    assert.strictEqual(inspected.session.status, 'terminated',
      `the session must still be "terminated"; got: ${inspected.session.status}`);
    assert.strictEqual(inspected.session.findings.length, 3,
      `the 3 findings must still be readable after the close; got: ${inspected.session.findings.length}`);
  });

  // ── 7. e2e-shortcut-equivalence ───────────────────────────────────────────
  //
  // Verify bin/cli.cjs party get --json --with-findings produces the same
  // shape as node gsd-tools.cjs party get --json --with-findings.
  // The terminated session still has its findings intact in PG.

  test('e2e-shortcut-equivalence', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const toolsR = runParty(['get', sessionId, '--json', '--with-findings']);
    const cliR = runCliParty(['get', sessionId, '--json', '--with-findings']);

    assert.strictEqual(toolsR.status, 0,
      `gsd-tools get must exit 0; got: ${toolsR.status}\nstderr: ${toolsR.stderr}`);
    assert.strictEqual(cliR.status, 0,
      `cli.cjs get must exit 0; got: ${cliR.status}\nstderr: ${cliR.stderr}`);

    let toolsParsed, cliParsed;
    try { toolsParsed = JSON.parse(toolsR.stdout); } catch (e) {
      assert.fail(`gsd-tools stdout must be valid JSON; got: ${toolsR.stdout}`);
    }
    try { cliParsed = JSON.parse(cliR.stdout); } catch (e) {
      assert.fail(`cli.cjs stdout must be valid JSON; got: ${cliR.stdout}`);
    }

    // Both must reflect "terminated" status
    assert.strictEqual(toolsParsed.status, 'terminated',
      `gsd-tools status must be "terminated"; got: ${toolsParsed.status}`);
    assert.strictEqual(cliParsed.status, 'terminated',
      `cli.cjs status must be "terminated"; got: ${cliParsed.status}`);

    // Both must return findings array with 3 entries
    assert.ok(Array.isArray(toolsParsed.findings),
      `gsd-tools findings must be an array; got: ${typeof toolsParsed.findings}`);
    assert.ok(Array.isArray(cliParsed.findings),
      `cli.cjs findings must be an array; got: ${typeof cliParsed.findings}`);
    assert.strictEqual(toolsParsed.findings.length, 3,
      `gsd-tools findings must have 3 entries; got: ${toolsParsed.findings.length}`);
    assert.strictEqual(cliParsed.findings.length, 3,
      `cli.cjs findings must have 3 entries; got: ${cliParsed.findings.length}`);

    // Both return same schema_version
    assert.strictEqual(toolsParsed.schema_version, '1.0',
      `gsd-tools schema_version must be "1.0"; got: ${toolsParsed.schema_version}`);
    assert.strictEqual(cliParsed.schema_version, '1.0',
      `cli.cjs schema_version must be "1.0"; got: ${cliParsed.schema_version}`);
  });
});

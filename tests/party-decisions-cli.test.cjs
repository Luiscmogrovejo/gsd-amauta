'use strict';
/**
 * Plan 51-03-03: party CLI integration tests for status/inspect and the
 * decision trail — converted by plan 89-13 (Phase 89 ORC-02 part 2). `kill` is
 * removed with `pause` and `resume`; a session is closed with `terminate`, and
 * the reason for closing it is a recorded decision. Each converted subtest says
 * what it used to assert.
 *
 * Subtests:
 *   1.  help-lists-all-6-actions       — no PG required (was help-lists-all-9)
 *   2.  unknown-action-exits-2         — no PG required
 *   3.  status-empty-or-json-shape     — PG gated
 *   4.  status-sorted-by-updated-at    — PG gated
 *   5.  inspect-frozen-shape           — PG gated
 *   6.  inspect-not-found-exit-1       — PG gated
 *   7.  terminate-closes-and-reason-is-a-decision — PG gated (was kill-terminates-and-audits)
 *   8.  terminate-twice-is-idempotent-kill-is-removed — PG gated (was kill-already-terminated-exit-1)
 *   9.  cli-removed-verb-shortcut-mirrors-tools   — PG gated (was cli-kill-shortcut)
 *  10.  known-actions-canary           — no PG required
 *  11.  action-lists-agree             — no PG required (new)
 *
 * PG-down resilience: subtests 1, 2, 10, 11 run unconditionally.
 * Subtests 3–9 skip when PG is unavailable (pgAvailable() probe in before()).
 *
 * Run: node --test tests/party-decisions-cli.test.cjs
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');

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
const _ISOLATED_DSN = pg.createIsolatedDatabase('party_dec_cli');

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
 * Detect whether PG is available by attempting a get on a bogus UUID.
 * Returns true when PG is reachable; false when PG is down.
 */
function pgAvailable() {
  const bogusId = crypto.randomUUID();
  const r = runParty(['get', bogusId, '--json']);
  if (r.status === 2) {
    const combined = (r.stdout || '') + (r.stderr || '');
    if (combined.includes('pg_io_error') || combined.includes('OperationalError')) {
      return false;
    }
  }
  if (r.status === 1) {
    try {
      const parsed = JSON.parse(r.stdout);
      if (parsed.error === 'SessionNotFoundError') {
        return true;
      }
    } catch (_e) { /* fall through */ }
  }
  return r.status === 1;
}

/**
 * Post a decision via inline Python -c invocation. Returns the UUID string
 * of the inserted finding_id. Throws on failure.
 *
 * Mirrors postFinding helper from tests/party-e2e.test.cjs (SC4 Layer 2 pattern).
 */
function postDecisionViaPython(sessionId, agentName, decisionType, content) {
  const script = [
    'import sys, os',
    `sys.path.insert(0, '${ROOT.replace(/'/g, "\\'")}')`,
    'from services.party_session import post_decision',
    `fid = post_decision(${JSON.stringify(sessionId)}, ${JSON.stringify(agentName)}, ${JSON.stringify(decisionType)}, ${JSON.stringify(content)})`,
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
      `post_decision failed (exit ${r.status}); stderr: ${r.stderr}; stdout: ${r.stdout}`
    );
  }

  const fid = (r.stdout || '').trim();
  if (!fid || fid.length !== 36) {
    throw new Error(
      `post_decision returned unexpected id: ${JSON.stringify(fid)}; stdout: ${r.stdout}`
    );
  }
  return fid;
}

/** The six actions plan 89-13 left, in help order; and the three it removed. */
const ACTIONS = ['create', 'start', 'terminate', 'get', 'status', 'inspect'];
const REMOVED_VERBS = ['pause', 'resume', 'kill'];

// ─── Test 1: unconditional — help lists the 6 actions, and only those ────────
//
// Was `party-decisions-help-lists-all-9`.
// used to assert: the usage banner names all nine actions.
// asserts now: it names the six that exist and offers none of the three removed.

test('party-decisions-help-lists-all-6', (t) => {
  const r = runParty([]);
  assert.strictEqual(r.status, 2, `must exit 2 when no args; got: ${r.status}`);
  assert.ok(
    r.stderr.includes('Usage:'),
    `stderr must contain "Usage:"; got: ${r.stderr.slice(0, 300)}`
  );
  for (const action of ACTIONS) {
    assert.ok(
      r.stderr.includes(`gsd-tools party ${action}`),
      `stderr usage banner must include action "${action}"; got: ${r.stderr.slice(0, 500)}`
    );
  }
  for (const verb of REMOVED_VERBS) {
    assert.ok(
      !new RegExp(`party ${verb}\\b`).test(r.stderr),
      `stderr usage banner must not offer the removed verb "${verb}"; got: ${r.stderr.slice(0, 500)}`
    );
  }
});

// ─── Test 2: unconditional — unknown action exits 2 ──────────────────────────

test('party-decisions-unknown-action-exit-2', (t) => {
  const r = runParty(['bogusaction']);
  assert.strictEqual(r.status, 2, `must exit 2 for unknown action; got: ${r.status}`);
  assert.ok(
    r.stderr.includes('Unknown party action: bogusaction'),
    `stderr must contain "Unknown party action: bogusaction"; got: ${r.stderr.slice(0, 300)}`
  );
});

// ─── Tests 3–9: PG-gated ─────────────────────────────────────────────────────

describe('party-decisions-pg-gated', (suite) => {
  let _pgUp = false;

  before(() => {
    _pgUp = pgAvailable();
  });

  // ── Test 3: status --json shape ─────────────────────────────────────────────

  test('party-status-empty-or-json-shape', (t) => {
    if (!_pgUp) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const r = runParty(['status', '--json']);
    assert.strictEqual(r.status, 0, `status --json must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.schema_version, '1.0', `schema_version must be "1.0"; got: ${parsed.schema_version}`);
    assert.ok(Array.isArray(parsed.sessions), `sessions must be an array; got: ${typeof parsed.sessions}`);
    if (parsed.sessions.length > 0) {
      for (const row of parsed.sessions) {
        assert.ok(typeof row.session_id === 'string', `session_id must be a string; got: ${row.session_id}`);
        assert.ok(typeof row.status === 'string', `status must be a string; got: ${row.status}`);
        assert.ok(typeof row.participant_count === 'number', `participant_count must be a number; got: ${row.participant_count}`);
        assert.ok(typeof row.decisions === 'object' && row.decisions !== null, 'decisions must be an object');
        assert.ok('propose' in row.decisions, 'decisions must have propose key');
        assert.ok('agree' in row.decisions, 'decisions must have agree key');
        assert.ok('dissent' in row.decisions, 'decisions must have dissent key');
        assert.ok('block' in row.decisions, 'decisions must have block key');
        assert.ok(typeof row.created_at === 'string', `created_at must be a string; got: ${row.created_at}`);
        assert.ok(typeof row.updated_at === 'string', `updated_at must be a string; got: ${row.updated_at}`);
      }
    }
  });

  // ── Test 4: status sorted by updated_at DESC ────────────────────────────────

  test('party-status-sorted-by-updated-at-desc', (t) => {
    if (!_pgUp) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    // Create session A
    const rA = runParty(['create', '--participants', 'agent-a,agent-b', '--json']);
    assert.strictEqual(rA.status, 0, `create A must exit 0; got: ${rA.status}`);
    let sidA;
    try { sidA = JSON.parse(rA.stdout).session_id; } catch (e) {
      assert.fail(`create A stdout must be valid JSON; got: ${rA.stdout}`);
    }

    // Create session B shortly after
    const rB = runParty(['create', '--participants', 'agent-c,agent-d', '--json']);
    assert.strictEqual(rB.status, 0, `create B must exit 0; got: ${rB.status}`);
    let sidB;
    try { sidB = JSON.parse(rB.stdout).session_id; } catch (e) {
      assert.fail(`create B stdout must be valid JSON; got: ${rB.stdout}`);
    }

    // Call status and assert sidB (more recent) appears at or before sidA
    const rStatus = runParty(['status', '--json']);
    assert.strictEqual(rStatus.status, 0, `status must exit 0; got: ${rStatus.status}`);
    let statusParsed;
    try { statusParsed = JSON.parse(rStatus.stdout); } catch (e) {
      assert.fail(`status stdout must be valid JSON; got: ${rStatus.stdout}`);
    }
    assert.ok(Array.isArray(statusParsed.sessions), 'sessions must be an array');
    assert.ok(statusParsed.sessions.length >= 2, `sessions must have at least 2 entries; got: ${statusParsed.sessions.length}`);

    const ids = statusParsed.sessions.map((s) => s.session_id);
    const idxA = ids.indexOf(sidA);
    const idxB = ids.indexOf(sidB);
    assert.ok(idxA >= 0, `session A (${sidA}) must appear in status output`);
    assert.ok(idxB >= 0, `session B (${sidB}) must appear in status output`);
    // B was created after A; sorted by updated_at DESC means B should be before A
    assert.ok(
      idxB <= idxA,
      `session B (more recently updated) must appear at or before session A in DESC order; idxB=${idxB}, idxA=${idxA}`
    );
  });

  // ── Test 5: inspect frozen shape ────────────────────────────────────────────

  test('party-inspect-frozen-shape', (t) => {
    if (!_pgUp) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    // Create + start a session
    const rCreate = runParty(['create', '--participants', 'agent-x,agent-y', '--json']);
    assert.strictEqual(rCreate.status, 0, `create must exit 0; got: ${rCreate.status}`);
    let sid;
    try { sid = JSON.parse(rCreate.stdout).session_id; } catch (e) {
      assert.fail(`create stdout must be valid JSON; got: ${rCreate.stdout}`);
    }
    const rStart = runParty(['start', sid, '--json']);
    assert.strictEqual(rStart.status, 0, `start must exit 0; got: ${rStart.status}`);

    // Post 2 decisions via Python inline
    postDecisionViaPython(sid, 'agent-x', 'propose', 'I propose option A');
    postDecisionViaPython(sid, 'agent-y', 'agree', 'I agree with option A');

    // Call inspect
    const rInspect = runParty(['inspect', sid, '--json']);
    assert.strictEqual(rInspect.status, 0, `inspect must exit 0; got: ${rInspect.status}\nstderr: ${rInspect.stderr}`);
    let parsed;
    try {
      parsed = JSON.parse(rInspect.stdout);
    } catch (e) {
      assert.fail(`inspect stdout must be valid JSON; got: ${rInspect.stdout}`);
    }

    // schema_version
    assert.strictEqual(parsed.schema_version, '1.0', `schema_version must be "1.0"; got: ${parsed.schema_version}`);

    // session: 9 Phase 50 keys
    const sessionKeys = ['schema_version', 'session_id', 'status', 'participants', 'created_at', 'updated_at', 'paused_at', 'terminated_at', 'findings'];
    for (const k of sessionKeys) {
      assert.ok(k in parsed.session, `session must have key "${k}"; got keys: ${Object.keys(parsed.session).join(', ')}`);
    }

    // decision_trail: 2 entries with correct shape
    assert.ok(Array.isArray(parsed.decision_trail), 'decision_trail must be an array');
    assert.strictEqual(parsed.decision_trail.length, 2, `decision_trail must have 2 entries; got: ${parsed.decision_trail.length}`);
    for (const entry of parsed.decision_trail) {
      assert.ok(typeof entry.finding_id === 'string', `finding_id must be a string; got: ${entry.finding_id}`);
      assert.ok(typeof entry.agent_name === 'string', `agent_name must be a string; got: ${entry.agent_name}`);
      assert.ok(typeof entry.decision_type === 'string', `decision_type must be a string; got: ${entry.decision_type}`);
      assert.ok(typeof entry.content === 'string', `content must be a string; got: ${entry.content}`);
      assert.ok(typeof entry.confidence === 'number', `confidence must be a number; got: ${entry.confidence}`);
      assert.ok(typeof entry.created_at === 'string', `created_at must be a string; got: ${entry.created_at}`);
    }

    // decision_summary: 4 keys with correct counts
    assert.ok(typeof parsed.decision_summary === 'object' && parsed.decision_summary !== null, 'decision_summary must be an object');
    assert.strictEqual(parsed.decision_summary.propose, 1, `propose count must be 1; got: ${parsed.decision_summary.propose}`);
    assert.strictEqual(parsed.decision_summary.agree, 1, `agree count must be 1; got: ${parsed.decision_summary.agree}`);
    assert.strictEqual(parsed.decision_summary.dissent, 0, `dissent count must be 0; got: ${parsed.decision_summary.dissent}`);
    assert.strictEqual(parsed.decision_summary.block, 0, `block count must be 0; got: ${parsed.decision_summary.block}`);
  });

  // ── Test 6: inspect not-found exits 1 ───────────────────────────────────────

  test('party-inspect-not-found-exit-1', (t) => {
    if (!_pgUp) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const r = runParty(['inspect', '00000000-0000-0000-0000-000000000000', '--json']);
    assert.strictEqual(r.status, 1, `inspect non-existent session must exit 1; got: ${r.status}`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON on exit 1; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.error, 'SessionNotFoundError', `error must be "SessionNotFoundError"; got: ${parsed.error}`);
  });

  // ── Test 7: terminate closes the session; the reason is a recorded decision ──
  //
  // Was `party-kill-terminates-and-audits`.
  // used to assert: `kill --reason` terminates the session and writes an
  // audit finding (finding_type 'kill', agent 'operator') that is visible in
  // session.findings and absent from decision_trail.
  // asserts now: the operator's reason is posted as a `block` decision and the
  // session is closed with `terminate`; the reason is IN the decision trail,
  // attributed to the operator, last in order, counted in the summary, and
  // still readable after the close.

  test('party-terminate-closes-and-reason-is-a-decision', (t) => {
    if (!_pgUp) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const rCreate = runParty(['create', '--participants', 'agent-kill-1,agent-kill-2', '--json']);
    assert.strictEqual(rCreate.status, 0, `create must exit 0; got: ${rCreate.status}`);
    const sid = JSON.parse(rCreate.stdout).session_id;
    const rStart = runParty(['start', sid, '--json']);
    assert.strictEqual(rStart.status, 0, `start must exit 0; got: ${rStart.status}`);

    postDecisionViaPython(sid, 'agent-kill-1', 'propose', 'Keep going');
    const reasonId = postDecisionViaPython(sid, 'operator', 'block', 'Session closed by operator. Reason: SC2 demo');

    const rTerminate = runParty(['terminate', sid, '--json']);
    assert.strictEqual(rTerminate.status, 0, `terminate must exit 0; got: ${rTerminate.status}\nstderr: ${rTerminate.stderr}`);
    const closed = JSON.parse(rTerminate.stdout);
    assert.strictEqual(closed.status, 'terminated', `status must be "terminated"; got: ${closed.status}`);
    assert.ok(closed.terminated_at !== null && closed.terminated_at !== undefined, 'terminated_at must not be null');

    const rInspect = runParty(['inspect', sid, '--json']);
    assert.strictEqual(rInspect.status, 0, `inspect after terminate must exit 0; got: ${rInspect.status}`);
    const inspectParsed = JSON.parse(rInspect.stdout);
    assert.strictEqual(inspectParsed.session.status, 'terminated');

    const trail = inspectParsed.decision_trail || [];
    assert.strictEqual(trail.length, 2, `decision_trail must hold both decisions; trail: ${JSON.stringify(trail)}`);
    assert.deepStrictEqual(trail.map((e) => [e.agent_name, e.decision_type]),
      [['agent-kill-1', 'propose'], ['operator', 'block']], 'the trail is ordered and attributed');
    assert.strictEqual(trail[1].finding_id, reasonId, 'the closing reason is the decision the operator posted');
    assert.ok(trail[1].content.includes('Reason: SC2 demo'), `the reason must be readable; got: ${trail[1].content}`);
    assert.deepStrictEqual(inspectParsed.decision_summary, { propose: 1, agree: 0, dissent: 0, block: 1 });

    // No 'kill' audit row exists any more: nothing writes one.
    const findings = inspectParsed.session.findings || [];
    assert.ok(!findings.some((f) => f.finding_type === 'kill'),
      `no finding_type='kill' row may be written; findings: ${JSON.stringify(findings.map((f) => f.finding_type))}`);
  });

  // ── Test 8: terminate twice is idempotent; kill is a removed verb ───────────
  //
  // Was `party-kill-already-terminated-exit-1`.
  // used to assert: a second `kill` exits 1 with InvalidTransitionError.
  // asserts now: `kill` answers the typed removal (exit 2) and changes
  // nothing; a second `terminate` exits 0 and keeps the closing time.

  test('party-terminate-twice-is-idempotent-kill-is-removed', (t) => {
    if (!_pgUp) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const rCreate = runParty(['create', '--participants', 'agent-double-kill-1,agent-double-kill-2', '--json']);
    assert.strictEqual(rCreate.status, 0, `create must exit 0; got: ${rCreate.status}`);
    const sid = JSON.parse(rCreate.stdout).session_id;
    assert.strictEqual(runParty(['start', sid, '--json']).status, 0, 'start must exit 0');

    const rKill = runParty(['kill', sid, '--json']);
    assert.strictEqual(rKill.status, 2, `kill must exit 2 (removed); got: ${rKill.status}`);
    const killParsed = JSON.parse(rKill.stdout);
    assert.strictEqual(killParsed.error, 'party_verb_removed', `error must be "party_verb_removed"; got: ${killParsed.error}`);
    assert.strictEqual(killParsed.action, 'kill');
    assert.match(killParsed.detail, /party terminate/, 'the answer must name the verb that closes a session');
    assert.strictEqual(JSON.parse(runParty(['get', sid, '--json']).stdout).status, 'active',
      'a removed verb must leave the session untouched');

    const first = runParty(['terminate', sid, '--json']);
    assert.strictEqual(first.status, 0, `first terminate must exit 0; got: ${first.status}`);
    const second = runParty(['terminate', sid, '--json']);
    assert.strictEqual(second.status, 0, `second terminate must exit 0; got: ${second.status}\nstdout: ${second.stdout}`);
    const secondParsed = JSON.parse(second.stdout);
    assert.strictEqual(secondParsed.status, 'terminated');
    assert.strictEqual(secondParsed.terminated_at, JSON.parse(first.stdout).terminated_at,
      'closing twice must not move the closing time');
    assert.ok(!/InvalidTransitionError/.test(second.stdout + second.stderr), 'the transition error no longer exists');
  });

  // ── Test 9: bin/cli.cjs party shortcut mirrors gsd-tools, removed verb and all ──
  //
  // Was `party-cli-kill-shortcut-mirrors-tools`.
  // used to assert: `bin/cli.cjs party kill` terminates the session like gsd-tools does.
  // asserts now: `bin/cli.cjs party kill` gives the SAME typed removal and exit
  // code as gsd-tools, and `bin/cli.cjs party terminate` closes the session.

  test('party-cli-removed-verb-shortcut-mirrors-tools', (t) => {
    if (!_pgUp) {
      t.skip(pg.SKIP_REASON);
      return;
    }
    const rCreate = runParty(['create', '--participants', 'cli-shortcut-1,cli-shortcut-2', '--json']);
    assert.strictEqual(rCreate.status, 0, `create must exit 0; got: ${rCreate.status}`);
    const sid = JSON.parse(rCreate.stdout).session_id;
    assert.strictEqual(runParty(['start', sid, '--json']).status, 0, 'start must exit 0');

    const rToolsKill = runParty(['kill', sid, '--reason', 'via gsd-tools', '--json']);
    const rCliKill = runCliParty(['kill', sid, '--reason', 'via bin/cli.cjs', '--json']);
    assert.strictEqual(rCliKill.status, 2, `bin/cli.cjs party kill must exit 2 (removed); got: ${rCliKill.status}\nstderr: ${rCliKill.stderr}`);
    assert.strictEqual(rCliKill.status, rToolsKill.status, 'the shortcut must propagate the exit code');
    assert.deepStrictEqual(JSON.parse(rCliKill.stdout), JSON.parse(rToolsKill.stdout),
      'the shortcut must give the same typed answer');

    const rCliTerminate = runCliParty(['terminate', sid, '--json']);
    assert.strictEqual(rCliTerminate.status, 0, `bin/cli.cjs party terminate must exit 0; got: ${rCliTerminate.status}\nstderr: ${rCliTerminate.stderr}`);
    const cliParsed = JSON.parse(rCliTerminate.stdout);
    assert.strictEqual(cliParsed.status, 'terminated', `status must be "terminated"; got: ${cliParsed.status}`);
    assert.strictEqual(cliParsed.schema_version, '1.0', `schema_version must be "1.0"; got: ${cliParsed.schema_version}`);
  });

});

// ─── Test 10: unconditional — Phase 50 known-actions canary ──────────────────

test('phase-50-known-actions-canary', () => {
  const src = fs.readFileSync(TOOLS, 'utf8');

  // Exactly 1 "case 'party':" in the file
  const partyMatches = (src.match(/case 'party':/g) || []).length;
  assert.strictEqual(
    partyMatches,
    1,
    `Expected exactly 1 "case 'party':" in gsd-tools.cjs; got: ${partyMatches}`
  );

  // KNOWN_ACTIONS Set contains exactly the 6 actions plan 89-13 left, in order
  // (it held 9 until then: pause, resume and kill are removed).
  const expectedSubstring = "new Set(['create', 'start', 'terminate', 'get', 'status', 'inspect'])";
  assert.ok(
    src.includes(expectedSubstring),
    `gsd-tools.cjs must contain the exact KNOWN_ACTIONS substring:\n  ${expectedSubstring}\n` +
    `Got substring missing or different in file.`
  );
});

// ─── Test 11: unconditional — the three surfaces carry ONE action list ───────
//
// Plan 89-13: the Python subparsers, gsd-tools' KNOWN_ACTIONS and the usage text
// must be the same list, and the removed verbs must be the same three on both
// sides. Read from the code, not restated.

test('party-action-lists-agree', () => {
  // Everything below `case 'party':` — the module case has a KNOWN_ACTIONS of its own.
  const whole = fs.readFileSync(TOOLS, 'utf8');
  const src = whole.slice(whole.indexOf("case 'party':"));

  const known = /const KNOWN_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(known, 'KNOWN_ACTIONS not found in gsd-tools.cjs');
  const knownActions = known[1].split(',').map((x) => x.trim().replace(/'/g, ''));
  assert.deepStrictEqual(knownActions, ACTIONS, 'KNOWN_ACTIONS is not the six surviving actions');

  // The one-line usage of the unknown-action branch.
  const oneLine = /gsd-tools party ([a-z|]+) <args\.\.\.>/.exec(src);
  assert.ok(oneLine, 'the one-line party usage was not found');
  assert.deepStrictEqual(oneLine[1].split('|'), ACTIONS, 'the one-line usage disagrees with KNOWN_ACTIONS');

  // The multi-line usage, as the tool prints it.
  const usage = runParty([]).stderr;
  const usageActions = [...usage.matchAll(/gsd-tools party ([a-z]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(usageActions, ACTIONS, `the usage text disagrees with KNOWN_ACTIONS: ${usage}`);

  // The Python CLI: its argparse choices, and its ACTIONS / REMOVED_ACTIONS constants.
  const script = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'services'))})`,
    'import party_session_cli as c',
    'sub = [a for a in c.build_parser()._actions if a.dest == "action"][0]',
    'print(json.dumps({"choices": list(sub.choices), "actions": list(c.ACTIONS), "removed": sorted(c.REMOVED_ACTIONS)}))',
  ].join('; ');
  const py = platform.spawnPython(['-c', script], { encoding: 'utf8', timeout: 30000, cwd: ROOT });
  assert.strictEqual(py.status, 0, `the Python CLI must import; stderr: ${py.stderr}`);
  const got = JSON.parse(py.stdout);
  assert.deepStrictEqual(got.choices, ACTIONS, 'the Python subparsers disagree with KNOWN_ACTIONS');
  assert.deepStrictEqual(got.actions, ACTIONS, 'party_session_cli.ACTIONS disagrees with its own subparsers');
  assert.deepStrictEqual(got.removed, [...REMOVED_VERBS].sort(), 'the Python removed-verb list is not pause/resume/kill');

  const removed = /const REMOVED_ACTIONS = \{([\s\S]*?)\n      \};/.exec(src);
  assert.ok(removed, 'REMOVED_ACTIONS not found in gsd-tools.cjs');
  const removedKeys = [...removed[1].matchAll(/^\s{8}([a-z]+):/gm)].map((m) => m[1]);
  assert.deepStrictEqual(removedKeys.sort(), [...REMOVED_VERBS].sort(), 'the Node removed-verb list is not pause/resume/kill');
  for (const verb of REMOVED_VERBS) {
    assert.ok(!knownActions.includes(verb), `"${verb}" is both removed and known`);
  }
});

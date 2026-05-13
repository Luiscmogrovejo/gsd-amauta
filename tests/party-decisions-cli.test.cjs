'use strict';
/**
 * Plan 51-03-03: party CLI integration tests for status/inspect/kill + exit codes.
 *
 * Tests the 3 new Phase 51 PARTY-04 subcommands dispatched via gsd-tools.cjs
 * and the bin/cli.cjs party shortcut. Also includes a canary asserting the
 * Phase 50 6-action baseline is preserved alongside the 3 new actions.
 *
 * Subtests:
 *   1.  help-lists-all-9-actions       — no PG required
 *   2.  unknown-action-exits-2         — no PG required
 *   3.  status-empty-or-json-shape     — PG gated
 *   4.  status-sorted-by-updated-at    — PG gated
 *   5.  inspect-frozen-shape           — PG gated
 *   6.  inspect-not-found-exit-1       — PG gated
 *   7.  kill-terminates-and-audits     — PG gated
 *   8.  kill-already-terminated-exit-1 — PG gated
 *   9.  cli-kill-shortcut              — PG gated
 *  10.  known-actions-canary           — no PG required
 *
 * PG-down resilience: subtests 1, 2, 10 run unconditionally.
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
      timeout: 30000,
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
      timeout: 30000,
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

  const r = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: ROOT },
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

// ─── Test 1: unconditional — help lists all 9 actions ────────────────────────

test('party-decisions-help-lists-all-9', (t) => {
  const r = runParty([]);
  assert.strictEqual(r.status, 2, `must exit 2 when no args; got: ${r.status}`);
  assert.ok(
    r.stderr.includes('Usage:'),
    `stderr must contain "Usage:"; got: ${r.stderr.slice(0, 300)}`
  );
  const allActions = ['create', 'start', 'pause', 'resume', 'terminate', 'get', 'status', 'inspect', 'kill'];
  for (const action of allActions) {
    assert.ok(
      r.stderr.includes(action),
      `stderr usage banner must include action "${action}"; got: ${r.stderr.slice(0, 500)}`
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
      t.skip('PG unavailable — skipping');
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
      t.skip('PG unavailable — skipping');
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
      t.skip('PG unavailable — skipping');
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
      t.skip('PG unavailable — skipping');
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

  // ── Test 7: kill terminates session and posts audit finding ─────────────────

  test('party-kill-terminates-and-audits', (t) => {
    if (!_pgUp) {
      t.skip('PG unavailable — skipping');
      return;
    }
    // Create + start a fresh session
    const rCreate = runParty(['create', '--participants', 'agent-kill-1,agent-kill-2', '--json']);
    assert.strictEqual(rCreate.status, 0, `create must exit 0; got: ${rCreate.status}`);
    let sid;
    try { sid = JSON.parse(rCreate.stdout).session_id; } catch (e) {
      assert.fail(`create stdout must be valid JSON; got: ${rCreate.stdout}`);
    }
    const rStart = runParty(['start', sid, '--json']);
    assert.strictEqual(rStart.status, 0, `start must exit 0; got: ${rStart.status}`);

    // Kill the session with a reason
    const rKill = runParty(['kill', sid, '--reason', 'SC2 demo', '--json']);
    assert.strictEqual(rKill.status, 0, `kill must exit 0; got: ${rKill.status}\nstderr: ${rKill.stderr}`);
    let killParsed;
    try {
      killParsed = JSON.parse(rKill.stdout);
    } catch (e) {
      assert.fail(`kill stdout must be valid JSON; got: ${rKill.stdout}`);
    }

    // Assert session is terminated
    assert.strictEqual(killParsed.session.status, 'terminated', `session.status must be "terminated"; got: ${killParsed.session.status}`);
    assert.ok(
      killParsed.session.terminated_at !== null && killParsed.session.terminated_at !== undefined,
      'session.terminated_at must not be null'
    );

    // Assert audit_finding_id is a UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.ok(
      typeof killParsed.audit_finding_id === 'string' && uuidRegex.test(killParsed.audit_finding_id),
      `audit_finding_id must be a UUID; got: ${killParsed.audit_finding_id}`
    );
    assert.strictEqual(killParsed.reason, 'SC2 demo', `reason must be "SC2 demo"; got: ${killParsed.reason}`);

    // Verify via inspect: kill audit row appears in session.findings with correct fields
    const rInspect = runParty(['inspect', sid, '--json']);
    assert.strictEqual(rInspect.status, 0, `inspect after kill must exit 0; got: ${rInspect.status}`);
    let inspectParsed;
    try {
      inspectParsed = JSON.parse(rInspect.stdout);
    } catch (e) {
      assert.fail(`inspect stdout must be valid JSON; got: ${rInspect.stdout}`);
    }

    // Find the kill audit row in session.findings
    const findings = inspectParsed.session.findings || [];
    const killRow = findings.find((f) => f.finding_type === 'kill' && f.agent_name === 'operator');
    assert.ok(killRow !== undefined, `session.findings must contain a row with finding_type='kill' and agent_name='operator'; findings: ${JSON.stringify(findings.map((f) => ({ ft: f.finding_type, an: f.agent_name })))}`);
    assert.ok(
      typeof killRow.content === 'string' && killRow.content.includes('Session killed by operator. Reason: SC2 demo'),
      `kill row content must include "Session killed by operator. Reason: SC2 demo"; got: ${killRow.content}`
    );

    // Kill audit row must NOT appear in decision_trail (decision_type is NULL)
    const trail = inspectParsed.decision_trail || [];
    const killInTrail = trail.find((e) => e.agent_name === 'operator' && (e.decision_type === 'kill' || e.content.includes('Session killed')));
    assert.ok(killInTrail === undefined, `kill audit row must NOT appear in decision_trail; trail: ${JSON.stringify(trail)}`);
  });

  // ── Test 8: kill already-terminated exits 1 ─────────────────────────────────

  test('party-kill-already-terminated-exit-1', (t) => {
    if (!_pgUp) {
      t.skip('PG unavailable — skipping');
      return;
    }
    // Create + start + kill a session
    const rCreate = runParty(['create', '--participants', 'agent-double-kill-1,agent-double-kill-2', '--json']);
    assert.strictEqual(rCreate.status, 0, `create must exit 0; got: ${rCreate.status}`);
    let sid;
    try { sid = JSON.parse(rCreate.stdout).session_id; } catch (e) {
      assert.fail(`create stdout must be valid JSON; got: ${rCreate.stdout}`);
    }
    const rStart = runParty(['start', sid, '--json']);
    assert.strictEqual(rStart.status, 0, `start must exit 0; got: ${rStart.status}`);

    // First kill — must succeed
    const rKill1 = runParty(['kill', sid, '--json']);
    assert.strictEqual(rKill1.status, 0, `first kill must exit 0; got: ${rKill1.status}`);

    // Second kill — must exit 1 with InvalidTransitionError
    const rKill2 = runParty(['kill', sid, '--json']);
    assert.strictEqual(rKill2.status, 1, `second kill must exit 1; got: ${rKill2.status}`);
    let parsed;
    try {
      parsed = JSON.parse(rKill2.stdout);
    } catch (e) {
      assert.fail(`second kill stdout must be valid JSON; got: ${rKill2.stdout}`);
    }
    assert.strictEqual(parsed.error, 'InvalidTransitionError', `error must be "InvalidTransitionError"; got: ${parsed.error}`);
  });

  // ── Test 9: bin/cli.cjs party kill shortcut mirrors gsd-tools ───────────────

  test('party-cli-kill-shortcut-mirrors-tools', (t) => {
    if (!_pgUp) {
      t.skip('PG unavailable — skipping');
      return;
    }
    // Create + start a fresh session
    const rCreate = runParty(['create', '--participants', 'cli-shortcut-1,cli-shortcut-2', '--json']);
    assert.strictEqual(rCreate.status, 0, `create must exit 0; got: ${rCreate.status}`);
    let sid;
    try { sid = JSON.parse(rCreate.stdout).session_id; } catch (e) {
      assert.fail(`create stdout must be valid JSON; got: ${rCreate.stdout}`);
    }
    const rStart = runParty(['start', sid, '--json']);
    assert.strictEqual(rStart.status, 0, `start must exit 0; got: ${rStart.status}`);

    // Kill via bin/cli.cjs party kill
    const rCliKill = runCliParty(['kill', sid, '--reason', 'via bin/cli.cjs', '--json']);
    assert.strictEqual(rCliKill.status, 0, `bin/cli.cjs party kill must exit 0; got: ${rCliKill.status}\nstderr: ${rCliKill.stderr}`);
    let cliParsed;
    try {
      cliParsed = JSON.parse(rCliKill.stdout);
    } catch (e) {
      assert.fail(`bin/cli.cjs kill stdout must be valid JSON; got: ${rCliKill.stdout}`);
    }
    assert.strictEqual(cliParsed.session.status, 'terminated', `session.status must be "terminated"; got: ${cliParsed.session.status}`);
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

  // KNOWN_ACTIONS Set contains all 9 actions in the frozen order
  const expectedSubstring = "'create', 'start', 'pause', 'resume', 'terminate', 'get', 'status', 'inspect', 'kill'";
  assert.ok(
    src.includes(expectedSubstring),
    `gsd-tools.cjs must contain the exact KNOWN_ACTIONS substring:\n  ${expectedSubstring}\n` +
    `Got substring missing or different in file.`
  );
});

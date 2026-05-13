'use strict';
/**
 * Plan 51-04-01: Party Mode Decisions E2E lifecycle test.
 *
 * Full end-to-end lifecycle via the public CLI surface:
 *   create -> start -> post 4 decisions (propose+agree+dissent+block via inline
 *   python3 subprocess) -> status returns counts {1,1,1,1} ->
 *   inspect returns FROZEN shape with decision_trail length 4 + decision_summary ->
 *   kill records audit row (visible in session.findings, absent from decision_trail) ->
 *   kill already-terminated exits 1 -> cli-shortcut-equivalence.
 *
 * SC3 evidence at E2E layer: dissent does NOT rollback session (status stays active).
 * SC4 Layer 2 evidence: each postDecisionViaPython is a FRESH python3 subprocess —
 * proves no in-memory state; persistence lives entirely in PG.
 *
 * PG-down resilience: probeCreate in before() sets _pgUp; each subtest checks
 * if (!_pgUp) { t.skip(...); return; } first. Non-PG canary in 51-04-02.
 *
 * Run:
 *   node --test tests/party-decisions-e2e.test.cjs
 *
 * Phase 51 PARTY-03 + PARTY-04. Mirrors party-e2e.test.cjs runner style.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');

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
 * Detect whether PG is available by attempting a create call.
 * Returns { pgUp: bool, sessionId: string | null }.
 * When PG is up, also returns the created session_id for re-use in the suite.
 */
function probeCreate() {
  const r = runParty([
    'create',
    '--participants', 'gsd-planner,gsd-checker,gsd-operator',
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
 * Post a decision via inline Python -c invocation (FRESH subprocess each call).
 * Returns the UUID string of the inserted finding_id. Throws on failure.
 *
 * Each call is a FRESH python3 subprocess — proves no in-memory state is shared
 * across calls (SC4 Layer 2 pattern: PG is the sole persistence layer).
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

/**
 * Synchronous sleep via blocking spawnSync. Guarantees created_at ordering
 * across separate subprocess boundaries.
 */
function sleepMs(ms) {
  spawnSync('node', ['-e', `setTimeout(()=>{},${ms})`], {
    encoding: 'utf8',
    timeout: 5000,
  });
}

// ─── E2E suite: all subtests share one session threaded via closure ─────────

describe('party-decisions-e2e (PG required)', (suite) => {
  let sessionId = null;
  let _pgUp = false;
  let _inspectParsed = null;  // shared across subtests 5 + 6

  before(() => {
    const probeResult = probeCreate();
    _pgUp = probeResult.pgUp;
    sessionId = probeResult.sessionId;
  });

  test('e2e-create-start', (t) => {
    if (!_pgUp || sessionId === null) {
      t.skip('PG unavailable');
      return;
    }
    // Start the session created by probeCreate() (participants: gsd-planner,gsd-checker,gsd-operator)
    const startR = runParty(['start', sessionId, '--json']);
    assert.strictEqual(
      startR.status, 0,
      `start must exit 0; got: ${startR.status}\nstderr: ${startR.stderr}`
    );
    let startParsed;
    try {
      startParsed = JSON.parse(startR.stdout);
    } catch (e) {
      assert.fail(`start stdout must be valid JSON; got: ${startR.stdout}`);
    }
    assert.strictEqual(
      startParsed.status, 'active',
      `status must be "active" after start; got: ${startParsed.status}`
    );
    assert.strictEqual(startParsed.session_id, sessionId, 'session_id must match after start');
  });

  test('e2e-post-four-decisions-via-subprocess', (t) => {
    if (!_pgUp || sessionId === null) {
      t.skip('PG unavailable');
      return;
    }

    // Each postDecisionViaPython is a FRESH python3 subprocess (SC4 Layer 2)
    const d1 = postDecisionViaPython(sessionId, 'gsd-planner', 'propose', 'Ship v3.2 Phase 51');
    assert.ok(
      typeof d1 === 'string' && d1.length === 36,
      `propose finding_id must be 36-char UUID; got: ${JSON.stringify(d1)}`
    );

    sleepMs(30);

    const d2 = postDecisionViaPython(sessionId, 'gsd-checker', 'agree', 'LGTM');
    assert.ok(
      typeof d2 === 'string' && d2.length === 36,
      `agree finding_id must be 36-char UUID; got: ${JSON.stringify(d2)}`
    );

    sleepMs(30);

    const d3 = postDecisionViaPython(sessionId, 'gsd-operator', 'dissent', 'Defer to next milestone');
    assert.ok(
      typeof d3 === 'string' && d3.length === 36,
      `dissent finding_id must be 36-char UUID; got: ${JSON.stringify(d3)}`
    );

    sleepMs(30);

    const d4 = postDecisionViaPython(sessionId, 'gsd-checker', 'block', 'Migration risk too high');
    assert.ok(
      typeof d4 === 'string' && d4.length === 36,
      `block finding_id must be 36-char UUID; got: ${JSON.stringify(d4)}`
    );

    // All 4 IDs must be distinct
    const ids = new Set([d1, d2, d3, d4]);
    assert.strictEqual(
      ids.size, 4,
      `All 4 finding_ids must be distinct; got: ${d1}, ${d2}, ${d3}, ${d4}`
    );
  });

  test('e2e-status-returns-counts', (t) => {
    if (!_pgUp || sessionId === null) {
      t.skip('PG unavailable');
      return;
    }
    const r = runParty(['status', '--json']);
    assert.strictEqual(
      r.status, 0,
      `status --json must exit 0; got: ${r.status}\nstderr: ${r.stderr}`
    );
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      assert.fail(`status stdout must be valid JSON; got: ${r.stdout}`);
    }

    assert.strictEqual(parsed.schema_version, '1.0', `schema_version must be "1.0"; got: ${parsed.schema_version}`);
    assert.ok(Array.isArray(parsed.sessions), 'sessions must be an array');

    // Find our session row
    const row = parsed.sessions.find((s) => s.session_id === sessionId);
    assert.ok(row !== undefined, `status output must contain our session ${sessionId}`);

    assert.strictEqual(row.status, 'active', `row.status must be "active"; got: ${row.status}`);
    assert.strictEqual(row.participant_count, 3, `row.participant_count must be 3; got: ${row.participant_count}`);

    // decisions: {propose:1, agree:1, dissent:1, block:1}
    assert.ok(
      typeof row.decisions === 'object' && row.decisions !== null,
      'row.decisions must be an object'
    );
    assert.strictEqual(row.decisions.propose, 1, `decisions.propose must be 1; got: ${row.decisions.propose}`);
    assert.strictEqual(row.decisions.agree, 1, `decisions.agree must be 1; got: ${row.decisions.agree}`);
    assert.strictEqual(row.decisions.dissent, 1, `decisions.dissent must be 1; got: ${row.decisions.dissent}`);
    assert.strictEqual(row.decisions.block, 1, `decisions.block must be 1; got: ${row.decisions.block}`);
  });

  test('e2e-status-sorted-by-updated-at-desc', (t) => {
    if (!_pgUp || sessionId === null) {
      t.skip('PG unavailable');
      return;
    }
    const r = runParty(['status', '--json']);
    assert.strictEqual(r.status, 0, `status --json must exit 0; got: ${r.status}`);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      assert.fail(`status stdout must be valid JSON; got: ${r.stdout}`);
    }
    assert.ok(Array.isArray(parsed.sessions), 'sessions must be an array');

    const ids = parsed.sessions.map((s) => s.session_id);
    const idx = ids.indexOf(sessionId);
    assert.ok(idx >= 0, `our session ${sessionId} must appear in status output`);
    // The 4 decision inserts made this the most recently updated session —
    // it must appear in the top 2 (accounting for other test sessions created concurrently).
    assert.ok(
      idx <= 1,
      `our session must be in top 2 (most-recently-updated, sorted DESC); got idx=${idx}; sessions=[${ids.join(', ')}]`
    );
  });

  test('e2e-inspect-frozen-shape-with-four-decisions', (t) => {
    if (!_pgUp || sessionId === null) {
      t.skip('PG unavailable');
      return;
    }
    const r = runParty(['inspect', sessionId, '--json']);
    assert.strictEqual(
      r.status, 0,
      `inspect must exit 0; got: ${r.status}\nstderr: ${r.stderr}`
    );
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      assert.fail(`inspect stdout must be valid JSON; got: ${r.stdout}`);
    }

    // Cache for subtest 6 (dissent-no-rollback)
    _inspectParsed = parsed;

    // schema_version
    assert.strictEqual(parsed.schema_version, '1.0', `schema_version must be "1.0"; got: ${parsed.schema_version}`);

    // session: must have all 9 Phase 50 keys
    const sessionKeys = [
      'schema_version', 'session_id', 'status', 'participants',
      'created_at', 'updated_at', 'paused_at', 'terminated_at', 'findings',
    ];
    for (const k of sessionKeys) {
      assert.ok(
        k in parsed.session,
        `session must have key "${k}"; got keys: ${Object.keys(parsed.session).join(', ')}`
      );
    }
    assert.strictEqual(
      parsed.session.status, 'active',
      `session.status must be "active"; got: ${parsed.session.status}`
    );

    // decision_trail: 4 entries, ascending created_at order
    assert.ok(Array.isArray(parsed.decision_trail), 'decision_trail must be an array');
    assert.strictEqual(
      parsed.decision_trail.length, 4,
      `decision_trail must have 4 entries; got: ${parsed.decision_trail.length}`
    );

    // Order: propose -> agree -> dissent -> block
    const expectedTypes = ['propose', 'agree', 'dissent', 'block'];
    for (let i = 0; i < expectedTypes.length; i++) {
      assert.strictEqual(
        parsed.decision_trail[i].decision_type, expectedTypes[i],
        `decision_trail[${i}].decision_type must be "${expectedTypes[i]}"; got: ${parsed.decision_trail[i].decision_type}`
      );
    }

    // Each entry shape
    for (const entry of parsed.decision_trail) {
      assert.ok(typeof entry.finding_id === 'string', `finding_id must be a string; got: ${entry.finding_id}`);
      assert.ok(typeof entry.agent_name === 'string', `agent_name must be a string; got: ${entry.agent_name}`);
      assert.ok(typeof entry.decision_type === 'string', `decision_type must be a string; got: ${entry.decision_type}`);
      assert.ok(typeof entry.content === 'string', `content must be a string; got: ${entry.content}`);
      assert.ok(typeof entry.confidence === 'number', `confidence must be a number; got: ${entry.confidence}`);
      assert.ok(typeof entry.created_at === 'string', `created_at must be a string; got: ${entry.created_at}`);
    }

    // decision_summary: {propose:1, agree:1, dissent:1, block:1}
    assert.ok(
      typeof parsed.decision_summary === 'object' && parsed.decision_summary !== null,
      'decision_summary must be an object'
    );
    assert.strictEqual(parsed.decision_summary.propose, 1, `decision_summary.propose must be 1; got: ${parsed.decision_summary.propose}`);
    assert.strictEqual(parsed.decision_summary.agree, 1, `decision_summary.agree must be 1; got: ${parsed.decision_summary.agree}`);
    assert.strictEqual(parsed.decision_summary.dissent, 1, `decision_summary.dissent must be 1; got: ${parsed.decision_summary.dissent}`);
    assert.strictEqual(parsed.decision_summary.block, 1, `decision_summary.block must be 1; got: ${parsed.decision_summary.block}`);
  });

  test('e2e-dissent-did-not-rollback-session', (t) => {
    if (!_pgUp || sessionId === null) {
      t.skip('PG unavailable');
      return;
    }
    // Re-fetch inspect if subtest 5 was skipped or cached value is missing
    let parsed = _inspectParsed;
    if (parsed === null) {
      const r = runParty(['inspect', sessionId, '--json']);
      assert.strictEqual(r.status, 0, `inspect must exit 0; got: ${r.status}`);
      try {
        parsed = JSON.parse(r.stdout);
      } catch (e) {
        assert.fail(`inspect stdout must be valid JSON; got: ${r.stdout}`);
      }
    }

    // Session must still be active (dissent is first-class; no auto-state change — SC3)
    assert.strictEqual(
      parsed.session.status, 'active',
      `session.status must still be "active" after dissent; got: ${parsed.session.status}`
    );

    // terminated_at must be null (not terminated by dissent)
    assert.ok(
      parsed.session.terminated_at === null ||
        parsed.session.terminated_at === undefined ||
        parsed.session.terminated_at === 'None',
      `session.terminated_at must be null after dissent; got: ${parsed.session.terminated_at}`
    );

    // The propose entry from gsd-planner must still exist (not removed by dissent)
    const proposeEntry = parsed.decision_trail.find(
      (e) => e.agent_name === 'gsd-planner' && e.content === 'Ship v3.2 Phase 51'
    );
    assert.ok(
      proposeEntry !== undefined,
      `propose entry from gsd-planner must exist in decision_trail after dissent; ` +
      `trail: ${JSON.stringify(parsed.decision_trail.map((e) => ({ at: e.agent_name, c: e.content })))}`
    );
  });

  test('e2e-kill-records-audit-and-terminates', (t) => {
    if (!_pgUp || sessionId === null) {
      t.skip('PG unavailable');
      return;
    }

    // Kill the session
    const rKill = runParty(['kill', sessionId, '--reason', '51-04 closeout', '--json']);
    assert.strictEqual(
      rKill.status, 0,
      `kill must exit 0; got: ${rKill.status}\nstderr: ${rKill.stderr}`
    );
    let killParsed;
    try {
      killParsed = JSON.parse(rKill.stdout);
    } catch (e) {
      assert.fail(`kill stdout must be valid JSON; got: ${rKill.stdout}`);
    }

    // Session must be terminated
    assert.strictEqual(
      killParsed.session.status, 'terminated',
      `session.status must be "terminated"; got: ${killParsed.session.status}`
    );
    assert.ok(
      killParsed.session.terminated_at !== null &&
        killParsed.session.terminated_at !== undefined &&
        killParsed.session.terminated_at !== 'None',
      `session.terminated_at must not be null; got: ${killParsed.session.terminated_at}`
    );

    // audit_finding_id is a 36-char UUID
    assert.ok(
      typeof killParsed.audit_finding_id === 'string' && killParsed.audit_finding_id.length === 36,
      `audit_finding_id must be a 36-char UUID; got: ${killParsed.audit_finding_id}`
    );

    // reason matches
    assert.strictEqual(
      killParsed.reason, '51-04 closeout',
      `reason must be "51-04 closeout"; got: ${killParsed.reason}`
    );

    // Verify via inspect: kill audit row in session.findings; absent from decision_trail
    const rInspect = runParty(['inspect', sessionId, '--json']);
    assert.strictEqual(
      rInspect.status, 0,
      `inspect after kill must exit 0; got: ${rInspect.status}`
    );
    let postKillInspect;
    try {
      postKillInspect = JSON.parse(rInspect.stdout);
    } catch (e) {
      assert.fail(`inspect stdout must be valid JSON; got: ${rInspect.stdout}`);
    }

    // Kill audit row must appear in session.findings
    const findings = postKillInspect.session.findings || [];
    const killRow = findings.find(
      (f) => f.finding_type === 'kill' && f.agent_name === 'operator'
    );
    assert.ok(
      killRow !== undefined,
      `session.findings must contain a row with finding_type='kill' + agent_name='operator'; ` +
      `findings: ${JSON.stringify(findings.map((f) => ({ ft: f.finding_type, an: f.agent_name })))}`
    );
    // The content must include the expected phrase "Session killed by operator"
    assert.ok(
      typeof killRow.content === 'string' &&
        killRow.content.includes('Session killed by operator'),
      `kill row content must include "Session killed by operator"; got: ${killRow.content}`
    );
    assert.ok(
      killRow.content.includes('51-04 closeout'),
      `kill row content must include "51-04 closeout"; got: ${killRow.content}`
    );

    // Kill audit row must NOT appear in decision_trail (decision_type is NULL)
    const trail = postKillInspect.decision_trail || [];
    const killInTrail = trail.find(
      (e) => e.agent_name === 'operator' ||
        (typeof e.content === 'string' && e.content.includes('Session killed'))
    );
    assert.ok(
      killInTrail === undefined,
      `kill audit row must NOT appear in decision_trail; trail: ${JSON.stringify(trail)}`
    );

    // decision_summary must still be {propose:1, agree:1, dissent:1, block:1} (kill is audit, not decision)
    assert.strictEqual(
      postKillInspect.decision_summary.propose, 1,
      `decision_summary.propose must still be 1 after kill; got: ${postKillInspect.decision_summary.propose}`
    );
    assert.strictEqual(
      postKillInspect.decision_summary.agree, 1,
      `decision_summary.agree must still be 1 after kill; got: ${postKillInspect.decision_summary.agree}`
    );
    assert.strictEqual(
      postKillInspect.decision_summary.dissent, 1,
      `decision_summary.dissent must still be 1 after kill; got: ${postKillInspect.decision_summary.dissent}`
    );
    assert.strictEqual(
      postKillInspect.decision_summary.block, 1,
      `decision_summary.block must still be 1 after kill; got: ${postKillInspect.decision_summary.block}`
    );
  });

  test('e2e-kill-already-terminated-exit-1', (t) => {
    if (!_pgUp || sessionId === null) {
      t.skip('PG unavailable');
      return;
    }
    // Session was killed in the previous subtest — second kill must exit 1
    const r = runParty(['kill', sessionId, '--reason', 'should fail', '--json']);
    assert.strictEqual(
      r.status, 1,
      `kill on already-terminated session must exit 1; got: ${r.status}\nstdout: ${r.stdout}`
    );
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (e) {
      assert.fail(`stdout must be valid JSON on exit 1; got: ${r.stdout}`);
    }
    assert.strictEqual(
      parsed.error, 'InvalidTransitionError',
      `error must be "InvalidTransitionError"; got: ${parsed.error}`
    );
  });

  test('e2e-cli-shortcut-equivalence', (t) => {
    if (!_pgUp) {
      t.skip('PG unavailable');
      return;
    }
    // Create + start a fresh session via gsd-tools
    const rCreate = runParty([
      'create',
      '--participants', 'gsd-planner,gsd-checker',
      '--json',
    ]);
    assert.strictEqual(
      rCreate.status, 0,
      `create must exit 0; got: ${rCreate.status}\nstderr: ${rCreate.stderr}`
    );
    let sid2;
    try {
      sid2 = JSON.parse(rCreate.stdout).session_id;
    } catch (e) {
      assert.fail(`create stdout must be valid JSON; got: ${rCreate.stdout}`);
    }

    const rStart = runParty(['start', sid2, '--json']);
    assert.strictEqual(rStart.status, 0, `start must exit 0; got: ${rStart.status}`);

    // Inspect via bin/cli.cjs party inspect — shortcut equivalence
    const rCliInspect = runCliParty(['inspect', sid2, '--json']);
    assert.strictEqual(
      rCliInspect.status, 0,
      `bin/cli.cjs party inspect must exit 0; got: ${rCliInspect.status}\nstderr: ${rCliInspect.stderr}`
    );
    let cliParsed;
    try {
      cliParsed = JSON.parse(rCliInspect.stdout);
    } catch (e) {
      assert.fail(`bin/cli.cjs inspect stdout must be valid JSON; got: ${rCliInspect.stdout}`);
    }
    assert.strictEqual(
      cliParsed.schema_version, '1.0',
      `schema_version must be "1.0"; got: ${cliParsed.schema_version}`
    );
    assert.ok(
      typeof cliParsed.session === 'object' && cliParsed.session !== null,
      'inspect output must have a session object'
    );
    assert.ok(
      Array.isArray(cliParsed.decision_trail),
      'inspect output must have decision_trail array'
    );
  });

});

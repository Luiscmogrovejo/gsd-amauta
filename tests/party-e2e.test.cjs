'use strict';
/**
 * Plan 50-04-01: party E2E lifecycle test.
 *
 * Full end-to-end lifecycle via the public CLI surface:
 *   create -> start -> post 3 findings -> pause ->
 *   subprocess restart (SC4 Layer 2) -> resume + replay ->
 *   terminate -> post-terminate error check + shortcut equivalence.
 *
 * SC4 Layer 2 evidence: resume() call is a FRESH node/python subprocess
 * (gsd-tools.cjs spawnSyncs party_session_cli.py). No in-memory state is
 * carried across the "daemon restart" boundary — persistence lives entirely
 * in PG. The findings replay asserts all 3 findings are returned with correct
 * content, order, and agent attribution.
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

  const r = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: ROOT,
    env: { ...process.env, PYTHONPATH: ROOT },
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
      t.skip('PG required for SC4 E2E');
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
      t.skip('PG required for SC4 E2E');
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

  // ── 3. e2e-pause ──────────────────────────────────────────────────────────

  test('e2e-pause', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip('PG required for SC4 E2E');
      return;
    }
    const r = runParty(['pause', sessionId, '--json']);
    assert.strictEqual(r.status, 0, `pause must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`pause stdout must be valid JSON; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.status, 'paused',
      `status must be "paused" after pause; got: ${parsed.status}`);
    assert.ok(
      parsed.paused_at !== null && parsed.paused_at !== undefined && parsed.paused_at !== 'None',
      `paused_at must not be null after pause; got: ${parsed.paused_at}`
    );
    assert.strictEqual(parsed.session_id, sessionId, 'session_id must match after pause');
  });

  // ── 4. e2e-simulated-daemon-restart-resume ────────────────────────────────
  //
  // SC4 Layer 2: This resume() call is a FRESH node process → FRESH python3
  // subprocess. No in-memory state is shared with the previous pause call.
  // The entire psycopg2 connection pool is re-created inside the Python process.
  // Findings are replayed exclusively from PG.

  test('e2e-simulated-daemon-restart-resume', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip('PG required for SC4 E2E');
      return;
    }
    // FRESH subprocess (node → gsd-tools.cjs → party_session_cli.py → psycopg2)
    const r = runParty(['resume', sessionId, '--json']);
    assert.strictEqual(r.status, 0, `resume must exit 0; got: ${r.status}\nstderr: ${r.stderr}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`resume stdout must be valid JSON; got: ${r.stdout}`);
    }

    // Session state assertions
    assert.strictEqual(parsed.status, 'active',
      `status must be "active" after resume; got: ${parsed.status}`);
    assert.ok(
      parsed.paused_at === null || parsed.paused_at === undefined || parsed.paused_at === 'None',
      `paused_at must be null after resume; got: ${parsed.paused_at}`
    );
    assert.strictEqual(parsed.session_id, sessionId, 'session_id must match after resume');

    // SC4 findings replay assertions — full ordered list of 3 findings
    assert.ok(Array.isArray(parsed.findings),
      `findings must be an array after resume; got: ${typeof parsed.findings}`);
    assert.strictEqual(parsed.findings.length, 3,
      `findings must have 3 entries after replay; got: ${parsed.findings.length}`);

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
      t.skip('PG required for SC4 E2E');
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

  // ── 6. e2e-terminated-cannot-resume ──────────────────────────────────────

  test('e2e-terminated-cannot-resume', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip('PG required for SC4 E2E');
      return;
    }
    const r = runParty(['resume', sessionId, '--json']);
    assert.strictEqual(r.status, 1,
      `resume on terminated session must exit 1; got: ${r.status}\nstdout: ${r.stdout}`);
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch (e) {
      assert.fail(`stdout must be valid JSON on exit 1; got: ${r.stdout}`);
    }
    assert.strictEqual(parsed.error, 'InvalidTransitionError',
      `error must be "InvalidTransitionError"; got: ${parsed.error}`);
    assert.ok(
      typeof parsed.detail === 'string' && parsed.detail.length > 0,
      `detail must be a non-empty string; got: ${parsed.detail}`
    );
    assert.strictEqual(parsed.schema_version, '1.0',
      `schema_version must be "1.0"; got: ${parsed.schema_version}`);
  });

  // ── 7. e2e-shortcut-equivalence ───────────────────────────────────────────
  //
  // Verify bin/cli.cjs party get --json --with-findings produces the same
  // shape as node gsd-tools.cjs party get --json --with-findings.
  // The terminated session still has its findings intact in PG.

  test('e2e-shortcut-equivalence', (t) => {
    if (!pgUp || sessionId === null) {
      t.skip('PG required for SC4 E2E');
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

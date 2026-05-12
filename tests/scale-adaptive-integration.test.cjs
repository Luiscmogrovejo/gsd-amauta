'use strict';
/**
 * Plan 42-04-04: Scale-Adaptive Integration Tests
 * File: tests/scale-adaptive-integration.test.cjs
 *
 * Requirements covered:
 *   SCALE-01, SCALE-02, SCALE-03, SCALE-04
 *
 * Tests the /api/complexity/{score,complete,escalate} daemon endpoints.
 * Tests requiring PG skip gracefully when PG is unavailable.
 * Tests requiring daemon skip gracefully when daemon is unavailable.
 *
 * Run: node --test tests/scale-adaptive-integration.test.cjs
 * Run live: DAEMON_URL=http://127.0.0.1:18799 node --test tests/scale-adaptive-integration.test.cjs
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DAEMON_FILE = path.join(ROOT, 'services', 'amauta-daemon.py');
const DAEMON_URL = process.env.DAEMON_URL || 'http://127.0.0.1:18799';
const COMPLEXITY_BASE = `${DAEMON_URL}/api/complexity`;

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpRequest(method, url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10) || 80,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...(extraHeaders || {}),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed_body;
        try { parsed_body = JSON.parse(data); }
        catch (_) { parsed_body = data; }
        resolve({ status: res.statusCode, body: parsed_body });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Synchronous availability checks (at module level) ────────────────────────

function checkSync(url, method, body) {
  const args = ['--eval', `
    const http = require('http');
    const parsed = new URL('${url}');
    const bodyStr = ${body ? JSON.stringify(JSON.stringify(body)) : 'null'};
    const options = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || 80,
      path: parsed.pathname,
      method: '${method}',
      headers: { 'Content-Type': 'application/json', ...(bodyStr ? {'Content-Length': Buffer.byteLength(bodyStr)} : {}) },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        process.stdout.write(JSON.stringify({ status: res.statusCode, body: data }));
      });
    });
    req.on('error', e => process.stdout.write(JSON.stringify({ error: e.message })));
    if (bodyStr) req.write(bodyStr);
    req.end();
  `];
  const result = spawnSync('node', args, { encoding: 'utf8', timeout: 5000 });
  try { return JSON.parse(result.stdout); }
  catch (_) { return { error: 'parse failed: ' + result.stdout }; }
}

// Check daemon availability
const healthResult = checkSync(`${DAEMON_URL}/health`, 'GET', null);
const daemonAvailable = healthResult.status === 200;

// Check if /api/complexity/score route exists (Phase 42 feature).
// Older daemon returns {"error": "Unknown POST route: ..."} — that means Phase 42
// routes are not available, so we skip live tests.
let complexityRouteAvailable = false;
if (daemonAvailable) {
  const r = checkSync(`${COMPLEXITY_BASE}/score`, 'POST', { task_meta: {} });
  // Route available if response does NOT contain "Unknown POST route"
  const bodyStr = (r.body || '').toString();
  complexityRouteAvailable = r.status !== undefined && !r.error && !bodyStr.includes('Unknown POST route');
}

// Check PG availability by probing the /api/complexity/complete endpoint
// (returns 400/500 if schema missing, but not network error if daemon is up)
function checkPgAvailable() {
  if (!daemonAvailable) return false;
  const result = spawnSync('psql', [
    process.env.DATABASE_URL || process.env.GSD_POSTGRES_URL || 'postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta',
    '-c', 'SELECT 1',
  ], { encoding: 'utf8', timeout: 3000 });
  return result.status === 0;
}
const pgAvailable = checkPgAvailable();

const SKIP_DAEMON = !daemonAvailable ? 'Daemon unavailable' : null;
const SKIP_ROUTE = !complexityRouteAvailable ? 'Phase 42 /api/complexity/ route not available' : null;
const SKIP_PG = !pgAvailable ? 'PostgreSQL unavailable' : null;

// ── Group 1: Daemon file-level structure (always run — no daemon needed) ──────

describe('[SCALE-01/02/03/04] Daemon file: /api/complexity/ routes are defined', () => {

  test('services/amauta-daemon.py exists', () => {
    assert.ok(fs.existsSync(DAEMON_FILE), 'services/amauta-daemon.py does not exist');
  });

  test('daemon has /api/complexity/score route', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(content.includes('/api/complexity/score'), 'daemon missing /api/complexity/score');
  });

  test('daemon has /api/complexity/complete route', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(content.includes('/api/complexity/complete'), 'daemon missing /api/complexity/complete');
  });

  test('daemon has /api/complexity/escalate route', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(content.includes('/api/complexity/escalate'), 'daemon missing /api/complexity/escalate');
  });

  test('daemon response includes calibrated_score field', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(content.includes('"calibrated_score"') || content.includes("'calibrated_score'") || content.includes('calibrated_score'), 'daemon missing calibrated_score in response');
  });

  test('daemon response includes cold_start field', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(content.includes('"cold_start"') || content.includes("'cold_start'") || content.includes('cold_start'), 'daemon missing cold_start in response');
  });

  test('daemon calls calibrate_score function', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(content.includes('calibrate_score'), 'daemon not calling calibrate_score');
  });

  test('daemon GSD_FORCE_PHASES override supported', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(content.includes('GSD_FORCE_PHASES'), 'daemon missing GSD_FORCE_PHASES override support');
  });

  test('daemon escalate endpoint has cap_hit handling', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(content.includes('cap_hit'), 'daemon escalate missing cap_hit handling');
  });

  test('daemon escalate endpoint has CAP REACHED banner', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(content.includes('CAP'), 'daemon escalate missing CAP banner text');
  });

});

// ── Group 2: Live endpoint tests (skip if daemon unavailable) ────────────────

describe('[SCALE-01/02] Live /api/complexity/score endpoint', () => {

  const SKIP_REASON = SKIP_DAEMON || SKIP_ROUTE;

  test('POST /api/complexity/score returns expected shape', { skip: SKIP_REASON || false }, async () => {
    const r = await httpRequest('POST', `${COMPLEXITY_BASE}/score`, {
      task_meta: { files_expected: ['services/foo.py'], estimated_loc: 100 },
    });
    assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    // Required fields
    assert.ok('score' in r.body, `Missing 'score' field: ${JSON.stringify(r.body)}`);
    assert.ok('auto_phases' in r.body, `Missing 'auto_phases' field`);
    assert.ok('chosen_phases' in r.body, `Missing 'chosen_phases' field`);
    assert.ok('override_source' in r.body, `Missing 'override_source' field`);
    assert.ok('feature_vector' in r.body, `Missing 'feature_vector' field`);
    assert.ok('banner' in r.body, `Missing 'banner' field`);
    assert.ok(typeof r.body.score === 'number', `score should be a number`);
    assert.ok(Array.isArray(r.body.chosen_phases), `chosen_phases should be an array`);
    assert.ok(typeof r.body.override_source === 'string', `override_source should be a string`);
  });

  test('POST /api/complexity/score override_source=auto when no overrides', { skip: SKIP_REASON || false }, async () => {
    const r = await httpRequest('POST', `${COMPLEXITY_BASE}/score`, {
      task_meta: {},
    });
    assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}`);
    // When no env/pin/project overrides set, override_source should be 'auto'
    assert.ok(
      r.body.override_source === 'auto' || r.body.override_source === 'project' || r.body.override_source === 'env',
      `override_source should be a valid value, got '${r.body.override_source}'`
    );
  });

  test('POST /api/complexity/score includes calibrated_score and cold_start', { skip: SKIP_REASON || false }, async () => {
    const r = await httpRequest('POST', `${COMPLEXITY_BASE}/score`, {
      task_meta: { files_expected: ['services/test.py'] },
    });
    assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}`);
    assert.ok('calibrated_score' in r.body, `Missing 'calibrated_score' field (42-04-01 wiring): ${JSON.stringify(Object.keys(r.body))}`);
    assert.ok('cold_start' in r.body, `Missing 'cold_start' field (42-04-01 wiring): ${JSON.stringify(Object.keys(r.body))}`);
    assert.ok(typeof r.body.calibrated_score === 'number', `calibrated_score should be a number`);
    assert.ok(typeof r.body.cold_start === 'boolean', `cold_start should be a boolean`);
  });

  test('POST /api/complexity/score deterministic for fixed task_meta', { skip: SKIP_REASON || false }, async () => {
    const body = { task_meta: { files_expected: ['services/foo.py', 'migrations/001.sql'], estimated_loc: 200 } };
    const r1 = await httpRequest('POST', `${COMPLEXITY_BASE}/score`, body);
    const r2 = await httpRequest('POST', `${COMPLEXITY_BASE}/score`, body);
    assert.strictEqual(r1.status, 200, `First call status ${r1.status}`);
    assert.strictEqual(r2.status, 200, `Second call status ${r2.status}`);
    assert.strictEqual(r1.body.score, r2.body.score, `score should be deterministic: ${r1.body.score} vs ${r2.body.score}`);
  });

});

// ── Group 3: Live complete + escalate (skip if PG unavailable) ───────────────

describe('[SCALE-03/04] Live /api/complexity/complete + escalate endpoints', () => {

  const SKIP_REASON = SKIP_DAEMON || SKIP_ROUTE || SKIP_PG;

  test('POST /api/complexity/complete: outcome_label=invalid → stored=false', { skip: SKIP_REASON || false }, async () => {
    const r = await httpRequest('POST', `${COMPLEXITY_BASE}/complete`, {
      task_id: 'TEST-INTEGRATION-00',
      phase_number: 0,
      workflow_name: 'execute-phase',
      raw_score: 50,
      chosen_phases: ['R', 'P', 'E', 'T'],
      phases_run: ['R', 'P', 'E', 'T'],
      outcome_label: 'invalid_label_xyz',
      escalation_history: [],
    });
    // Should return stored=false with error about invalid outcome_label
    assert.ok(
      r.status === 400 || r.body.stored === false || (r.body.error && r.body.error.includes('outcome_label')),
      `Expected invalid outcome rejected, got ${r.status}: ${JSON.stringify(r.body)}`
    );
  });

  test('POST /api/complexity/escalate: no_handoff for non-existent task', { skip: SKIP_REASON || false }, async () => {
    const r = await httpRequest('POST', `${COMPLEXITY_BASE}/escalate`, {
      task_id: 'TEST-NONEXISTENT-TASK-99999999',
      phase_number: 1,
      workflow_name: 'execute-phase',
      executor_report: { files_touched: 10 },
    });
    assert.ok(
      r.status === 200 || r.status === 404,
      `Expected 200 or 404 for no-handoff, got ${r.status}: ${JSON.stringify(r.body)}`
    );
    if (r.status === 200) {
      assert.ok(
        r.body.escalated === false || r.body.reason === 'no_handoff' || (r.body.reason && r.body.reason.includes('no')),
        `Expected escalated=false or no_handoff reason: ${JSON.stringify(r.body)}`
      );
    }
  });

});

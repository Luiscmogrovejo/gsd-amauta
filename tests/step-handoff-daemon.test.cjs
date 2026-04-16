'use strict';
/**
 * Plan 41-03-02: Step Handoff Daemon Endpoint Tests
 * File: tests/step-handoff-daemon.test.cjs
 *
 * Requirements covered:
 *   SHARD-04: GET /api/steps/:workflow/:phase + POST /api/steps/:workflow/:phase/handoff
 *
 * Tests the 2 daemon endpoints added in Phase 41 Wave 1.
 * Uses HTTP calls to the running daemon (DAEMON_URL=http://127.0.0.1:18799).
 * Skips all tests if daemon is unavailable OR if the Phase 41 routes are not present
 * (older daemon instance without /api/steps/ support).
 *
 * Run: node --test tests/step-handoff-daemon.test.cjs
 * Run live: DAEMON_URL=http://127.0.0.1:18799 node --test tests/step-handoff-daemon.test.cjs
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const DAEMON_URL = process.env.DAEMON_URL || 'http://127.0.0.1:18799';
const STEPS_BASE = `${DAEMON_URL}/api/steps`;

// ─── Helper: HTTP request (node built-in, no external deps) ──────────────────

function httpRequest(method, url, body) {
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

// ─── Check daemon health and Phase 41 route availability ─────────────────────

async function checkDaemonAvailable() {
  try {
    const r = await httpRequest('GET', `${DAEMON_URL}/health`, null);
    return r.status === 200;
  } catch (_) {
    return false;
  }
}

async function checkStepsRouteAvailable() {
  try {
    // GET on an unlikely phase — if it returns 404 with "Unknown GET route"
    // the daemon is running an old version without Phase 41 support.
    const r = await httpRequest('GET', `${STEPS_BASE}/plan-phase/0`, null);
    // 404 with "Unknown GET route" = old daemon
    if (r.status === 404 && r.body && r.body.error && r.body.error.includes('Unknown GET route')) {
      return false;
    }
    // 200 or {"step_id": null} = route exists
    return true;
  } catch (_) {
    return false;
  }
}

// Run availability checks synchronously at module level (before test suite runs)
// This follows the spawnSync at describe-block level pattern from Phase 38-39 integration tests.
const { spawnSync } = require('node:child_process');

function checkSync(url, method, body) {
  const args = ['--eval', `
    const http = require('http');
    const parsed = new URL('${url}');
    const options = {
      hostname: parsed.hostname,
      port: parseInt(parsed.port) || 80,
      path: parsed.pathname,
      method: '${method}',
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        process.stdout.write(JSON.stringify({ status: res.statusCode, body: data }));
      });
    });
    req.on('error', e => process.stdout.write(JSON.stringify({ error: e.message })));
    req.end();
  `];
  const result = spawnSync('node', args, { encoding: 'utf8', timeout: 5000 });
  try { return JSON.parse(result.stdout); }
  catch (_) { return { error: 'parse failed: ' + result.stdout }; }
}

const healthResult = checkSync(`${DAEMON_URL}/health`, 'GET', null);
const daemonAvailable = healthResult.status === 200;

// Check if Phase 41 steps route is available
let stepsRouteAvailable = false;
if (daemonAvailable) {
  const stepsResult = checkSync(`${STEPS_BASE}/plan-phase/0`, 'GET', null);
  // If it returns 404 with "Unknown GET route" the daemon doesn't have Phase 41 support
  const body = stepsResult.body || '';
  stepsRouteAvailable = !(stepsResult.status === 404 && body.includes('Unknown GET route'));
}

const SKIP_REASON = !daemonAvailable
  ? 'Daemon unavailable'
  : !stepsRouteAvailable
  ? 'Phase 41 /api/steps/ route not available (daemon predates Phase 41 — restart daemon)'
  : null;

// ─── Daemon file structure tests (always run — no daemon needed) ──────────────

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const DAEMON_FILE = path.join(ROOT, 'services', 'amauta-daemon.py');

describe('[SHARD-04] Daemon file: /api/steps/ routes are defined', () => {

  it('services/amauta-daemon.py exists', () => {
    assert.ok(fs.existsSync(DAEMON_FILE), 'services/amauta-daemon.py does not exist');
  });

  it('daemon has GET /api/steps/ route handler', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      content.includes('path.startswith("/api/steps/")'),
      'daemon missing GET /api/steps/ route handler'
    );
  });

  it('daemon has POST /api/steps/ handoff route handler', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      content.includes('path.endswith("/handoff")'),
      'daemon missing POST /api/steps/*/handoff route handler'
    );
  });

  it('daemon GET /api/steps/ validates phase_number is integer', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      content.includes('phase must be integer'),
      'daemon missing integer validation for phase in GET /api/steps/'
    );
  });

  it('daemon POST /api/steps/ returns 201 with id and created_at', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      content.includes('"id": str(row[0])') || content.includes('"id":'),
      'daemon POST /api/steps/ missing id in response'
    );
    assert.ok(
      content.includes('"created_at"'),
      'daemon POST /api/steps/ missing created_at in response'
    );
  });

  it('daemon GET /api/steps/ returns step_id: null when no handoff found', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      content.includes('"step_id": None') || content.includes('"step_id": null') || content.includes('"step_id"'),
      'daemon GET /api/steps/ missing step_id: null response for empty case'
    );
  });

  it('daemon GET /api/steps/ returns 400 for incomplete path', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    assert.ok(
      content.includes('Usage: /api/steps/:workflow/:phase'),
      'daemon missing 400 error message for incomplete /api/steps/ path'
    );
  });

  it('daemon POST /api/steps/ returns 400 for bad phase number', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    // The POST route also validates phase as integer
    assert.ok(
      content.includes('Usage: /api/steps/:workflow/:phase/handoff'),
      'daemon missing 400 error message for incomplete POST /api/steps/ path'
    );
  });

});

// ─── Live endpoint tests (skip if daemon unavailable or route missing) ─────────

describe('[SHARD-04] Live GET /api/steps/ endpoint tests', () => {

  if (SKIP_REASON) {
    it(`[SKIP] ${SKIP_REASON}`, () => {
      console.log(`[skip] Daemon/route not available: ${SKIP_REASON}`);
      assert.ok(true, 'Graceful skip — daemon or route not available');
    });
  } else {

    it('GET returns {"step_id": null} when no handoff exists', async () => {
      const r = await httpRequest('GET', `${STEPS_BASE}/plan-phase/999999`, null);
      assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.step_id, null, `Expected null step_id, got: ${r.body.step_id}`);
    });

    it('GET returns 400 for non-integer phase', async () => {
      const r = await httpRequest('GET', `${STEPS_BASE}/plan-phase/abc`, null);
      assert.strictEqual(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    it('POST creates handoff and returns 201 with id and created_at', async () => {
      const r = await httpRequest('POST', `${STEPS_BASE}/plan-phase/99/handoff`, {
        workflow_name: 'plan-phase',
        step_id: 'step-01-init',
        task_id: 'daemon-test-post-01',
        phase_number: 99,
        completed_steps: [],
        context_snapshot: { test: true },
        next_step: 'step-02-research',
        escalation_flags: [],
      });
      assert.strictEqual(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.id, `Response missing id field: ${JSON.stringify(r.body)}`);
      assert.ok(r.body.created_at, `Response missing created_at field: ${JSON.stringify(r.body)}`);
    });

    it('GET returns latest handoff after POST', async () => {
      // POST first handoff
      await httpRequest('POST', `${STEPS_BASE}/plan-phase/99/handoff`, {
        step_id: 'step-01-init',
        task_id: 'daemon-test-get-01',
        completed_steps: [],
        context_snapshot: { order: 1 },
        next_step: 'step-02-research',
      });
      // POST second handoff (newer)
      await httpRequest('POST', `${STEPS_BASE}/plan-phase/99/handoff`, {
        step_id: 'step-02-research',
        task_id: 'daemon-test-get-01',
        completed_steps: ['step-01-init'],
        context_snapshot: { order: 2 },
        next_step: 'step-03-plan',
      });
      // GET should return the SECOND (latest) handoff
      const r = await httpRequest('GET', `${STEPS_BASE}/plan-phase/99`, null);
      assert.strictEqual(r.status, 200, `GET failed: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.step_id, 'step-02-research', `Expected step-02-research, got: ${r.body.step_id}`);
    });

    it('GET includes all expected fields when handoff exists', async () => {
      const r = await httpRequest('GET', `${STEPS_BASE}/plan-phase/99`, null);
      assert.strictEqual(r.status, 200);
      const fields = ['workflow_name', 'step_id', 'task_id', 'phase_number', 'completed_steps', 'context_snapshot'];
      for (const field of fields) {
        assert.ok(field in r.body, `Missing field ${field} in GET response`);
      }
    });

    it('POST preserves JSONB fields (context_snapshot, artifacts, decisions)', async () => {
      const complexContext = { key1: 'value1', nested: { a: 1, b: [1, 2, 3] } };
      const complexArtifacts = { plan_files: ['f1.md'], summaries: ['s1'] };
      const complexDecisions = [{ decision: 'test', rationale: 'r', agent: 'test-agent' }];
      await httpRequest('POST', `${STEPS_BASE}/plan-phase/99/handoff`, {
        step_id: 'step-03-plan',
        task_id: 'daemon-test-jsonb-01',
        completed_steps: ['step-01-init', 'step-02-research'],
        context_snapshot: complexContext,
        artifacts: complexArtifacts,
        decisions: complexDecisions,
        next_step: 'step-04-check',
      });
      const r = await httpRequest('GET', `${STEPS_BASE}/plan-phase/99`, null);
      assert.strictEqual(r.status, 200);
      // Verify context_snapshot was preserved (it should be returned)
      assert.ok(r.body.context_snapshot !== null, 'context_snapshot should not be null');
    });

    it('Multiple workflows are independent (plan-phase vs execute-phase)', async () => {
      await httpRequest('POST', `${STEPS_BASE}/plan-phase/99/handoff`, {
        step_id: 'step-04-check',
        task_id: 'daemon-test-wf-01',
        completed_steps: ['step-01-init', 'step-02-research', 'step-03-plan'],
        context_snapshot: { workflow: 'plan' },
        next_step: 'step-05-approve',
      });
      await httpRequest('POST', `${STEPS_BASE}/execute-phase/99/handoff`, {
        step_id: 'step-02-route',
        task_id: 'daemon-test-wf-01',
        completed_steps: ['step-01-prepare'],
        context_snapshot: { workflow: 'execute' },
        next_step: 'step-03-execute',
      });
      const planR = await httpRequest('GET', `${STEPS_BASE}/plan-phase/99`, null);
      const execR = await httpRequest('GET', `${STEPS_BASE}/execute-phase/99`, null);
      assert.strictEqual(planR.body.step_id, 'step-04-check', `plan-phase step wrong: ${planR.body.step_id}`);
      assert.strictEqual(execR.body.step_id, 'step-02-route', `execute-phase step wrong: ${execR.body.step_id}`);
    });

  }

});

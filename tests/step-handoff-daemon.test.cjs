'use strict';
/**
 * Plan 41-03-02: Step Handoff Daemon Endpoint Tests
 * File: tests/step-handoff-daemon.test.cjs
 *
 * Requirements covered:
 *   SHARD-04: GET /api/steps/:workflow/:phase + POST /api/steps/:workflow/:phase/handoff
 *
 * Tests the 2 daemon endpoints added in Phase 41 Wave 1.
 *
 * Phase 88 plan 88-16-06: these seven live tests used to probe the OPERATOR'S
 * daemon and collapse into one vacuous `[SKIP]` placeholder when it did not
 * answer — which, under the hermetic guard, it never could. They start their
 * own fixture daemon on an ephemeral port, in POSTGRES MODE because
 * /api/steps/ writes to step_handoffs, and skip only when there is no
 * disposable database to point it at.
 *
 * Run: node --test tests/step-handoff-daemon.test.cjs
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { startFixtureDaemon, stopFixtureDaemon } = require('./support/fixture-daemon.cjs');
const pg = require('./support/pg-fixture.cjs');

let daemon = null;

/** @returns {string} the fixture daemon's /api/steps base URL */
function stepsBase() {
  if (!daemon) throw new Error('the fixture daemon has not started yet');
  return `http://127.0.0.1:${daemon.port}/api/steps`;
}

// /api/steps/ persists to step_handoffs, a PostgreSQL table, so this file needs
// the daemon in Postgres mode. Without a disposable database the seven live
// tests carry the one standard reason.
const SKIP_REASON = pg.postgresDsn() ? false : pg.SKIP_REASON;

before(async () => {
  if (SKIP_REASON) return;
  daemon = await startFixtureDaemon({ postgres: true });
});

after(async () => {
  await stopFixtureDaemon(daemon);
  daemon = null;
});

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

  it('daemon GET /api/steps/ validates phase_number is a number', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    // Phase 89 plan 89-02 (FND-11). This asserted `content.includes('phase must be
    // integer')` — a string that has not been the daemon's error message since Phase
    // 88; the only occurrence left was inside `_parse_phase_arg`'s docstring, which
    // was recounting the historical message it replaced. The assertion was therefore
    // pinned to a COMMENT and passed no matter what the code did. It now pins the
    // error the code actually answers, and asserts that the refusal 031 removed is
    // gone.
    assert.ok(
      content.includes('"error": "phase must be a number (e.g. 72 or 72.1)"'),
      'daemon missing the typed 400 for a non-numeric phase in /api/steps/'
    );
    assert.ok(
      // The bare prefix, not the full old error name: this assertion must be able
      // to live in a tree where `grep -rc <the old name> services/ tests/` is zero,
      // and `decimal_phase` is also the STRICTER test.
      !content.includes('decimal_phase'),
      'the daemon still carries a decimal-phase refusal; '
        + 'migration 031 made step_handoffs.phase_number NUMERIC(10,3)'
    );
  });

  it('daemon binds phase_number as a numeric, not as a binary float', () => {
    const content = fs.readFileSync(DAEMON_FILE, 'utf-8');
    // A float parameter against a NUMERIC column makes PostgreSQL cast the column to
    // double precision, which reintroduces exactly the inexact `= 72.1` comparison
    // NUMERIC(10,3) was chosen to avoid. Every PG bind of a phase goes through
    // `_pg_phase`, which returns a decimal.Decimal.
    assert.ok(content.includes('def _pg_phase('), 'daemon missing the _pg_phase adapter');
    assert.ok(
      content.includes('_pg_phase(phase_number)'),
      'the /api/steps/ handoff INSERT does not bind phase_number through _pg_phase'
    );
    assert.ok(
      content.includes('_pg_phase(_phase_num)'),
      'the /api/complexity/escalate handoff INSERT does not bind through _pg_phase'
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


    it('GET returns {"step_id": null} when no handoff exists', { skip: SKIP_REASON }, async () => {
      const r = await httpRequest('GET', `${stepsBase()}/plan-phase/999999`, null);
      assert.strictEqual(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.step_id, null, `Expected null step_id, got: ${r.body.step_id}`);
    });

    it('GET returns 400 for non-integer phase', { skip: SKIP_REASON }, async () => {
      const r = await httpRequest('GET', `${stepsBase()}/plan-phase/abc`, null);
      assert.strictEqual(r.status, 400, `Expected 400, got ${r.status}: ${JSON.stringify(r.body)}`);
    });

    it('POST creates handoff and returns 201 with id and created_at', { skip: SKIP_REASON }, async () => {
      const r = await httpRequest('POST', `${stepsBase()}/plan-phase/99/handoff`, {
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

    it('GET returns latest handoff after POST', { skip: SKIP_REASON }, async () => {
      // POST first handoff
      await httpRequest('POST', `${stepsBase()}/plan-phase/99/handoff`, {
        step_id: 'step-01-init',
        task_id: 'daemon-test-get-01',
        completed_steps: [],
        context_snapshot: { order: 1 },
        next_step: 'step-02-research',
      });
      // POST second handoff (newer)
      await httpRequest('POST', `${stepsBase()}/plan-phase/99/handoff`, {
        step_id: 'step-02-research',
        task_id: 'daemon-test-get-01',
        completed_steps: ['step-01-init'],
        context_snapshot: { order: 2 },
        next_step: 'step-03-plan',
      });
      // GET should return the SECOND (latest) handoff
      const r = await httpRequest('GET', `${stepsBase()}/plan-phase/99`, null);
      assert.strictEqual(r.status, 200, `GET failed: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.step_id, 'step-02-research', `Expected step-02-research, got: ${r.body.step_id}`);
    });

    it('GET includes all expected fields when handoff exists', { skip: SKIP_REASON }, async () => {
      const r = await httpRequest('GET', `${stepsBase()}/plan-phase/99`, null);
      assert.strictEqual(r.status, 200);
      const fields = ['workflow_name', 'step_id', 'task_id', 'phase_number', 'completed_steps', 'context_snapshot'];
      for (const field of fields) {
        assert.ok(field in r.body, `Missing field ${field} in GET response`);
      }
    });

    it('POST preserves JSONB fields (context_snapshot, artifacts, decisions)', { skip: SKIP_REASON }, async () => {
      const complexContext = { key1: 'value1', nested: { a: 1, b: [1, 2, 3] } };
      const complexArtifacts = { plan_files: ['f1.md'], summaries: ['s1'] };
      const complexDecisions = [{ decision: 'test', rationale: 'r', agent: 'test-agent' }];
      await httpRequest('POST', `${stepsBase()}/plan-phase/99/handoff`, {
        step_id: 'step-03-plan',
        task_id: 'daemon-test-jsonb-01',
        completed_steps: ['step-01-init', 'step-02-research'],
        context_snapshot: complexContext,
        artifacts: complexArtifacts,
        decisions: complexDecisions,
        next_step: 'step-04-check',
      });
      const r = await httpRequest('GET', `${stepsBase()}/plan-phase/99`, null);
      assert.strictEqual(r.status, 200);
      // Verify context_snapshot was preserved (it should be returned)
      assert.ok(r.body.context_snapshot !== null, 'context_snapshot should not be null');
    });

    it('Multiple workflows are independent (plan-phase vs execute-phase)', { skip: SKIP_REASON }, async () => {
      await httpRequest('POST', `${stepsBase()}/plan-phase/99/handoff`, {
        step_id: 'step-04-check',
        task_id: 'daemon-test-wf-01',
        completed_steps: ['step-01-init', 'step-02-research', 'step-03-plan'],
        context_snapshot: { workflow: 'plan' },
        next_step: 'step-05-approve',
      });
      await httpRequest('POST', `${stepsBase()}/execute-phase/99/handoff`, {
        step_id: 'step-02-route',
        task_id: 'daemon-test-wf-01',
        completed_steps: ['step-01-prepare'],
        context_snapshot: { workflow: 'execute' },
        next_step: 'step-03-execute',
      });
      const planR = await httpRequest('GET', `${stepsBase()}/plan-phase/99`, null);
      const execR = await httpRequest('GET', `${stepsBase()}/execute-phase/99`, null);
      assert.strictEqual(planR.body.step_id, 'step-04-check', `plan-phase step wrong: ${planR.body.step_id}`);
      assert.strictEqual(execR.body.step_id, 'step-02-route', `execute-phase step wrong: ${execR.body.step_id}`);
    });


});

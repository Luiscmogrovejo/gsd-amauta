/**
 * GSD-Amauta CLI Tests
 *
 * Tests the Node.js CLI wrapper (gsd-amauta.cjs) against the live daemon.
 * Requires: daemon running on :18799, PG on :5433.
 *
 * If daemon is not running, integration tests are skipped gracefully.
 *
 * TK-0057
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');

const CLI_PATH = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs');

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function run(args, { expectFail = false } = {}) {
  try {
    const result = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AMAUTA_DATA_DIR: path.join(__dirname, '..', 'data'),
      },
      timeout: 15000,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return {
      success: false,
      output: (err.stdout || '').toString().trim(),
      error: (err.stderr || '').toString().trim(),
      code: err.status,
    };
  }
}

function runJSON(args) {
  const result = run([...args, '--json']);
  if (result.output) {
    try {
      result.json = JSON.parse(result.output);
    } catch {
      // Not all commands support --json cleanly
    }
  }
  return result;
}

function daemonHealth() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:18799/health', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function skipIfNoDaemon(ctx) {
  if (!daemonOk) {
    ctx.skip('daemon not running');
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════

let daemonOk = false;
let testTaskId = null;

describe('gsd-amauta.cjs', () => {

  before(async () => {
    const health = await daemonHealth();
    daemonOk = health && health.status === 'ok';
    if (!daemonOk) {
      console.log('  WARN: Daemon not running — skipping integration tests');
    }
  });

  // ─── CLI Help (no daemon needed) ──────────────────

  describe('help', () => {
    test('no args shows usage', () => {
      const r = run([]);
      const combined = r.output + ' ' + (r.error || '');
      assert.ok(
        combined.includes('gsd-amauta') || combined.includes('Usage') || combined.includes('Commands'),
        `should show usage: ${combined.slice(0, 200)}`
      );
    });

    test('unknown command shows error', () => {
      const r = run(['nonexistent-xyz-command'], { expectFail: true });
      const combined = r.output + ' ' + (r.error || '');
      assert.ok(
        !r.success || combined.includes('Unknown') || combined.includes('ERROR'),
        `should fail or show error: ${combined.slice(0, 200)}`
      );
    });
  });

  // ─── Daemon Status ─────────────────────────────────

  describe('daemon status', () => {
    test('daemon status reports running', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = run(['daemon', 'status']);
      assert.ok(r.success, `daemon status should succeed: ${r.error || ''}`);
      assert.ok(
        r.output.includes('running') || r.output.includes('Daemon'),
        `should indicate running: ${r.output}`
      );
    });
  });

  describe('stats', () => {
    test('stats command runs successfully', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = run(['stats']);
      assert.ok(r.success, `stats should succeed: ${r.error || ''}`);
      assert.ok(r.output.length > 10, 'should have meaningful output');
    });
  });

  // ─── CRUD: Add → Show → Claim → RPETD → Validate ─

  describe('task lifecycle', () => {

    test('1. add a test task', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = run(['exec', 'add', 'task', 'GSD-AMAUTA-TEST-TASK-AUTO', '--agent', 'executor-general', '--priority', 'low', '--description', 'Automated test task — safe to delete']);
      assert.ok(r.success, `add should succeed: ${r.error || r.output}`);
      const match = r.output.match(/TK-\d+/);
      assert.ok(match, `should return task ID: ${r.output}`);
      testTaskId = match[0];
    });

    test('2. show the created task', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['show', testTaskId]);
      assert.ok(r.success, `show should succeed: ${r.error || ''}`);
      assert.ok(r.output.includes('GSD-AMAUTA-TEST-TASK-AUTO'), 'should contain task title');
      assert.ok(r.output.includes(testTaskId), 'should contain task ID');
    });

    test('3. list includes the task', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['list']);
      assert.ok(r.success, 'list should succeed');
      assert.ok(r.output.length > 0, 'should have output');
    });

    test('4. claim the test task', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['claim', testTaskId, '--agent', 'executor-general']);
      assert.ok(r.success, `claim should succeed: ${r.error || r.output}`);
      assert.ok(
        r.output.includes('CLAIMED') || r.output.includes('in-progress'),
        `should show claimed: ${r.output}`
      );
    });

    test('5. rpetd R phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['rpetd', testTaskId, '--phase', 'R', '--content', 'Research: automated test research entry']);
      assert.ok(r.success, `rpetd R should succeed: ${r.error || r.output}`);
    });

    test('6. rpetd P phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['rpetd', testTaskId, '--phase', 'P', '--content', 'Plan: automated test plan entry']);
      assert.ok(r.success, `rpetd P should succeed: ${r.error || r.output}`);
    });

    test('7. rpetd E phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['rpetd', testTaskId, '--phase', 'E', '--content', 'Execute: implemented changes on feat/test-branch']);
      assert.ok(r.success, `rpetd E should succeed: ${r.error || r.output}`);
    });

    test('8. rpetd T phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['rpetd', testTaskId, '--phase', 'T', '--content', 'Test: $ npm test\nPASS all tests passed (3/3)']);
      assert.ok(r.success, `rpetd T should succeed: ${r.error || r.output}`);
    });

    test('9. rpetd D phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['rpetd', testTaskId, '--phase', 'D', '--content', 'Document: LEARNING: test lifecycle works end-to-end']);
      assert.ok(r.success, `rpetd D should succeed: ${r.error || r.output}`);
    });

    test('10. tag no-gitflow for validation', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['exec', 'update', testTaskId, '--tags', 'no-gitflow']);
      assert.ok(r.success, `update tags should succeed: ${r.error || r.output}`);
    });

    test('11. validate --pass --force', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['validate', testTaskId, '--pass', '--force']);
      assert.ok(r.success, `validate should succeed: ${r.error || r.output}`);
      assert.ok(
        r.output.includes('VALIDATED') || r.output.includes('DONE'),
        `should show validated: ${r.output}`
      );
    });

    test('12. task is now done', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!testTaskId) { t.skip('no test task'); return; }
      const r = run(['show', testTaskId]);
      assert.ok(r.success, 'show should succeed');
      assert.ok(
        r.output.includes('done') || r.output.includes('DONE'),
        `should be done: ${r.output}`
      );
    });
  });

  // ─── Board ────────────────────────────────────────

  describe('board', () => {
    test('board command runs', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = run(['board']);
      assert.ok(r.success, `board should succeed: ${r.error || ''}`);
      assert.ok(
        r.output.includes('PENDING') || r.output.includes('DONE') || r.output.includes('BOARD'),
        'should show board sections'
      );
    });
  });

  // ─── Cleanup ──────────────────────────────────────

  after(() => {
    if (testTaskId && daemonOk) {
      try {
        run(['exec', 'delete', testTaskId, '--force']);
      } catch { /* best effort cleanup */ }
    }
  });
});

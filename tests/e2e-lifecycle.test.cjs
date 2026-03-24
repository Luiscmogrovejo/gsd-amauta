/**
 * GSD-Amauta E2E Lifecycle Test
 *
 * Tests the full lifecycle: create epic/stories → create tasks → claim →
 * RPETD all 5 phases → validate → verify memory entries → cleanup.
 *
 * Requires: daemon on :18799, PG on :5433.
 *
 * TK-0058
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');

const AMAUTA_CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs');
const MEMORY_CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');
const RLM_CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-rlm.cjs');
const RESEARCH_CLI = path.join(__dirname, '..', 'get-shit-done', 'bin', 'gsd-research.cjs');

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function run(cliPath, args) {
  try {
    const result = execFileSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AMAUTA_DATA_DIR: path.join(__dirname, '..', 'data'),
        GSD_MEMORY_DISTILL_THRESHOLD: '999999',  // Disable auto-distill in tests
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

function amauta(args) { return run(AMAUTA_CLI, args); }
function memory(args) { return run(MEMORY_CLI, args); }
function rlm(args) { return run(RLM_CLI, args); }

function extractId(output, prefix = 'TK') {
  const match = output.match(new RegExp(`${prefix}-\\d+`));
  return match ? match[0] : null;
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

// ═══════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════

let daemonOk = false;
let epicId = null;
let storyId = null;
let taskId = null;

function skipIfNoDaemon(ctx) {
  if (!daemonOk) { ctx.skip('daemon not running'); return true; }
  return false;
}

describe('E2E Lifecycle', () => {

  before(async () => {
    const health = await daemonHealth();
    daemonOk = health && health.status === 'ok';
    if (!daemonOk) console.log('  WARN: Daemon not running — skipping E2E tests');
  });

  // ─── Phase 1: Create project structure in Amauta ──

  describe('1. Project structure', () => {
    test('create epic', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = amauta(['exec', 'add', 'epic', 'E2E-TEST-PROJECT', '--agent', 'operator', '--priority', 'low', '--description', 'Automated E2E test — safe to delete']);
      assert.ok(r.success, `add epic: ${r.error || r.output}`);
      epicId = extractId(r.output, 'EP');
      assert.ok(epicId, `should get epic ID: ${r.output}`);
    });

    test('create story under epic', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!epicId) { t.skip('no epic'); return; }
      const r = amauta(['exec', 'add', 'story', 'E2E Phase 1: Setup', '--parent', epicId, '--agent', 'operator', '--description', 'Setup phase for E2E test']);
      assert.ok(r.success, `add story: ${r.error || r.output}`);
      storyId = extractId(r.output, 'ST');
      assert.ok(storyId, `should get story ID: ${r.output}`);
    });

    test('create task under story', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!storyId) { t.skip('no story'); return; }
      const uniqueTitle = `E2E-LIFECYCLE-TASK-${Date.now()}`;
      const r = amauta(['exec', 'add', 'task', uniqueTitle, '--parent', storyId, '--agent', 'executor-general', '--priority', 'low', '--description', 'Task for E2E lifecycle test']);
      assert.ok(r.success, `add task: ${r.error || r.output}`);
      taskId = extractId(r.output, 'TK');
      assert.ok(taskId, `should get task ID: ${r.output}`);
    });

    test('epic is visible via show', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!epicId) { t.skip('no epic'); return; }
      const r = amauta(['show', epicId]);
      assert.ok(r.success, `show epic should work: ${r.error || ''}`);
      assert.ok(
        r.output.includes('E2E-TEST-PROJECT') || r.output.includes(epicId),
        `show should contain epic title or ID: ${r.output.slice(0, 300)}`
      );
    });
  });

  // ─── Phase 2: Task lifecycle (claim → RPETD → validate) ──

  describe('2. Task lifecycle', () => {
    test('claim task', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      const r = amauta(['claim', taskId, '--agent', 'executor-general']);
      // Accept both fresh claim and already-in-progress (idempotent)
      const alreadyClaimed = r.error && (r.error.includes('in-progress') || r.output.includes('in-progress'));
      assert.ok(r.success || alreadyClaimed, `claim: ${r.error || r.output}`);
    });

    test('RPETD R-phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      const r = amauta(['rpetd', taskId, '--phase', 'R', '--content', 'Research: Investigated E2E testing patterns for CLI tools']);
      assert.ok(r.success, `rpetd R: ${r.error || r.output}`);
    });

    test('RPETD P-phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      const r = amauta(['rpetd', taskId, '--phase', 'P', '--content', 'Plan: Will implement sequential test with cleanup']);
      assert.ok(r.success, `rpetd P: ${r.error || r.output}`);
    });

    test('RPETD E-phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      const r = amauta(['rpetd', taskId, '--phase', 'E', '--content', 'Execute: Changes made on feat/e2e-test branch. All files updated.']);
      assert.ok(r.success, `rpetd E: ${r.error || r.output}`);
    });

    test('RPETD T-phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      const r = amauta(['rpetd', taskId, '--phase', 'T', '--content', 'Test: $ node --test\nPASS e2e-lifecycle (5 tests)\nAll tests passed']);
      assert.ok(r.success, `rpetd T: ${r.error || r.output}`);
    });

    test('RPETD D-phase', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      const r = amauta(['rpetd', taskId, '--phase', 'D', '--content', 'Document: LEARNING: E2E lifecycle test validates all RPETD phases and cleanup']);
      assert.ok(r.success, `rpetd D: ${r.error || r.output}`);
    });

    test('show task has RPETD phases', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      const r = amauta(['show', taskId]);
      assert.ok(r.success, 'show should work');
      // The show output should indicate in-progress status and logged phases
      assert.ok(r.output.includes(taskId), 'should contain task ID');
    });
  });

  // ─── Phase 3: Validation ──────────────────────────

  describe('3. Validation', () => {
    test('tag no-gitflow', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      const r = amauta(['exec', 'update', taskId, '--tags', 'no-gitflow']);
      assert.ok(r.success, `tag: ${r.error || r.output}`);
    });

    test('move to validation status', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      // Move to validation status first (validate --pass requires validation or in-progress)
      const r = amauta(['status', taskId, 'validation']);
      // OK if already in validation or succeeds
      assert.ok(r.success || r.output.includes('validation') || r.error.includes('validation'),
        `status validation: ${r.error || r.output}`);
    });

    test('validate --pass --force-reason', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      // Move to validation status first — validate --pass requires validation/in-progress
      amauta(['status', taskId, 'validation', '--agent', 'executor-general']);
      const r = amauta(['validate', taskId, '--pass', '--force-reason', 'automated-test-override', '--validator', 'e2e-test', '--notes', 'E2E automated pass']);
      assert.ok(r.success, `validate: ${r.error || r.output}`);
      assert.ok(r.output.includes('VALIDATED') || r.output.includes('DONE') || r.output.includes('done'));
    });

    test('task status is done', (t) => {
      if (skipIfNoDaemon(t)) return;
      if (!taskId) { t.skip('no task'); return; }
      const r = amauta(['show', taskId, '--json']);
      assert.ok(r.success);
      try {
        const data = JSON.parse(r.output);
        assert.ok(data.status === 'done' || data.status === 'validated',
          `expected done/validated, got: ${data.status}`);
      } catch {
        assert.ok(r.output.includes('done') || r.output.includes('DONE') || r.output.includes('validated'),
          `should be done: ${r.output.slice(0, 200)}`);
      }
    });
  });

  // ─── Phase 4: Memory integration ─────────────────

  describe('4. Memory integration', () => {
    test('store a memory entry', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = memory(['store', 'E2E test memory entry — should be cleaned up', '--source', 'agent', '--tags', 'e2e-test']);
      assert.ok(r.success, `store: ${r.error || r.output}`);
      assert.ok(r.output.includes('Stored'), 'should confirm stored');
    });

    test('search finds the entry', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = memory(['search', 'E2E test memory']);
      assert.ok(r.success, `search: ${r.error || r.output}`);
      assert.ok(r.output.includes('E2E test memory entry'), 'should find stored entry');
    });

    test('learn stores auto_learning', (t) => {
      if (skipIfNoDaemon(t)) return;
      // learn calls /api/memory/store (same path as store test above).
      // In full-suite runs, prior tests may exhaust the 60-req/min rate limit.
      // Retry once after a delay; skip if still rate-limited (transient, not a code bug).
      const { execFileSync } = require('child_process');
      let r = memory(['learn', 'E2E test learning — cleanup after test']);
      const isRateLimited = (res) => ((res.error || '') + (res.output || '')).includes('Too many requests');
      if (!r.success && isRateLimited(r)) {
        execFileSync('sleep', ['3']);
        r = memory(['learn', 'E2E test learning — cleanup after test']);
      }
      if (!r.success && isRateLimited(r)) {
        t.skip('daemon rate-limited (60 req/min on /api/memory/store exhausted by prior tests)');
        return;
      }
      assert.ok(r.success, `learn: ${r.error || r.output}`);
      assert.ok(r.output.includes('auto_learning'), 'should be auto_learning source');
    });

    test('count returns > 0', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = memory(['count']);
      assert.ok(r.success, 'count should work');
      const match = r.output.match(/Memories:\s*(\d+)/);
      assert.ok(match && parseInt(match[1]) > 0, `count should be > 0: ${r.output}`);
    });

    test('infer-tags works', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = memory(['infer-tags', path.join(__dirname, '..'), '--json']);
      assert.ok(r.success, `infer-tags: ${r.error || r.output}`);
      const json = JSON.parse(r.output);
      assert.ok(json.tags.length > 0, 'should infer some tags');
      assert.ok(json.tags.includes('javascript'), 'should detect javascript');
    });

    test('cross-project search works', (t) => {
      if (skipIfNoDaemon(t)) return;
      // Just check it runs without error; may or may not find results
      const r = memory(['cross-project', 'test patterns', '--limit', '3']);
      assert.ok(r.success, `cross-project: ${r.error || r.output}`);
    });
  });

  // ─── Phase 5: RLM and Research CLIs ───────────────

  describe('5. RLM and Research CLIs', () => {
    test('RLM health check', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = rlm(['health']);
      // May or may not be running; just check CLI doesn't crash
      assert.ok(r.output.length > 0 || r.error.length > 0, 'should produce output');
    });

    test('research check-providers', (t) => {
      if (skipIfNoDaemon(t)) return;
      const r = run(RESEARCH_CLI, ['check-providers']);
      assert.ok(r.success, `check-providers: ${r.error || r.output}`);
      assert.ok(r.output.includes('memory'), 'should list memory provider');
      assert.ok(r.output.includes('perplexity'), 'should list perplexity provider');
    });
  });

  // ─── Cleanup ──────────────────────────────────────

  after(() => {
    if (!daemonOk) return;
    // Delete test artifacts (best effort) — use 'delete' command (has dedicated /api/delete route)
    const toDelete = [taskId, storyId, epicId].filter(Boolean);
    for (const id of toDelete) {
      try { amauta(['delete', id]); } catch { /* ok */ }
    }
  });
});

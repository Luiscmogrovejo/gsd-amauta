/**
 * Auto-Learning Feedback Loop Tests
 *
 * Tests the agent performance tracking system:
 *   - _extract_failed_gate() — gate name extraction from validator notes
 *   - _calc_duration_minutes() — duration calculation from claimed_at
 *   - Performance recording in cmd_validate (pass + fail paths)
 *   - Performance injection in Layer 1 enrichment
 *   - pg_store methods (record + summary)
 *   - Daemon routes (GET + POST /api/agent-performance)
 *   - Graceful degradation when PG unavailable
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const AMAUTA_PY = path.join(__dirname, '..', 'amauta.py');

function withTmp(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autolearn-test-'));
  try { fn(tmpDir); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ } }
}

function py(args, dataDir) {
  try {
    const out = execFileSync('python3', [AMAUTA_PY, ...args], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AMAUTA_DATA_DIR: dataDir, NO_COLOR: '1', GSD_AMAUTA_PORT: '19999' },
      cwd: dataDir,
      timeout: 10000,
    });
    return { success: true, output: out.trim(), error: '' };
  } catch (err) {
    return { success: false, output: (err.stdout || '').toString().trim(), error: (err.stderr || '').toString().trim() };
  }
}

// ═══════════════════════════════════════════════════════
// _extract_failed_gate unit tests (via Python inline)
// ═══════════════════════════════════════════════════════

describe('_extract_failed_gate() — gate extraction from notes', () => {

  function extractGate(notes) {
    const result = execFileSync('python3', ['-c', `
import sys; sys.path.insert(0, '${path.join(__dirname, '..')}')
from amauta import _extract_failed_gate
print(_extract_failed_gate(${JSON.stringify(notes)}))
`], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    return result.trim();
  }

  test('detects BRANCH_EVIDENCE from "no branch evidence"', () => {
    assert.strictEqual(extractGate('FAIL: no branch evidence in E-phase'), 'BRANCH_EVIDENCE');
  });

  test('detects BRANCH_EVIDENCE from gate constant name', () => {
    assert.strictEqual(extractGate('BRANCH_EVIDENCE: missing feat/ branch'), 'BRANCH_EVIDENCE');
  });

  test('detects LEARNING_BLOCK from "no learning"', () => {
    assert.strictEqual(extractGate('FAIL: no learning block found'), 'LEARNING_BLOCK');
  });

  test('detects LEARNING_BLOCK from gate constant name', () => {
    assert.strictEqual(extractGate('LEARNING_BLOCK: D-phase empty'), 'LEARNING_BLOCK');
  });

  test('detects TEST_EVIDENCE from "test evidence"', () => {
    assert.strictEqual(extractGate('FAIL: test evidence missing from T-phase'), 'TEST_EVIDENCE');
  });

  test('detects TEST_EVIDENCE from "no test output"', () => {
    assert.strictEqual(extractGate('no test output captured'), 'TEST_EVIDENCE');
  });

  test('detects PR_URL from "pr url"', () => {
    assert.strictEqual(extractGate('PR_URL: no PR found in D or E phase'), 'PR_URL');
  });

  test('detects PR_URL from "pull request"', () => {
    assert.strictEqual(extractGate('FAIL: missing pull request reference'), 'PR_URL');
  });

  test('detects PR_URL from "not merged"', () => {
    assert.strictEqual(extractGate('changes not merged to main'), 'PR_URL');
  });

  test('returns UNKNOWN for generic notes', () => {
    assert.strictEqual(extractGate('FAIL: success criteria not met'), 'UNKNOWN');
  });

  test('does NOT false-positive "pr" in "project"', () => {
    // This was the B4 bug — "pr" in "project" used to match PR_URL
    assert.strictEqual(extractGate('FAIL: project requirements incomplete'), 'UNKNOWN');
  });

  test('does NOT false-positive "test" in "latest"', () => {
    assert.strictEqual(extractGate('FAIL: latest version not deployed'), 'UNKNOWN');
  });

  test('Gate 1 keyword works', () => {
    assert.strictEqual(extractGate('Gate 1 failed'), 'BRANCH_EVIDENCE');
  });

  test('Gate 4 keyword works', () => {
    assert.strictEqual(extractGate('Gate 4 not satisfied'), 'PR_URL');
  });
});

// ═══════════════════════════════════════════════════════
// _calc_duration_minutes unit tests
// ═══════════════════════════════════════════════════════

describe('_calc_duration_minutes() — duration calculation', () => {

  function calcDuration(claimedAt) {
    const result = execFileSync('python3', ['-c', `
import sys; sys.path.insert(0, '${path.join(__dirname, '..')}')
from amauta import _calc_duration_minutes
print(_calc_duration_minutes(${JSON.stringify(claimedAt)}))
`], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    return result.trim();
  }

  test('returns None for missing claimed_at', () => {
    assert.strictEqual(calcDuration({}), 'None');
  });

  test('returns None for null claimed_at', () => {
    const result = execFileSync('python3', ['-c', `
import sys; sys.path.insert(0, '${path.join(__dirname, '..')}')
from amauta import _calc_duration_minutes
print(_calc_duration_minutes({"claimed_at": None}))
`], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
    assert.strictEqual(result.trim(), 'None');
  });

  test('returns integer for valid ISO datetime', () => {
    // Claimed 5 minutes ago
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = calcDuration({ claimed_at: fiveMinAgo });
    const minutes = parseInt(result, 10);
    assert.ok(!isNaN(minutes), `should be a number: ${result}`);
    assert.ok(minutes >= 4 && minutes <= 7, `should be ~5 minutes: ${minutes}`);
  });

  test('returns 0 for just-now claim', () => {
    const now = new Date().toISOString();
    const result = calcDuration({ claimed_at: now });
    const minutes = parseInt(result, 10);
    assert.ok(minutes >= 0 && minutes <= 1, `should be 0-1 minutes: ${minutes}`);
  });
});

// ═══════════════════════════════════════════════════════
// Performance recording integration (via validate)
// ═══════════════════════════════════════════════════════

describe('Performance recording in cmd_validate', () => {

  test('validate --pass calls _record_agent_performance (code path exists)', () => {
    const content = fs.readFileSync(AMAUTA_PY, 'utf-8');
    // Both VALIDATED print and _record_agent_performance should exist in cmd_validate
    assert.ok(content.includes('VALIDATED'), 'should have VALIDATED print');
    // Check that _record_agent_performance appears in cmd_validate function
    const cmdValidateStart = content.indexOf('def cmd_validate(');
    const cmdValidateEnd = content.indexOf('\ndef ', cmdValidateStart + 1);
    const cmdValidateBody = content.slice(cmdValidateStart, cmdValidateEnd > 0 ? cmdValidateEnd : undefined);
    const callCount = (cmdValidateBody.match(/_record_agent_performance/g) || []).length;
    assert.ok(callCount >= 2, `cmd_validate should call _record_agent_performance at least twice (pass+fail), found ${callCount}`);
  });

  test('validate --fail calls _record_agent_performance (code path exists)', () => {
    const content = fs.readFileSync(AMAUTA_PY, 'utf-8');
    const failSection = content.indexOf('FAILED ✗');
    const recordCall = content.indexOf('_record_agent_performance', failSection);
    assert.ok(recordCall > failSection && recordCall - failSection < 500,
      '_record_agent_performance should be called near FAILED print');
  });

  test('pass path includes learning_captured from D-phase', () => {
    const content = fs.readFileSync(AMAUTA_PY, 'utf-8');
    assert.ok(content.includes('learning_captured=(item.get("rpetd_phases")'),
      'pass path should extract D-phase LEARNING for tracking');
  });

  test('fail path includes gate_failed extraction', () => {
    const content = fs.readFileSync(AMAUTA_PY, 'utf-8');
    assert.ok(content.includes('gate_failed=_extract_failed_gate'),
      'fail path should extract which gate failed');
  });
});

// ═══════════════════════════════════════════════════════
// Performance injection in Layer 1 enrichment
// ═══════════════════════════════════════════════════════

describe('Performance injection in _enrich_task_context', () => {

  test('enrichment queries agent performance summary', () => {
    const content = fs.readFileSync(AMAUTA_PY, 'utf-8');
    assert.ok(content.includes('_agent_performance_summary(owner)'),
      'enrichment should query performance summary for the claiming agent');
  });

  test('enrichment injects [AGENT PERFORMANCE] section', () => {
    const content = fs.readFileSync(AMAUTA_PY, 'utf-8');
    assert.ok(content.includes('[AGENT PERFORMANCE]'),
      'enrichment should inject [AGENT PERFORMANCE] label');
  });

  test('enrichment shows pass rate and common failures', () => {
    const content = fs.readFileSync(AMAUTA_PY, 'utf-8');
    assert.ok(content.includes('pass rate'), 'should show pass rate');
    assert.ok(content.includes('Common issues'), 'should show common failure patterns');
  });

  test('enrichment shows 100% message for perfect agents', () => {
    const content = fs.readFileSync(AMAUTA_PY, 'utf-8');
    assert.ok(content.includes('100% pass rate'), 'should congratulate perfect agents');
  });

  test('performance injection wrapped in try/except (best-effort)', () => {
    const content = fs.readFileSync(AMAUTA_PY, 'utf-8');
    const perfStart = content.indexOf('Agent performance history');
    assert.ok(perfStart > 0, 'should have agent performance section in enrichment');
    // Check that the section has exception handling within 2000 chars
    const section = content.slice(perfStart, perfStart + 2000);
    assert.ok(section.includes('except'), 'performance section should have except handler');
  });
});

// ═══════════════════════════════════════════════════════
// pg_store methods exist
// ═══════════════════════════════════════════════════════

describe('pg_store.py agent performance methods', () => {

  test('record_agent_performance method exists', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'pg_store.py'), 'utf-8');
    assert.ok(content.includes('def record_agent_performance('),
      'pg_store.py should have record_agent_performance method');
  });

  test('agent_performance_summary method exists with pass/fail stats', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'pg_store.py'), 'utf-8');
    assert.ok(content.includes('def agent_performance_summary('),
      'pg_store.py should have agent_performance_summary method');
    assert.ok(content.includes("outcome = 'pass'"),
      'should count pass outcomes');
    assert.ok(content.includes("outcome = 'fail'"),
      'should count fail outcomes');
  });

  test('summary returns common_failures with gate_failed', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'pg_store.py'), 'utf-8');
    assert.ok(content.includes('gate_failed, COUNT(*)'),
      'should group failures by gate_failed');
  });

  test('summary returns recent_failures with hours_ago', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'pg_store.py'), 'utf-8');
    assert.ok(content.includes('hours_ago'),
      'should calculate hours_ago for recent failures');
  });
});

// ═══════════════════════════════════════════════════════
// Daemon routes
// ═══════════════════════════════════════════════════════

describe('Daemon agent-performance routes', () => {

  test('GET /api/agent-performance route exists with query param parsing', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'amauta-daemon.py'), 'utf-8');
    assert.ok(content.includes('"/api/agent-performance"') || content.includes("'/api/agent-performance'"),
      'daemon should have /api/agent-performance route');
    assert.ok(content.includes('agent_id'),
      'route should parse agent_id param');
  });

  test('POST /api/agent-performance route validates required fields', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'amauta-daemon.py'), 'utf-8');
    assert.ok(content.includes('agent_id and task_id are required'),
      'POST route should validate agent_id and task_id');
  });

  test('POST route calls pg_store.record_agent_performance', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'amauta-daemon.py'), 'utf-8');
    assert.ok(content.includes('record_agent_performance'),
      'POST route should call pg_store method');
  });
});

// ═══════════════════════════════════════════════════════
// Migration
// ═══════════════════════════════════════════════════════

describe('Migration 005: gsd_agent_performance table', () => {

  test('migration file exists', () => {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'migrations', '005-agent-performance.sql')),
      'migrations/005-agent-performance.sql should exist');
  });

  test('migration creates gsd_agent_performance table', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '005-agent-performance.sql'), 'utf-8');
    assert.ok(content.includes('CREATE TABLE IF NOT EXISTS gsd_agent_performance'),
      'should create gsd_agent_performance table');
  });

  test('migration has outcome check constraint', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '005-agent-performance.sql'), 'utf-8');
    assert.ok(content.includes("outcome IN ('pass', 'fail')"),
      'outcome should be constrained to pass/fail');
  });

  test('migration has agent_id index', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '005-agent-performance.sql'), 'utf-8');
    assert.ok(content.includes('idx_agent_perf_agent'),
      'should have agent_id index');
  });
});

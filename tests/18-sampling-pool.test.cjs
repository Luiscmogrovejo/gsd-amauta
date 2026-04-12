#!/usr/bin/env node
/**
 * Plan 18-02: Regression tests for SAMPLE-01 rewrite of sampleCompletedTasks().
 *
 * Dual-path coverage (18-CONTEXT.md § Dual-Path Test Coverage MANDATORY):
 *   Path A — daemon available, queryDaemonTaskIds returns success
 *   Path B — daemon unavailable OR empty pool, fallback to SUMMARY.md
 *
 * Stub strategy: verify-v26.cjs uses `const { spawnSync } = require('child_process')`
 * at require time. We hijack child_process.spawnSync BEFORE requiring the script —
 * the module's destructured binding captures the stub value at require time.
 * Each test uses freshRequireVerify() to invalidate require.cache and re-require
 * with a fresh stub in place.
 *
 * Run: node --test tests/18-sampling-pool.test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const VERIFY_PATH = path.join(REPO_ROOT, 'scripts', 'verify-v26.cjs');

// ─── Helpers: fresh require + spawnSync hijack ─────────────────────────────

function freshRequireVerify(spawnSyncStub) {
  // Clear verify-v26 from the require cache so each test gets a fresh module
  // with our stub in place.
  delete require.cache[require.resolve(VERIFY_PATH)];
  // Hijack child_process.spawnSync BEFORE requiring the module. The module's
  // `const { spawnSync } = require('child_process')` captures the stub value
  // at require time because destructuring reads the property at that moment.
  const realChildProcess = require('node:child_process');
  const originalSpawnSync = realChildProcess.spawnSync;
  realChildProcess.spawnSync = spawnSyncStub;
  try {
    const mod = require(VERIFY_PATH);
    return mod;
  } finally {
    realChildProcess.spawnSync = originalSpawnSync;
    // Clear again so subsequent tests re-require cleanly.
    delete require.cache[require.resolve(VERIFY_PATH)];
  }
}

// Build a fake `gsd-amauta.cjs exec list --json` envelope containing the
// provided TK-IDs. Real daemon output is ANSI-wrapped; we include ANSI codes
// in the fixture to verify the regex survives them.
function buildDaemonEnvelope(taskIds) {
  const ansiBold = '\u001b[1m';
  const ansiReset = '\u001b[0m';
  const lines = taskIds.map((tk) => `${ansiBold}${tk}${ansiReset}  done  @executor`).join('\n');
  return JSON.stringify({ output: lines });
}

// Build a spawnSync stub that returns a canned daemon envelope for the
// gsd-amauta.cjs call and delegates everything else to the real implementation.
function buildDaemonStub(envelope, overrides) {
  overrides = overrides || {};
  const realSpawnSync = require('node:child_process').spawnSync;
  return function spawnSyncStub(cmd, args, opts) {
    const joined = Array.isArray(args) ? args.join(' ') : '';
    if (cmd === 'node' && joined.includes('gsd-amauta.cjs') && joined.includes('exec list')) {
      return Object.assign({
        pid: 1234,
        status: 0,
        signal: null,
        stdout: envelope,
        stderr: '',
        error: null,
      }, overrides);
    }
    // Pass through to real spawnSync for npm/pytest calls during buildReport.
    return realSpawnSync(cmd, args, opts);
  };
}

// ─── Path A: daemon available, returns TK-IDs ─────────────────────────────

test('Path A: sampleCompletedTasks returns daemon IDs when queryDaemonTaskIds succeeds', () => {
  const envelope = buildDaemonEnvelope(['TK-0001', 'TK-0002', 'TK-0003']);
  const stub = buildDaemonStub(envelope);
  const mod = freshRequireVerify(stub);
  const ids = mod.sampleCompletedTasks();
  assert.ok(Array.isArray(ids), 'returns an array');
  assert.ok(ids.includes('TK-0001'), 'includes TK-0001 from daemon envelope');
  assert.ok(ids.includes('TK-0002'), 'includes TK-0002 from daemon envelope');
  assert.ok(ids.includes('TK-0003'), 'includes TK-0003 from daemon envelope');
});

test('Path A: queryDaemonTaskIds returns success=true with TK-IDs parsed from envelope', () => {
  const envelope = buildDaemonEnvelope(['TK-0042']);
  const stub = buildDaemonStub(envelope);
  const mod = freshRequireVerify(stub);
  const result = mod.queryDaemonTaskIds();
  assert.strictEqual(result.success, true, 'success flag is true');
  assert.ok(result.ids.includes('TK-0042'), 'ids array includes TK-0042');
  assert.strictEqual(result.reason, null, 'reason is null on success');
});

test('Path A: queryDaemonTaskIds shells out to gsd-amauta.cjs (NOT amauta.cjs wrapper)', () => {
  let capturedArgs = null;
  const realSpawnSync = require('node:child_process').spawnSync;
  const stub = function (cmd, args, opts) {
    if (cmd === 'node' && Array.isArray(args) && args.some((a) => a.includes('amauta'))) {
      capturedArgs = args;
      return { status: 0, stdout: buildDaemonEnvelope(['TK-9999']), stderr: '', error: null };
    }
    return realSpawnSync(cmd, args, opts);
  };
  const mod = freshRequireVerify(stub);
  mod.queryDaemonTaskIds();
  assert.ok(capturedArgs !== null, 'spawnSync was called');
  const joined = capturedArgs.join(' ');
  assert.ok(joined.includes('gsd-amauta.cjs'), 'args include gsd-amauta.cjs');
  assert.ok(!joined.match(/(^|\s|\/)amauta\.cjs(\s|$)/), 'args do NOT include bare amauta.cjs (wrapper)');
});

test('Path A: sampling_health records pool_source=daemon_query and fallback_used=null when daemon succeeds', () => {
  const envelope = buildDaemonEnvelope(['TK-0100', 'TK-0101']);
  const stub = buildDaemonStub(envelope);
  const mod = freshRequireVerify(stub);
  mod.sampleCompletedTasks();
  // sampling_health is surfaced via buildReport — call it with a minimal fixture.
  const fakeDeterministic = {
    verification_files: { total: 0, present: 0, per_phase: {}, all_present: true },
    npm: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
    pytest: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
    gsd_tools_exports: true,
    gsd_amauta_exports: { all_present: true },
  };
  const fakeBehavioral = null;
  const fakeEnvCheck = { available: true, missing: [] };
  const report = mod.buildReport(fakeDeterministic, fakeBehavioral, fakeEnvCheck);
  assert.ok(report.sampling_health, 'sampling_health field present');
  assert.strictEqual(report.sampling_health.pool_source, 'daemon_query', 'pool_source=daemon_query');
  assert.strictEqual(report.sampling_health.fallback_used, null, 'fallback_used=null');
  assert.strictEqual(report.sampling_health.daemon_available, true, 'daemon_available=true');
  assert.ok(report.sampling_health.pool_size >= 2, 'pool_size reflects daemon pool');
});

// ─── Path B: daemon unavailable, fallback to SUMMARY.md ───────────────────

function buildFailingDaemonStub(failureMode) {
  const realSpawnSync = require('node:child_process').spawnSync;
  return function spawnSyncStub(cmd, args, opts) {
    const joined = Array.isArray(args) ? args.join(' ') : '';
    if (cmd === 'node' && joined.includes('gsd-amauta.cjs') && joined.includes('exec list')) {
      if (failureMode === 'spawn_error') {
        const err = new Error('spawn ENOENT');
        err.code = 'ENOENT';
        return { pid: -1, status: null, signal: null, stdout: '', stderr: '', error: err };
      }
      if (failureMode === 'nonzero_exit') {
        return { pid: 1234, status: 2, signal: null, stdout: '', stderr: 'boom', error: null };
      }
      if (failureMode === 'empty_output') {
        return { pid: 1234, status: 0, signal: null, stdout: '', stderr: '', error: null };
      }
      if (failureMode === 'parse_error') {
        return { pid: 1234, status: 0, signal: null, stdout: 'not valid json at all', stderr: '', error: null };
      }
      if (failureMode === 'empty_pool') {
        return { pid: 1234, status: 0, signal: null, stdout: JSON.stringify({ output: 'no tasks here' }), stderr: '', error: null };
      }
    }
    return realSpawnSync(cmd, args, opts);
  };
}

test('Path B: sampleCompletedTasks falls back to SUMMARY scraping on spawn_error', () => {
  const stub = buildFailingDaemonStub('spawn_error');
  const mod = freshRequireVerify(stub);
  // The function should NOT throw — it should fall back silently.
  const ids = mod.sampleCompletedTasks();
  assert.ok(Array.isArray(ids), 'returns an array (possibly empty) from SUMMARY fallback');
});

test('Path B: queryDaemonTaskIds returns success=false with named reason on nonzero exit', () => {
  const stub = buildFailingDaemonStub('nonzero_exit');
  const mod = freshRequireVerify(stub);
  const result = mod.queryDaemonTaskIds();
  assert.strictEqual(result.success, false, 'success is false');
  assert.ok(result.reason && result.reason.startsWith('nonzero_exit'), 'reason starts with nonzero_exit: ' + result.reason);
});

test('Path B: queryDaemonTaskIds returns success=false with envelope_parse_error on malformed JSON', () => {
  const stub = buildFailingDaemonStub('parse_error');
  const mod = freshRequireVerify(stub);
  const result = mod.queryDaemonTaskIds();
  assert.strictEqual(result.success, false, 'success is false on parse error');
  assert.strictEqual(result.reason, 'envelope_parse_error', 'reason names envelope_parse_error');
});

test('Path B: sampling_health records pool_source=summary_md and fallback_used=summary_md_scraping on daemon failure', () => {
  const stub = buildFailingDaemonStub('spawn_error');
  const mod = freshRequireVerify(stub);
  const fakeDeterministic = {
    verification_files: { total: 0, present: 0, per_phase: {}, all_present: true },
    npm: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
    pytest: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
    gsd_tools_exports: true,
    gsd_amauta_exports: { all_present: true },
  };
  const report = mod.buildReport(fakeDeterministic, null, { available: true, missing: [] });
  assert.ok(report.sampling_health, 'sampling_health field present');
  assert.strictEqual(report.sampling_health.pool_source, 'summary_md', 'pool_source=summary_md');
  assert.strictEqual(report.sampling_health.fallback_used, 'summary_md_scraping', 'fallback_used=summary_md_scraping');
  assert.strictEqual(report.sampling_health.daemon_available, false, 'daemon_available=false on spawn_error');
  assert.ok(Array.isArray(report.sampling_health.limitations_observed), 'limitations_observed is array');
  const joined = report.sampling_health.limitations_observed.join(' | ');
  assert.ok(joined.includes('daemon_unavailable'), 'limitations_observed contains daemon_unavailable entry');
});

test('Path B: empty daemon pool triggers no_v2.7_tasks_registered limitation and fallback', () => {
  const stub = buildFailingDaemonStub('empty_pool');
  const mod = freshRequireVerify(stub);
  const fakeDeterministic = {
    verification_files: { total: 0, present: 0, per_phase: {}, all_present: true },
    npm: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
    pytest: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
    gsd_tools_exports: true,
    gsd_amauta_exports: { all_present: true },
  };
  const report = mod.buildReport(fakeDeterministic, null, { available: true, missing: [] });
  const joined = (report.sampling_health.limitations_observed || []).join(' | ');
  assert.ok(joined.includes('no_v2.7_tasks_registered'), 'limitations_observed contains no_v2.7_tasks_registered: ' + joined);
  assert.strictEqual(report.sampling_health.pool_source, 'summary_md', 'empty pool falls back to summary_md');
  assert.strictEqual(report.sampling_health.daemon_available, true, 'daemon was technically reachable, daemon_available=true');
});

// ─── Schema + Markdown coverage ────────────────────────────────────────────

test('Schema: buildReport emits schema_version === 4 (Phase 19 final)', () => {
  const envelope = buildDaemonEnvelope(['TK-0001']);
  const stub = buildDaemonStub(envelope);
  const mod = freshRequireVerify(stub);
  const fakeDeterministic = {
    verification_files: { total: 0, present: 0, per_phase: {}, all_present: true },
    npm: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
    pytest: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
    gsd_tools_exports: true,
    gsd_amauta_exports: { all_present: true },
  };
  const report = mod.buildReport(fakeDeterministic, null, { available: true, missing: [] });
  assert.strictEqual(report.schema_version, 4, 'schema_version must be 4 (Phase 19 final)');
});

test('Schema: sampling_health has all five documented subkeys', () => {
  const envelope = buildDaemonEnvelope(['TK-0001']);
  const stub = buildDaemonStub(envelope);
  const mod = freshRequireVerify(stub);
  const report = mod.buildReport(
    {
      verification_files: { total: 0, present: 0, per_phase: {}, all_present: true },
      npm: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
      pytest: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
      gsd_tools_exports: true,
      gsd_amauta_exports: { all_present: true },
    },
    null,
    { available: true, missing: [] }
  );
  const sh = report.sampling_health;
  assert.ok(sh, 'sampling_health present');
  assert.ok('daemon_available' in sh, 'has daemon_available');
  assert.ok('pool_source' in sh, 'has pool_source');
  assert.ok('fallback_used' in sh, 'has fallback_used');
  assert.ok('pool_size' in sh, 'has pool_size');
  assert.ok('limitations_observed' in sh, 'has limitations_observed');
});

test('Markdown: generateMarkdown renders Sampling Health section between Behavioral and Pre-Existing', () => {
  const envelope = buildDaemonEnvelope(['TK-0001']);
  const stub = buildDaemonStub(envelope);
  const mod = freshRequireVerify(stub);
  const report = mod.buildReport(
    {
      verification_files: { total: 0, present: 0, per_phase: {}, all_present: true },
      npm: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
      pytest: { pre_existing_observed: [], new_failures: [], exit_code: 0 },
      gsd_tools_exports: true,
      gsd_amauta_exports: { all_present: true },
    },
    null,
    { available: true, missing: [] }
  );
  const md = mod.generateMarkdown(report);
  const idxBehavioral = md.indexOf('## Behavioral Test Results');
  const idxSampling = md.indexOf('## Sampling Health');
  const idxPreExisting = md.indexOf('## Pre-Existing vs New Failures');
  assert.ok(idxBehavioral >= 0, 'Behavioral section present');
  assert.ok(idxSampling >= 0, 'Sampling Health section present');
  assert.ok(idxPreExisting >= 0, 'Pre-Existing section present');
  assert.ok(idxBehavioral < idxSampling, 'Sampling Health appears AFTER Behavioral');
  assert.ok(idxSampling < idxPreExisting, 'Sampling Health appears BEFORE Pre-Existing');
});

// ─── GA3 contract stability ────────────────────────────────────────────────

test('GA3 contract: sampleCompletedTasks returns flat array of strings (no change to assessDogfood01 interface)', () => {
  const envelope = buildDaemonEnvelope(['TK-0001', 'TK-0002']);
  const stub = buildDaemonStub(envelope);
  const mod = freshRequireVerify(stub);
  const ids = mod.sampleCompletedTasks();
  assert.ok(Array.isArray(ids), 'is array');
  for (const item of ids) {
    assert.strictEqual(typeof item, 'string', 'each item is a string');
    assert.ok(/^TK-\d+$/.test(item), 'each item matches TK-\\d+: ' + item);
  }
});

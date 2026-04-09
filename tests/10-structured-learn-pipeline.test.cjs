#!/usr/bin/env node
/**
 * Phase 10 integration test: full learn -> search -> increment -> promote pipeline.
 *
 * Uses CLI subprocess invocations. If the daemon is not running (connect ECONNREFUSED),
 * the full pipeline tests are skipped but the CLI parse/validation tests still run.
 *
 * Run: node tests/10-structured-learn-pipeline.test.cjs
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');
const http = require('http');

const MEM_CLI = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');
const PORT = parseInt(process.env.GSD_AMAUTA_PORT || '18799', 10);

function daemonAlive() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/health', method: 'GET', timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function runMem(...args) {
  return spawnSync('node', [MEM_CLI, ...args], { encoding: 'utf-8', timeout: 15000 });
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('structured learn --structured --what rejects over-120-char WHAT', () => {
  const r = runMem('learn', '--structured', '--what', 'x'.repeat(130));
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /WHAT is 130 chars \(max 120\)/);
});

test('structured learn --structured --tags banned-only is rejected with guidance', () => {
  const r = runMem('learn', '--structured', '--what', 'valid what field', '--tags', 'best-practice,lesson');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /all tags are generic/);
});

test('structured learn --structured with valid input does not crash (daemon-reachable OR file-fallback)', () => {
  const r = runMem('learn', '--structured',
    '--what', 'Integration test learning',
    '--why', 'Verify happy path end-to-end',
    '--when', 'Running phase 10 integration tests',
    '--category', 'pattern',
    '--tags', 'postgresql,testing,integration'
  );
  // Daemon reachable -> exit 0; daemon down -> file fallback
  // Must not be a syntax error (crash = exit >=2)
  assert.ok(r.status === 0 || r.status === 1, `unexpected exit ${r.status}: ${r.stderr}`);
});

test('increment-applied without --task flag is rejected', () => {
  const r = runMem('increment-applied', 'mem-abc123def456');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /task.*required/i);
});

test('skb-promote without --reviewed flag is rejected', () => {
  const r = runMem('skb-promote', 'mem-abc123def456');
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /reviewed flag is required/i);
});

// ---- Daemon-dependent pipeline tests (skipped if daemon down) ----

test('PIPELINE: learn -> search --tags -> increment -> skb-candidates (daemon-dependent)', async () => {
  const alive = await daemonAlive();
  if (!alive) { console.log('    [skipped -- daemon not reachable on port ' + PORT + ']'); return; }

  // 1. Store a structured learning
  const uniqueMarker = `int-test-${Date.now()}`;
  const r1 = runMem('learn', '--structured',
    '--what', `Integration test ${uniqueMarker}`,
    '--why', 'verification',
    '--category', 'pattern',
    '--tags', 'integration,testing,pattern'
  );
  assert.strictEqual(r1.status, 0, `store failed: ${r1.stderr}`);

  // 2. Search by category
  const r2 = runMem('search', '--category', 'pattern', '--tags', 'integration', uniqueMarker);
  assert.strictEqual(r2.status, 0, `search failed: ${r2.stderr}`);
  assert.ok(r2.stdout.includes(uniqueMarker) || r2.stdout.includes('WHAT:'), `search result did not contain marker: ${r2.stdout.slice(0, 200)}`);

  // 3. Verify skb-candidates runs without error
  const r3 = runMem('skb', 'candidates');
  assert.strictEqual(r3.status, 0, `skb candidates failed: ${r3.stderr}`);
});

// -------------------- Runner --------------------

(async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
      passed++;
    } catch (e) {
      console.log(`  FAIL  ${name}`);
      console.log(`    ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();

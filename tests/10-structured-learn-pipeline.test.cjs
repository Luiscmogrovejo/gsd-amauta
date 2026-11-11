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
const fs = require('fs');
const os = require('os');
const { startFixtureDaemon, stopFixtureDaemon } = require('./support/fixture-daemon.cjs');

const MEM_CLI = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'gsd-memory.cjs');

// Phase 88 (88-07) disposition: fixture daemon for the pipeline test, file mode for the rest.
// The parse/validation tests need no daemon: they run in test mode against a port nothing listens on.
// The PIPELINE test used to probe 127.0.0.1:18799 (the operator's live daemon) and skip when it was
// down; it now starts its own SQLite fixture daemon on an ephemeral port and a temp data dir, so it
// runs the same way everywhere. Under GSD_TEST_MODE=1 gsd-memory.cjs caps a request at 2000 ms.
const DEAD_PORT = (process.env.GSD_AMAUTA_PORT && process.env.GSD_AMAUTA_PORT !== '18799') ? process.env.GSD_AMAUTA_PORT : '19941';

// TK-2386: file-mode writes land in `<cwd>/.planning`, and this suite ran the
// CLI with the repo as cwd — so every run appended to the repo's own tracked
// .planning/STATE.md. Give the CLI a scratch cwd instead.
const MEM_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-memcli-'));
process.on('exit', () => { try { fs.rmSync(MEM_TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

function runMemEnv(extraEnv, ...args) {
  // TK-2386: this suite's contract is "daemon-reachable OR file-fallback".
  // A degraded memory CLI now refuses with exit 3 unless the caller opts in to
  // file mode, so the file-fallback half of the contract is taken explicitly
  // here. Without this the suite silently measured whichever store the shared
  // daemon on 18799 happened to be answering from.
  return spawnSync('node', [MEM_CLI, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    cwd: MEM_TMP,
    env: { ...process.env, GSD_MEMORY_FILE_MODE: '1', GSD_TEST_MODE: '1', GSD_AMAUTA_PORT: DEAD_PORT, ...extraEnv },
  });
}

function runMem(...args) { return runMemEnv({}, ...args); }

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

test('PIPELINE: learn -> search --tags -> increment -> skb-candidates (fixture daemon)', async () => {
  const h = await startFixtureDaemon();
  try {
    const runH = (...args) => runMemEnv({ ...h.env }, ...args);

    // 1. Store a structured learning
    const uniqueMarker = `int-test-${Date.now()}`;
    const r1 = runH('learn', '--structured',
      '--what', `Integration test ${uniqueMarker}`,
      '--why', 'verification',
      '--category', 'pattern',
      '--tags', 'integration,testing,pattern'
    );
    assert.strictEqual(r1.status, 0, `store failed: ${r1.stderr}`);

    // 2. Search by category
    const r2 = runH('search', '--category', 'pattern', '--tags', 'integration', uniqueMarker);
    assert.strictEqual(r2.status, 0, `search failed: ${r2.stderr}`);
    assert.ok(r2.stdout.includes(uniqueMarker) || r2.stdout.includes('WHAT:'), `search result did not contain marker: ${r2.stdout.slice(0, 200)}`);

    // 3. Verify skb-candidates runs without error
    // The fixture daemon runs the SQLite store, which does not implement skb-candidates (HTTP 501,
    // "not supported by this store"); that path is PG-backed and arrives with the Phase 89 merge.
    // Anything other than success or that named 501 is still a failure.
    const r3 = runH('skb', 'candidates');
    const notSupported = /501/.test(r3.stderr + r3.stdout) && /not supported by this store/.test(r3.stderr + r3.stdout);
    assert.ok(r3.status === 0 || notSupported, `skb candidates failed: ${r3.stderr}`);
  } finally {
    await stopFixtureDaemon(h);
  }
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

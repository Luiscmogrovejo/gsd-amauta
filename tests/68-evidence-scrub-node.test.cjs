'use strict';

/**
 * tests/68-evidence-scrub-node.test.cjs — Phase 68 MOBL-04
 *
 * Node twin of tests/test_68_evidence_scrub.py. Both suites read the SAME
 * tests/fixtures/68-build-log-fixtures.json -- the cross-runtime PARITY
 * test below asserts scrubEvidence() produces the exact byte-identical
 * `expected` string the Python scrub_text() suite also asserts (same
 * marker names, same replacement text) -- the twin-drift guard.
 *
 * Run: node --test tests/68-evidence-scrub-node.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const cliPath = path.resolve(__dirname, '../get-shit-done/bin/gsd-amauta.cjs');
const { scrubEvidence, loadEvidenceScrubPatterns } = require(cliPath);

const fixturesPath = path.resolve(__dirname, 'fixtures', '68-build-log-fixtures.json');
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf-8')).fixtures;

function runCli(args, envOverrides = {}) {
  return spawnSync('node', [cliPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
}

// ─── PARITY: Node scrubEvidence() must match the SAME expected strings the
//     Python scrub_text() suite asserts, for every shared fixture ──────────

test('parity: scrubEvidence() matches shared fixture expected output byte-for-byte (Python/Node twin lock)', () => {
  for (const fixture of fixtures) {
    const out = scrubEvidence(fixture.input);
    assert.equal(
      out,
      fixture.expected,
      `parity mismatch for fixture "${fixture.name}": got ${JSON.stringify(out)}, expected ${JSON.stringify(fixture.expected)}`
    );
  }
});

test('each shared fixture individually round-trips through scrubEvidence()', () => {
  for (const fixture of fixtures) {
    const out = scrubEvidence(fixture.input);
    if (fixture.expected_hits.length === 0) {
      assert.equal(out, fixture.input, `fixture "${fixture.name}" should be byte-untouched`);
    } else {
      for (const hitName of fixture.expected_hits) {
        assert.ok(
          out.includes(`[scrubbed:${hitName}]`),
          `fixture "${fixture.name}" missing marker [scrubbed:${hitName}]`
        );
      }
    }
  }
});

test('fixture file has no raw secrets surviving in any expected column', () => {
  const rawSecretNeedles = [
    'hunter2', 'swordfish123', 's3cr3t', 'ABCDE12345',
    '12345678-1234-1234-1234-123456789012',
    'ghp_0123456789abcdef0123456789abcdef0123',
    'github_pat_11ABCDEFG0123456789',
    'xoxb-1234567890-abcdefghijklmno',
    'AKIAABCDEFGHIJKLMNOP',
    'supersecretpass',
  ];
  for (const fixture of fixtures) {
    for (const needle of rawSecretNeedles) {
      assert.ok(!fixture.expected.includes(needle), `fixture "${fixture.name}": raw secret ${needle} leaked into expected`);
    }
  }
});

// ─── Kill switch ───────────────────────────────────────────────────────────────

test('kill switch: GSD_EVIDENCE_SCRUB=off round-trips input unchanged', () => {
  const original = process.env.GSD_EVIDENCE_SCRUB;
  try {
    process.env.GSD_EVIDENCE_SCRUB = 'off';
    const text = 'iPhone Distribution: Acme Corp (ABCDE12345) storePassword=hunter2';
    assert.equal(scrubEvidence(text), text);
  } finally {
    if (original === undefined) delete process.env.GSD_EVIDENCE_SCRUB;
    else process.env.GSD_EVIDENCE_SCRUB = original;
  }
});

test('kill switch: default (unset/not "off") scrubs normally', () => {
  const original = process.env.GSD_EVIDENCE_SCRUB;
  try {
    delete process.env.GSD_EVIDENCE_SCRUB;
    assert.equal(scrubEvidence('storePassword=hunter2'), '[scrubbed:keystore-password]');
  } finally {
    if (original === undefined) delete process.env.GSD_EVIDENCE_SCRUB;
    else process.env.GSD_EVIDENCE_SCRUB = original;
  }
});

// ─── Fail-open ─────────────────────────────────────────────────────────────────

test('fail-open: nonexistent patterns path degrades to unchanged passthrough, never throws', () => {
  const original = process.env.GSD_EVIDENCE_SCRUB_PATTERNS_PATH;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-scrub-fail-open-'));
  const missingPath = path.join(tmpDir, 'does-not-exist.json');
  try {
    process.env.GSD_EVIDENCE_SCRUB_PATTERNS_PATH = missingPath;
    loadEvidenceScrubPatterns(true); // force reload against the missing path
    const text = 'storePassword=hunter2';
    assert.doesNotThrow(() => scrubEvidence(text));
    assert.equal(scrubEvidence(text), text);
  } finally {
    if (original === undefined) delete process.env.GSD_EVIDENCE_SCRUB_PATTERNS_PATH;
    else process.env.GSD_EVIDENCE_SCRUB_PATTERNS_PATH = original;
    loadEvidenceScrubPatterns(true); // restore the real registry for later tests
  }
});

test('fail-open: corrupt patterns file degrades to unchanged passthrough, never throws', () => {
  const original = process.env.GSD_EVIDENCE_SCRUB_PATTERNS_PATH;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-scrub-fail-open-'));
  const corruptPath = path.join(tmpDir, 'corrupt.json');
  fs.writeFileSync(corruptPath, '{not valid json');
  try {
    process.env.GSD_EVIDENCE_SCRUB_PATTERNS_PATH = corruptPath;
    loadEvidenceScrubPatterns(true);
    const text = 'storePassword=hunter2';
    assert.doesNotThrow(() => scrubEvidence(text));
    assert.equal(scrubEvidence(text), text);
  } finally {
    if (original === undefined) delete process.env.GSD_EVIDENCE_SCRUB_PATTERNS_PATH;
    else process.env.GSD_EVIDENCE_SCRUB_PATTERNS_PATH = original;
    loadEvidenceScrubPatterns(true);
  }
});

// ─── CLI-level choke-point proof: cmdNote/cmdRpetd scrub BEFORE the
//     file-fallback runDirect() call reaches python3 ────────────────────────
//
// Forces the direct-CLI (no-daemon) path by pointing GSD_AMAUTA_PORT at an
// unused port + GSD_AMAUTA_NO_AUTO_START=1 (ensureDaemon() then returns
// false without attempting to spawn a real daemon), and intercepts the
// runDirect() python3 invocation with a fake `python3` shell script placed
// first on PATH that just echoes its argv -- proving the CLI passes the
// SCRUBBED content string to the subprocess, not the raw secret.

function makeFakePython3Dir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-python3-'));
  const scriptPath = path.join(dir, 'python3');
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho "FAKE_PYTHON3_ARGV:$@"\n');
  fs.chmodSync(scriptPath, 0o755);
  return dir;
}

function directFallbackEnv(fakePythonDir) {
  return {
    PATH: `${fakePythonDir}:${process.env.PATH}`,
    GSD_AMAUTA_PORT: '18999', // unused port -- forces isDaemonRunning() to fail fast
    GSD_AMAUTA_NO_AUTO_START: '1',
  };
}

test('cmdNote CLI (file-fallback path) scrubs --content before reaching python3', () => {
  const fakeDir = makeFakePython3Dir();
  try {
    const result = runCli(
      ['note', 'FAKE-68-02-04', '--content', 'storePassword=hunter2'],
      directFallbackEnv(fakeDir)
    );
    assert.match(result.stdout, /FAKE_PYTHON3_ARGV/, result.stderr);
    assert.ok(!result.stdout.includes('hunter2'), `raw secret leaked into subprocess argv: ${result.stdout}`);
    assert.ok(result.stdout.includes('[scrubbed:keystore-password]'), result.stdout);
  } finally {
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test('cmdRpetd CLI (file-fallback path) scrubs --content before reaching python3', () => {
  const fakeDir = makeFakePython3Dir();
  try {
    const result = runCli(
      ['rpetd', 'FAKE-68-02-04', '--phase', 'T', '--content', 'AKIAABCDEFGHIJKLMNOP'],
      directFallbackEnv(fakeDir)
    );
    assert.match(result.stdout, /FAKE_PYTHON3_ARGV/, result.stderr);
    assert.ok(!result.stdout.includes('AKIAABCDEFGHIJKLMNOP'), `raw secret leaked into subprocess argv: ${result.stdout}`);
    assert.ok(result.stdout.includes('[scrubbed:aws-access-key]'), result.stdout);
  } finally {
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test('cmdNote CLI honors GSD_EVIDENCE_SCRUB=off (kill switch mirrored in the CLI path)', () => {
  const fakeDir = makeFakePython3Dir();
  try {
    const result = runCli(
      ['note', 'FAKE-68-02-04', '--content', 'storePassword=hunter2'],
      { ...directFallbackEnv(fakeDir), GSD_EVIDENCE_SCRUB: 'off' }
    );
    assert.match(result.stdout, /FAKE_PYTHON3_ARGV/, result.stderr);
    assert.ok(result.stdout.includes('storePassword=hunter2'), 'kill switch should have left content unscrubbed');
  } finally {
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

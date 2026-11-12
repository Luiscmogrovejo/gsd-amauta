'use strict';
/**
 * 88-16-07: the scanner PARSING and POLICY behaviour, on every cell.
 *
 * The eleven scanner skips this plan closes are closed by installing the real
 * gitleaks, trivy and semgrep in CI. That leaves a question the real tools
 * cannot answer cheaply: does the pipeline read their output correctly, and
 * does it apply the right policy to a finding? These cases answer it with a
 * hermetic fake on ALL nine cells — a fake that runs only where the real tool
 * is missing would be a second, untested code path everywhere else.
 *
 * **The fake is proven able to FAIL the test.** A stand-in that always reports
 * clean makes every assertion vacuous, which is the same defect as a skip, so
 * each case below runs the pipeline twice: once with a fake that finds
 * something and once with a fake that does not, and asserts the two differ.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { writeFakeScanner, fakeScannerPath, FAKE_VERSIONS } = require('./support/fake-scanner.cjs');

/** A fresh directory holding one fake tool, plus the PATH that finds it. */
function stageFake(tool, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-scanner-'));
  writeFakeScanner(dir, tool, opts);
  return { dir, env: { ...process.env, PATH: fakeScannerPath(dir) } };
}

/** Run the semgrep enforcement runner as a CHILD, so PATH applies to it. */
function runEnforcementWith(env, targetDir) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'skill-semgrep-runner.cjs'), targetDir, '--json'],
    { encoding: 'utf8', cwd: ROOT, env, timeout: 60000 }
  );
}


// The three cases below drive `scripts/skill-semgrep-runner.cjs`. They used to
// SKIP on Windows: the runner called `spawnSync('semgrep', …)` with
// `shell: false`, the fake is a `.cmd` shim (tests/support/fake-exe.cjs, plan
// 88-14), and current Node refuses to spawn a `.cmd` without a shell (the
// CVE-2024-27980 hardening). Plan 88-11 closed it at the product, not at the
// test: the runner now spawns through `platform.spawnTool`, which resolves the
// tool with PATHEXT and runs a `.cmd` through `cmd.exe /d /s /c` with an
// allowlisted command line — the form plan 88-17 proved for the host runtime
// CLI on the Windows cells. `shell: true` was NOT the fix; it reopens exactly
// what the CVE closed. All six cases in this file now run on all nine cells.

// ── semgrep: parsing and the ERROR-severity policy ──────────────────────────

test('88-16-07: the semgrep runner reports a finding the fake emits', () => {
  const { dir, env } = stageFake('semgrep', { findings: 1, severity: 'ERROR' });
  try {
    const r = runEnforcementWith(env, path.join(ROOT, 'get-shit-done', 'skills'));
    assert.notStrictEqual(r.status, 2, 'exit 2 means the runner did not find the fake on PATH');
    assert.strictEqual(r.status, 1, `a finding must make the runner exit 1: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.findings.length, 1, r.stdout);
    assert.match(out.findings[0].check_id, /gsd-fake-rule-0/);
    assert.match(r.stderr, /FAIL: 1 violation/, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('88-16-07: the same runner reports clean when the fake finds nothing', () => {
  const { dir, env } = stageFake('semgrep', { findings: 0 });
  try {
    const r = runEnforcementWith(env, path.join(ROOT, 'get-shit-done', 'skills'));
    assert.strictEqual(r.status, 0, `a clean scan must exit 0: ${r.stdout} ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /FAIL:/, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('88-16-07: only ERROR-severity semgrep findings count', () => {
  // The policy under test: `runEnforcement` filters to extra.severity ERROR.
  // A WARNING must be parsed and then NOT counted — which is exactly the kind
  // of thing a real scanner run would never exercise deterministically.
  const { dir, env } = stageFake('semgrep', { findings: 2, severity: 'WARNING' });
  try {
    const r = runEnforcementWith(env, path.join(ROOT, 'get-shit-done', 'skills'));
    assert.strictEqual(r.status, 0, `WARNING findings must not fail the gate: ${r.stdout} ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /FAIL:/, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the fakes answer a --version probe like the real tools ──────────────────

test('88-16-07: each fake answers a version probe, so an availability check sees it', () => {
  for (const tool of ['semgrep', 'gitleaks', 'trivy']) {
    const { dir, env } = stageFake(tool, { findings: 0 });
    try {
      const args = tool === 'gitleaks' ? ['version'] : ['--version'];
      const r = spawnSync(tool, args, { encoding: 'utf8', env, shell: process.platform === 'win32' });
      assert.strictEqual(r.status, 0, `${tool} --version: status ${r.status} ${r.stderr}`);
      assert.ok(
        String(r.stdout).includes(FAKE_VERSIONS[tool]),
        `${tool} must report its version: ${r.stdout}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── gitleaks: the report is a JSON ARRAY written to --report-path ───────────

test('88-16-07: the gitleaks fake writes a findings array, and an empty one when clean', () => {
  for (const [findings, expected] of [[2, 2], [0, 0]]) {
    const { dir, env } = stageFake('gitleaks', { findings });
    const report = path.join(dir, 'report.json');
    try {
      const r = spawnSync(
        'gitleaks',
        ['detect', '--source', ROOT, '--no-git', '--report-format', 'json', '--report-path', report],
        { encoding: 'utf8', env, shell: process.platform === 'win32' }
      );
      const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
      assert.ok(Array.isArray(parsed), 'gitleaks reports a bare JSON array');
      assert.strictEqual(parsed.length, expected);
      assert.strictEqual(r.status, findings > 0 ? 1 : 0, 'gitleaks exits 1 when it found a secret');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── trivy: Results[].Vulnerabilities, and --exit-code is honoured ───────────

test('88-16-07: the trivy fake reports vulnerabilities and honours --exit-code', () => {
  const { dir, env } = stageFake('trivy', { findings: 3 });
  try {
    const r = spawnSync('trivy', ['image', '--format', 'json', '--exit-code', '1', 'fake:latest'], {
      encoding: 'utf8',
      env,
      shell: process.platform === 'win32',
    });
    const report = JSON.parse(r.stdout);
    assert.strictEqual(report.Results[0].Vulnerabilities.length, 3, r.stdout);
    assert.strictEqual(r.status, 1, 'trivy must honour --exit-code when it found something');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const clean = stageFake('trivy', { findings: 0 });
  try {
    const r = spawnSync('trivy', ['image', '--format', 'json', '--exit-code', '1', 'fake:latest'], {
      encoding: 'utf8',
      env: clean.env,
      shell: process.platform === 'win32',
    });
    assert.deepStrictEqual(JSON.parse(r.stdout).Results, []);
    assert.strictEqual(r.status, 0, 'a clean trivy scan exits 0 even with --exit-code 1');
  } finally {
    fs.rmSync(clean.dir, { recursive: true, force: true });
  }
});

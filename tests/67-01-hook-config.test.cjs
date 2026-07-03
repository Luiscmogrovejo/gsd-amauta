'use strict';

// 67-01-02: gsd-tools hook-config emit|check — generated hook-allowlists.json
// artifact, single-sourced from GLOBAL_ALLOWLIST/ORCHESTRATOR_OWNED +
// the capability catalog identity.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const GSD_TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');
const REAL_ARTIFACT_PATH = path.join(REPO_ROOT, 'get-shit-done', 'config', 'hook-allowlists.json');

function runToolsCli(args, cwd) {
  try {
    const out = execFileSync(process.execPath, [GSD_TOOLS, ...args, '--cwd', cwd], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function makeTmpCwd() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-config-test-'));
  fs.mkdirSync(path.join(tmp, 'get-shit-done', 'config'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'get-shit-done', 'config', 'capability-catalog.json'),
    path.join(tmp, 'get-shit-done', 'config', 'capability-catalog.json')
  );
  return tmp;
}

test('67-01-02: hook-config emit generates artifact from single-source constants', () => {
  const tmp = makeTmpCwd();
  const result = runToolsCli(['hook-config', 'emit'], tmp);
  assert.equal(result.code, 0, `emit failed: ${result.stderr}`);

  const artifactPath = path.join(tmp, 'get-shit-done', 'config', 'hook-allowlists.json');
  assert.ok(fs.existsSync(artifactPath));
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));

  assert.equal(artifact.artifact_version, 1);
  assert.ok(artifact.orchestrator_owned.includes('.planning/STATE.md'), 'orchestrator_owned missing .planning/STATE.md');
  assert.ok(artifact.global_allowlist.includes('.planning/STATE.md'), 'global_allowlist missing .planning/STATE.md');
  assert.ok(artifact.capability_catalog.entry_names.includes('amauta-daemon-http'), 'entry_names missing amauta-daemon-http');
});

test('67-01-02: hook-config emit is idempotent (byte-identical on re-run)', () => {
  const tmp = makeTmpCwd();
  const first = runToolsCli(['hook-config', 'emit'], tmp);
  assert.equal(first.code, 0);
  const artifactPath = path.join(tmp, 'get-shit-done', 'config', 'hook-allowlists.json');
  const beforeBytes = fs.readFileSync(artifactPath, 'utf-8');

  const second = runToolsCli(['hook-config', 'emit'], tmp);
  assert.equal(second.code, 0);
  const afterBytes = fs.readFileSync(artifactPath, 'utf-8');

  assert.equal(beforeBytes, afterBytes, 're-emit churned the file (generated_at or otherwise) despite no source change');
});

test('67-01-02: hook-config check exits 1 on hand-edit drift, 0 after restore', () => {
  const tmp = makeTmpCwd();
  runToolsCli(['hook-config', 'emit'], tmp);
  const artifactPath = path.join(tmp, 'get-shit-done', 'config', 'hook-allowlists.json');
  const original = fs.readFileSync(artifactPath, 'utf-8');

  const okCheck = runToolsCli(['hook-config', 'check'], tmp);
  assert.equal(okCheck.code, 0);

  const artifact = JSON.parse(original);
  artifact.global_allowlist.push('hand-edited-entry.txt');
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');

  const driftCheck = runToolsCli(['hook-config', 'check'], tmp);
  assert.equal(driftCheck.code, 1, 'check should exit 1 on drift');
  assert.match(driftCheck.stderr, /global_allowlist/);

  fs.writeFileSync(artifactPath, original);
  const restoredCheck = runToolsCli(['hook-config', 'check'], tmp);
  assert.equal(restoredCheck.code, 0);
});

test('67-01-02: the real committed repo artifact passes hook-config check (drift lock)', () => {
  assert.ok(fs.existsSync(REAL_ARTIFACT_PATH), 'get-shit-done/config/hook-allowlists.json must be committed');
  const result = runToolsCli(['hook-config', 'check'], REPO_ROOT);
  assert.equal(result.code, 0, `real artifact has drift vs source constants: ${result.stderr}`);
});

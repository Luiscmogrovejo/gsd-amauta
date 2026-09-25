'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

function runManifestCheck({ phase, wave, taskId, filesExpectedYaml, before, after }) {
  const tmp = path.join(os.tmpdir(), `fidel04-${Date.now()}.yaml`);
  fs.writeFileSync(tmp, filesExpectedYaml, 'utf-8');
  try {
    return spawnSync('node', [
      TOOLS,
      'manifest-check',
      '--phase', phase,
      '--wave', wave,
      '--task-id', taskId,
      '--files-expected', tmp,
      '--before', before,
      '--after', after,
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 15000,
      env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1' },
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

test('FIDEL-04: manifest-check exits 2 on halt', () => {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  const result = runManifestCheck({
    phase: '59',
    wave: '1',
    taskId: '59-test-halt',
    filesExpectedYaml: 'modify: []\ncreate:\n  - nonexistent-file-that-will-never-exist.txt\ndelete: []',
    before: headSha,
    after: headSha,
  });

  assert.equal(result.status, 2, result.stderr);
  const cliOut = JSON.parse(result.stdout);
  assert.equal(cliOut.action, 'halt');
  assert.ok(cliOut.reportPath && fs.existsSync(cliOut.reportPath));
  const report = JSON.parse(fs.readFileSync(cliOut.reportPath, 'utf-8'));
  assert.equal(report.atomization_reconciliation_required, true);
});

test('FIDEL-04: manifest-check exits 0 on pass', () => {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  const result = runManifestCheck({
    phase: '59',
    wave: '1',
    taskId: '59-test-pass',
    filesExpectedYaml: 'modify: []\ncreate: []\ndelete: []',
    before: headSha,
    after: headSha,
  });

  assert.equal(result.status, 0, result.stderr);
  const cliOut = JSON.parse(result.stdout);
  assert.equal(cliOut.action, 'pass');
});

test('FIDEL-04: halt report carries atomization_reconciliation_required', () => {
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  const result = runManifestCheck({
    phase: '59',
    wave: '1',
    taskId: '59-test-arec',
    filesExpectedYaml: `modify: []\ncreate:\n  - will-not-exist-${Date.now()}.txt\ndelete: []`,
    before: headSha,
    after: headSha,
  });

  const cliOut = JSON.parse(result.stdout);
  assert.ok(cliOut.reportPath && fs.existsSync(cliOut.reportPath));
  const report = JSON.parse(fs.readFileSync(cliOut.reportPath, 'utf-8'));
  assert.strictEqual(report.atomization_reconciliation_required, true);
});

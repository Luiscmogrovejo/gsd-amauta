'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

test('FIDEL-03: staleness exits 0 and returns a JSON array', () => {
  const result = spawnSync('node', [TOOLS, 'staleness', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
});

test('FIDEL-03: staleness --phase 59 scopes to phase 59', () => {
  const result = spawnSync('node', [TOOLS, 'staleness', '--phase', '59', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  for (const entry of parsed) {
    assert.ok(entry.planFile.includes('59-phase-file-fidelity'));
  }
});

test('FIDEL-03: stale entry has planFile, taskId, citedPath, reason fields', () => {
  const phaseDir = path.join(REPO_ROOT, '.planning', 'phases', `99-fidel03-temp-${Date.now()}`);
  fs.mkdirSync(phaseDir, { recursive: true });
  const planPath = path.join(phaseDir, '99-test-PLAN.md');
  const T = 'task';
  const S = 'story';
  const A = 'agent';
  const FE = 'files_expected';
  const AC = 'acceptance_criteria';
  fs.writeFileSync(planPath, [
    '---', 'plan_id: 99-test', '---',
    `<${S}><title>T</title><success_criteria>G W T</success_criteria><doc_refs></doc_refs></${S}>`,
    `<${T} id="99-test-01">`,
    '  <title>Stale Citation Task</title>',
    `  <${A}>executor-backend</${A}>`,
    '  <depends_on>[]</depends_on>',
    '  <read_first>',
    '    - this/path/does-not-exist-ever-12345.py',
    '  </read_first>',
    '  <action>Do something.</action>',
    `  <${AC}>- echo ok</${AC}>`,
    `  <${FE}>`,
    '    modify: []',
    '    create: []',
    '    delete: []',
    `  </${FE}>`,
    `</${T}>`,
  ].join('\n'), 'utf-8');

  try {
    const result = spawnSync('node', [TOOLS, 'staleness', '--phase', '99', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].taskId, '99-test-01');
    assert.equal(parsed[0].citedPath, 'this/path/does-not-exist-ever-12345.py');
    assert.equal(parsed[0].reason, 'not_in_working_tree');
    assert.ok(parsed[0].planFile.includes('99-fidel03-temp-'));
  } finally {
    fs.rmSync(phaseDir, { recursive: true, force: true });
  }
});

test('FIDEL-03: milestone.cjs includes reindex hook fallback', () => {
  const milestonePath = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'lib', 'milestone.cjs');
  const content = fs.readFileSync(milestonePath, 'utf-8');
  assert.ok(content.includes('FIDEL-03'));
  assert.ok(content.includes('RLM unreachable'));
  assert.ok(content.includes('/reindex'));
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(REPO_ROOT, 'get-shit-done', 'bin', 'gsd-tools.cjs');

test('FIDEL-05: init plan-phase returns scope_width_warning field', () => {
  const result = spawnSync('node', [TOOLS, 'init', 'plan-phase', '59', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'scope_width_warning'));
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'scope_width_ceiling'));
});

test('FIDEL-05: scope_width_ceiling defaults to 4', () => {
  const result = spawnSync('node', [TOOLS, 'init', 'plan-phase', '59', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 10000,
    env: { ...process.env, GSD_AMAUTA_NO_AUTO_START: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.scope_width_ceiling, 4);
});

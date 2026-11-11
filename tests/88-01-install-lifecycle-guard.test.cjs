/**
 * Phase 88 plan 88-01: a test-mode `npm ci` lifecycle run cannot install into the
 * real ~/.claude.
 *
 * bin/install.js is spawned with GSD_TEST_MODE=1 and no CLAUDE_CONFIG_DIR. Nothing is
 * written into ~/.claude by this test: the entry count of ~/.claude is compared before
 * and after the run instead.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LIVE_CONFIG = path.join(os.homedir(), '.claude');

/**
 * @returns {number|null} entry count of ~/.claude, or null when it does not exist
 */
function liveEntryCount() {
  return fs.existsSync(LIVE_CONFIG) ? fs.readdirSync(LIVE_CONFIG).length : null;
}

describe('install.js lifecycle guard', () => {
  test('GSD_TEST_MODE=1 with the live config target refuses, exits 0, writes nothing', () => {
    const env = { ...process.env, GSD_TEST_MODE: '1' };
    delete env.CLAUDE_CONFIG_DIR;
    const before = liveEntryCount();
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install.js')], {
      env,
      encoding: 'utf-8',
      timeout: 30000,
    });
    assert.strictEqual(r.status, 0, r.stderr.slice(0, 400));
    assert.ok(r.stderr.includes('refusing to install into the live config directory'), r.stderr.slice(0, 400));
    assert.strictEqual(liveEntryCount(), before, '~/.claude entry count changed');
  });

  test('requiring the module under GSD_TEST_MODE=1 does not exit the process', () => {
    const env = { ...process.env, GSD_TEST_MODE: '1' };
    delete env.CLAUDE_CONFIG_DIR;
    const r = spawnSync(
      process.execPath,
      ['-e', "const m=require(process.argv[1]); console.log(typeof m.install)", path.join(ROOT, 'bin', 'install.js')],
      { env, encoding: 'utf-8', timeout: 30000 }
    );
    assert.strictEqual(r.status, 0, r.stderr.slice(0, 400));
    // install.js prints its banner at load; the typeof line is the last one.
    assert.strictEqual(r.stdout.trim().split('\n').pop(), 'function');
  });
});

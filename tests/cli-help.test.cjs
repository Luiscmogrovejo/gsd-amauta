'use strict';
/**
 * bin/cli.cjs help: `gsd-amauta`, `help`, `--help` and `-h` print usage and exit 0.
 *
 * Run: node --test tests/cli-help.test.cjs
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('child_process');

const CLI_ENTRY = path.resolve(__dirname, '..', 'bin', 'cli.cjs');

function runCli(args) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], { encoding: 'utf8', timeout: 15000 });
}

for (const args of [[], ['help'], ['--help'], ['-h']]) {
  test(`cli ${args.join(' ') || '(no args)'} prints usage and exits 0`, () => {
    const r = runCli(args);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: gsd-amauta <command>/);
    assert.match(r.stdout, /doctor/);
  });
}

test('cli doctor is not swallowed by the help branch', () => {
  const src = require('node:fs').readFileSync(CLI_ENTRY, 'utf8');
  assert.ok(src.indexOf("command === 'doctor'") > src.indexOf("command === '--help'"));
});

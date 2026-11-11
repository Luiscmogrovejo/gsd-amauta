'use strict';

/**
 * The `amauta` bin is a symlink to get-shit-done/bin/amauta.cjs (npm link,
 * package bin shims). Invoked through a symlink whose name has no .cjs
 * suffix, the CLI used to exit 0 without running anything.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WRAPPER = path.resolve(__dirname, '..', 'get-shit-done', 'bin', 'amauta.cjs');
let dir;

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amauta-link-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function help(entry) {
  return spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 20000 });
}

test('amauta.cjs --help prints usage when run directly', () => {
  const r = help(WRAPPER);
  assert.ok(r.stdout.trim().length > 0, 'direct invocation must print usage');
});

test('a symlink named `amauta` runs the CLI instead of exiting silently', () => {
  const link = path.join(dir, 'amauta');
  fs.symlinkSync(WRAPPER, link);
  const direct = help(WRAPPER);
  const linked = help(link);
  assert.ok(linked.stdout.trim().length > 0, 'symlinked invocation must not be a silent no-op');
  assert.equal(linked.stdout, direct.stdout, 'symlinked invocation must behave like the direct one');
  assert.equal(linked.status, direct.status);
});

test('a symlink with an arbitrary name also runs the CLI', () => {
  const link = path.join(dir, 'am');
  fs.symlinkSync(WRAPPER, link);
  assert.ok(help(link).stdout.trim().length > 0);
});

test('every package bin script is committed executable', () => {
  // `amauta` is a symlink to a bin script: without the executable bit the
  // shell answers "permission denied" however correct the script is.
  const { execFileSync } = require('child_process');
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bins = Object.values(pkg.bin).concat(['get-shit-done/bin/gsd-shunt.cjs']);
  let listing;
  try {
    listing = execFileSync('git', ['-C', root, 'ls-files', '-s', '--', ...bins], { encoding: 'utf8' });
  } catch {
    return; // not a git checkout (installed package): nothing to assert
  }
  const notExec = listing.trim().split('\n').filter(Boolean)
    .filter(l => !l.startsWith('100755')).map(l => l.split('\t')[1]);
  assert.deepEqual(notExec, [], 'bin scripts must be mode 100755 in git');
});

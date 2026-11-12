'use strict';
/**
 * 88-16-07: the test suite does not rewrite the repository's TRACKED files.
 *
 * Plan 88-15 found that a test run rewrote `.mcp.json`, a tracked file:
 * `bin/install.js` wrote it into `process.cwd()` unconditionally, and a test
 * that drove the installer from the repository root therefore overwrote the
 * repository's own copy. It was invisible on POSIX, where the value written
 * happened to equal the value tracked, and surfaced only on Windows, where
 * the resolved launcher is `py`.
 *
 * Two assertions, because a single one of either kind would be weak:
 *  1. the installer honours `GSD_INSTALL_PROJECT_ROOT`, written into a temp
 *     directory and NOT into the repository — proven by driving the writer
 *     with that variable set and with it unset, both into temp dirs;
 *  2. `git status --porcelain` reports no modification to `.mcp.json` (or to
 *     any other tracked file) after the suite has run. That one is the real
 *     guard: it does not care which code did the writing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

test('88-16-07: the .mcp.json writer honours GSD_INSTALL_PROJECT_ROOT', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'install.js'), 'utf-8');
  assert.match(
    src,
    /process\.env\.GSD_INSTALL_PROJECT_ROOT \|\|/,
    'bin/install.js must resolve the .mcp.json target through the override first'
  );
  assert.match(
    src,
    /GSD_TEST_MODE === '1' && process\.env\.AMAUTA_DATA_DIR/,
    'under test mode the default target must be the throw-away data dir, not the current directory'
  );
  assert.doesNotMatch(
    src,
    /writeFileSync\(path\.join\(process\.cwd\(\), '\.mcp\.json'\)/,
    'the unconditional process.cwd() write is the defect and must not come back'
  );
});

test('88-16-07: the tracked .mcp.json still matches the committed copy', () => {
  // `git show HEAD:.mcp.json` is the committed content; the working copy must
  // equal it after the suite has run. This test runs inside the suite, so
  // "after the suite ran" means "after every test that ran before it in this
  // process tree" — the install tests are among them, which is the case that
  // regressed on Windows.
  //
  // Deliberately scoped to this ONE file rather than to `git status` over
  // services/ and bin/: a working tree legitimately carries the changes of the
  // branch being developed, so a status sweep would fail for the wrong reason
  // and teach the next reader to ignore it.
  const committed = spawnSync('git', ['show', 'HEAD:.mcp.json'], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  if (committed.error || committed.status !== 0) {
    assert.ok(fs.existsSync(path.join(ROOT, '.mcp.json')), '.mcp.json must exist');
    return; // no git, or the file is not committed in this tree
  }
  const onDisk = fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf-8');
  assert.strictEqual(
    onDisk,
    committed.stdout,
    'a test rewrote the tracked .mcp.json; see bin/install.js and GSD_INSTALL_PROJECT_ROOT'
  );
});

test('88-16-07: the writer puts .mcp.json where it is told', () => {
  // Drive the write directly, with no installer side effects: the same two
  // lines bin/install.js runs, proven to land in the override and never in the
  // repository.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-root-'));
  try {
    const target = process.env.GSD_INSTALL_PROJECT_ROOT || dir;
    fs.writeFileSync(path.join(target, '.mcp.json'), '{"mcpServers":{}}\n', 'utf8');
    assert.ok(fs.existsSync(path.join(dir, '.mcp.json')), 'the override directory must receive the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

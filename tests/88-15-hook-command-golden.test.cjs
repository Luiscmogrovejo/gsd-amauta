'use strict';

/**
 * tests/88-15-hook-command-golden.test.cjs — Phase 88, plan 88-15 task 01.
 *
 * GOLDEN POSIX PINS, written and green BEFORE any Windows branch was added.
 *
 * 88-CONTEXT.md (decisions on 88-13-14-RESEARCH.md): "every Windows branch is
 * additive ... and hook command strings for POSIX paths without spaces are
 * unchanged (golden-string test)". Research §11 names the risk directly: these
 * hooks run on EVERY tool call for every user, so a changed command string is a
 * change to every user's shell line.
 *
 * The expected values below are LITERAL strings captured from the unmodified
 * code at commit f114bf0 (origin/master, the base of plan 88-15). Task 88-15-04
 * may NOT edit any expectation in the "PLAIN POSIX" section: those are the
 * byte-identity guarantee. The space / quote / backslash cases are expected to
 * change and their new values are asserted in the "WINDOWS AND SPACES" section,
 * which task 88-15-04 adds.
 *
 * Nothing here spawns a shell, touches a port, or reads the operator's store.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const compressGate = require('../hooks/gsd-compress-gate.cjs');
const shuntGate = require('../hooks/gsd-shunt-gate.cjs');

const { buildWrappedCommand } = compressGate;
const { shellSplit } = shuntGate;

// A POSIX wrapper path with no space, no quote and no backslash: the shape every
// installed POSIX user has today.
const PLAIN_WRAPPER = '/Users/operator/Code/gsd-amauta/get-shit-done/bin/gsd-compress.cjs';

// ─────────────────────────────────────────────────────────────────────────────
// PLAIN POSIX — byte-identity. These literals must never change.
// ─────────────────────────────────────────────────────────────────────────────

test('GOLDEN: buildWrappedCommand on a plain POSIX wrapper path is byte-identical', () => {
  assert.equal(
    buildWrappedCommand('cat README.md', PLAIN_WRAPPER),
    'node /Users/operator/Code/gsd-amauta/get-shit-done/bin/gsd-compress.cjs -- cat README.md',
  );
});

test('GOLDEN: buildWrappedCommand --raw on a plain POSIX wrapper path is byte-identical', () => {
  assert.equal(
    buildWrappedCommand('cat README.md', PLAIN_WRAPPER, { raw: true }),
    'node /Users/operator/Code/gsd-amauta/get-shit-done/bin/gsd-compress.cjs --raw -- cat README.md',
  );
});

test('GOLDEN: buildWrappedCommand preserves the original command verbatim (quotes, flags)', () => {
  assert.equal(
    buildWrappedCommand('grep -rn "needle" src/', PLAIN_WRAPPER),
    'node /Users/operator/Code/gsd-amauta/get-shit-done/bin/gsd-compress.cjs -- grep -rn "needle" src/',
  );
  assert.equal(
    buildWrappedCommand("git log --format='%s'", PLAIN_WRAPPER, { raw: false }),
    "node /Users/operator/Code/gsd-amauta/get-shit-done/bin/gsd-compress.cjs -- git log --format='%s'",
  );
});

test('GOLDEN: a relative POSIX wrapper path with no special characters stays bare', () => {
  assert.equal(
    buildWrappedCommand('wc -l x', 'get-shit-done/bin/gsd-compress.cjs'),
    'node get-shit-done/bin/gsd-compress.cjs -- wc -l x',
  );
});

// isAlreadyWrapped (PostToolUse side) is a substring check over the emitted
// command; the pin records that the wrapper basename survives in the string, so
// adding quotes around the path cannot break it.
test('GOLDEN: the emitted command contains the wrapper basename as a substring', () => {
  const cmd = buildWrappedCommand('cat x', PLAIN_WRAPPER);
  assert.ok(cmd.includes('gsd-compress.cjs'), cmd);
  assert.ok(cmd.startsWith('node '), cmd);
  assert.ok(cmd.includes(' -- '), cmd);
});

// ─────────────────────────────────────────────────────────────────────────────
// shellSplit — the POSIX corpus. Task 88-15-04 gives shellSplit an injectable
// platform; on POSIX every one of these must still split exactly this way,
// INCLUDING the legitimate backslash escape (`cat foo\ bar.txt` is ONE argument
// on POSIX and must stay one).
// ─────────────────────────────────────────────────────────────────────────────

const POSIX_SHELLSPLIT_CORPUS = [
  ['cat foo.txt', ['cat', 'foo.txt']],
  ['cat foo\\ bar.txt', ['cat', 'foo bar.txt']],                 // backslash escape: ONE arg
  ['cat "foo bar.txt"', ['cat', 'foo bar.txt']],
  ["cat 'foo bar.txt'", ['cat', 'foo bar.txt']],
  ['head -n 5 /etc/hosts', ['head', '-n', '5', '/etc/hosts']],
  ['cat   spaced    args', ['cat', 'spaced', 'args']],
  ['cat ""', ['cat', '']],                                        // empty quoted arg is kept
  ['cat /Users/jane/a\\ b/c.txt', ['cat', '/Users/jane/a b/c.txt']],
  ['tail -f ./relative/path.log', ['tail', '-f', './relative/path.log']],
  ['cat a\\\\b', ['cat', 'a\\b']],                                // escaped backslash -> one backslash
];

test('GOLDEN: shellSplit on the POSIX corpus (backslash is an escape on POSIX)', () => {
  for (const [cmd, expected] of POSIX_SHELLSPLIT_CORPUS) {
    assert.deepEqual(shellSplit(cmd), expected, `shellSplit(${JSON.stringify(cmd)})`);
  }
});

test('GOLDEN: shellSplit returns null on an unterminated quote', () => {
  assert.equal(shellSplit('cat "unterminated'), null);
  assert.equal(shellSplit("cat 'unterminated"), null);
});

test('GOLDEN: bashTargets on the POSIX corpus', () => {
  const { bashTargets } = shuntGate;
  assert.deepEqual(bashTargets('cat foo.txt'), ['foo.txt']);
  assert.deepEqual(bashTargets('cat foo\\ bar.txt'), ['foo bar.txt']);
  assert.deepEqual(bashTargets('head -n 5 foo.txt'), []);        // flagged head -> not a bare dump
  assert.deepEqual(bashTargets('ls -la'), []);                   // not a dump command
});

// ─────────────────────────────────────────────────────────────────────────────
// The search filter's POSIX grouping. Task 88-15-04 teaches it the Windows
// drive-letter prefix; the POSIX grouping below must not move.
// ─────────────────────────────────────────────────────────────────────────────

test('GOLDEN: the search filter groups POSIX grep output by the real file', () => {
  const filter = require('../get-shit-done/bin/lib/compress-filters/search.cjs');
  const lines = [];
  for (let f = 0; f < 3; f++) {
    for (let k = 0; k < 8; k++) lines.push(`/srv/tree/gf${f}.txt:${k + 1}:needle match on line ${k}`);
  }
  const out = filter.transform(lines.join('\n') + '\n');
  assert.ok(out.includes('3 files'), `POSIX grep output must group by 3 real files:\n${out}`);
  assert.ok(!/single file\/stream/.test(out), out);
  assert.ok(out.includes('/srv/tree/gf0.txt (8)'), out);
});

test('GOLDEN: the search filter still detects the numeric-first-field single-stream case', () => {
  const filter = require('../get-shit-done/bin/lib/compress-filters/search.cjs');
  const lines = [];
  for (let k = 0; k < 40; k++) lines.push(`${k + 1}:needle match on line ${k}`);
  const out = filter.transform(lines.join('\n') + '\n');
  assert.ok(/single file\/stream/.test(out), `a bare lineno:content stream must collapse:\n${out}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// WINDOWS AND SPACES — added by task 88-15-04. These cases were BROKEN before
// (a backslash eaten by bash, a space splitting the command) and their new
// expected values are asserted here, not in the PLAIN POSIX section above,
// which must stay byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('88-15-04: a wrapper path with a space is quoted, forward-slashed and $-escaped', () => {
  assert.equal(
    buildWrappedCommand('cat x', '/Users/Jane Doe/repo/gsd-compress.cjs'),
    'node "/Users/Jane Doe/repo/gsd-compress.cjs" -- cat x',
  );
  assert.equal(
    buildWrappedCommand('cat x', '/Users/Jane Doe/repo/gsd-compress.cjs', { raw: true }),
    'node "/Users/Jane Doe/repo/gsd-compress.cjs" --raw -- cat x',
  );
  // a `$` or a backtick in a path is a shell substitution: escaped inside the quotes
  assert.equal(
    buildWrappedCommand('cat x', '/Users/a $HOME b/gsd-compress.cjs'),
    'node "/Users/a \\$HOME b/gsd-compress.cjs" -- cat x',
  );
  assert.equal(
    buildWrappedCommand('cat x', '/Users/a `id` b/gsd-compress.cjs'),
    'node "/Users/a \\`id\\` b/gsd-compress.cjs" -- cat x',
  );
  assert.equal(
    buildWrappedCommand('cat x', '/Users/a "q" b/gsd-compress.cjs'),
    'node "/Users/a \\"q\\" b/gsd-compress.cjs" -- cat x',
  );
});

test('88-15-04: a Windows wrapper path is forward-slashed, so bash cannot eat it', () => {
  assert.equal(
    buildWrappedCommand('git status', 'D:\\a\\gsd-amauta\\get-shit-done\\bin\\gsd-compress.cjs'),
    'node D:/a/gsd-amauta/get-shit-done/bin/gsd-compress.cjs -- git status',
  );
  assert.equal(
    buildWrappedCommand('git status', 'C:\\Program Files\\gsd\\gsd-compress.cjs'),
    'node "C:/Program Files/gsd/gsd-compress.cjs" -- git status',
  );
  // the wrapper sentinel survives, so isAlreadyWrapped (a substring check on
  // 'gsd-compress') still recognises the emitted command
  assert.ok(
    buildWrappedCommand('git status', 'C:\\Program Files\\gsd\\gsd-compress.cjs')
      .includes('gsd-compress'),
  );
});

test('88-15-04 PROOF (a): the command emitted for a path WITH A SPACE really runs the wrapper', () => {
  // Not a shape check: the emitted string is executed by a shell and the
  // wrapper is asserted to have run. A path with a space is a genuine macOS
  // defect today, so this is end-to-end verifiable here.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '88-15-04-'));
  try {
    const dir = path.join(base, 'a space dir');
    fs.mkdirSync(dir);
    const wrapper = path.join(dir, 'gsd-compress.cjs');
    fs.writeFileSync(wrapper, "process.stdout.write('WRAPPER-RAN-88-15 ' + process.argv.slice(2).join(' '));\n", 'utf8');
    const command = buildWrappedCommand('git status', wrapper);
    assert.match(command, /^node "/, command);
    const r = spawnSync('/bin/sh', ['-c', command.replace(/^node /, process.execPath + ' ')], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `the emitted command must run: ${r.stderr}`);
    assert.match(r.stdout, /^WRAPPER-RAN-88-15 -- git status$/, r.stdout);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('88-15-04: shellSplit keeps a backslash as a path character on Windows only', () => {
  assert.deepEqual(shellSplit('cat D:\\a\\big.js', 'win32'), ['cat', 'D:\\a\\big.js']);
  assert.deepEqual(shellSplit('cat D:\\a\\big.js', 'darwin'), ['cat', 'D:abig.js']);
  // the POSIX corpus is unchanged under an injected darwin/linux
  for (const [cmd, expected] of POSIX_SHELLSPLIT_CORPUS) {
    assert.deepEqual(shellSplit(cmd, 'darwin'), expected, cmd);
    assert.deepEqual(shellSplit(cmd, 'linux'), expected, cmd);
  }
  // quoting still wins on Windows
  assert.deepEqual(shellSplit('cat "C:\\Program Files\\x.js"', 'win32'), ['cat', 'C:\\Program Files\\x.js']);
});

test('88-15-04: the shunt gate extracts a Windows path intact and still denies', () => {
  const { bashTargets, decide } = shuntGate;
  assert.deepEqual(bashTargets('cat D:\\a\\big.js', 'win32'), ['D:\\a\\big.js']);
  assert.deepEqual(bashTargets('head -c 100 D:\\a\\big.js', 'win32'), []);

  // The deny half, proven against a real file this test creates: with the
  // backslash no longer eaten the path reaches bigFile(), which stats it.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '88-15-04-shunt-'));
  try {
    const big = path.join(base, 'big.js');
    fs.writeFileSync(big, 'x\n'.repeat(5000), 'utf8');
    const hit = decide({ tool_name: 'Bash', tool_input: { command: `cat ${big}` }, cwd: base }, 'win32');
    assert.ok(hit && hit.hit, 'a bare dump of a big file must be a hit under injected win32');
    assert.equal(hit.hit.path, big);
    // and the pre-88-15 behaviour: with the backslash eaten, the name never matched
    assert.deepEqual(bashTargets('cat D:\\a\\big.js', 'darwin'), ['D:abig.js']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('88-15-04: the search filter groups a Windows drive-letter path by the real file', () => {
  const filter = require('../get-shit-done/bin/lib/compress-filters/search.cjs');
  const lines = [];
  for (let f = 0; f < 3; f++) {
    for (let k = 0; k < 8; k++) lines.push(`C:\\x\\gf${f}.txt:${k + 1}:needle match on line ${k}`);
  }
  const out = filter.transform(lines.join('\n') + '\n');
  assert.ok(out.includes('3 files'), `drive-letter paths must group by 3 real files:\n${out}`);
  assert.ok(out.includes('C:\\x\\gf0.txt (8)'), out);
  assert.ok(!/single file\/stream/.test(out), out);
  assert.ok(!out.includes('C (24)'), 'the drive letter must not become the file name');
});

test('88-15-04 FAIL-OPEN: a hook still exits 0 when nothing outside hooks/ is present', () => {
  // The hooks are installed with only ./lib/hook-common.cjs beside them: no
  // bin/, no get-shit-done/. A require of a module outside hooks/ would throw
  // AT LOAD and break the fail-open guarantee, so this runs each gate from a
  // tree that contains hooks/ ALONE.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '88-15-04-isolated-'));
  try {
    fs.cpSync(path.join(__dirname, '..', 'hooks'), path.join(base, 'hooks'), { recursive: true });
    assert.ok(!fs.existsSync(path.join(base, 'get-shit-done')), 'the isolated tree has no get-shit-done/');
    assert.ok(!fs.existsSync(path.join(base, 'bin')), 'the isolated tree has no bin/');
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      cwd: base,
    });
    for (const hook of ['gsd-compress-gate.cjs', 'gsd-shunt-gate.cjs']) {
      const r = spawnSync(process.execPath, [path.join(base, 'hooks', hook)], {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: base, GSD_COMPRESS_MODE: 'on', GSD_SHUNT_MODE: 'block' },
      });
      assert.equal(r.status, 0, `${hook} must fail open with exit 0; stderr: ${r.stderr}`);
      assert.ok(!/Cannot find module/.test(r.stderr), `${hook} must not require anything outside hooks/: ${r.stderr}`);
      assert.ok(!/"permissionDecision"\s*:\s*"deny"/.test(r.stdout), `${hook} must not deny from a failure path: ${r.stdout}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

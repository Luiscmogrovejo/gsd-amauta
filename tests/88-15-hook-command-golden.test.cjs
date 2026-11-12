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

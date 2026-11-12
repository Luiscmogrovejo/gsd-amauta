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
 *
 * 88-11 (2026-11-12) extends this file with the case content comparison CANNOT
 * see. tests/81-01 and tests/82-01 called the agent compiler's
 * `compile('claude-code', { source })` with no `outDir`; the default is the
 * RELATIVE path `agents/`, resolved against `process.cwd()` — the repository
 * root — so each run truncated and rewrote all 35 tracked `agents/gsd-*.md`.
 * The bytes written were identical, so `git status` stayed clean and assertion
 * 2 above passed; what broke was a SIBLING test process reading
 * `agents/gsd-auditor-api-connections.md` during the truncation window and
 * getting an empty string (master 33f33b6, run 43248042858, five failures in
 * tests/82-01-domain-auditors-w2.test.cjs).
 *
 * Two further assertions, one static and one dynamic:
 *  3. no test lets the compiler's cwd-relative default outDir resolve into the
 *     source tree — the rule that ends the class at authoring time;
 *  4. the runner carries the tracked-tree canary (mtime included), so the
 *     cross-process alarm that catches ANY writer, including a subprocess,
 *     cannot be removed silently.
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
    /GSD_TEST_MODE === '1'\s*\n?\s*\? \(process\.env\.AMAUTA_DATA_DIR/,
    'under test mode the default target must be a throw-away directory, never the current one'
  );
  assert.match(
    src,
    /gsd-mcp-json-/,
    'test mode must have a last-resort temp directory, so a child with neither ' +
      'AMAUTA_DATA_DIR nor CLAUDE_CONFIG_DIR still cannot write into the repository'
  );
  assert.match(
    src,
    /path\.resolve\(mcpProjectRoot\) === pkgRoot/,
    'the installer must never write .mcp.json into its OWN package root, whatever ' +
      'the environment says: that is the rule that ends the class of defect rather ' +
      'than one instance of it'
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

/**
 * The argument text of the call that starts at `src[openIdx]` (the '(' of the
 * call), by balanced-paren scan. Quotes and template literals are skipped so a
 * ')' inside a string cannot end the scan early.
 *
 * @param {string} src file source
 * @param {number} openIdx index of the opening '('
 * @returns {string} the raw text between the parentheses
 * @example
 *   callArgs("f('a', { b: ')' })", 1) // "'a', { b: ')' }"
 */
function callArgs(src, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1);
}

/**
 * Blank out comments AND string/template bodies, keeping byte offsets (so
 * reported line numbers stay true). Prose about compile() — a test title, an
 * assertion message, a comment — is not a call to it; every test name in this
 * repository that reads `compile(claude-code) emits ...` would otherwise be
 * reported as a violation and the guard would be useless noise.
 *
 * @param {string} src file source
 * @returns {string} same length, non-code bytes replaced by spaces
 * @example
 *   stripNonCode("a // compile('x')\nb").includes('compile') // false
 *   stripNonCode("t('compile(y)', f)").includes('compile(y') // false
 */
function stripNonCode(src) {
  const out = src.split('');
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      if (c === '\\') { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === quote) { quote = null; i++; continue; }
      if (c !== '\n') out[i] = ' ';
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      out[i] = ' ';
      if (i + 1 < src.length) out[i + 1] = ' ';
      i += 2;
      continue;
    }
    i++;
  }
  return out.join('');
}

test('88-11: no test lets the agent compiler write into the repository source tree', () => {
  // The rule, not the instance: agent-compiler's compile() defaults outDir to
  // the RELATIVE 'agents/', so ANY call from a test without an explicit outDir
  // (or dryRun) writes into the tracked agents/ directory of whatever cwd the
  // runner used. Fails naming the file and the call.
  const violations = [];
  for (const file of fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.cjs')).sort()) {
    const raw = fs.readFileSync(path.join(ROOT, 'tests', file), 'utf8');
    // Any file that reaches the agent compiler, however it requires it: both
    // victims of the 2026-11-12 flake do it through a path CONSTANT
    // (`require(COMPILER)`), so matching on `require('...agent-compiler.cjs')`
    // would skip exactly the two files that carried the defect.
    if (!/agent-compiler\.cjs/.test(raw)) continue;
    const src = stripNonCode(raw);
    const mentionsOut = /outDir|dryRun/.test(src);
    const re = /(?<![\w.])compile\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const open = m.index + m[0].length - 1;
      const args = callArgs(src, open);
      if (!args.trim()) continue; // `compile()` inside an assertion message, not a call
      // Second argument, if any.
      const comma = args.indexOf(',');
      const second = comma === -1 ? '' : args.slice(comma + 1).trim();
      const line = src.slice(0, m.index).split('\n').length;
      if (!second) {
        violations.push(`${file}:${line} — compile(${args.trim()}) has no options: outDir defaults to 'agents/'`);
      } else if (second.startsWith('{')) {
        if (!/\boutDir\b|\bdryRun\b/.test(second)) {
          violations.push(`${file}:${line} — compile() options literal has neither outDir nor dryRun`);
        }
      } else if (!mentionsOut) {
        violations.push(`${file}:${line} — compile() options come from '${second}', and this file never mentions outDir/dryRun`);
      }
    }
  }
  assert.deepStrictEqual(
    violations,
    [],
    'a test would write the compiler output into the tracked agents/ directory:\n  ' +
      violations.join('\n  ') +
      '\n  Pass outDir: fs.mkdtempSync(...) (or dryRun: true). A byte-identical rewrite ' +
      'leaves git clean, but truncates the file and a sibling test process reads it empty.'
  );
});

test('88-11: the runner carries the tracked-tree canary, mtime included', () => {
  // The dynamic half of the defence: it is in the runner, not in a test file,
  // because node --test runs test files in parallel in an arbitrary order — a
  // test could not see a write that another file made after it finished. These
  // assertions keep the wiring from being dropped.
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.cjs'), 'utf-8');
  assert.match(runner, /canary\.trackedSnapshot\(/, 'the runner must snapshot the tracked tree before the run');
  assert.match(runner, /canary\.trackedDiff\(/, 'the runner must compare the tracked tree after the run');
  assert.match(runner, /status = 7/, 'a tracked-tree write must fail the run with its own status');

  const canary = require('./support/live-store-canary.cjs');
  assert.ok(canary.TRACKED_WATCH.includes('agents'), 'agents/ must be watched');
  assert.ok(canary.TRACKED_WATCH.includes('.mcp.json'), '.mcp.json must be watched');

  // mtime is part of the comparison — that is the whole point: the defect wrote
  // identical bytes, so sha-only comparison reported nothing.
  const same = { sha256: 'x', size: 3, mtimeMs: 1000 };
  assert.deepStrictEqual(
    canary.trackedDiff({ files: { 'agents/a.md': same } }, { files: { 'agents/a.md': { ...same, mtimeMs: 2000 } } }),
    [{ path: 'agents/a.md', reason: 'rewritten with identical bytes (mtime moved)' }],
    'an identical-bytes rewrite must be a finding'
  );
  assert.deepStrictEqual(
    canary.trackedDiff({ files: { 'agents/a.md': same } }, { files: { 'agents/a.md': same } }),
    [],
    'an untouched tree must be silent'
  );
  assert.match(
    canary.formatTracked([{ path: 'agents/a.md', reason: 'content changed' }]),
    /agents\/a\.md: content changed/,
    'the finding must name the changed file'
  );

  // The watch list resolves against a real checkout: the 35 compiled agents.
  const watched = canary.trackedWatchFiles(ROOT);
  assert.ok(
    watched.includes('agents/gsd-auditor-api-connections.md'),
    'the file the 2026-11-12 flake read empty must be under watch'
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

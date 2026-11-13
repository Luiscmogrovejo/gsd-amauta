/**
 * Phase 88 plan 88-19: the skip gate (FND-04).
 *
 * A test that skips without an entry in tests/skip-exceptions.d/ fails the run with
 * status 6; an entry that excuses nothing on a FULL run fails it too. This file proves
 * every rule of `scripts/skip-gate.cjs`, proves the Python half in
 * `tests/support/skip_gate.py` agrees with it rather than asserting that it does, and
 * carries the interpreter measurement the gate's design rests on so that it is re-taken
 * on every cell (Node 20 and 22 on Linux, macOS and Windows) instead of once on the
 * author's machine.
 *
 * Nothing here connects to a socket, reads the operator's records or writes outside a
 * temp directory. The three fixture files under tests/fixtures/skip-gate/ are deliberately
 * NOT named *.test.cjs, so the default glob never runs them.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'skip-gate.cjs');
const PY_GATE = path.join(ROOT, 'tests', 'support', 'skip_gate.py');
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.cjs');
const REPORTER = path.join(ROOT, 'scripts', 'skip-reporter.mjs');
// Plan 89-09: the ledger is a DIRECTORY of shards, one per owning plan. The block
// at the bottom of this file reads the UNION through the gate's own loader instead
// of `fs.readFileSync` on a single path.
const EXCEPTIONS_DIR = path.join(ROOT, 'tests', 'skip-exceptions.d');

/**
 * The real union, flattened into ONE temp file, for the two parity cases that
 * drive `--evaluate`'s single-file `exceptionsFile` input. Built lazily so the
 * temp directory is created once, when the CASES table is defined.
 * @returns {string} absolute path of the temp file
 */
let _realLedgerFile = null;
function realLedgerFile() {
  if (_realLedgerFile === null) {
    _realLedgerFile = path.join(tmp('ledger'), 'skip-exceptions-union.json');
    fs.writeFileSync(_realLedgerFile, JSON.stringify(gate.loadUnion(ROOT).entries, null, 2));
  }
  return _realLedgerFile;
}
const gate = require(GATE);
const { resolvePython, pythonEnv } = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'platform.cjs'));

const TMP_DIRS = [];

/**
 * A throwaway directory, removed by the `after` hook.
 * @param {string} [tag='gate'] name hint
 * @returns {string}
 */
function tmp(tag = 'gate') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-19-${tag}-`));
  TMP_DIRS.push(d);
  return d;
}

/**
 * One well-formed exceptions entry, with overrides.
 * @param {object} [over]
 * @returns {object}
 */
function entry(over = {}) {
  return {
    name: 'a skipped test',
    file: 'tests/fake.test.cjs',
    platform: 'all',
    context: 'any',
    reason: 'the thing it needs does not exist yet',
    reason_class: 'fixture-class',
    owner: 'plan 88-19 (this test file)',
    owner_phase: 88,
    exit_criterion: 'the thing it needs exists',
    ...over,
  };
}

/**
 * One observation, with overrides.
 * @param {object} [over]
 * @returns {object}
 */
function skip(over = {}) {
  return { kind: 'skip', file: 'tests/fake.test.cjs', name: 'a skipped test', reason: 'because', ...over };
}

/** @param {object} result @returns {string[]} the finding codes, in order */
function codes(result) {
  return result.findings.map((f) => f.code);
}

/**
 * Environment for a nested `node --test`: no NODE_OPTIONS (the guard is already
 * loaded in this process and the probe needs none) and, crucially, no
 * NODE_TEST_CONTEXT — a child that inherits it believes it IS a test process and
 * reports to its parent instead of running as a runner, so no reporter output is
 * ever written.
 * @returns {object}
 */
function nestedTestEnv() {
  const env = { ...process.env, NODE_OPTIONS: '' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Run the Node runner on explicit files and capture everything.
 * @param {string[]} files repo-relative paths
 * @param {object} [extraEnv]
 * @returns {{status: number, out: string}}
 */
function runRunner(files, extraEnv = {}) {
  const env = { ...process.env, GSD_SKIP_LIVE_STORE_CANARY: '1', ...extraEnv };
  delete env.GSD_PROCESS_LEDGER;
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` must really run its files
  const r = spawnSync(process.execPath, [RUNNER, ...files], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 300000,
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test.after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('88-19 the interpreter measurement the design rests on', () => {
  // Re-taken on every cell: Node 20 and 22 on ubuntu, macOS and Windows. The design
  // choice (a custom reporter, not TAP) is only sound if these hold everywhere.
  test('two reporters coexist: the human one on stdout, the gate one in a file', () => {
    const dir = tmp('probe');
    const file = path.join(dir, 'tiny.test.cjs');
    fs.writeFileSync(
      file,
      "const{test}=require('node:test');\n" +
        "test('probe passes',()=>{});\n" +
        "test('probe skips',(t)=>{t.skip('deliberate probe skip');});\n"
    );
    const dest = path.join(dir, 'skips.jsonl');
    const r = spawnSync(
      process.execPath,
      ['--test',
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        `--test-reporter=${pathToFileURL(REPORTER).href}`, `--test-reporter-destination=${dest}`,
        file],
      { cwd: dir, encoding: 'utf8', env: nestedTestEnv(), timeout: 120000 }
    );
    assert.strictEqual(r.status, 0, `probe run failed: ${r.stderr}`);
    assert.match(r.stdout, /probe passes/, 'the human reporter must still reach stdout');
    const rows = fs.readFileSync(dest, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(rows.length, 1, `exactly the skipped test is recorded: ${JSON.stringify(rows)}`);
    assert.strictEqual(rows[0].kind, 'skip');
    assert.strictEqual(rows[0].name, 'probe skips');
    assert.strictEqual(rows[0].reason, 'deliberate probe skip');
    // realpath on both sides: macOS reports the temp dir as /private/var/… in the
    // event and /var/… in the path the test built.
    assert.strictEqual(fs.realpathSync(rows[0].file), fs.realpathSync(file),
      'the event stream must carry the FILE: this is why the gate does not parse TAP');
  });

  test('the reporter attributes each skip to its own file in a MULTI-file run', () => {
    // The measured reason TAP was rejected: on Node 20, 22 and 25 a multi-file TAP plan
    // is flat and names no file, so `(file, name, platform)` is not recoverable from it.
    const dir = tmp('probe2');
    fs.writeFileSync(path.join(dir, 'a.test.cjs'),
      "const{test,describe,it}=require('node:test');\n" +
      "test('a top skip',(t)=>{t.skip('ra');});\n" +
      "describe('a group',()=>{it('a nested skip',(t)=>{t.skip('rn');});});\n");
    fs.writeFileSync(path.join(dir, 'b.test.cjs'),
      "const{test}=require('node:test');\ntest('b skip',(t)=>{t.skip('rb');});\n");
    const dest = path.join(dir, 'skips.jsonl');
    const r = spawnSync(
      process.execPath,
      ['--test',
        `--test-reporter=${pathToFileURL(REPORTER).href}`, `--test-reporter-destination=${dest}`,
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        'a.test.cjs', 'b.test.cjs'],
      { cwd: dir, encoding: 'utf8', env: nestedTestEnv(), timeout: 120000 }
    );
    assert.strictEqual(r.status, 0, r.stderr);
    const rows = fs.readFileSync(dest, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const byName = Object.fromEntries(rows.map((x) => [x.name, path.basename(x.file)]));
    assert.deepStrictEqual(byName, {
      'a top skip': 'a.test.cjs',
      'a nested skip': 'a.test.cjs',
      'b skip': 'b.test.cjs',
    });
  });

  test('a skipped SUITE is reported as one, and its children are invisible', () => {
    // Measured in 88-19-01: Node emits one event for the suite and none for its
    // children, and does not count the suite in `# skipped`. That is why rule 6 makes
    // a skipped suite a finding that no entry can excuse.
    const dir = tmp('probe3');
    // The suite-skip form is assembled, not written literally: scripts/quality-audit.cjs
    // bans that construct as a flaky marker, and it is right to — this file is the one
    // place that needs it, and only as a STRING it feeds to a child interpreter.
    const suiteSkip = `describe${'.'}skip`;
    fs.writeFileSync(path.join(dir, 'c.test.cjs'),
      "const{describe,it}=require('node:test');\n" +
      `${suiteSkip}('hidden suite',()=>{it('child one',()=>{});it('child two',()=>{});});\n`);
    const dest = path.join(dir, 'skips.jsonl');
    const r = spawnSync(
      process.execPath,
      ['--test', `--test-reporter=${pathToFileURL(REPORTER).href}`, `--test-reporter-destination=${dest}`,
        '--test-reporter=spec', '--test-reporter-destination=stdout', 'c.test.cjs'],
      { cwd: dir, encoding: 'utf8', env: nestedTestEnv(), timeout: 120000 }
    );
    assert.strictEqual(r.status, 0, r.stderr);
    const rows = fs.readFileSync(dest, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(rows.map((x) => [x.kind, x.name]), [['suite-skip', 'hidden suite']],
      'the children emit nothing, so the suite itself must be the finding');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('88-19 the matching rules', () => {
  const base = { runner: 'node', platform: 'darwin', ci: false, explicit: true };

  test('a listed skip is excused and nothing is reported', () => {
    const r = gate.evaluate({ ...base, entries: [entry()], observed: [skip()] });
    assert.deepStrictEqual(codes(r), []);
    assert.strictEqual(r.exit_code, 0);
  });

  test('an unlisted skip is SKIP_UNLISTED and names the test', () => {
    const r = gate.evaluate({ ...base, entries: [], observed: [skip()] });
    assert.deepStrictEqual(codes(r), ['SKIP_UNLISTED']);
    assert.strictEqual(r.findings[0].file, 'tests/fake.test.cjs');
    assert.strictEqual(r.findings[0].name, 'a skipped test');
    assert.strictEqual(r.exit_code, gate.EXIT_SKIP_GATE);
    assert.strictEqual(gate.EXIT_SKIP_GATE, 6);
  });

  test('an entry for ANOTHER platform does not excuse the skip, and the message says so', () => {
    const r = gate.evaluate({ ...base, entries: [entry({ platform: 'win32' })], observed: [skip()] });
    assert.deepStrictEqual(codes(r), ['SKIP_UNLISTED']);
    assert.match(r.findings[0].detail, /entries for win32 only/);
  });

  test('platform "all" and the current platform both match; another does not', () => {
    for (const p of ['all', 'darwin']) {
      assert.deepStrictEqual(codes(gate.evaluate({ ...base, entries: [entry({ platform: p })], observed: [skip()] })), []);
    }
    assert.deepStrictEqual(codes(gate.evaluate({ ...base, entries: [entry({ platform: 'linux' })], observed: [skip()] })), ['SKIP_UNLISTED']);
  });

  test('context "local" is accepted without CI and REFUSED with it, under its own code', () => {
    const local = [entry({ context: 'local' })];
    assert.deepStrictEqual(codes(gate.evaluate({ ...base, ci: false, entries: local, observed: [skip()] })), []);
    const under = gate.evaluate({ ...base, ci: true, entries: local, observed: [skip()] });
    assert.deepStrictEqual(codes(under), ['SKIP_LOCAL_ENTRY_UNDER_CI']);
    assert.match(under.findings[0].detail, /ONLY when CI is unset/);
    assert.strictEqual(under.exit_code, 6);
  });

  test('the Node gate judges only *.cjs entries, the Python gate only *.py and (collection)', () => {
    assert.strictEqual(gate.runnerOf('tests/a.test.cjs'), 'node');
    assert.strictEqual(gate.runnerOf('tests/test_a.py'), 'python');
    assert.strictEqual(gate.runnerOf('(collection)'), 'python');
    assert.strictEqual(gate.runnerOf('tests/a.txt'), 'unowned');
    // a Python entry is neither matched nor reported stale by the Node gate
    const r = gate.evaluate({
      ...base, explicit: false,
      entries: [entry({ file: 'tests/test_a.py' })],
      observed: [],
    });
    assert.deepStrictEqual(codes(r), []);
  });

  test('reason_class is never consulted: two entries of one class are independent', () => {
    const a = entry({ name: 'one', reason_class: 'shared' });
    const b = entry({ name: 'two', reason_class: 'shared' });
    const r = gate.evaluate({ ...base, explicit: false, entries: [a, b], observed: [skip({ name: 'one' })] });
    assert.deepStrictEqual(codes(r), ['SKIP_EXCEPTION_STALE']);
    assert.strictEqual(r.findings[0].name, 'two', 'the stale one is named by ITSELF, not by its class');
  });

  test('STALENESS: a full run reports an entry that excused nothing', () => {
    const r = gate.evaluate({ ...base, explicit: false, entries: [entry()], observed: [] });
    assert.deepStrictEqual(codes(r), ['SKIP_EXCEPTION_STALE']);
    assert.match(r.findings[0].detail, /normal, green path/);
  });

  test('STALENESS: a PARTIAL run stays green with the same stale entry', () => {
    // The case that keeps every single-file acceptance command in this plan, in 88-17
    // and in 88-11 executable.
    const r = gate.evaluate({ ...base, explicit: true, entries: [entry()], observed: [] });
    assert.deepStrictEqual(codes(r), []);
    assert.strictEqual(r.exit_code, 0);
    assert.strictEqual(r.counts.stale_checked, false);
  });

  test('STALENESS: a context "local" entry is never stale (rule 4d)', () => {
    const r = gate.evaluate({ ...base, explicit: false, entries: [entry({ context: 'local' })], observed: [] });
    assert.deepStrictEqual(codes(r), [],
      'a local entry matching nothing means this machine HAS the tool, which is not rot');
  });

  test('STALENESS: an entry for another platform is not reported as stale', () => {
    const r = gate.evaluate({ ...base, explicit: false, entries: [entry({ platform: 'win32' })], observed: [] });
    assert.deepStrictEqual(codes(r), []);
  });

  test('a skipped suite can never be excused by an entry', () => {
    const r = gate.evaluate({
      ...base,
      entries: [entry({ name: 'hidden suite' })],
      observed: [{ kind: 'suite-skip', file: 'tests/fake.test.cjs', name: 'hidden suite', reason: 'x' }],
    });
    assert.deepStrictEqual(codes(r), ['SKIP_SUITE_HIDES_TESTS']);
  });

  test('a todo test can never be excused by an entry', () => {
    const r = gate.evaluate({
      ...base,
      entries: [entry({ name: 'later' })],
      observed: [{ kind: 'todo', file: 'tests/fake.test.cjs', name: 'later', reason: 'soon' }],
    });
    assert.deepStrictEqual(codes(r), ['SKIP_TODO_NOT_ALLOWED']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('88-19 the gate fails closed', () => {
  test('a missing exceptions file is red, not green', () => {
    const { entries, problems } = gate.loadExceptions(path.join(tmp('closed'), 'nope.json'));
    assert.deepStrictEqual(entries, []);
    assert.deepStrictEqual(problems.map((p) => p.code), ['SKIP_EXCEPTIONS_UNREADABLE']);
    assert.match(problems[0].detail, /fails closed/);
  });

  test('invalid JSON is red', () => {
    const f = path.join(tmp('closed2'), 'x.json');
    fs.writeFileSync(f, '[{,}]');
    assert.deepStrictEqual(gate.loadExceptions(f).problems.map((p) => p.code), ['SKIP_EXCEPTIONS_UNREADABLE']);
  });

  test('a non-array document is red', () => {
    const f = path.join(tmp('closed3'), 'x.json');
    fs.writeFileSync(f, JSON.stringify({ exceptions: [] }));
    assert.deepStrictEqual(gate.loadExceptions(f).problems.map((p) => p.code), ['SKIP_EXCEPTIONS_MALFORMED']);
  });

  test('a missing or wrongly typed field is red, and the field is named', () => {
    const f = path.join(tmp('closed4'), 'x.json');
    fs.writeFileSync(f, JSON.stringify([entry({ owner_phase: '88' })]));
    const p = gate.loadExceptions(f).problems;
    assert.deepStrictEqual(p.map((x) => x.code), ['SKIP_EXCEPTIONS_MALFORMED']);
    assert.match(p[0].detail, /owner_phase/);
  });

  test('a duplicate (file, name, platform) is red: the file is FLAT', () => {
    const f = path.join(tmp('closed5'), 'x.json');
    fs.writeFileSync(f, JSON.stringify([entry(), entry()]));
    assert.match(gate.loadExceptions(f).problems[0].detail, /duplicates the key/);
  });

  test('an entry no runner owns is red', () => {
    const f = path.join(tmp('closed6'), 'x.json');
    fs.writeFileSync(f, JSON.stringify([entry({ file: 'tests/a.txt' })]));
    assert.match(gate.loadExceptions(f).problems[0].detail, /no runner owns/);
  });

  test('a reporter that wrote nothing is red: no evidence is not "no skips"', () => {
    const r = gate.runNodeGate({
      reportFile: path.join(tmp('closed7'), 'absent.jsonl'),
      repoRoot: ROOT,
      explicit: true,
      env: {},
    });
    assert.deepStrictEqual(r.findings.map((f) => f.code), ['SKIP_GATE_NO_EVIDENCE']);
    assert.strictEqual(r.exit_code, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('88-19 tests/skip-exceptions.d/ itself', () => {
  // The union, read the way every reader reads it. Plan 89-09 replaced the single
  // file this block used to open by path; `all` is now the union of the shards and
  // every subtest below iterates it, so uniqueness is asserted ACROSS the shards —
  // the same property SKIP_EXCEPTIONS_DUPLICATE_ACROSS_SHARDS enforces at load.
  const union = gate.loadUnion(ROOT);
  const all = union.entries;

  test('it loads clean through the gate: flat, unique, schema-valid', () => {
    assert.deepStrictEqual(union.problems, []);
    assert.ok(union.sources.length >= 1, `the shard directory must hold at least one shard; sources: ${union.sources.join(', ')}`);
    assert.ok(all.length > 0, 'the union must not be empty');
    assert.strictEqual(new Set(all.map((e) => `${e.file}|${e.name}|${e.platform}`)).size, all.length);
    // every shard is readable on its own, named individually on failure
    for (const name of fs.readdirSync(EXCEPTIONS_DIR).filter((n) => n.endsWith('.json'))) {
      const one = gate.loadExceptions(path.join(EXCEPTIONS_DIR, name));
      assert.deepStrictEqual(one.problems, [], `${name} does not load clean`);
    }
  });

  test('every entry carries an integer owner_phase and an exit criterion', () => {
    for (const e of all) {
      assert.ok(Number.isInteger(e.owner_phase), `${e.file} :: ${e.name}`);
      assert.ok(e.exit_criterion.trim().length > 20, `${e.file} :: ${e.name} needs a real exit criterion`);
    }
  });

  test('the test_grammar_strip entries name phase 96, as the ROADMAP ledger does', () => {
    const phases = [...new Set(all.filter((e) => /grammar_strip/.test(e.name + e.file)).map((e) => e.owner_phase))];
    assert.deepStrictEqual(phases, [96]);
  });

  test('every context "local" entry names a known local-only class, and none shadows a CI excuse', () => {
    const local = all.filter((e) => e.context === 'local');
    // Measured, never guessed. Plan 89-09 task 01 measured the first class (ten
    // scanner entries in carried.json); plan 89-07 measured the second from the
    // gate's own SKIP_UNLISTED list on a local full run with CI unset and no
    // GSD_TEST_POSTGRES_URL -- 239 python + 65 node = 304 tests that RUN on all
    // nine CI cells and cannot run on a machine with no disposable PostgreSQL.
    // Plan 89-13 re-measured it at 305: converting the party state-machine tests
    // renamed 23 of the 304 (23 closed in 89-07.json, the same 23 reopened under
    // their new names in 89-13.json, net zero) and added ONE, the PostgreSQL arm
    // of test_decision_trail_on_both_backends -- 240 python + 65 node.
    const byClass = {};
    for (const e of local) byClass[e.reason_class] = (byClass[e.reason_class] || 0) + 1;
    assert.deepStrictEqual(byClass, {
      'scanner-not-installed-locally': 10,
      'pg-no-disposable-database-local': 305,
    }, 'a local-only class changed size without being re-measured');

    for (const e of local) {
      assert.notStrictEqual(e.owner_phase, 89,
        'a phase cannot close with an open entry it owns, and a local-only entry '
        + `is open by construction: ${e.file} :: ${e.name}`);
      // "Shadowing" means an entry that excuses the SAME skip for the SAME
      // reason twice, which hides a change. Two entries for one test are
      // legitimate only when they describe two DIFFERENT obstacles -- plan
      // 89-07's measured case: `pg-no-disposable-database-local` (a developer
      // machine has no database at all) alongside
      // `paradedb-engine-unavailable` on darwin and win32 (the CI cells HAVE a
      // database, and it has no pg_search). Neither can excuse the other's
      // cell: the gate refuses a local entry when CI is set, and the darwin
      // entry does not apply to linux.
      for (const other of all) {
        if (other === e || other.file !== e.file || other.name !== e.name) continue;
        assert.notStrictEqual(other.reason_class, e.reason_class,
          `${e.file} :: ${e.name} carries two entries of the same class`);
        assert.notStrictEqual(other.context, 'local',
          `${e.file} :: ${e.name} carries two local entries`);
        assert.notStrictEqual(other.platform, 'all',
          `${e.file} :: ${e.name} has a context "any" entry for EVERY platform, `
          + 'that already excuses the skip everywhere, so the local entry adds nothing');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('88-19 the two implementations cannot drift', () => {
  // The plan allows either a shared module or a proven-identical pair. The language
  // boundary makes a shared module impossible (pytest cannot require a .cjs), so the
  // rules are written twice and PROVEN equal here: the same fixture exceptions file and
  // the same synthetic observations go into both `--evaluate` interfaces and the two
  // verdicts are compared field by field.
  const python = resolvePython();

  const CASES = [
    { label: 'listed skip', runner: 'node', platform: 'darwin', ci: false, explicit: false,
      entries: [entry()], observed: [skip()] },
    { label: 'unlisted skip', runner: 'node', platform: 'darwin', ci: false, explicit: false,
      entries: [], observed: [skip()] },
    { label: 'wrong platform', runner: 'node', platform: 'darwin', ci: false, explicit: false,
      entries: [entry({ platform: 'win32' })], observed: [skip()] },
    { label: 'local entry, no CI', runner: 'node', platform: 'linux', ci: false, explicit: false,
      entries: [entry({ context: 'local' })], observed: [skip()] },
    { label: 'local entry, under CI', runner: 'node', platform: 'linux', ci: true, explicit: false,
      entries: [entry({ context: 'local' })], observed: [skip()] },
    { label: 'stale on a full run', runner: 'node', platform: 'darwin', ci: false, explicit: false,
      entries: [entry()], observed: [] },
    { label: 'stale ignored on a partial run', runner: 'node', platform: 'darwin', ci: false, explicit: true,
      entries: [entry()], observed: [] },
    { label: 'python runner, py entries', runner: 'python', platform: 'win32', ci: true, explicit: false,
      entries: [entry({ file: 'tests/test_a.py' }), entry({ file: '(collection)', name: 'tests.test_a' })],
      observed: [{ kind: 'xfail', file: 'tests/test_a.py', name: 'a skipped test', reason: 'x' }] },
    { label: 'suite skip', runner: 'node', platform: 'darwin', ci: false, explicit: true,
      entries: [entry()], observed: [{ kind: 'suite-skip', file: 'tests/fake.test.cjs', name: 'a skipped test', reason: 'x' }] },
    { label: 'todo', runner: 'node', platform: 'darwin', ci: false, explicit: true,
      entries: [entry()], observed: [{ kind: 'todo', file: 'tests/fake.test.cjs', name: 'a skipped test', reason: 'x' }] },
    // These two drive `--evaluate`'s `exceptionsFile` input, which is deliberately
    // still a SINGLE file on both sides (plan 89-09 row 3): the parity interface
    // takes one path, and the ledger's own sharding lives in `loadUnion` /
    // `load_union`, above it. The content is the real union, written to a temp
    // file at module load, so these cases keep testing the real ledger.
    { label: 'the real exceptions file, one real skip', runner: 'node', platform: 'darwin', ci: true, explicit: true,
      exceptionsFile: realLedgerFile(),
      observed: [{ kind: 'skip', file: 'tests/board.e2e.test.cjs', name: 'create and complete task journey', reason: 'r' }] },
    { label: 'the real exceptions file, one unlisted skip', runner: 'python', platform: 'linux', ci: true, explicit: true,
      exceptionsFile: realLedgerFile(),
      observed: [{ kind: 'skip', file: 'tests/test_nope.py', name: 'test_nope', reason: 'r' }] },
  ];

  for (const c of CASES) {
    test(`parity: ${c.label}`, () => {
      const input = path.join(tmp('parity'), 'in.json');
      fs.writeFileSync(input, JSON.stringify(c));
      const js = spawnSync(process.execPath, [GATE, '--evaluate', input], { encoding: 'utf8', cwd: ROOT });
      const py = spawnSync(python.command, [...python.args, PY_GATE, '--evaluate', input],
        { encoding: 'utf8', cwd: ROOT, env: pythonEnv() });
      assert.strictEqual(py.status !== null, true, `python did not run: ${py.error && py.error.message}`);
      assert.ok(js.stdout.trim(), `node gate printed nothing: ${js.stderr}`);
      assert.ok(py.stdout.trim(), `python gate printed nothing: ${py.stderr}`);
      assert.deepStrictEqual(JSON.parse(py.stdout), JSON.parse(js.stdout), `${c.label}: the two verdicts differ`);
      assert.strictEqual(py.status, js.status, `${c.label}: the two exit statuses differ`);
    });
  }

  test('the two halves name the same codes', () => {
    const jsCodes = Object.values(gate.CODES).sort();
    const pySource = fs.readFileSync(PY_GATE, 'utf8');
    for (const code of jsCodes) {
      assert.ok(pySource.includes(`"${code}"`), `${code} is missing from the Python half`);
    }
    const pyOnly = [...pySource.matchAll(/"(SKIP_[A-Z_]+)"/g)].map((m) => m[1]);
    for (const code of new Set(pyOnly)) {
      // SKIP_XFAIL_COUNT_CHANGED is pytest-only (Node has no xfail): it is allowed here.
      if (code === 'SKIP_XFAIL_COUNT_CHANGED') continue;
      assert.ok(jsCodes.includes(code), `${code} exists only in the Python half`);
    }
  });

  test('the Python half refuses to be used as anything but a gate', () => {
    const r = spawnSync(python.command, [...python.args, PY_GATE], { encoding: 'utf8', cwd: ROOT, env: pythonEnv() });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /--evaluate/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('88-19 the CLI self-test of the context rule', () => {
  test('without CI the local entry is accepted (exit 0)', () => {
    const env = { ...process.env };
    delete env.CI;
    const r = spawnSync(process.execPath, [GATE, '--self-test-local-entry'], { encoding: 'utf8', cwd: ROOT, env });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ACCEPTED/);
  });

  test('with CI the local entry is refused (exit 6) and the message names the rule', () => {
    const r = spawnSync(process.execPath, [GATE, '--self-test-local-entry'],
      { encoding: 'utf8', cwd: ROOT, env: { ...process.env, CI: '1' } });
    assert.strictEqual(r.status, 6, r.stdout + r.stderr);
    assert.match(r.stdout, /REFUSED/);
    assert.match(r.stdout, /local/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('88-19 end to end: the runner', () => {
  test('an unlisted skip turns a green run RED with status 6, naming the test', () => {
    const r = runRunner(['tests/fixtures/skip-gate/unlisted-skip.cjs']);
    assert.strictEqual(r.status, 6, r.out.slice(-3000));
    assert.match(r.out, /SKIP_UNLISTED/);
    assert.match(r.out, /88-19 fixture: deliberate unlisted skip/);
  });

  test('the same file without the skip is green again', () => {
    const dir = tmp('green');
    const file = path.join(dir, 'no-skip.test.cjs');
    fs.writeFileSync(file, "const{test}=require('node:test');\ntest('88-19 fixture: this one passes',()=>{});\n");
    const r = runRunner([file]);
    assert.strictEqual(r.status, 0, r.out.slice(-3000));
    assert.match(r.out, /skip gate: 0 skip\(s\), all listed/);
  });

  test('the human per-test output still reaches the terminal', () => {
    const r = runRunner(['tests/fixtures/skip-gate/unlisted-skip.cjs']);
    assert.match(r.out, /88-19 fixture: this one passes/, 'the spec reporter must still print each test');
    assert.match(r.out, /tests 2/);
  });

  test('the live-store canary still exits 4, and the gate does not steal its status', () => {
    const fakeLive = tmp('88-19-canary');
    fs.mkdirSync(path.join(fakeLive, 'data'), { recursive: true });
    fs.writeFileSync(path.join(fakeLive, 'data', 'tasks.json'), JSON.stringify({ tasks: [] }));
    const r = runRunner(['tests/fixtures/skip-gate/canary-poke.cjs'], {
      GSD_SKIP_LIVE_STORE_CANARY: '0',
      GSD_LIVE_CHECKOUT: fakeLive,
    });
    assert.strictEqual(r.status, 4, r.out.slice(-3000));
    assert.match(r.out, /SKIP_UNLISTED/, 'the gate still reports, it just does not overwrite status 4');
    assert.match(r.out, /already failed with status 4/);
  });

  test('a leaked process still exits 5, and the gate does not steal its status', () => {
    let leaked = null;
    try {
      const r = runRunner(['tests/fixtures/skip-gate/leaky-sleeper.cjs']);
      const m = /LEAKED_PID=(\d+)/.exec(r.out);
      assert.ok(m, `the fixture did not print LEAKED_PID: ${r.out.slice(-2000)}`);
      leaked = Number(m[1]);
      assert.strictEqual(r.status, 5, r.out.slice(-3000));
      assert.match(r.out, /STRAY PROCESS/);
      assert.match(r.out, /already failed with status 5/);
    } finally {
      if (leaked) {
        try {
          process.kill(leaked, 'SIGKILL');
        } catch (_e) {
          /* already gone */
        }
      }
    }
  });
});

/**
 * Phase 89 plan 89-09 task 02: the skip ledger is SHARDED, one file per owning plan.
 *
 * What this file proves, in the order the plan asks for it:
 *   1. the union of `tests/skip-exceptions.d/*.json` is set-equal to the 467-entry
 *      array that stood in `tests/skip-exceptions.json` on master `7c93244`, on the
 *      full nine-field tuple — the migration lost and invented nothing;
 *   2. the same `(file, name, platform)` key in TWO shards is a FINDING, not a merge;
 *   3. an unreadable or non-array shard is a FINDING, not a pass (fail closed);
 *   4. the legacy single file is still an accepted input, so the two `planning-drift`
 *      fixture trees keep working untouched;
 *   5. an absent directory AND an absent file still produce no `planning-drift`
 *      finding, so the five older fixture trees report exactly what they did before;
 *   6. the two halves of the gate agree about the union, the duplicate code included.
 *
 * Plan 89-05 (addendum A) moved the DECLARED DELTA out of two shared arrays in this
 * file into one file per plan under `tests/skip-exceptions.d/delta/<plan>.json`, so a
 * plan touches only its own shard and its own delta file instead of this shared hot
 * spot (it conflicted in three of wave 2's four PRs). The proof is unchanged in
 * strength and gains two:
 *   7. every delta file loads clean, and a malformed or duplicated declaration FAILS
 *      CLOSED naming the file;
 *   8. a plan's declared additions are exactly the entries its OWN shard holds, and
 *      its declared removals are in no shard — stronger than 89-09's pinned count.
 *
 * Nothing here connects to a socket, reads the operator's records, or writes outside
 * a temp directory.
 */

'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const gate = require(path.join(ROOT, 'scripts', 'skip-gate.cjs'));
const PY_GATE = path.join(ROOT, 'tests', 'support', 'skip_gate.py');
const { resolvePython, pythonEnv } = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'platform.cjs'));
const { planningDrift } = require(path.join(ROOT, 'get-shit-done', 'bin', 'lib', 'planning-drift.cjs'));

const DIR = path.join(ROOT, 'tests', 'skip-exceptions.d');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'planning-drift');

/** The nine fields of an entry, in the gate's own SCHEMA order. */
const FIELDS = ['name', 'file', 'platform', 'context', 'reason', 'reason_class', 'owner', 'owner_phase', 'exit_criterion'];

// ─── The frozen pre-shard fingerprint ────────────────────────────────────────
//
// `tests/skip-exceptions.json` on master 7c93244, the commit this plan branched
// from: 467 entries, and the sha256 of their nine-field tuples sorted and joined
// by newlines. A digest rather than the file itself, so the proof survives the
// file's deletion without carrying a second copy of 467 entries in the tree.

/** Entry count of the ledger immediately before the shard migration. */
const PRE_SHARD_COUNT = 467;

/** sha256 of the sorted nine-field tuples of that ledger. */
const PRE_SHARD_DIGEST = '75cd221c305f84dec466e190ca55e108b55e2a78a838fe91c91dfbab4ac3f4a7';

// ─── The declared delta since the migration ──────────────────────────────────
//
// Plan 89-09 moved all 467 entries BY CONTENT and changed none, so the delta
// started empty. A later plan that removes an entry (89-01, 89-05 and 89-07 all
// do) or adds one declares its nine-field tuples, in its own PR — which is what
// keeps this proof alive instead of being deleted at the first edit, and is the
// same discipline `tests/skip-exceptions.d/README.md` rule 2 states.
//
// WHERE THE DECLARATION LIVES (plan 89-05, addendum A). It used to live in TWO
// shared arrays in this file, `ADDED_SINCE_SHARDING` and
// `REMOVED_SINCE_SHARDING`. Every plan that touched a shard had to edit them, so
// every parallel pair of PRs conflicted in this one file — three times in wave 2
// (89-02, 89-04 and 89-01 each hit it), and git resolves a conflicting array by
// taking ONE side, which is exactly the silent loss the set-equality proof below
// exists to catch. The declaration is now ONE FILE PER PLAN under
// `tests/skip-exceptions.d/delta/<plan>.json`, and this file loads their union.
// A plan now touches only its own shard and its own delta file.
//
// `delta/` is NOT a shard directory and no gate reads it: all four readers
// enumerate `tests/skip-exceptions.d/` non-recursively and keep only names
// ending in `.json` (`scripts/skip-gate.cjs:300`,
// `tests/support/skip_gate.py:292`,
// `get-shit-done/bin/lib/planning-drift.cjs:498`, and this file), and `delta` is
// a directory name with no such suffix. `the delta directory is invisible to the
// gates` below asserts that rather than assuming it.

/** The nine-field tuple shape of a declared entry. */
const DELTA_DIR = path.join(DIR, 'delta');

/**
 * Load every per-plan delta declaration, failing CLOSED on a malformed one.
 *
 * A delta file is `{plan, shard, note, added: [tuple...], removed: [tuple...]}`
 * where a tuple is the nine fields of `FIELDS`, in that order. Anything else is
 * a problem string naming the file: an unreadable or non-JSON file, a document
 * that is not an object, a missing or non-array `added`/`removed`, a row that is
 * not a nine-element array, or the same tuple twice — inside one file or across
 * two. A silently ignored delta file would let a plan's declaration disappear
 * without the digest check noticing which plan lost it.
 *
 * @param {string} dir directory holding `<plan>.json` delta files
 * @returns {{deltas: Array<{plan: string, source: string, added: Array<Array<unknown>>, removed: Array<Array<unknown>>}>, problems: string[]}}
 */
function loadDeltas(dir) {
  const deltas = [];
  const problems = [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    return { deltas, problems: [`delta directory unreadable: ${e.message}`] };
  }
  if (names.length === 0) problems.push(`${dir} holds no delta file`);
  const seen = new Map(); // tuple JSON -> "<source>/<list>"
  for (const name of names) {
    const source = `tests/skip-exceptions.d/delta/${name}`;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (e) {
      problems.push(`${source}: unreadable or not JSON (${e.message})`);
      continue;
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      problems.push(`${source}: must be a JSON object with added/removed arrays`);
      continue;
    }
    if (typeof doc.plan !== 'string' || doc.plan.length === 0) {
      problems.push(`${source}: "plan" must name the owning plan`);
      continue;
    }
    if (`${doc.plan}.json` !== name) {
      problems.push(`${source}: "plan" is ${JSON.stringify(doc.plan)} but the file is named ${name}`);
      continue;
    }
    const lists = {};
    let shapeOk = true;
    for (const list of ['added', 'removed']) {
      const rows = doc[list];
      if (!Array.isArray(rows)) {
        problems.push(`${source}: "${list}" must be an array of nine-field tuples`);
        shapeOk = false;
        continue;
      }
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== FIELDS.length) {
          problems.push(
            `${source}: "${list}" holds a row that is not a ${FIELDS.length}-element tuple: ${JSON.stringify(row)}`
          );
          shapeOk = false;
          continue;
        }
        const key = JSON.stringify(row);
        const where = `${source} ${list}`;
        if (seen.has(key)) {
          problems.push(`${source}: "${list}" repeats a tuple already declared in ${seen.get(key)}: ${key}`);
          shapeOk = false;
          continue;
        }
        seen.set(key, where);
      }
      lists[list] = rows;
    }
    if (!shapeOk) continue;
    deltas.push({ plan: doc.plan, source, added: lists.added, removed: lists.removed });
  }
  return { deltas, problems };
}

const DELTA = loadDeltas(DELTA_DIR);

/** Every plan's declared additions, unioned. */
const ADDED_SINCE_SHARDING = DELTA.deltas.flatMap((d) => d.added);

/** Every plan's declared removals, unioned. */
const REMOVED_SINCE_SHARDING = DELTA.deltas.flatMap((d) => d.removed);

/**
 * One plan's declared additions, by plan id.
 * @param {string} plan e.g. '89-04'
 * @returns {Array<Array<unknown>>}
 */
function declaredAdded(plan) {
  const hit = DELTA.deltas.find((d) => d.plan === plan);
  assert.ok(hit, `tests/skip-exceptions.d/delta/${plan}.json is missing`);
  return hit.added;
}

/** Plan 89-04's 51: 23 PostgreSQL-gated tests x darwin + win32, plus 5 on linux. */
const ADDED_EXPECTED = 51;

const TMP_DIRS = [];

/**
 * A throwaway directory, removed by the `after` hook.
 * @param {string} [tag='shards'] name hint
 * @returns {string} absolute path
 */
function tmp(tag = 'shards') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-8909-${tag}-`));
  TMP_DIRS.push(d);
  return d;
}

after(() => {
  for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * The nine-field tuple of one entry, as a comparable string.
 * @param {object} entry one ledger entry
 * @returns {string}
 */
function tuple(entry) {
  return JSON.stringify(FIELDS.map((f) => entry[f]));
}

/**
 * A repository-shaped temp tree holding `tests/skip-exceptions.d/` and nothing else.
 * @param {Record<string, unknown>} shards file name -> content (array, or a raw string)
 * @returns {string} the tree root
 */
function treeWithShards(shards) {
  const root = tmp('tree');
  fs.mkdirSync(path.join(root, 'tests', 'skip-exceptions.d'), { recursive: true });
  for (const [name, content] of Object.entries(shards)) {
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    fs.writeFileSync(path.join(root, 'tests', 'skip-exceptions.d', name), body);
  }
  return root;
}

/**
 * One schema-valid entry, with overrides.
 * @param {object} [over]
 * @returns {object}
 */
function entry(over = {}) {
  return {
    name: 'a skipped test',
    file: 'tests/fake.test.cjs',
    platform: 'all',
    context: 'any',
    reason: 'the fixture feature does not exist yet, so this test cannot run',
    reason_class: 'fixture-pending',
    owner: 'plan 89-09 (this test file)',
    owner_phase: 89,
    exit_criterion: 'never: this entry exists only inside a temp directory in this test',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('89-09 the shard migration lost nothing', () => {
  const union = gate.loadUnion(ROOT);

  test('the repository ledger loads clean, from the shard directory only', () => {
    assert.deepStrictEqual(union.problems, []);
    assert.deepStrictEqual(
      union.sources,
      fs.readdirSync(DIR).filter((n) => n.endsWith('.json')).sort().map((n) => `tests/skip-exceptions.d/${n}`),
      'the union reads every *.json shard and, at the repository root, nothing else'
    );
    assert.strictEqual(
      fs.existsSync(path.join(ROOT, 'tests', 'skip-exceptions.json')),
      false,
      'the monolith is deleted; the shards are the ledger'
    );
  });

  test('every delta file loads clean and declares only tuples its own shard holds', () => {
    assert.deepStrictEqual(DELTA.problems, [],
      'a delta file is malformed or declares a tuple twice; the loader fails closed');
    assert.ok(DELTA.deltas.length >= 3,
      `expected one delta file per plan that moved an entry, got ${DELTA.deltas.length}`);
    // The invariant that replaces plan 89-09's "derive from the shard and pin the
    // count": a plan's declared ADDITIONS must be exactly the tuples its own shard
    // holds, and its declared REMOVALS must be in no shard at all. That is
    // stronger than a count — a swapped entry of the same size fails here — and it
    // is what lets a plan edit its own two files and nothing else.
    const liveByShard = new Map();
    for (const name of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
      liveByShard.set(name, new Set(
        JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')).map((e) => tuple(e))
      ));
    }
    const liveAll = new Set([...liveByShard.values()].flatMap((s) => [...s]));
    for (const d of DELTA.deltas) {
      const own = liveByShard.get(`${d.plan}.json`);
      assert.ok(own, `${d.source} names plan ${d.plan}, which has no shard ${d.plan}.json`);
      for (const row of d.added) {
        assert.ok(own.has(JSON.stringify(row)),
          `${d.source} declares an addition its own shard does not hold: ${JSON.stringify(row)}`);
      }
      assert.strictEqual(d.added.length, own.size,
        `${d.source} declares ${d.added.length} additions but ${d.plan}.json holds ${own.size}: `
        + 'every entry of a plan-owned shard was added by that plan and must be declared');
      for (const row of d.removed) {
        assert.ok(!liveAll.has(JSON.stringify(row)),
          `${d.source} declares a removal that is still live in the ledger: ${JSON.stringify(row)}`);
      }
    }
  });

  test('the delta directory is invisible to the gates', () => {
    assert.ok(fs.existsSync(DELTA_DIR), 'tests/skip-exceptions.d/delta/ must exist');
    assert.ok(fs.statSync(DELTA_DIR).isDirectory());
    // No reader may pick a delta file up as a shard: all four enumerate the shard
    // directory non-recursively and keep only *.json names, and `delta` has no
    // such suffix. Proven by the loaded union rather than by reading the readers.
    for (const source of union.sources) {
      assert.ok(!source.includes('/delta/'), `a gate read a delta file as a shard: ${source}`);
    }
    const shardTotal = fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))
      .reduce((n, f) => n + JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).length, 0);
    assert.strictEqual(union.entries.length, shardTotal,
      'the union holds entries no shard holds — a delta file reached the ledger');
  });

  test('the declared additions are exactly plan 89-04\'s 51, all in its own shard', () => {
    const ADDED_BY_89_04 = declaredAdded('89-04');
    assert.strictEqual(ADDED_BY_89_04.length, ADDED_EXPECTED,
      'tests/skip-exceptions.d/delta/89-04.json changed size without updating ADDED_EXPECTED');
    const at = (t, f) => t[FIELDS.indexOf(f)];
    const platforms = new Set(ADDED_BY_89_04.map((t) => at(t, 'platform')));
    assert.deepStrictEqual([...platforms].sort(), ['darwin', 'linux', 'win32']);
    const classes = new Set(ADDED_BY_89_04.map((t) => at(t, 'reason_class')));
    assert.deepStrictEqual([...classes].sort(),
      ['pg-client-major-mismatch', 'pg-no-disposable-database']);
    const files = new Set(ADDED_BY_89_04.map((t) => at(t, 'file')));
    assert.deepStrictEqual([...files].sort(),
      ['tests/test_89_04_backup_guard.py', 'tests/test_89_04_restore_e2e.py'],
      'tests/test_89_04_backup_snapshot.py needs no entry: it reaches for no database');

    // The two groups, counted apart, because they are closed by two different
    // things and a change to either must be visible.
    const noDb = ADDED_BY_89_04.filter((t) => at(t, 'reason_class') === 'pg-no-disposable-database');
    const mismatch = ADDED_BY_89_04.filter((t) => at(t, 'reason_class') === 'pg-client-major-mismatch');
    assert.strictEqual(noDb.length, 46, '23 tests x darwin + win32');
    assert.strictEqual(mismatch.length, 5, 'the five tests that perform a real restore');
    assert.deepStrictEqual([...new Set(noDb.map((t) => at(t, 'platform')))].sort(),
      ['darwin', 'win32']);
    assert.deepStrictEqual([...new Set(mismatch.map((t) => at(t, 'platform')))], ['linux'],
      'the Linux cell HAS a database; only its client major is wrong');
    for (const tuple of mismatch) {
      assert.match(at(tuple, 'exit_criterion'), /postgresql-client-16/,
        'the mismatch entries must name the install step that removes them');
    }
    for (const tuple of ADDED_BY_89_04) {
      assert.match(at(tuple, 'exit_criterion'), /89-07/,
        'every entry must name the plan that removes it');
      assert.strictEqual(at(tuple, 'owner_phase'), 89);
      assert.strictEqual(at(tuple, 'context'), 'any');
    }
  });

  test('the union is SET-EQUAL to the pre-shard ledger on the full nine-field tuple', () => {
    const removed = REMOVED_SINCE_SHARDING.map((t) => JSON.stringify(t));
    const added = ADDED_SINCE_SHARDING.map((t) => JSON.stringify(t));
    const current = union.entries.map(tuple);
    for (const t of added) {
      const at = current.indexOf(t);
      assert.notStrictEqual(at, -1,
        `a delta file's "added" names an entry the ledger does not hold: ${t}`);
      current.splice(at, 1);
    }
    const reconstructed = [...current, ...removed].sort();
    assert.strictEqual(
      reconstructed.length,
      PRE_SHARD_COUNT,
      `the ledger plus its declared removals must still account for ${PRE_SHARD_COUNT} entries; `
        + `got ${reconstructed.length} (${union.entries.length} live, ${removed.length} declared removed, ${added.length} declared added)`
    );
    assert.strictEqual(
      crypto.createHash('sha256').update(reconstructed.join('\n'), 'utf8').digest('hex'),
      PRE_SHARD_DIGEST,
      'the nine-field tuples no longer reproduce the pre-shard ledger. Either an entry '
        + 'changed without being declared in this plan\'s tests/skip-exceptions.d/delta/'
        + '<plan>.json, or the migration lost one.'
    );
  });

  test('every key is unique ACROSS the shards, and no shard is empty of purpose', () => {
    const keys = union.entries.map((e) => `${e.file}|${e.name}|${e.platform}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'a duplicate key across shards');
    for (const name of fs.readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
      const doc = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
      assert.ok(Array.isArray(doc), `${name} must be a flat array`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plan 89-05 addendum A: the per-plan delta loader fails closed too. Without
// these, a delta file that stopped parsing would make the plan's declaration
// vanish, the digest check would blame "the migration lost one", and nobody
// would know which plan's file broke.
describe('89-05 the per-plan delta loader fails closed', () => {
  const tupleOf = (over = {}) => FIELDS.map((f) => entry(over)[f]);

  /**
   * A temp delta directory holding the given files.
   * @param {Record<string, unknown>} files name -> document (object) or raw string
   * @returns {string} the directory
   */
  function deltaDir(files) {
    const dir = tmp('delta');
    for (const [name, content] of Object.entries(files)) {
      const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
  }

  test('a well-formed pair of delta files loads with no problem', () => {
    const r = loadDeltas(deltaDir({
      '89-aa.json': { plan: '89-aa', added: [tupleOf()], removed: [] },
      '89-bb.json': { plan: '89-bb', added: [], removed: [tupleOf({ name: 'gone' })] },
    }));
    assert.deepStrictEqual(r.problems, []);
    assert.strictEqual(r.deltas.length, 2);
    assert.strictEqual(r.deltas.flatMap((d) => d.added).length, 1);
    assert.strictEqual(r.deltas.flatMap((d) => d.removed).length, 1);
  });

  test('an unparseable delta file is a problem naming it, and contributes nothing', () => {
    const r = loadDeltas(deltaDir({
      '89-aa.json': { plan: '89-aa', added: [tupleOf()], removed: [] },
      '89-bb.json': '{ not json',
    }));
    assert.strictEqual(r.problems.length, 1, r.problems.join('; '));
    assert.match(r.problems[0], /delta\/89-bb\.json: unreadable or not JSON/);
    assert.strictEqual(r.deltas.length, 1, 'the good file still loads; the bad one is reported');
  });

  test('a delta that is an array, not an object, is a problem', () => {
    const r = loadDeltas(deltaDir({ '89-aa.json': [tupleOf()] }));
    assert.match(r.problems.join('\n'), /89-aa\.json: must be a JSON object/);
    assert.deepStrictEqual(r.deltas, []);
  });

  test('a non-array added/removed is a problem naming the list', () => {
    for (const list of ['added', 'removed']) {
      const doc = { plan: '89-aa', added: [], removed: [] };
      doc[list] = 'all of them';
      const r = loadDeltas(deltaDir({ '89-aa.json': doc }));
      assert.match(r.problems.join('\n'),
        new RegExp(`89-aa\\.json: "${list}" must be an array of nine-field tuples`));
      assert.deepStrictEqual(r.deltas, []);
    }
  });

  test('a row that is not a nine-element tuple is a problem quoting the row', () => {
    const r = loadDeltas(deltaDir({
      '89-aa.json': { plan: '89-aa', added: [tupleOf().slice(0, 8)], removed: [] },
    }));
    assert.match(r.problems.join('\n'), /is not a 9-element tuple/);
    assert.deepStrictEqual(r.deltas, []);
  });

  test('the same tuple twice IN ONE delta file is a problem', () => {
    const t = tupleOf();
    const r = loadDeltas(deltaDir({ '89-aa.json': { plan: '89-aa', added: [t, t], removed: [] } }));
    assert.match(r.problems.join('\n'), /repeats a tuple already declared/);
    assert.deepStrictEqual(r.deltas, []);
  });

  test('the same tuple in TWO delta files is a problem naming both', () => {
    const t = tupleOf();
    const r = loadDeltas(deltaDir({
      '89-aa.json': { plan: '89-aa', added: [t], removed: [] },
      '89-bb.json': { plan: '89-bb', added: [t], removed: [] },
    }));
    assert.strictEqual(r.problems.length, 1, r.problems.join('; '));
    assert.match(r.problems[0], /89-bb\.json/);
    assert.match(r.problems[0], /delta\/89-aa\.json added/,
      'the problem must name the file that declared it first');
  });

  test('a delta whose "plan" disagrees with its file name is a problem', () => {
    const r = loadDeltas(deltaDir({ '89-aa.json': { plan: '89-zz', added: [], removed: [] } }));
    assert.match(r.problems.join('\n'), /"plan" is "89-zz" but the file is named 89-aa\.json/);
    assert.deepStrictEqual(r.deltas, []);
  });

  test('an empty delta directory is a problem, not a silent zero delta', () => {
    const r = loadDeltas(tmp('delta-empty'));
    assert.strictEqual(r.problems.length, 1, r.problems.join('; '));
    assert.match(r.problems[0], /holds no delta file/);
  });

  test('an absent delta directory is a problem, not a silent zero delta', () => {
    const r = loadDeltas(path.join(tmp('delta-missing'), 'nope'));
    assert.strictEqual(r.problems.length, 1, r.problems.join('; '));
    assert.match(r.problems[0], /delta directory unreadable/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('89-09 the shard loader fails closed', () => {
  test('the same (file, name, platform) in TWO shards is a finding naming both', () => {
    const shared = entry({ file: 'tests/dup.test.cjs', name: 'the contested test' });
    const root = treeWithShards({ '89-aa.json': [shared], '89-bb.json': [shared] });
    const r = gate.loadUnion(root);
    assert.deepStrictEqual(r.problems.map((p) => p.code), ['SKIP_EXCEPTIONS_DUPLICATE_ACROSS_SHARDS']);
    assert.deepStrictEqual(r.entries, [], 'the gate fails closed: no entry is trusted');
    assert.match(r.problems[0].detail, /89-aa\.json/);
    assert.match(r.problems[0].detail, /89-bb\.json/);
  });

  test('the same key TWICE IN ONE shard keeps reporting as MALFORMED, unchanged', () => {
    const shared = entry({ file: 'tests/dup.test.cjs', name: 'the contested test' });
    const r = gate.loadUnion(treeWithShards({ '89-aa.json': [shared, shared] }));
    assert.deepStrictEqual(r.problems.map((p) => p.code), ['SKIP_EXCEPTIONS_MALFORMED']);
  });

  test('an unreadable shard is a finding, not a pass', () => {
    const root = treeWithShards({ '89-aa.json': [entry()], '89-bb.json': '{ not json' });
    const r = gate.loadUnion(root);
    assert.deepStrictEqual(r.problems.map((p) => p.code), ['SKIP_EXCEPTIONS_UNREADABLE']);
    assert.match(r.problems[0].detail, /89-bb\.json/);
    assert.deepStrictEqual(r.entries, []);
  });

  test('a shard that is not an array is a finding naming the shard', () => {
    const r = gate.loadUnion(treeWithShards({ '89-aa.json': { entries: [entry()] } }));
    assert.deepStrictEqual(r.problems.map((p) => p.code), ['SKIP_EXCEPTIONS_MALFORMED']);
    assert.match(r.problems[0].detail, /89-aa\.json must be a FLAT JSON array/);
  });

  test('for the RUNNER, no shard and no legacy file is a finding; for the LIBRARY it is silence', () => {
    const bare = tmp('bare');
    assert.deepStrictEqual(gate.loadUnion(bare).problems, [], 'the library stays silent for planning-drift');
    assert.deepStrictEqual(
      gate.loadUnionForGate(bare).problems.map((p) => p.code),
      ['SKIP_EXCEPTIONS_UNREADABLE'],
      'the runner fails closed: no ledger is not "no skips"'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('89-09 the legacy single file is still an accepted input', () => {
  test('a tree with ONLY tests/skip-exceptions.json is read', () => {
    const root = tmp('legacy');
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'skip-exceptions.json'), JSON.stringify([entry()], null, 2));
    const r = gate.loadUnion(root);
    assert.deepStrictEqual(r.problems, []);
    assert.deepStrictEqual(r.sources, ['tests/skip-exceptions.json']);
    assert.strictEqual(r.entries.length, 1);
  });

  test('shards AND the legacy file are read together, in that order', () => {
    const root = treeWithShards({ '89-aa.json': [entry({ name: 'from the shard' })] });
    fs.writeFileSync(path.join(root, 'tests', 'skip-exceptions.json'),
      JSON.stringify([entry({ name: 'from the legacy file' })], null, 2));
    const r = gate.loadUnion(root);
    assert.deepStrictEqual(r.problems, []);
    assert.deepStrictEqual(r.sources, ['tests/skip-exceptions.d/89-aa.json', 'tests/skip-exceptions.json']);
    assert.deepStrictEqual(r.entries.map((e) => e.name), ['from the shard', 'from the legacy file']);
  });

  test('loadExceptions keeps its single-file signature, for --evaluate and the fixtures', () => {
    const root = tmp('one');
    const file = path.join(root, 'one.json');
    fs.writeFileSync(file, JSON.stringify([entry()], null, 2));
    const r = gate.loadExceptions(file);
    assert.deepStrictEqual(r.problems, []);
    assert.strictEqual(r.entries.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('89-09 planning-drift is unchanged where it must be', () => {
  /** The five trees that existed before plan 88-19, and the finding COUNT each produced. */
  const PRE_88_19_TREES = { agree: 0, disagree: 7, exceptions: 7, 'archived-milestone': 0, 'unreadable-goal': 2 };

  test('the five older fixture trees have neither a shard directory nor a file, and are silent as before', () => {
    for (const [name, before] of Object.entries(PRE_88_19_TREES)) {
      const dir = path.join(FIXTURES, name);
      assert.strictEqual(fs.existsSync(path.join(dir, 'tests', 'skip-exceptions.json')), false, name);
      assert.strictEqual(fs.existsSync(path.join(dir, 'tests', 'skip-exceptions.d')), false, name);
      assert.strictEqual(planningDrift(dir).findings.length, before, `${name} changed count`);
    }
  });

  test('the two 88-19 fixture trees still carry the LEGACY single file and are untouched', () => {
    for (const name of ['skip-ledger-agrees', 'skip-ledger-disagrees']) {
      const file = path.join(FIXTURES, name, 'tests', 'skip-exceptions.json');
      assert.strictEqual(fs.existsSync(file), true, `${name} must keep its legacy file`);
      assert.ok(Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8'))));
    }
    assert.deepStrictEqual(planningDrift(path.join(FIXTURES, 'skip-ledger-agrees')).findings, []);
  });

  test('planning-drift reads a SHARD directory too', () => {
    const root = tmp('pd');
    fs.cpSync(path.join(FIXTURES, 'skip-ledger-agrees'), root, { recursive: true });
    const legacy = path.join(root, 'tests', 'skip-exceptions.json');
    const entries = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    fs.rmSync(legacy);
    fs.mkdirSync(path.join(root, 'tests', 'skip-exceptions.d'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'skip-exceptions.d', 'shard.json'), JSON.stringify(entries, null, 2));
    assert.deepStrictEqual(planningDrift(root).findings, [],
      'the same entries in a shard must read exactly as they did in the single file');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('89-09 the two gate halves agree about the union', () => {
  const python = resolvePython();

  /**
   * Ask the Python half to load a union and report what it found.
   * @param {string} root the tree to load from
   * @returns {{entries: number, codes: string[]}}
   */
  function pythonUnion(root) {
    const code = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'import skip_gate',
      'entries, problems = skip_gate.load_union(sys.argv[2])',
      'print(json.dumps({"entries": len(entries), "codes": [p["code"] for p in problems]}))',
    ].join('\n');
    const r = spawnSync(python.command, [...python.args, '-c', code, path.dirname(PY_GATE), root],
      { encoding: 'utf8', cwd: ROOT, env: pythonEnv() });
    assert.ok(r.stdout && r.stdout.trim(), `python printed nothing: ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  }

  test('the repository union: the same entry count on both sides', () => {
    assert.strictEqual(pythonUnion(ROOT).entries, gate.loadUnion(ROOT).entries.length);
  });

  test('a duplicate across shards: the same code on both sides', () => {
    const shared = entry({ file: 'tests/dup.py', name: 'test_contested' });
    const root = treeWithShards({ '89-aa.json': [shared], '89-bb.json': [shared] });
    assert.deepStrictEqual(pythonUnion(root).codes, ['SKIP_EXCEPTIONS_DUPLICATE_ACROSS_SHARDS']);
    assert.deepStrictEqual(gate.loadUnion(root).problems.map((p) => p.code), ['SKIP_EXCEPTIONS_DUPLICATE_ACROSS_SHARDS']);
  });

  test('an unreadable shard: the same code on both sides', () => {
    const root = treeWithShards({ '89-aa.json': '{ not json' });
    assert.deepStrictEqual(pythonUnion(root).codes, ['SKIP_EXCEPTIONS_UNREADABLE']);
    assert.deepStrictEqual(gate.loadUnion(root).problems.map((p) => p.code), ['SKIP_EXCEPTIONS_UNREADABLE']);
  });
});

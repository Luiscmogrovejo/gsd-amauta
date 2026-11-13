/**
 * Phase 89 plan 89-05 (ORC-02): the bespoke A2A surface is gone, and the four
 * PG-only feature lists agree about what the SQLite backend cannot do.
 *
 * Task 89-05-03 ships the four-list agreement; task 89-05-06 adds the absence
 * proof over the tracked tree, once the eight test files are deleted with the
 * feature.
 *
 * Nothing here starts a process that binds a port or reads the operator's store.
 *
 * Run: node --test tests/89-05-a2a-absent.test.cjs
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// ═════════════════════════════════════════════════════════════════════════════
// The four PG-only feature lists
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The prose a PG-only feature is reported in, per typed key.
 *
 * `services/sqlite_store.py` `SQLiteStore.PG_ONLY_FEATURES` is the AUTHORITY —
 * it is the store that knows what it cannot do. `services/doctor.py` and
 * `bin/init.cjs` report prose to the operator. This is the mapping, written out
 * so a row that names nothing real cannot hide in a different vocabulary: it is
 * exactly how 'A2A exchange log' and 'blackboard (agent_findings /
 * agent_messages)' survived in two files after the typed lists had moved on.
 */
const PROSE_FOR_TYPED = {
  vector_search: 'vector/semantic memory search (pgvector)',
  rlm_index: 'RLM code index (rlm_chunks)',
  semantic_cache: 'semantic cache',
};

/**
 * Typed features `doctor` deliberately does NOT put in its prose list, with the
 * reason. Declared, so the gap is visible instead of implicit; the stale check
 * below fails if `doctor` starts reporting one.
 */
const NOT_IN_DOCTOR_PROSE = {
  party_sessions: 'party sessions are reduced to recorded decisions by plan 89-13; what '
    + 'doctor should say about them is that plan\'s to decide',
  skill_invocations: 'skill_invocation_store is PG-only and has no operator-facing row in '
    + 'doctor today — routed, not invented here',
  task_completions: 'complexity_scorer.store_completion is PG-only and has no '
    + 'operator-facing row in doctor today — routed, not invented here',
};

/**
 * `bin/init.cjs` rows that disagree with `services/doctor.py`, allowed until
 * plan 89-11 edits that pinned file (decision D8).
 *
 * This is the Phase 88 ratchet shape (POSIX_LITERAL_EXCEPTION_STALE,
 * DRIFT_EXCEPTION_STALE): a documented allowance plus a STALE CHECK that fails
 * once the entry is gone and the allowance was not removed. It adds NO skip
 * entry — the test ships passing and 89-11 clears it.
 */
const PENDING_89_11 = [
  'A2A exchange log',
  'blackboard (agent_findings / agent_messages)',
];

/**
 * A JavaScript/Python string-array literal, read out of a source file.
 * @param {string} src file text
 * @param {string} marker the assignment, e.g. `const PG_ONLY_FEATURES = [`
 * @returns {string[]} the single-quoted or double-quoted strings, in order
 */
function stringArrayAfter(src, marker) {
  const at = src.indexOf(marker);
  assert.notStrictEqual(at, -1, `marker not found: ${marker}`);
  const open = src.indexOf('[', at + marker.length - 1);
  const close = src.indexOf(']', open);
  assert.ok(open !== -1 && close > open, `no array literal after ${marker}`);
  const body = src.slice(open + 1, close);
  return [...body.matchAll(/(['"])((?:[^'"\\]|\\.)*)\1/g)].map((m) => m[2]);
}

/**
 * A Python tuple/list of strings, read out of a source file.
 * @param {string} src file text
 * @param {string} marker e.g. `PG_ONLY_FEATURES = (`
 * @returns {string[]}
 */
function pyStringSeqAfter(src, marker) {
  const at = src.indexOf(marker);
  assert.notStrictEqual(at, -1, `marker not found: ${marker}`);
  const openChar = marker.trim().endsWith('(') ? '(' : '[';
  const closeChar = openChar === '(' ? ')' : ']';
  const open = src.indexOf(openChar, at + marker.length - 1);
  const close = src.indexOf(closeChar, open);
  const body = src.slice(open + 1, close);
  return [...body.matchAll(/(['"])((?:[^'"\\]|\\.)*)\1/g)].map((m) => m[2]);
}

/** The keys of the daemon's `PG_ONLY_FEATURE_DETAIL` dict. */
function daemonDetailKeys(src) {
  const at = src.indexOf('PG_ONLY_FEATURE_DETAIL = {');
  assert.notStrictEqual(at, -1, 'PG_ONLY_FEATURE_DETAIL not found');
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(src.indexOf('{', at) + 1, end);
  return [...body.matchAll(/^\s{4}"([a-z_]+)":/gm)].map((m) => m[1]);
}

/**
 * The daemon's `features_off` list, as typed keys.
 *
 * The marker itself contains a `[` (`health["features_off"]`), so the array's own
 * bracket is found AFTER the marker, never by scanning from its start.
 */
function daemonFeaturesOff(src) {
  const marker = 'health["features_off"] = [';
  const at = src.indexOf(marker);
  assert.notStrictEqual(at, -1, 'features_off list not found');
  const open = at + marker.length - 1;
  const close = src.indexOf(']', open);
  assert.ok(close > open, 'features_off array is not closed');
  const body = src.slice(open + 1, close);
  const keys = [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 8, `features_off parsed as ${JSON.stringify(keys)}`);
  return keys;
}

describe('89-05 the four PG-only feature lists agree', () => {
  const storeSrc = read('services/sqlite_store.py');
  const daemonSrc = read('services/amauta-daemon.py');
  const doctorSrc = read('services/doctor.py');
  const initSrc = read('bin/init.cjs');

  const typed = pyStringSeqAfter(storeSrc, '    PG_ONLY_FEATURES = (');
  const detailKeys = daemonDetailKeys(daemonSrc);
  const featuresOff = daemonFeaturesOff(daemonSrc);
  const doctorProse = pyStringSeqAfter(doctorSrc, 'PG_ONLY_FEATURES = [');
  const initProse = stringArrayAfter(initSrc, 'const PG_ONLY_FEATURES = [');

  test('the typed authority no longer names A2A, and still names the rest', () => {
    assert.ok(typed.length >= 5, typed);
    assert.ok(!typed.includes('a2a'), `SQLiteStore.PG_ONLY_FEATURES still names a2a: ${typed}`);
    for (const key of ['vector_search', 'rlm_index', 'semantic_cache', 'party_sessions']) {
      assert.ok(typed.includes(key), `${key} left the typed list: ${typed}`);
    }
  });

  test('the daemon detail dict is a subset of the typed authority, A2A gone', () => {
    assert.ok(detailKeys.length >= 4, detailKeys);
    assert.ok(!detailKeys.includes('a2a'), `PG_ONLY_FEATURE_DETAIL still keys a2a: ${detailKeys}`);
    for (const key of detailKeys) {
      assert.ok(typed.includes(key),
        `PG_ONLY_FEATURE_DETAIL keys ${key}, which SQLiteStore.PG_ONLY_FEATURES does not: `
        + 'a typed 503 for a feature the store does not call PG-only');
    }
  });

  test('the daemon features_off list covers the typed authority, A2A gone', () => {
    assert.ok(!featuresOff.includes('a2a'), `features_off still names a2a: ${featuresOff}`);
    for (const key of typed) {
      assert.ok(featuresOff.includes(key),
        `/health's features_off omits ${key}, which the store calls PG-only`);
    }
  });

  test('every doctor prose row maps to a typed feature, and none to a dead one', () => {
    const byProse = Object.fromEntries(
      Object.entries(PROSE_FOR_TYPED).map(([k, v]) => [v, k]));
    for (const row of doctorProse) {
      const key = byProse[row];
      assert.ok(key, `services/doctor.py reports "${row}", which maps to no typed feature. `
        + 'Either the mapping in PROSE_FOR_TYPED is missing it, or the row names something '
        + 'that is not PG-only.');
      assert.ok(typed.includes(key),
        `services/doctor.py reports "${row}" (${key}), which the typed authority does not hold`);
    }
    assert.ok(!doctorProse.some((r) => /a2a/i.test(r)),
      `services/doctor.py still reports an A2A row: ${doctorProse}`);
    assert.ok(!doctorProse.some((r) => /blackboard/i.test(r)),
      'services/doctor.py reports the blackboard as PG-only, which is false: '
      + 'tests/test_89_05_inbox_round_trip.py round-trips it on SQLite');
  });

  test('STALE CHECK: the typed features doctor omits are declared, and still omitted', () => {
    const mapped = new Set(Object.keys(PROSE_FOR_TYPED));
    const omitted = typed.filter((k) => !mapped.has(k));
    assert.deepStrictEqual(omitted.sort(), Object.keys(NOT_IN_DOCTOR_PROSE).sort(),
      'the set of typed features doctor does not report changed; update '
      + 'NOT_IN_DOCTOR_PROSE (with the reason) or PROSE_FOR_TYPED');
    for (const [key, why] of Object.entries(NOT_IN_DOCTOR_PROSE)) {
      assert.ok(why.length > 30, `${key}: NOT_IN_DOCTOR_PROSE needs a reason`);
      assert.ok(!(key in PROSE_FOR_TYPED),
        `${key} is both mapped and declared unmapped — remove it from NOT_IN_DOCTOR_PROSE`);
    }
  });

  test('the installer list equals doctor\'s, modulo the PENDING_89_11 allowance', () => {
    // bin/init.cjs is READ ONLY here: it is canary-pinned and handed to 89-11.
    // The prose differs by whitespace around the slash ("vector / semantic" vs
    // "vector/semantic"), which is a wording difference, not a feature
    // difference, so the comparison normalises it and the record says so.
    const norm = (s) => s.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
    const doctorSet = new Set(doctorProse.map(norm));
    const extra = initProse.filter((r) => !doctorSet.has(norm(r)));
    const allowed = new Set(PENDING_89_11.map(norm));
    const unexpected = extra.filter((r) => !allowed.has(norm(r)));
    assert.deepStrictEqual(unexpected, [],
      'bin/init.cjs reports a PG-only feature services/doctor.py does not, and it is not '
      + `in the PENDING_89_11 allowance: ${unexpected.join(', ')}`);
    const missing = doctorProse.filter(
      (r) => !initProse.map(norm).includes(norm(r)));
    assert.deepStrictEqual(missing, [],
      `bin/init.cjs omits a row services/doctor.py reports: ${missing.join(', ')}`);
  });

  test('STALE CHECK: PENDING_89_11 fails once plan 89-11 has done the work', () => {
    const norm = (s) => s.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
    const initNorm = initProse.map(norm);
    const gone = PENDING_89_11.filter((r) => !initNorm.includes(norm(r)));
    assert.deepStrictEqual(gone, [],
      'bin/init.cjs no longer carries ' + gone.join(', ') + ' — plan 89-11 has removed it, '
      + 'so delete it from PENDING_89_11 in this file. An allowance that outlives its '
      + 'reason is how a list starts disagreeing again.');
    assert.ok(PENDING_89_11.length === 2,
      `PENDING_89_11 must hold exactly the two rows 89-11 owns, holds ${PENDING_89_11.length}`);
  });
});

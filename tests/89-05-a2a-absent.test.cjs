/**
 * Phase 89 plan 89-05 (ORC-02): the bespoke A2A surface is gone, and the four
 * PG-only feature lists agree about what the SQLite backend cannot do.
 *
 * Two halves:
 *
 *   1. THE ABSENCE PROOF, over the TRACKED tree. `git ls-files` is what makes
 *      the untracked `data/` and `backups/` irrelevant: `data/tasks.json`,
 *      `data/migration-drift-report-2026-07-03.md` and
 *      `backups/pg_dump_20260324_175819.sql` all contain the string `a2a`, so an
 *      absence grep over the WORKING tree can never reach zero. Every exclusion
 *      is a named constant with its owning phase, and every exclusion carries a
 *      STALE CHECK: when the token disappears from an excluded path, this test
 *      fails until the exclusion is removed. Without that, an exclusion outlives
 *      its reason — the whole lesson of the Phase 88 ratchets.
 *
 *   2. THE FOUR-LIST AGREEMENT. `services/sqlite_store.py`
 *      `SQLiteStore.PG_ONLY_FEATURES` (typed), `services/amauta-daemon.py`
 *      `PG_ONLY_FEATURE_DETAIL` (typed) and its `features_off` list,
 *      `services/doctor.py` `PG_ONLY_FEATURES` (prose) and `bin/init.cjs`
 *      `PG_ONLY_FEATURES` (prose) used three vocabularies, which is how they
 *      could disagree unnoticed about a whole feature. The mapping between typed
 *      and prose is explicit here, and the installer's two stale rows are a
 *      documented PENDING_89_11 allowance with its own stale check — no skip
 *      entry, the Phase 88 ratchet shape.
 *
 * Task 89-05-03 shipped half 2; task 89-05-06 added half 1, once the eight
 * tests/test_a2a_*.py files had been deleted with the feature.
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
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// ═════════════════════════════════════════════════════════════════════════════
// 1. The absence proof
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The tokens that must not survive anywhere outside a named exclusion.
 *
 * Deliberately NOT the bare string `a2a`: `HISTORY.md` records the v3.3
 * milestone that shipped the protocol (history is not rewritten), the README's
 * own removal sentence names it, and the pinned ParadeDB image digest
 * `sha256:21518b4005ad4111bdd41a6687ef37ca2abc363d7af30e700900ad6b8cb33e1e`
 * contains `a2a` in `...ca2abc...` — in `.github/workflows/test.yml` and
 * `docker/docker-compose.yml`. These are the tokens that name CODE.
 */
const FORBIDDEN = [
  'a2a_client',
  'a2a_breaker',
  'a2a_registry',
  '/a2a/exchanges',
  "case 'a2a'",
];

/**
 * One exclusion: a tracked path that may still carry a forbidden token, the
 * phase that owns removing it, and why it is not removed here.
 *
 * `tokens` is what the path is allowed to carry. The stale check asserts each
 * listed token is STILL THERE: when it goes, the exclusion must go with it —
 * `permanent` ones included, because a record that stops recording is just
 * stale.
 *
 * `routed: true` marks OWED WORK: a live reference another phase removes. There
 * are exactly four, and the test asserts that count, so an exclusion cannot
 * quietly change class from "a record of the removal" to "a reference nobody
 * owns". Everything else is a file whose JOB is to name the removal: the
 * migration pair that drops the table, the two tests that assert the absence,
 * the removal statements in README and CONTRIBUTING, and three records (the
 * Phase 88 file manifest, the declared skip delta, the entry-point census).
 */
const EXCLUSIONS = [
  {
    file: 'bin/init.cjs',
    tokens: ['A2A exchange log'],
    owner: 'plan 89-11',
    routed: true,
    why: "the 'A2A exchange log' row of PG_ONLY_FEATURES. bin/init.cjs is pinned by a "
      + 'whole-file git diff in party-canary.test.cjs and party-decisions-canary.test.cjs, '
      + 'and decision D8 puts every Phase 89 edit to it in ONE plan so the four canaries '
      + 'move once. Plan 89-11 removes the row and this exclusion together.',
  },
  {
    file: 'agents/gsd-auditor-api-connections.md',
    tokens: ['a2a_client'],
    owner: 'Phase 97',
    routed: true,
    why: 'a file-pattern example naming the deleted module. agents/ is byte-pinned by '
      + 'party-canary (directory-level diff), phase-53-canary group F and the agent '
      + 'byte-match test, so a one-word edit costs three re-baselines and a recompile. '
      + 'Phase 97 (Agent Management) owns agents/ churn.',
  },
  {
    file: 'get-shit-done/agents/gsd-auditor-api-connections/AGENT.yaml',
    tokens: ['a2a_client'],
    owner: 'Phase 97',
    routed: true,
    why: 'the COMPILED SOURCE of the line above — the agent definition is generated from '
      + 'it, so editing one without the other makes the byte-match test red. Same owner, '
      + 'same reason.',
  },
  {
    file: 'tests/89-03-sharded-step-capabilities.test.cjs',
    tokens: ['a2a_client'],
    owner: 'Phase 97',
    routed: true,
    why: 'a VERBATIM QUOTE of agents/gsd-auditor-api-connections.md:35, used as the '
      + 'measured evidence for plan 89-03\'s classification of the circuit-breaker token. '
      + 'Editing the quote would falsify the evidence; it changes when the quoted line '
      + 'changes, which is Phase 97\'s.',
  },
  {
    file: 'migrations/024-a2a-messages.sql',
    tokens: ['a2a_messages'],
    owner: 'nobody: deliberately permanent',
    why: 'an APPLIED migration is never deleted — removing one breaks schema_migrations '
      + 'reconciliation and detect_applied_by_schema. Migration 032 drops the table '
      + 'instead. This exclusion has no exit.',
    permanent: true,
  },
  {
    file: 'migrations/024-a2a-messages-DOWN.sql',
    tokens: ['a2a_messages'],
    owner: 'nobody: deliberately permanent',
    why: 'the DOWN of the migration above, kept for the same reason.',
    permanent: true,
  },
  {
    file: 'migrations/032-drop-a2a-messages.sql',
    tokens: ['a2a_messages'],
    owner: 'nobody: deliberately permanent',
    why: 'the migration that performs the drop must name the table it drops.',
    permanent: true,
  },
  {
    file: 'migrations/032-drop-a2a-messages-DOWN.sql',
    tokens: ['a2a_messages'],
    owner: 'nobody: deliberately permanent',
    why: "the DOWN recreates the table with 024's exact DDL, so it names it too.",
    permanent: true,
  },
  {
    file: 'README.md',
    tokens: ['/a2a/exchanges'],
    owner: 'nobody: deliberately permanent',
    why: 'the removal sentence itself. Criterion 5 is that the README SAYS the removal '
      + 'happened, which means naming what was removed.',
    permanent: true,
  },
  {
    file: 'tests/89-05-a2a-absent.test.cjs',
    tokens: FORBIDDEN,
    owner: 'nobody: deliberately permanent',
    why: 'this file is the absence test; it must spell the tokens it forbids.',
    permanent: true,
  },
  {
    file: 'CONTRIBUTING.md',
    tokens: ['/a2a/exchanges'],
    owner: 'nobody: deliberately permanent',
    why: "the removal statement in CONTRIBUTING's agent-communication section, which "
      + 'exists so a contributor looking for the protocol is told what happened to it '
      + 'and what to use instead.',
    permanent: true,
  },
  {
    file: 'tests/docs-update-truth.test.cjs',
    tokens: ['a2a_client', 'a2a_breaker', 'a2a_registry'],
    owner: 'nobody: deliberately permanent',
    why: 'the doc-truth test asserts the four modules do not exist, so it names all '
      + 'four. A test that proves an absence has to spell what is absent.',
    permanent: true,
  },
  {
    file: 'tests/test_sqlite_first_class_daemon.py',
    tokens: ['/a2a/exchanges'],
    owner: 'nobody: deliberately permanent',
    why: 'its inverted test REQUESTS the removed route and asserts the daemon answers '
      + '404, never a 500 from a half-removed handler or a 503 suggesting PostgreSQL '
      + 'would serve it.',
    permanent: true,
  },
  {
    file: 'tests/88-18-file-manifest.json',
    tokens: ['tests/test_a2a_client.py', 'tests/test_a2a_registry.py'],
    owner: 'nobody: deliberately permanent',
    why: "task 88-18-03's entry names four of the deleted test files, and they stay: "
      + 'the per-task gate judges the Phase 88 commits still reachable on every branch, '
      + 'so removing a name makes commit b1d4a491 a retroactive violation. '
      + '`deleted_since` records the deletion and exempts them from the existence '
      + 'check only.',
    permanent: true,
  },
  {
    file: 'tests/skip-exceptions.d/delta/89-05.json',
    tokens: ['tests/test_a2a_client.py'],
    owner: 'nobody: deliberately permanent',
    why: "this plan's declared skip delta records the 26 removed entries as full "
      + 'nine-field tuples, which name the deleted test files. Deleting the record '
      + 'would make tests/89-09-skip-shards.test.cjs report the removal as an '
      + 'undeclared loss.',
    permanent: true,
  },
  {
    file: 'tests/test_88_13_console_encoding.py',
    tokens: ['a2a_registry_cli.py'],
    owner: 'nobody: deliberately permanent',
    why: 'the entry-point census comment names the entry point this plan deleted — the '
      + 'audit trail for taking that count from 18 to 17.',
    permanent: true,
  },
];

/** How many exclusions are OWED WORK rather than a record of the removal. */
const ROUTED_EXCLUSIONS = 4;

/** @returns {string[]} every tracked file, repo-relative, with forward slashes. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
}

/** Paths the absence walk never reads: generated, binary, or the orchestrator's own. */
function isSkippedPath(rel) {
  return rel.startsWith('.planning/')      // orchestrator-owned history and plans
    || rel === 'HISTORY.md'                // the changelog records what shipped
    || rel === 'package-lock.json'
    || /\.(png|jpg|jpeg|gif|ico|pdf|zip|gz|woff2?)$/i.test(rel);
}

describe('89-05 the A2A code surface is absent from the tracked tree', () => {
  const files = trackedFiles();
  const excluded = new Map(EXCLUSIONS.map((e) => [e.file, e]));

  test('git ls-files is the walk, and it found a real tree', () => {
    assert.ok(files.length > 200, `git ls-files returned ${files.length} paths`);
    assert.ok(files.includes('services/amauta-daemon.py'));
  });

  test('the four modules, the CLI surfaces and the endpoint are gone', () => {
    for (const rel of [
      'services/a2a_client.py',
      'services/a2a_breaker.py',
      'services/a2a_registry.py',
      'services/a2a_registry_cli.py',
    ]) {
      assert.ok(!fs.existsSync(path.join(ROOT, rel)), `${rel} still exists`);
      assert.ok(!files.includes(rel), `${rel} is still tracked`);
    }
    assert.ok(!/a2a/i.test(read('bin/cli.cjs')), 'bin/cli.cjs still names a2a');
    assert.ok(!/a2a/i.test(read('get-shit-done/bin/gsd-tools.cjs')),
      'gsd-tools.cjs still names a2a');
    assert.ok(!read('services/amauta-daemon.py').includes('/a2a/exchanges'),
      'the exchange endpoint survives in the daemon');
    for (const rel of files) {
      assert.ok(!/^tests\/test_a2a_/.test(rel), `${rel} is still tracked`);
    }
  });

  test('no FORBIDDEN token survives outside a named exclusion', () => {
    const hits = [];
    for (const rel of files) {
      if (isSkippedPath(rel)) continue;
      const abs = path.join(ROOT, rel);
      let text;
      try {
        text = fs.readFileSync(abs, 'utf-8');
      } catch (_e) {
        continue; // a path git tracks but this checkout does not materialise
      }
      const found = FORBIDDEN.filter((t) => text.includes(t));
      if (found.length === 0) continue;
      const exclusion = excluded.get(rel);
      if (exclusion) {
        // An exclusion token covers a forbidden token when either contains the
        // other: `tests/test_a2a_client.py` covers `a2a_client`, and
        // `a2a_client` covers itself. An exclusion for ONE token does not
        // silently cover a different one appearing later in the same file.
        const covered = (t) => exclusion.tokens.some(
          (ok) => ok.includes(t) || t.includes(ok));
        const unexpected = found.filter((t) => !covered(t));
        if (unexpected.length) {
          hits.push(`${rel}: ${unexpected.join(', ')} (not covered by its exclusion)`);
        }
        continue;
      }
      hits.push(`${rel}: ${found.join(', ')}`);
    }
    assert.deepStrictEqual(hits, [],
      'a forbidden A2A token survives in the tracked tree:\n' + hits.join('\n'));
  });

  test('every exclusion names its owning phase and its reason', () => {
    for (const e of EXCLUSIONS) {
      assert.ok(e.owner && e.owner.length > 3, `${e.file}: no owner`);
      assert.ok(e.why && e.why.length > 40, `${e.file}: no reason`);
      assert.ok(Array.isArray(e.tokens) && e.tokens.length, `${e.file}: no tokens`);
      assert.ok(e.routed === true || e.permanent === true,
        `${e.file}: an exclusion is either OWED WORK (routed) or a record of the `
        + 'removal (permanent); it cannot be neither');
      assert.ok(!(e.routed && e.permanent), `${e.file}: it cannot be both`);
      if (e.routed) {
        assert.ok(!/^nobody/.test(e.owner),
          `${e.file}: a routed exclusion needs a real owner, got ${e.owner}`);
      }
    }
    const routed = EXCLUSIONS.filter((e) => e.routed);
    assert.strictEqual(routed.length, ROUTED_EXCLUSIONS,
      'the number of A2A references this plan does NOT remove changed: '
      + `${routed.map((e) => e.file).join(', ')}. Adding one means a reference nobody `
      + 'owns; removing one means its phase did the work and the exclusion must go.');
    // The two routed hand-overs are named, by the plan's own requirement.
    const owners = EXCLUSIONS.map((e) => e.owner).join(' | ');
    assert.match(owners, /89-11/, 'bin/init.cjs must be routed to plan 89-11');
    assert.match(owners, /Phase 97/, 'agents/ must be routed to Phase 97');
  });

  test('STALE CHECK: an exclusion whose token is gone is itself a failure', () => {
    const stale = [];
    for (const e of EXCLUSIONS) {
      const abs = path.join(ROOT, e.file);
      if (!fs.existsSync(abs)) {
        stale.push(`${e.file} no longer exists: remove its exclusion (owner: ${e.owner})`);
        continue;
      }
      const text = fs.readFileSync(abs, 'utf-8');
      for (const token of e.tokens) {
        if (!text.includes(token)) {
          stale.push(
            `${e.file} no longer contains ${JSON.stringify(token)}: ${e.owner} has done the `
            + 'work, so delete this exclusion from EXCLUSIONS'
          );
        }
      }
    }
    assert.deepStrictEqual(stale, [],
      'an exclusion outlived its reason:\n' + stale.join('\n'));
  });

  test('the two handed-over paths are NOT in this PR\'s diff', () => {
    // Measured against the merge base with origin/master, which is what the
    // plan's own acceptance greps. Silent when there is no such ref (a shallow
    // or detached checkout), because then there is nothing to compare against.
    let base;
    try {
      base = execFileSync('git', ['merge-base', 'origin/master', 'HEAD'],
        { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (_e) {
      return;
    }
    const changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`],
      { cwd: ROOT, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n').filter(Boolean);
    assert.ok(!changed.includes('bin/init.cjs'),
      'bin/init.cjs is pinned and handed to plan 89-11 (decision D8)');
    assert.deepStrictEqual(changed.filter((f) => f.startsWith('agents/')), [],
      'agents/ is byte-pinned by three canaries and routed to Phase 97');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The four PG-only feature lists
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

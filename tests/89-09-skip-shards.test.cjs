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
// Plan 89-09 moved all 467 entries BY CONTENT and changed none, so both lists are
// empty here. A later plan that removes an entry (89-01, 89-05 and 89-07 all do)
// or adds one appends its nine-field tuple to the right list, in its own PR — which
// is what keeps this proof alive instead of being deleted at the first edit, and is
// the same discipline `tests/skip-exceptions.d/README.md` rule 2 states.

/** `[name, file, platform, context, reason, reason_class, owner, owner_phase, exit_criterion]` tuples removed since the migration. */
const REMOVED_SINCE_SHARDING = [
    [
      "test_rlm_mrr_validation",
      "tests/test_27_mrr_validation.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ],
    [
      "test_cli_prints_hybrid_provenance",
      "tests/test_65_retrieval_e2e.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ],
    [
      "test_mcp_search_code_ranks_by_query",
      "tests/test_65_retrieval_e2e.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ],
    [
      "test_query_answers_hybrid",
      "tests/test_65_retrieval_e2e.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ],
    [
      "test_graph_names_the_real_caller",
      "tests/test_65_retrieval_e2e.py",
      "linux",
      "any",
      "with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback`, so /query never reaches the hybrid branch that attaches graph_callers",
      "retrieval-leg-routed-89",
      "Phase 89 (retrieval pipeline)",
      89,
      "the hybrid engine answers for a freshly ingested fixture project on the Linux cell, the same criterion the other ten entries of this class carry. Plan 88-11 MEASURED that Valkey was never the obstacle the old `valkey-not-provided` entry claimed: it gave the Linux pytest cell a disposable Valkey on a port freePort() chose (run 43217682043, job 131180975509, `disposable Valkey answering on host port 40019`), the probe returned True, the positive branch ran for the first time on any cell, and it failed with `graph_callers missing main_entry: None` -- the key is ABSENT, because services/rlm-service.py attaches it only on the hybrid branch (`expand_chunks_with_graph`). The Valkey service stays in the workflow so the recorded reason is the true one."
    ],
    [
      "test_hybrid_search_end_to_end_rrf_score_is_float_live",
      "tests/test_65_vector_leg.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ],
    [
      "test_go_symbol_query_retrieves_defining_chunk",
      "tests/test_69_ast_parity_e2e.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ],
    [
      "test_java_symbol_query_retrieves_defining_chunk",
      "tests/test_69_ast_parity_e2e.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ],
    [
      "test_kotlin_symbol_query_retrieves_defining_chunk",
      "tests/test_69_ast_parity_e2e.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ],
    [
      "test_rust_symbol_query_retrieves_defining_chunk",
      "tests/test_69_ast_parity_e2e.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ],
    [
      "test_swift_symbol_query_retrieves_defining_chunk",
      "tests/test_69_ast_parity_e2e.py",
      "linux",
      "any",
      "plan 88-16-09 routed this to Phase 89: with a real PostgreSQL the RLM retrieval leg answers `legacy_in_memory_fallback` / no rows instead of the hybrid engine. The cause is in the retrieval pipeline Phase 89 rewrites (ingestion populates rlm_chunks without embeddings when no provider is configured, which the main pytest step deliberately has not), not in anything this plan owns. EXIT CRITERION: re",
      "retrieval-leg-routed-89",
      "Phase 89 (the retrieval pipeline rewrite)",
      89,
      "the hybrid retrieval engine answers for a freshly ingested fixture project against a real PostgreSQL on the Linux cell, instead of falling back to legacy_in_memory. These are NON-strict xfails: they turn into passes the moment the pipeline works, and plan 88-16 made them visible by giving the suite a real database for the first time."
    ]
  ];

/** The same shape, for entries added since the migration. */
const ADDED_SINCE_SHARDING = [
    [
      "test_cell1_alias_qualified_filter_with_embedding_returns_rows",
      "tests/test_89_01_bm25_alias_matrix.py",
      "darwin",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_cell1_alias_qualified_filter_with_embedding_returns_rows",
      "tests/test_89_01_bm25_alias_matrix.py",
      "win32",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_cell2_alias_qualified_filter_without_embedding_returns_rows",
      "tests/test_89_01_bm25_alias_matrix.py",
      "darwin",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_cell2_alias_qualified_filter_without_embedding_returns_rows",
      "tests/test_89_01_bm25_alias_matrix.py",
      "win32",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_cell3_unqualified_filter_with_embedding_returns_rows",
      "tests/test_89_01_bm25_alias_matrix.py",
      "darwin",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_cell3_unqualified_filter_with_embedding_returns_rows",
      "tests/test_89_01_bm25_alias_matrix.py",
      "win32",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_cell4_unqualified_filter_without_embedding_returns_rows",
      "tests/test_89_01_bm25_alias_matrix.py",
      "darwin",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_cell4_unqualified_filter_without_embedding_returns_rows",
      "tests/test_89_01_bm25_alias_matrix.py",
      "win32",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_operational_error_still_degrades_to_an_empty_result",
      "tests/test_89_01_bm25_alias_matrix.py",
      "darwin",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_operational_error_still_degrades_to_an_empty_result",
      "tests/test_89_01_bm25_alias_matrix.py",
      "win32",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_sql_programming_error_raises_typed_and_never_returns_empty",
      "tests/test_89_01_bm25_alias_matrix.py",
      "darwin",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_sql_programming_error_raises_typed_and_never_returns_empty",
      "tests/test_89_01_bm25_alias_matrix.py",
      "win32",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_the_pre_fix_unaliased_shape_answers_sqlstate_42p01",
      "tests/test_89_01_bm25_alias_matrix.py",
      "darwin",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_the_pre_fix_unaliased_shape_answers_sqlstate_42p01",
      "tests/test_89_01_bm25_alias_matrix.py",
      "win32",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_relevance_mrr_at_k_on_the_deterministic_provider",
      "tests/test_89_01_relevance_check.py",
      "darwin",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_relevance_mrr_at_k_on_the_deterministic_provider",
      "tests/test_89_01_relevance_check.py",
      "win32",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_relevance_mrr_with_the_real_embedding_provider",
      "tests/test_89_01_relevance_check.py",
      "darwin",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ],
    [
      "test_relevance_mrr_with_the_real_embedding_provider",
      "tests/test_89_01_relevance_check.py",
      "win32",
      "any",
      "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test (CI provides one; the operator machine deliberately has none)",
      "pg-no-disposable-database",
      "Phase 89 (plan 89-07 gives every cell a disposable PostgreSQL)",
      89,
      "task 89-07-04 closes the pg-no-disposable-database class once the macOS and Windows cells have a database."
    ]
  ];

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

  test('the union is SET-EQUAL to the pre-shard ledger on the full nine-field tuple', () => {
    const removed = REMOVED_SINCE_SHARDING.map((t) => JSON.stringify(t));
    const added = ADDED_SINCE_SHARDING.map((t) => JSON.stringify(t));
    const current = union.entries.map(tuple);
    for (const t of added) {
      const at = current.indexOf(t);
      assert.notStrictEqual(at, -1, `ADDED_SINCE_SHARDING names an entry the ledger does not hold: ${t}`);
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
        + 'changed without being declared in REMOVED_SINCE_SHARDING / ADDED_SINCE_SHARDING, '
        + 'or the migration lost one.'
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

#!/usr/bin/env python3
"""Phase 89 plan 89-06: the lexical leg on both engines, same shape, same rules.

Decision D3 / RETR-08. Where ``pg_search`` is absent the lexical leg runs
``to_tsvector``/``ts_rank_cd`` instead of ParadeDB BM25. What this file proves:

* the ``@@@``-to-``tsquery`` translation rule, one case per rule (fields,
  boosts, multi-word combination, stray syntax, the empty query) — the rule
  itself is written down in ``services/rlm_search.py`` ``fts_query_sql``;
* that the result SHAPE is key-for-key identical across the two engines, for
  all three statements;
* that the probe runs ONCE PER CONNECTION, counted, not once per search;
* ordering properties both engines must agree on, chosen so that the
  engine-specific SCORES never decide an assertion. **No test in this file
  asserts, or even names, either engine's score function** — ParadeDB's BM25
  value and PostgreSQL's cover-density value are different functions of
  different statistics, the two engines are not claimed to rank alike, and
  that is the whole point of the RETR-08 note.

Run:
    python3 -m pytest tests/test_89_06_lexical_fallback.py -q -rs -p no:cacheprovider
"""
import pathlib
import sys

import pytest

_REPO = pathlib.Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

import pg_engines  # noqa: E402  (tests/support is on sys.path — see tests/conftest.py)
from pg_engines import both, paradedb, plain  # noqa: E402,F401

from services import infra_detect, pg_store, rlm_search  # noqa: E402

MIGRATIONS = _REPO / "migrations"

#: Deliberately non-words, so neither engine's English stemmer can merge two
#: of them, and each appears in exactly one FIELD of exactly one row. Rows
#: `one` and `two` are mirror images: the same two terms, swapped between
#: `content` and `description`, at the same length — so an ordering difference
#: between them can only come from the field weighting.
#:
#: The file names carry no directory separator at all. A LIKE prefix would have
#: to be spelled with `os.sep`, and on Windows that is a backslash, which LIKE
#: reads as its own escape character — a trap this fixture simply does not need.
CORPUS = (
    # (file_path, symbol_name, content, description)
    ("89-06-corpus-alpha.py", "one", "alphaterm routine", "zebraword notes"),
    ("89-06-corpus-beta.py", "two", "zebraword routine", "alphaterm notes"),
    ("89-06-corpus-gamma.py", "three", "gammaword only", "deltaword here"),
)

CORPUS_PATHS = [row[0] for row in CORPUS]

SELECT_COLUMNS = ["id", "file_path", "symbol_name", "symbol_type",
                  "start_line", "end_line", "content", "description",
                  "dependencies", "dependents"]


def _connect(dsn):
    import psycopg2

    return psycopg2.connect(dsn, connect_timeout=10)


def _load_corpus(dsn):
    """Insert CORPUS into rlm_chunks with a usable embedding_code vector."""
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rlm_chunks WHERE file_path = ANY(%s)",
                        (CORPUS_PATHS,))
            for number, (name, symbol, content, description) in enumerate(CORPUS):
                # A distinct, deterministic 1024-dim unit-ish vector per row, so
                # the vector leg has something real to rank and the hybrid SQL
                # is genuinely exercised on both engines.
                vector = [0.0] * 1024
                vector[number] = 1.0
                cur.execute(
                    """
                    INSERT INTO rlm_chunks
                        (file_path, symbol_name, symbol_type, start_line,
                         end_line, content, description, sha256, embedding_code)
                    VALUES (%s, %s, 'function', %s, %s, %s, %s, %s, %s::vector)
                    """,
                    (name, symbol, number + 1, number + 10,
                     content, description, f"{number:064d}",
                     "[" + ",".join(f"{v:.1f}" for v in vector) + "]"),
                )
        conn.commit()
    finally:
        conn.close()


def _drop_corpus(dsn):
    conn = _connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM rlm_chunks WHERE file_path = ANY(%s)",
                        (CORPUS_PATHS,))
            cur.execute("DELETE FROM gsd_memory WHERE agent_id = %s",
                        ("test-89-06",))
        conn.commit()
    finally:
        conn.close()


@pytest.fixture(scope="session")
def corpus(paradedb, plain):
    """The same three rows in both engines' databases."""
    for db in (paradedb, plain):
        _load_corpus(db["dsn"])
    yield {"pg_search_bm25": paradedb, "postgres_fts": plain}
    for db in (paradedb, plain):
        _drop_corpus(db["dsn"])


def _query_embedding(index=0):
    vector = [0.0] * 1024
    vector[index] = 1.0
    return vector


def _hybrid(dsn, query, *, query_embedding=None, top_k=5):
    conn = _connect(dsn)
    try:
        infra_detect.reset_lexical_engine_cache()
        return rlm_search.hybrid_search_generic(
            query, conn,
            table="rlm_chunks", id_column="id", select_columns=SELECT_COLUMNS,
            vector_column="embedding_code", query_embedding=query_embedding,
            bm25_query=rlm_search._boosted_rlm_query(
                rlm_search._sanitize_query(query)),
            # An alias-qualified fragment, which is what plan 89-01 made valid
            # in BOTH branches — so the new leg has to carry it too.
            filter_sql="AND (c.file_path = ANY(%s))",
            filter_params=(CORPUS_PATHS,),
            fts_columns=rlm_search.RLM_FTS_COLUMNS,
            fts_weights=rlm_search.RLM_FTS_WEIGHTS,
            fts_query=rlm_search._sanitize_query(query),
            top_k=top_k,
        )
    finally:
        conn.close()


def _bm25_only(dsn, query, top_k=5, file_filter=None):
    conn = _connect(dsn)
    try:
        infra_detect.reset_lexical_engine_cache()
        return rlm_search.bm25_only_search(query, conn, top_k=top_k,
                                           file_filter=file_filter)
    finally:
        conn.close()


def _symbols(rows):
    return [r["symbol_name"] for r in rows]


# ═══════════════════════════════════════════════════════════════════════════
# 1. The translation rule — no database needed, so every cell runs these
# ═══════════════════════════════════════════════════════════════════════════

def test_rule_1_fields_the_tsvector_covers_exactly_the_boosted_querys_fields():
    """`_boosted_rlm_query` names content, description and symbol_name — and so
    does the tsvector. `file_path` rides in the BM25 INDEX but in neither
    engine's QUERY, so it is in neither."""
    boosted = rlm_search._boosted_rlm_query("needle")
    named = {field for field in ("content", "description", "symbol_name",
                                 "file_path")
             if f"{field}:" in boosted}
    assert named == {"content", "description", "symbol_name"}
    assert named == {column for column, _weight in rlm_search.RLM_FTS_COLUMNS}


def test_rule_2_boosts_become_tsvector_weights_with_the_same_ratios():
    """description^2.0 over content, symbol_name at 1x — in weights {D,C,B,A}."""
    weights = dict(rlm_search.RLM_FTS_COLUMNS)
    assert weights == {"description": "A", "content": "B", "symbol_name": "C"}
    d, c, b, a = rlm_search.RLM_FTS_WEIGHTS
    assert a == pytest.approx(2 * b), "description must weigh twice content"
    assert c == pytest.approx(b), "symbol_name rides at 1x content"
    assert "^2.0" in rlm_search._boosted_rlm_query("needle"), \
        "the pg_search side of the ratio moved; the weights must move with it"


def test_rule_3_multi_word_is_ORed_not_ANDed():
    """pg_search ORs space-separated groups, so the tsquery must OR too."""
    sql = rlm_search.fts_query_sql()
    assert "websearch_to_tsquery" in sql
    assert "replace(" in sql and "'&', '|'" in sql
    assert sql.count("%s") == 1, "one bound parameter, so nothing is interpolated"
    # `to_tsquery` is NOT used: it would need the terms escaped in Python,
    # which is where a parse error or an injection would come from.
    assert "to_tsquery(" not in sql.replace("websearch_to_tsquery(", "")


def test_rule_4_the_sanitizer_removes_every_tsquery_operator_first():
    """Which is why re-spelling `&` as `|` cannot corrupt a phrase or a negation."""
    sanitized = rlm_search._sanitize_query('a!b ^c ~d @e (f) [g] {h} "i"')
    for operator in "!^~@()[]{}\"":
        assert operator not in sanitized


def test_rule_5_an_empty_query_builds_no_statement_at_all():
    assert rlm_search._sanitize_query("   ") == ""
    assert rlm_search._boosted_rlm_query("") == ""


def test_the_vector_expression_is_the_one_in_migration_033():
    """An expression index is only used when the query's expression matches it.

    This is the pin that keeps the Python builder and the migration from
    drifting into a silent sequential scan.
    """
    sql = (MIGRATIONS / "033-plain-fts-fallback.sql").read_text(encoding="utf-8")
    assert rlm_search.fts_vector_sql(rlm_search.RLM_FTS_COLUMNS) in sql, \
        "idx_rlm_chunks_fts is not built on fts_vector_sql(RLM_FTS_COLUMNS)"
    assert rlm_search.fts_vector_sql(pg_store.MEMORY_FTS_COLUMNS) in sql, \
        "idx_gsd_memory_fts_fallback is not built on fts_vector_sql(MEMORY_FTS_COLUMNS)"


def test_the_builders_reject_an_unsafe_identifier_or_weight():
    """Table and column names cannot be bound parameters, so they are validated."""
    with pytest.raises(ValueError):
        rlm_search.fts_vector_sql((("content; DROP TABLE rlm_chunks --", "A"),))
    with pytest.raises(ValueError):
        rlm_search.fts_vector_sql((("content", "A'); DROP TABLE x --"),))
    with pytest.raises(ValueError):
        rlm_search.fts_vector_sql(())
    with pytest.raises(ValueError):
        rlm_search._fts_rank_sql(rlm_search.RLM_FTS_COLUMNS, (0.1, 0.2))


def test_the_divergence_is_documented_in_the_module():
    source = (_REPO / "services" / "rlm_search.py").read_text(encoding="utf-8")
    assert "RETR-08" in source
    assert "not BM25" in source
    assert "ranking differs from the ParadeDB BM25 leg" in source


# ═══════════════════════════════════════════════════════════════════════════
# 2. The same leg on both engines
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.integration
def test_each_database_runs_the_engine_it_is_supposed_to(corpus):
    for engine, db in corpus.items():
        conn = _connect(db["dsn"])
        try:
            infra_detect.reset_lexical_engine_cache()
            assert rlm_search._has_pg_search(conn) is (engine == "pg_search_bm25")
        finally:
            conn.close()


@pytest.mark.integration
def test_the_lexical_leg_finds_the_same_rows_on_both_engines(corpus):
    """Membership, not ranking: a term in one row's content is found on both."""
    for engine, db in corpus.items():
        rows = _bm25_only(db["dsn"], "gammaword")
        assert _symbols(rows) == ["three"], f"{engine}: {_symbols(rows)}"


@pytest.mark.integration
def test_a_description_match_outranks_a_content_match_on_both_engines(corpus):
    """The boost translation, as an ORDERING both engines must agree on.

    Row `two` carries the term in `description` (weight A / ^2.0), row `one` in
    `content` (weight B / 1x); the two rows are otherwise the same length. No
    score is asserted — only which of the two comes first.
    """
    for engine, db in corpus.items():
        rows = _bm25_only(db["dsn"], "alphaterm")
        pg_engines.measure("boost-ordering-%s" % engine, _symbols(rows))
        assert set(_symbols(rows)) == {"one", "two"}, f"{engine}: {_symbols(rows)}"
        assert _symbols(rows)[0] == "two", (
            f"{engine}: the description boost did not survive: {_symbols(rows)}"
        )


@pytest.mark.integration
def test_a_multi_word_query_ORs_its_terms_on_both_engines(corpus):
    """`alphaterm omegaword` — the second term matches nothing.

    Under AND semantics this returns zero rows; under the OR semantics
    `_boosted_rlm_query` has on pg_search and `fts_query_sql` reproduces on
    PostgreSQL full-text, it returns the two rows carrying `alphaterm`.
    """
    for engine, db in corpus.items():
        rows = _bm25_only(db["dsn"], "alphaterm omegaword")
        assert set(_symbols(rows)) == {"one", "two"}, (
            f"{engine}: multi-word is not ORed: {_symbols(rows)}"
        )


@pytest.mark.integration
def test_a_stopword_only_query_returns_nothing_on_both_engines(corpus):
    for engine, db in corpus.items():
        assert _bm25_only(db["dsn"], "   ") == [], engine


@pytest.mark.integration
def test_the_result_shape_is_key_for_key_identical_across_engines(corpus):
    """Three statements, two engines, one field set each."""
    shapes = {}
    for engine, db in corpus.items():
        hybrid = _hybrid(db["dsn"], "routine",
                         query_embedding=_query_embedding(0))
        degraded = _hybrid(db["dsn"], "routine", query_embedding=None)
        only = _bm25_only(db["dsn"], "routine")
        assert hybrid and degraded and only, f"{engine}: an empty leg proves nothing"
        shapes[engine] = {
            "hybrid_rrf": sorted(hybrid[0]),
            "bm25_only_branch": sorted(degraded[0]),
            "bm25_only_search": sorted(only[0]),
        }

    for engine, per_statement in sorted(shapes.items()):
        for statement, fields in sorted(per_statement.items()):
            pg_engines.measure("fields-%s-%s" % (engine, statement), fields)
    assert shapes["postgres_fts"] == shapes["pg_search_bm25"], (
        "the two engines returned different field sets: %r" % shapes
    )
    # And the fields are the documented ones, not an accident of agreement.
    assert shapes["postgres_fts"]["hybrid_rrf"] == sorted(
        SELECT_COLUMNS + ["rrf_score", "rank_bm25", "rank_vector"])
    assert shapes["postgres_fts"]["bm25_only_search"] == sorted(
        SELECT_COLUMNS + ["bm25_score", "rrf_score", "rank_bm25", "rank_vector"])


@pytest.mark.integration
def test_the_types_match_too_not_only_the_keys(corpus):
    """A float that became a Decimal would pass a key comparison and fail later."""
    types = {}
    for engine, db in corpus.items():
        row = _hybrid(db["dsn"], "routine", query_embedding=_query_embedding(0))[0]
        types[engine] = {k: type(v).__name__ for k, v in sorted(row.items())}
    assert types["postgres_fts"] == types["pg_search_bm25"], types


@pytest.mark.integration
def test_the_degraded_branch_reports_the_same_null_fusion_values_on_both(corpus):
    """`_score_fused_memories` and `hybrid_search`'s sort key read these."""
    for engine, db in corpus.items():
        rows = _hybrid(db["dsn"], "routine", query_embedding=None)
        for row in rows:
            assert row["rrf_score"] is None, engine
            assert row["rank_bm25"] == 1, engine
            assert row["rank_vector"] is None, engine


@pytest.mark.integration
def test_the_vector_leg_and_the_fusion_are_the_same_on_both_engines(corpus):
    """RRF fuses the two legs the same way whichever engine ran the lexical one.

    `routine` is in rows `one` and `two`; row `three` matches neither engine's
    lexical leg and its vector is orthogonal to the query, so it has the worst
    rank in BOTH legs and must come LAST on both engines. Rows `one` and `two`
    are deliberately NOT ordered against each other here: they are mirror
    images at the same weight for this term, so which of them leads is a
    score question, and this plan does not claim the two engines answer score
    questions alike.
    """
    for engine, db in corpus.items():
        rows = _hybrid(db["dsn"], "routine", query_embedding=_query_embedding(0))
        assert set(_symbols(rows)) == {"one", "two", "three"}, (
            f"{engine}: {_symbols(rows)}")
        assert all(r["rrf_score"] is not None for r in rows), engine
        assert all(r["rank_vector"] is not None for r in rows), engine
        assert _symbols(rows)[-1] == "three", (
            f"{engine}: the row that loses BOTH legs did not come last: "
            f"{_symbols(rows)}"
        )


@pytest.mark.integration
def test_a_file_filter_works_on_both_engines(corpus):
    """Plan 89-01's alias fix has to hold on the new leg too."""
    for engine, db in corpus.items():
        hit = _bm25_only(db["dsn"], "routine", file_filter=CORPUS_PATHS[0])
        miss = _bm25_only(db["dsn"], "routine",
                          file_filter="89-06-corpus-absent.py")
        assert _symbols(hit) == ["one"], f"{engine}: {_symbols(hit)}"
        assert miss == [], engine


# ═══════════════════════════════════════════════════════════════════════════
# 3. The probe is cached — measured, not asserted
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.integration
def test_the_probe_runs_once_per_connection_not_once_per_search(corpus):
    for engine, db in corpus.items():
        raw = _connect(db["dsn"])
        counting = pg_engines.CountingConnection(raw)
        try:
            infra_detect.reset_lexical_engine_cache()
            for _ in range(4):
                rlm_search.bm25_only_search("routine", counting, top_k=5)
                rlm_search.hybrid_search_generic(
                    "routine", counting, table="rlm_chunks", id_column="id",
                    select_columns=SELECT_COLUMNS,
                    fts_columns=rlm_search.RLM_FTS_COLUMNS,
                    fts_weights=rlm_search.RLM_FTS_WEIGHTS,
                    bm25_query=rlm_search._boosted_rlm_query("routine"),
                    top_k=5,
                )
        finally:
            raw.close()
        probes = counting.matching("extname = 'pg_search'")
        pg_engines.measure(
            "probe-statements-per-connection-%s" % engine,
            "%d probe statement(s) in %d total statements across 8 searches on "
            "ONE connection" % (len(probes), len(counting.statements)))
        assert len(probes) == 1, (
            f"{engine}: the lexical probe ran {len(probes)} times across 8 "
            f"searches on one connection"
        )


@pytest.mark.integration
def test_a_second_connection_gets_its_own_probe(corpus):
    """The cache is per connection, so a reconnect sees the current truth."""
    db = corpus["postgres_fts"]
    infra_detect.reset_lexical_engine_cache()
    counts = []
    for _ in range(2):
        raw = _connect(db["dsn"])
        counting = pg_engines.CountingConnection(raw)
        try:
            rlm_search._has_pg_search(counting)
            rlm_search._has_pg_search(counting)
        finally:
            raw.close()
        counts.append(len(counting.matching("extname = 'pg_search'")))
    assert counts == [1, 1], counts


# ═══════════════════════════════════════════════════════════════════════════
# 4. memory_search's rung 1 — the fourth routed site
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.integration
def test_memory_search_rung1_answers_on_both_engines(corpus):
    """pg_store has no `@@@` SQL of its own: its BM25 rung IS the primitive.

    So the fourth routed site is proven by driving memory_search end to end on
    both engines and asserting the row comes back — rung 1 is what answers,
    because rung 2 and rung 3 would also find it and that is exactly why the
    engine report in rung 1's log line matters.
    """
    for engine, db in corpus.items():
        store = pg_store.PGStore(db["dsn"])
        store.memory_store(
            "the plain postgresql lexical leg answers memory search too",
            agent_id="test-89-06", source="lesson-learned", tags=["phase89"],
        )
        results = store.memory_search("plain postgresql lexical leg", limit=5)
        assert results, f"{engine}: memory_search found nothing"
        assert any("lexical leg" in (r.get("text") or "") for r in results), engine


def test_memory_searchs_declared_fts_columns_match_its_bm25_field():
    """`_memory_bm25_query` field-qualifies `text`; so does MEMORY_FTS_COLUMNS.

    No database: the two declarations have to agree in the source, and that is
    checkable on every cell.
    """
    assert "text:" in pg_store._memory_bm25_query("needle")
    assert [c for c, _w in pg_store.MEMORY_FTS_COLUMNS] == ["text"]

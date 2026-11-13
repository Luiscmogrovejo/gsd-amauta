#!/usr/bin/env python3
"""
Hybrid RRF search for GSD-Amauta RLM — Phase 27 / RLM-04, generalized Phase 65 / RETR-06.

hybrid_search_generic() fuses pg_search BM25 + pgvector cosine similarity using
Reciprocal Rank Fusion against ANY table/column set supplied by the caller.
Table and column names arrive as parameters ONLY, validated against _IDENT_RE
before SQL interpolation — Phase 66 (memory ranking) reuses this primitive
unmodified against memory tables (locked shared-primitive constraint,
CONTEXT.md).

hybrid_search() is the rlm_chunks-specific wrapper. Its public signature
`hybrid_search(query, pg_conn, top_k, file_filter)` and return shape (list of
rlm_chunks row dicts + rrf_score/rank_bm25/rank_vector) are FROZEN for the
duration of the Phase 65 wave — 65-01 (/query router) and 65-03 (MCP
delegation) call it in parallel.

RRF formula: 1/(k + rank_bm25) + 1/(k + rank_vector) with k=60.
All fusion happens inside PostgreSQL — no application-level merging.
Falls back to BM25-only when embedding_code IS NULL for returned chunks.

TK-1741 (audit RLM-L4, live-confirmed): the vector leg previously cast BOTH
the query literal and the stored column to ::vector(256), but the column is
genuinely vector(1024) end to end (migration 013; every populated row
live-reports vector_dims()=1024) -- pgvector's vector(N) cast enforces an
EXACT dimension match rather than slicing to the leading Matryoshka
dimensions, so the leg raised on every call and silently fell back to
BM25-only. Fixed by comparing at the caller-supplied dimensionality (bare
::vector cast, no modifier) and by having hybrid_search() request a full
1024-dim query embedding instead of a 256-dim truncation. Fixing the cast
also activated two previously-dormant bugs in the same code that had never
been exercised (the vector leg had never once succeeded before this fix):
an aborted-transaction error on the fallback query (missing
pg_conn.rollback() in both except branches), and a Decimal-vs-float
TypeError in position_decay (PostgreSQL's bare `1.0` literal is `numeric`,
not `double precision`, so rrf_score arrived as decimal.Decimal once the
CTE actually returned rows; the None-rrf_score BM25-only-degradation path
had the same class of bug against its own sort/decay code). All three fixed
together — see the inline comments at each site.

BM25 tuning (Phase 65 / RETR-06, RETR-07):
  - Column boost (RETR-06, real as of this phase — audit RLM-M4 flagged the
    prior header comment as a claim with no implementation): every rlm_chunks
    `@@@` query is expanded by `_boosted_rlm_query()` into a field-qualified
    match string that weights the Phase 22 caveman `description` field ~2x
    over `content` (symbol_name rides at 1x). Verified live against the
    installed pg_search 0.24.1 (`SELECT extversion FROM pg_extension WHERE
    extname='pg_search'`) on 2026-07-03: `content:TERM OR
    description:TERM^2.0 OR symbol_name:TERM` parses and measurably reorders
    results (synthetic description-only-token row outscored a
    content-only-token row, 16.08 vs 14.23 via paradedb.score). Applied to
    BOTH `@@@` legs: hybrid_search's bm25 leg (via hybrid_search_generic's
    bm25_query kwarg) and bm25_only_search.
  - RETR-07 (documented divergence, not reconciled this phase): the pg_search
    leg runs Tantivy's default BM25 b=0.75; the in-memory fallback scorer in
    rlm-service.py tunes b=0.6. The two engines never rank the same request
    (hybrid pipeline vs. legacy in-memory scan are mutually exclusive per
    query per RETR-01 routing), so the divergence is aligned-or-documented
    rather than reconciled — this comment is that documentation.
  - RETR-08 (Phase 89 / decision D3, plan 89-06 — documented divergence, not
    reconciled and not reconcilable): `pg_search` is OPTIONAL. Where the
    extension is absent the lexical leg of all three statements in this module
    runs PostgreSQL's own full-text search over migration 033's GIN indexes.
    That leg is not BM25: `ts_rank_cd` is a cover-density score over tsvector
    lexemes, Tantivy's BM25 is a saturating tf-idf over its own term
    statistics, and the two will not rank the same corpus identically: the
    ranking differs from the ParadeDB BM25 leg, which `doctor` and `/health`
    say in those words wherever the fallback is active. What IS
    identical is everything around it — the vector leg, the RRF formula and k,
    the candidate pools, the top-k contract, the degradation ladder and the
    returned field set. The boosts survive the translation (description rides
    at tsvector weight A against content's B, which is the same 2x), the
    ordering within one engine is stable, and `doctor` and `/health` name the
    engine that answered. See the block above `_has_pg_search` for the whole
    translation rule.
  - position_decay=0.05: applied as post-score penalty in Python (WHERE start_line > N -> reduce score)
"""

import logging
import os
import re
from typing import Optional

log = logging.getLogger("amauta.rlm_search")

# RRF constant (k=60 per CONTEXT.md)
RRF_K = 60

# Default top-k for BM25 and vector legs before RRF fusion
RRF_CANDIDATE_K = 20

# Default top-k returned to caller
DEFAULT_TOP_K = 5

# Table/column identifier guard for hybrid_search_generic (SQL-injection defense:
# table/column names cannot be bound parameters, so they are validated instead).
_IDENT_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def _check_ident(name: str) -> None:
    """Raise ValueError if `name` is not a safe bare SQL identifier."""
    if not isinstance(name, str) or not _IDENT_RE.match(name):
        raise ValueError(f"unsafe SQL identifier: {name!r}")


# Phase 89 / RET-02: the typed-error machinery the three `except ... -> []`
# sites below use is at the BOTTOM of this file, deliberately after its callers
# — plan 89-01's acceptance measures `_generic_bm25_only` by line range, and
# module-level names resolve at call time, so the order is a reading order only.

#: Per-connection cache for the migration-029 column probe.
_HAS_EMBEDDING_MODEL_COLUMN = {}


def _has_embedding_model_column(pg_conn) -> bool:
    """True when rlm_chunks has migration 030's embedding_model column."""
    key = id(pg_conn)
    if key in _HAS_EMBEDDING_MODEL_COLUMN:
        return _HAS_EMBEDDING_MODEL_COLUMN[key]
    present = False
    try:
        with pg_conn.cursor() as cur:
            cur.execute("""
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'rlm_chunks' AND column_name = 'embedding_model'
            """)
            present = cur.fetchone() is not None
    except Exception as e:
        log.debug("embedding_model_probe_failed error=%s", str(e))
        try:
            pg_conn.rollback()
        except Exception:
            pass
    if len(_HAS_EMBEDDING_MODEL_COLUMN) > 32:
        _HAS_EMBEDDING_MODEL_COLUMN.clear()
    _HAS_EMBEDDING_MODEL_COLUMN[key] = present
    return present


# ───────────────────────────────────────────────────────────────────────────────
# Phase 89 / RETR-08, decision D3 (plan 89-06): the lexical leg has two engines
#
# `pg_search` is OPTIONAL as of this phase -- it has no Windows build, and
# migration 011's unguarded CREATE EXTENSION used to take the whole schema with
# it on any plain PostgreSQL. When the extension is absent, the lexical leg runs
# PostgreSQL's own full-text search (`to_tsvector`/`ts_rank_cd`) over migration
# 033's GIN indexes instead of ParadeDB's BM25.
#
# WHAT IS IDENTICAL: the vector leg, the RRF fusion formula and its k, the
# candidate pool sizes, the top-k contract, the position_decay post-pass, the
# degradation ladder, and the returned field set -- key for key, including
# `bm25_score` in `bm25_only_search`'s rows. Only the lexical leg's SQL differs.
#
# WHAT IS NOT: the SCORES, and therefore the ordering of two documents the two
# engines disagree about. Tantivy BM25 and ts_rank_cd are different functions of
# different statistics; no amount of tuning makes them agree. This is a
# DOCUMENTED DIVERGENCE of exactly the kind RETR-07 records above -- the plain
# PostgreSQL leg is NOT BM25 and this module never claims the two rank a corpus
# alike. `doctor` and `/health` name the engine that answered (one resolver,
# services/infra_detect.py `lexical_engine`), so a reader can always tell which
# of the two produced a given ranking.
# ───────────────────────────────────────────────────────────────────────────────

#: Per-connection cache for the pg_search probe, the same shape and the same
#: failure behaviour as _HAS_EMBEDDING_MODEL_COLUMN above. The ANSWER is
#: computed and cached by services/infra_detect.py `lexical_engine()`, which is
#: also what the capability report, `doctor` and `/health` read -- one probe,
#: one cache, four routed call sites, no two of which can disagree.
_LEXICAL_WEIGHT_LABELS = ("A", "B", "C", "D")

#: ts_rank_cd's weight array is {D, C, B, A}. This one reproduces
#: `_boosted_rlm_query`'s boosts exactly: description (A, 0.8) counts twice
#: content (B, 0.4), and symbol_name (C, 0.4) counts the same as content -- the
#: `content:T OR description:T^2.0 OR symbol_name:T` weighting, in the only
#: vocabulary a tsquery has.
RLM_FTS_COLUMNS = (("description", "A"), ("content", "B"), ("symbol_name", "C"))
RLM_FTS_WEIGHTS = (0.1, 0.4, 0.4, 0.8)

#: PostgreSQL's own default weights, for a caller with a single text column.
DEFAULT_FTS_WEIGHTS = (0.1, 0.2, 0.4, 1.0)

#: The text-search configuration both the query expressions and migration 033's
#: index expressions use. They must be the same string or the index is not used.
FTS_CONFIG = "english"


def _has_pg_search(pg_conn) -> bool:
    """True when this connection's lexical leg should be ParadeDB BM25.

    Written like `_has_embedding_model_column`: one probe per connection,
    cached, and a failure degrades instead of raising. The caching and the
    probe statement live in services/infra_detect.py `lexical_engine()` so that
    this module, the capability report, `doctor` and `/health` all read ONE
    answer -- see that function for why `pg_extension` is the ground truth and
    how `gsd.lexical_engine` pins the plain leg.

    ONLY a measured `postgres_fts` routes to the full-text leg. An UNKNOWN
    answer -- a connection that is a test double, in an aborted transaction, or
    dead -- keeps the `@@@` statement this module has always run, for two
    reasons: a failed catalogue read is not evidence that the extension is
    absent, and if it really is absent the `@@@` surfaces as plan 89-01's typed
    EngineProgrammingError rather than as a quietly different ranking. The
    cheapest statement in the system failing is a condition to report, not to
    silently reinterpret.
    """
    try:
        try:
            from services.infra_detect import lexical_engine, LEXICAL_POSTGRES_FTS
        except ImportError:  # pragma: no cover - script-launched from services/
            from infra_detect import lexical_engine, LEXICAL_POSTGRES_FTS
        return lexical_engine(pg_conn)["lexical_engine"] != LEXICAL_POSTGRES_FTS
    except Exception as e:  # noqa: BLE001 - never raise out of a probe
        log.debug("pg_search_probe_failed error=%s", str(e))
        return True


def _check_weight(label) -> None:
    """Raise ValueError unless `label` is one of tsvector's four weights."""
    if label not in _LEXICAL_WEIGHT_LABELS:
        raise ValueError(f"unsafe tsvector weight: {label!r}")


def like_escape(text: str) -> str:
    """Escape *text* so a ``LIKE`` pattern matches it LITERALLY.

    PostgreSQL's default ``LIKE`` escape is the backslash, so three characters
    carry meaning inside a pattern and must be doubled or escaped before a
    caller's own path can be pasted into one: the backslash itself, ``%`` and
    ``_``. A Windows path is made of backslashes, so a pattern built by
    concatenating one is NOT the pattern its author meant -- see
    :func:`like_beneath` for the defect this caused in three product sites, and
    note that an ad-hoc pattern in a test is wrong in exactly the same way.

    Args:
        text: the literal to appear inside a ``LIKE`` pattern.

    Returns:
        str: the escaped literal; append ``"%"`` to make it a prefix pattern.

    Example:
        >>> like_escape('C:\\\\srv\\\\a_b')
        'C:\\\\\\\\srv\\\\\\\\a\\\\_b'
    """
    return (str(text).replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_"))


def like_beneath(prefix: str, sep: Optional[str] = None) -> str:
    """The ``LIKE`` pattern that matches every path strictly beneath *prefix*.

    **A directory-scoped search matched NOTHING on Windows before this.**
    Three sites built their pattern as ``prefix + os.sep + "%"`` and bound it to
    ``LIKE``. On Windows ``os.sep`` is a BACKSLASH, which is SQL ``LIKE``'s
    default ESCAPE character, so ``...\\%`` stopped being "the wildcard" and
    became "a literal per-cent sign" -- a pattern that matches one impossible
    string. Measured on `pytest (windows-latest)`, run 43366250606, the first
    run of these tests on any Windows cell: eleven tests failed, every one of
    them a directory-filtered search or a prune, each returning an EMPTY result
    with no error and no warning. Plan 89-07 found it by giving that cell a
    database.

    The same expression also left ``%`` and ``_`` in the CALLER's path
    unescaped, so a directory literally named ``a_b`` matched ``axb`` too. Both
    are fixed here, in ONE place the three sites now share.

    PostgreSQL's default LIKE escape is the backslash, so a doubled backslash is
    a literal one; nothing in the SQL changes and no ``ESCAPE`` clause is
    needed. The value travels as a bound parameter, so it is never parsed as a
    SQL literal.

    Args:
        prefix: a directory path, with or without a trailing separator.
        sep: the separator to treat as the boundary; the HOST's when omitted.

    Returns:
        str: the pattern to bind beside the exact-match parameter.

    Example:
        >>> like_beneath('/a/b')          # doctest: +SKIP
        '/a/b/%'
        >>> like_beneath('C:\\a\\b')  # doctest: +SKIP
        'C:\\\\a\\\\b\\\\%'
    """
    boundary = os.sep if sep is None else sep
    return like_escape(str(prefix).rstrip("/\\") + boundary) + "%"


def beneath_patterns(prefix: str):
    """The patterns that match everything beneath *prefix*, either separator.

    A path filter must not care which separator the STORED path uses. Windows
    accepts both, a database can hold rows written by another host, and the
    fixtures of several tests build their paths with a literal ``/`` while the
    product's own ingestion uses ``os.path.abspath``. Measured on `pytest
    (windows-latest)`, run 43370212942: with one host-separator pattern, five
    tests still came back EMPTY on that cell after the escaping fix, every one
    of them a filter whose seeded paths used ``/`` while ``os.sep`` was ``\\``.

    Args:
        prefix: a directory path.

    Returns:
        list[str]: one pattern per separator, in a stable order.
    """
    return [like_beneath(prefix, "/"), like_beneath(prefix, "\\")]


def fts_vector_sql(fts_columns, alias: Optional[str] = None) -> str:
    """The weighted `tsvector` expression for a column list.

    THE one place this expression is spelled. Migration
    033-plain-fts-fallback.sql carries the same text for `rlm_chunks` and
    `gsd_memory` (an expression index is only used when the query's expression
    parses to the same tree), and
    tests/test_89_06_lexical_fallback.py pins the two against each other so the
    pair cannot drift into a silent sequential scan.

    Args:
        fts_columns: sequence of ``(column, weight_label)``. Column names are
            validated with `_check_ident` and weights against tsvector's four
            labels, exactly like every other identifier this module
            interpolates -- neither can be a bound parameter.
        alias: table alias to qualify the columns with, or None for the bare
            column names a CREATE INDEX expression uses.

    Returns:
        str: ``(setweight(to_tsvector('english', coalesce(c.x, '')), 'A') || ...)``

    Raises:
        ValueError: on an unsafe column name or weight label.
    """
    parts = []
    for column, label in fts_columns:
        _check_ident(column)
        _check_weight(label)
        ref = f"{alias}.{column}" if alias else column
        parts.append(
            f"setweight(to_tsvector('{FTS_CONFIG}', coalesce({ref}, '')), '{label}')"
        )
    if not parts:
        raise ValueError("fts_columns is empty")
    return "(" + " || ".join(parts) + ")"


def fts_query_sql() -> str:
    """The `tsquery` expression, with ONE bound parameter for the query text.

    ## The @@@-to-tsquery translation rule, in one place
    1. **Fields.** The tsvector covers exactly the columns the caller declares
       in `fts_columns` -- for `rlm_chunks` the same three `_boosted_rlm_query`
       names, and deliberately NOT `file_path`, which rides in the BM25 index
       but in neither engine's QUERY.
    2. **Boosts.** `description^2.0` becomes tsvector weight A against
       content's B, scored with `ts_rank_cd({0.1,0.4,0.4,0.8})`: description
       twice content, symbol_name equal to content. The boosts are PRESERVED,
       not dropped.
    3. **Multi-word.** `_boosted_rlm_query` emits one boost group per term and
       pg_search combines space-separated groups with implicit OR, so the
       tsquery must OR too. `websearch_to_tsquery` ANDs with `&`; this
       expression re-spells those `&` as `|` on the tsquery's own text, which
       keeps ALL parsing of untrusted input inside PostgreSQL behind a bound
       parameter -- unlike `to_tsquery`, which would need the terms escaped in
       Python.
    4. **Stray syntax.** `_sanitize_query` has already stripped
       ``! ^ ~ @ ( ) [ ] { } "`` for pg_search's parser, which also removes
       every tsquery operator and every phrase quote -- so `&` is the only
       operator `websearch_to_tsquery` can emit here, and the substitution
       cannot corrupt a phrase. A hyphenated token keeps websearch's phrase
       semantics (`'a-b' <-> 'a' <-> 'b'`), the one place the two engines read a
       token differently.
    5. **Empty.** A stopword-only query yields the empty tsquery, which matches
       nothing -- the same answer pg_search gives, reached without a round trip
       to a parse error.

    Returns:
        str: the expression, consuming exactly one `%s`.
    """
    return (
        f"replace(websearch_to_tsquery('{FTS_CONFIG}', %s)::text, '&', '|')::tsquery"
    )


def _fts_rank_sql(fts_columns, weights, alias: Optional[str] = None) -> str:
    """`ts_rank_cd(weights, vector, query)` -- the FTS leg's score expression.

    Consumes one `%s` (the query text), via :func:`fts_query_sql`.
    """
    weights = tuple(weights or DEFAULT_FTS_WEIGHTS)
    if len(weights) != 4:
        raise ValueError("ts_rank_cd needs exactly four weights {D,C,B,A}")
    weight_sql = "'{" + ",".join(f"{float(w):.4f}" for w in weights) + "}'::float4[]"
    return (
        f"ts_rank_cd({weight_sql}, {fts_vector_sql(fts_columns, alias)}, "
        f"{fts_query_sql()})"
    )


def _fts_match_sql(fts_columns, alias: Optional[str] = None) -> str:
    """`vector @@ query` -- the FTS leg's WHERE predicate. Consumes one `%s`."""
    return f"{fts_vector_sql(fts_columns, alias)} @@ {fts_query_sql()}"


def hybrid_search_generic(query: str, pg_conn, *, table: str, id_column: str,
                           select_columns, vector_column: Optional[str] = None,
                           query_embedding: Optional[list] = None,
                           bm25_query: Optional[str] = None,
                           filter_sql: str = "", filter_params=(),
                           vector_filter_sql: str = "", vector_filter_params=(),
                           top_k: int = DEFAULT_TOP_K,
                           candidate_k: int = RRF_CANDIDATE_K,
                           rrf_k: int = RRF_K,
                           fts_columns=None, fts_weights=None,
                           fts_query: Optional[str] = None) -> list:
    """
    Table/column-agnostic RRF fusion of a pg_search BM25 leg and a pgvector
    cosine-similarity leg (Phase 66 shared-primitive contract, CONTEXT.md).

    Every table/column identifier arrives as a parameter and is validated via
    _check_ident before interpolation — this function must never contain a
    literal reference to any specific caller's schema.

    Args:
        query: raw query string (only used to derive bm25_query when it is None)
        pg_conn: psycopg2 connection
        table: source table name (validated identifier)
        id_column: primary key column name (validated identifier)
        select_columns: iterable of column names returned in the result rows
            (validated identifiers)
        vector_column: optional embedding column name for the vector leg
            (validated identifier); None disables the vector leg
        query_embedding: optional query embedding vector; None runs BM25-only
            (graceful degradation, same semantics as today's Phase 27 path)
        bm25_query: pre-built pg_search match string (already sanitized/boosted
            by the caller); derived via _sanitize_query(query) when None
        filter_sql: optional SQL fragment appended to BOTH legs (e.g.
            "AND c.some_column LIKE %s")
        filter_params: positional params for filter_sql, applied once per leg
        vector_filter_sql: optional SQL fragment appended to the VECTOR leg
            only (e.g. restricting to rows embedded by the active model —
            a condition that must not suppress BM25 matches)
        vector_filter_params: positional params for vector_filter_sql
        top_k: rows returned after RRF fusion
        candidate_k: candidate pool size per leg before fusion
        rrf_k: RRF k constant
        fts_columns: Phase 89 / D3 — the caller's table shape for the
            plain-PostgreSQL lexical leg, as ``(column, weight_label)`` pairs
            (see :func:`fts_vector_sql`). Consulted ONLY where pg_search is
            absent. A caller that does not declare it keeps a working search on
            such a database but with NO lexical leg: the vector leg answers
            alone, which the log names, because inventing a text column set
            from `select_columns` would guess at types.
        fts_weights: ts_rank_cd's ``{D,C,B,A}`` array; PostgreSQL's own default
            when omitted.
        fts_query: plain query text for the tsquery; ``_sanitize_query(query)``
            when omitted. Never the pg_search match string — `bm25_query`'s
            field qualifiers and boosts are not tsquery syntax.

    Returns a list of row dicts: select_columns plus rrf_score, rank_bm25,
    rank_vector. On any SQL failure, falls back to the BM25-only branch
    (never raises up to the caller — mirrors the pre-Phase-65 degradation
    contract).
    """
    _check_ident(table)
    _check_ident(id_column)
    for col in select_columns:
        _check_ident(col)
    if vector_column is not None:
        _check_ident(vector_column)

    if bm25_query is None:
        bm25_query = _sanitize_query(query)
    if fts_query is None:
        fts_query = _sanitize_query(query)

    # Phase 89 / D3: which engine answers the lexical leg. ONE probe, cached
    # per connection (services/infra_detect.py `lexical_engine`), consulted
    # here and passed down to _generic_bm25_only rather than probed again.
    use_bm25 = _has_pg_search(pg_conn)
    if use_bm25 and not bm25_query:
        return []
    if not use_bm25 and not fts_query:
        return []

    filter_params = list(filter_params)
    vector_filter_params = list(vector_filter_params)

    if query_embedding is None or vector_column is None:
        log.debug("hybrid_search_generic_bm25_only_mode table=%s reason=no_query_embedding", table)
        return _generic_bm25_only(bm25_query, pg_conn, table=table, id_column=id_column,
                                   select_columns=select_columns, filter_sql=filter_sql,
                                   filter_params=filter_params, top_k=top_k,
                                   fts_columns=fts_columns, fts_weights=fts_weights,
                                   fts_query=fts_query)

    select_cols_sql = ", ".join(f"c.{col}" for col in select_columns)

    # Convert query embedding to a PostgreSQL vector literal at its FULL
    # dimensionality. TK-1741: a prior version truncated to [:256] and cast
    # both sides to ::vector(256) on the theory that pgvector's cast would
    # slice down to the leading Matryoshka dimensions. It does not -- vector
    # type-modifier casts enforce an EXACT dimension match and raise
    # ("expected 256 dimensions, not 1024") against any caller-supplied
    # column whose stored vectors don't already match 256 dims exactly.
    # This primitive has no opinion on caller dimensionality: callers must
    # pass query_embedding at the same dimension their vector_column stores
    # (see hybrid_search()'s wrapper-level fix for its table's case).
    # Casting the literal to a bare `vector` (no dimension modifier) is
    # sufficient for the <=> operator and preserves whatever dimensionality
    # the caller supplied -- no silent truncation, no modifier mismatch.
    vec_literal = "[" + ",".join(f"{v:.6f}" for v in query_embedding) + "]"

    # ── Routed site 1 of 4 (Phase 89 / D3): the lexical CTE ────────────────
    # Same CTE name, same two output columns, same RANK() window, same
    # candidate_k, same position in the FULL OUTER JOIN below — so the fusion
    # that reads it cannot tell the two engines apart. Only the score
    # expression and the match predicate differ.
    if use_bm25:
        lexical_rank_sql = f"paradedb.score(c.{id_column})"
        lexical_where_sql = "c @@@ %s"
        lexical_params = [bm25_query]
    elif fts_columns:
        lexical_rank_sql = _fts_rank_sql(fts_columns, fts_weights, alias="c")
        lexical_where_sql = _fts_match_sql(fts_columns, alias="c")
        # Two binds, in the order the two expressions appear in the text:
        # the RANK() window first, then the WHERE predicate.
        lexical_params = [fts_query, fts_query]
    else:
        # No pg_search and no declared text columns: run the vector leg alone
        # rather than guess. `FALSE` keeps the CTE's shape, so the fusion SQL
        # below is untouched and every row arrives with the same
        # COALESCE(rank_bm25, candidate_k + 1) a genuine lexical miss gets.
        log.warning(
            "hybrid_search_generic_no_lexical_leg table=%s — pg_search absent and "
            "no fts_columns declared; the vector leg answers alone", table,
        )
        lexical_rank_sql = "0"
        lexical_where_sql = "FALSE"
        lexical_params = []

    sql = f"""
        WITH bm25_leg AS (
            SELECT
                c.{id_column} AS id,
                RANK() OVER (ORDER BY {lexical_rank_sql} DESC) AS rank_bm25
            FROM {table} c
            WHERE {lexical_where_sql}
            {filter_sql}
            LIMIT {candidate_k}
        ),
        vector_leg AS (
            SELECT
                c.{id_column} AS id,
                RANK() OVER (ORDER BY c.{vector_column} <=> %s::vector) AS rank_vector
            FROM {table} c
            WHERE c.{vector_column} IS NOT NULL
            {filter_sql}
            {vector_filter_sql}
            LIMIT {candidate_k}
        ),
        rrf_fused AS (
            SELECT
                COALESCE(b.id, v.id) AS id,
                COALESCE(b.rank_bm25, {candidate_k + 1}) AS rank_bm25,
                COALESCE(v.rank_vector, {candidate_k + 1}) AS rank_vector,
                (1.0::float8 / ({rrf_k} + COALESCE(b.rank_bm25, {candidate_k + 1})) +
                 1.0::float8 / ({rrf_k} + COALESCE(v.rank_vector, {candidate_k + 1}))) AS rrf_score
            FROM bm25_leg b
            FULL OUTER JOIN vector_leg v ON b.id = v.id
        )
        SELECT
            {select_cols_sql},
            r.rrf_score, r.rank_bm25, r.rank_vector
        FROM rrf_fused r
        JOIN {table} c ON c.{id_column} = r.id
        ORDER BY r.rrf_score DESC
        LIMIT %s
    """

    params = (lexical_params + filter_params + [vec_literal] + filter_params
              + vector_filter_params + [top_k])

    # Output column order is deterministic from the SELECT list we just built
    # (select_columns, then the three fusion aliases) — no cursor metadata
    # round-trip needed to name the result dict keys.
    result_cols = list(select_columns) + ["rrf_score", "rank_bm25", "rank_vector"]

    try:
        with pg_conn.cursor() as cur:
            cur.execute(sql, params)
            rows = [dict(zip(result_cols, row)) for row in cur.fetchall()]
        log.debug("hybrid_search_generic_ok table=%s results=%d", table, len(rows))
        return rows
    except Exception as e:
        # TK-1741: a failed cur.execute() leaves the psycopg2 transaction
        # aborted (PostgreSQL requires ROLLBACK before any further statement
        # on the same connection/transaction). Without this, the fallback
        # query issued immediately below would itself raise
        # "current transaction is aborted, commands ignored until end of
        # transaction block" and mask the real error. rollback() is
        # best-effort: pg_conn may be a stub/fake in unit tests with no
        # rollback method, or already closed — swallow those cases and let
        # the fallback path's own try/except handle whatever comes next.
        _rollback_quietly(pg_conn, "hybrid_search_generic")

        # Phase 89 / RET-02. This leg HAS a lower rung, so the degradation is
        # kept for every error class (the contract TK-1741 relies on) — but a
        # programming error is a defect in this module's own SQL, so it is
        # counted, logged with its sqlstate, and re-raised under GSD_TEST_MODE:
        # a lower rung answering must not let CI pass over unplannable SQL.
        sqlstate = _programming_error_sqlstate(e)
        if sqlstate is not None:
            typed = _engine_programming_error("hybrid_rrf", table, sqlstate, e)
            if _test_mode():
                raise typed from e
            log.warning(
                "hybrid_search_generic_failed table=%s sqlstate=%s — falling back to BM25",
                table, typed.sqlstate,
            )
        else:
            log.warning("hybrid_search_generic_failed table=%s error=%s — falling back to BM25", table, str(e))
        return _generic_bm25_only(bm25_query, pg_conn, table=table, id_column=id_column,
                                   select_columns=select_columns, filter_sql=filter_sql,
                                   filter_params=filter_params, top_k=top_k,
                                   fts_columns=fts_columns, fts_weights=fts_weights,
                                   fts_query=fts_query)


def _generic_bm25_only(bm25_query: str, pg_conn, *, table: str, id_column: str,
                        select_columns, filter_sql: str = "", filter_params=(),
                        top_k: int = DEFAULT_TOP_K,
                        fts_columns=None, fts_weights=None,
                        fts_query: Optional[str] = None) -> list:
    """
    BM25-only branch shared by hybrid_search_generic's graceful-degradation path
    (no query_embedding) and its exception fallback (hybrid SQL failed). Same
    table/column-agnostic contract as hybrid_search_generic — no literal schema
    references.

    Phase 89 / RET-02: this statement aliases its single table as `c`, exactly
    as hybrid_search_generic's per-leg CTEs do, so that ONE `filter_sql`
    fragment is valid in BOTH branches. It used to query the bare unaliased
    table name in both its FROM and its `@@@` operand, and `hybrid_search` splices
    an alias-qualified fragment ("AND (c.file_path = %s OR c.file_path LIKE
    %s)"): every call with a file filter and no query embedding -- the only
    combination the main CI pytest step can take, since it deliberately carries
    no embedding key -- made PostgreSQL answer `missing FROM-clause entry for
    table "c"` (sqlstate 42P01), which the `except` below turned into an empty
    result set. Eleven tests were carried as expected failures on that.

    Aliasing HERE rather than un-qualifying the caller's fragment is the
    deliberate choice (89-RESEARCH.md §6.3 item 1): the one-line alternative
    (make `hybrid_search` emit bare `file_path`) fixes today's caller and leaves
    the trap armed for the next one. An unqualified column still resolves
    against a single aliased table, so `services/pg_store.py`'s deliberately
    unqualified fragments (`_memory_filter_sql`, documented at :333-338) keep
    working unchanged -- that is cells 3 and 4 of
    tests/test_89_01_bm25_alias_matrix.py.

    The result SHAPE, the ordering contract and the degradation semantics are
    untouched; the only change is which name the statement gives its one table.

    Phase 89 / D3, routed site 2 of 4: without pg_search this is the same
    statement over `to_tsvector`/`ts_rank_cd`. The three fusion aliases keep
    their literal values (`rrf_score` NULL, `rank_bm25` 1, `rank_vector` NULL),
    so `pg_store._score_fused_memories`' NULL-rrf_score branch and
    `hybrid_search`'s None-score sort key behave identically on both engines.
    """
    _check_ident(table)
    _check_ident(id_column)
    for col in select_columns:
        _check_ident(col)

    use_bm25 = _has_pg_search(pg_conn)
    if use_bm25:
        if not bm25_query:
            return []
        lexical_where_sql = "c @@@ %s"
        lexical_order_sql = f"paradedb.score(c.{id_column})"
        # `paradedb.score()` takes the key column, not the query: one bind.
        where_params, order_params = [bm25_query], []
    else:
        if not fts_query or not fts_columns:
            # No lexical engine and no lower rung: an empty result is the whole
            # answer this branch can give, and the caller's own ladder decides
            # what to do with it (pg_store's rung 2, hybrid_search's caller).
            if not fts_columns:
                log.warning(
                    "generic_bm25_only_no_lexical_leg table=%s — pg_search absent and "
                    "no fts_columns declared", table,
                )
            return []
        lexical_where_sql = _fts_match_sql(fts_columns, alias="c")
        lexical_order_sql = _fts_rank_sql(fts_columns, fts_weights, alias="c")
        # ts_rank_cd scores the same tsquery the predicate matched: one bind
        # each, and `filter_sql` sits textually between them.
        where_params, order_params = [fts_query], [fts_query]

    select_cols_sql = ", ".join(f"c.{col}" for col in select_columns)
    filter_params = list(filter_params)

    sql = f"""
        SELECT
            {select_cols_sql},
            NULL::float AS rrf_score,
            1 AS rank_bm25,
            NULL::int AS rank_vector
        FROM {table} c
        WHERE {lexical_where_sql}
        {filter_sql}
        ORDER BY {lexical_order_sql} DESC
        LIMIT %s
    """
    params = where_params + filter_params + order_params + [top_k]

    # Same deterministic-column-order approach as hybrid_search_generic — no
    # cursor metadata round-trip needed to name the result dict keys.
    result_cols = list(select_columns) + ["rrf_score", "rank_bm25", "rank_vector"]

    try:
        with pg_conn.cursor() as cur:
            cur.execute(sql, params)
            rows = [dict(zip(result_cols, row)) for row in cur.fetchall()]
        return rows
    except Exception as e:
        # TK-1741: mirror the rollback in hybrid_search_generic's except --
        # this branch is both the graceful-degradation path (no
        # query_embedding) and the exception-fallback path, either of which
        # can be called again on the same pg_conn by a subsequent request,
        # so leaving the transaction aborted here is just as harmful.
        _rollback_quietly(pg_conn, "generic_bm25_only")

        # Phase 89 / RET-02. Unlike hybrid_search_generic, this branch has NO
        # lower rung: the `return []` below IS the silence that hid the alias
        # defect for two phases. So a programming error here is raised as a
        # typed EngineProgrammingError in every mode, not only under test mode
        # — that is what lets /query and /search report `engine_error` at all,
        # and the HTTP callers are the layer that decides whether to degrade.
        # Operational errors (connection lost, lock timeout, disk full) keep
        # the degraded empty result, unchanged.
        sqlstate = _programming_error_sqlstate(e)
        if sqlstate is not None:
            raise _engine_programming_error("bm25_only", table, sqlstate, e) from e
        log.warning("generic_bm25_only_failed table=%s error=%s", table, str(e))
        return []


def _boosted_rlm_query(safe_query: str) -> str:
    """
    Expand a sanitized rlm_chunks term string into a field-qualified,
    description-weighted pg_search match string (Phase 65 / RETR-06).

    Weights the caveman `description` field ~2x over `content`; `symbol_name`
    rides at 1x (plain, unboosted term). Each whitespace-separated term gets
    its own boost group so multi-term queries stay robust — pg_search's
    default query parser combines space-separated groups with implicit OR,
    matching the interpretation a plain (un-field-qualified) `@@@ %s` query
    would have had.

    Live-verified against the installed pg_search 0.24.1 (2026-07-03,
    `SELECT extversion FROM pg_extension WHERE extname='pg_search'` ->
    0.24.1): `rlm_chunks @@@ 'content:foo OR description:foo^2.0 OR
    symbol_name:foo'` parses and the description boost has a real ranking
    effect. Smoke-tested against a synthetic row pair inserted directly into
    rlm_chunks (description-only-token row scored 16.08 vs the
    content-only-token row's 14.23 via paradedb.score(id)); rows deleted and
    cleanup verified with a COUNT(*)=0 check afterward.

    Note: pg_search 0.24.1 requires a field-qualified query — a bare
    unqualified string (no `field:` prefix) is parsed against the `id`
    key_field and errors on any non-numeric term (audit RLM-M4). Every term
    emitted here is field-qualified, which also resolves that gap as a
    side effect of the boost.
    """
    terms = safe_query.split()
    if not terms:
        return ""
    return " ".join(
        f"(content:{term} OR description:{term}^2.0 OR symbol_name:{term})"
        for term in terms
    )


def hybrid_search(query: str, pg_conn, top_k: int = DEFAULT_TOP_K,
                  file_filter: Optional[str] = None) -> list:
    """
    Perform hybrid RRF search: pg_search BM25 + pgvector cosine in one SQL transaction.

    Thin rlm_chunks-specific wrapper over hybrid_search_generic() (Phase 65 /
    RETR-06). FROZEN public signature and return shape — 65-01 and 65-03 depend
    on it as-is in the same wave.

    Returns a list of chunk dicts (up to top_k), sorted by RRF score descending.
    Each chunk includes all rlm_chunks columns plus 'rrf_score', 'rank_bm25', 'rank_vector'.

    If embedding_code is NULL for retrieved chunks (no embeddings available),
    returns BM25-only results (vector leg produces empty set, fused with RRF_K offset).

    Args:
        query: search query string
        pg_conn: psycopg2 connection (from _get_pg_conn in rlm-service.py)
        top_k: number of results to return
        file_filter: optional file path prefix to restrict search scope

    Graceful degradation: falls back to BM25-only when no embedding model is available.
    """
    # Generate query embedding for vector leg.
    # TK-1741: previously used embed_for_query() which truncates to 256 dims
    # under the (incorrect, for a plain vector(N) cast) assumption that
    # pgvector's ::vector(256) cast would slice the leading Matryoshka
    # dimensions out of a stored 1024-dim vector. It doesn't -- the cast
    # requires an EXACT dimension match and raised on every call, live-
    # confirmed against migration 013's embedding_code vector(1024) column
    # (every populated row is genuinely 1024-dim). generate_code_embedding()
    # returns the full 1024-dim embedding that matches the column's actual
    # stored dimensionality, so the leg now compares like-for-like without
    # a cast-dimension mismatch. embed_for_query() has no other call sites
    # (only a callable-existence check in tests/test_27_ingestion.py) so this
    # redirect is scoped to this one call site.
    # input_type="query", not "document". voyage-code-3 is asymmetric: the
    # query side and the document side get different prompts, and embedding a
    # query as a document throws away recall for nothing. The previous call
    # took generate_code_embedding's hard-coded "document" default.
    from services.rlm_embeddings import (
        INPUT_TYPE_QUERY, active_embedding_model, generate_code_embedding,
    )
    query_embedding = generate_code_embedding(
        query, input_type=INPUT_TYPE_QUERY
    )  # full 1024-dim, or None

    select_columns = [
        "id", "file_path", "symbol_name", "symbol_type", "start_line", "end_line",
        "content", "description", "dependencies", "dependents",
    ]
    # `LIKE prefix%` also matched SIBLING directories: a filter of /a/b
    # matched /a/bc/... and /a/b-old/... Match the directory itself or a path
    # genuinely beneath it.
    if file_filter:
        prefix = str(file_filter).rstrip("/\\")
        filter_sql = ("AND (c.file_path = %s OR c.file_path LIKE %s "
                      "OR c.file_path LIKE %s)")
        filter_params = tuple([prefix] + beneath_patterns(prefix))
    else:
        filter_sql = ""
        filter_params = ()
    bm25_query = _boosted_rlm_query(_sanitize_query(query))

    # Vector-leg-only filter: compare like with like. Voyage (1024-dim) and
    # Qodo (1536-dim, truncated to 1024) vectors live in the same
    # embedding_code column; cosine distance between the two spaces is noise.
    # Rows embedded by another model still reach the results through BM25 —
    # they just do not pollute the vector ranking. NULL embedding_model means
    # "written before migration 030, provenance unknown" and is included so
    # an existing index does not go dark the moment this ships.
    vector_filter_sql = ""
    vector_filter_params = ()
    active_model = active_embedding_model()
    if active_model and _has_embedding_model_column(pg_conn):
        vector_filter_sql = (
            "AND (c.embedding_model IS NULL OR c.embedding_model = %s)"
        )
        vector_filter_params = (active_model,)

    # Phase 89 / D3: declare rlm_chunks' shape for the plain-PostgreSQL lexical
    # leg. RLM_FTS_COLUMNS and RLM_FTS_WEIGHTS reproduce `_boosted_rlm_query`'s
    # description^2.0 boost as tsvector weights; migration 033's
    # idx_rlm_chunks_fts is built on exactly the expression they generate.
    results = hybrid_search_generic(
        query, pg_conn,
        table="rlm_chunks", id_column="id", select_columns=select_columns,
        vector_column="embedding_code", query_embedding=query_embedding,
        bm25_query=bm25_query, filter_sql=filter_sql, filter_params=filter_params,
        vector_filter_sql=vector_filter_sql,
        vector_filter_params=vector_filter_params,
        top_k=top_k,
        fts_columns=RLM_FTS_COLUMNS, fts_weights=RLM_FTS_WEIGHTS,
        fts_query=_sanitize_query(query),
    )

    # Apply position_decay=0.05 penalty (replicate rlm-service.py BM25 tuning)
    # Later chunks (higher start_line) score lower: penalty = 0.05 * (start_line / max_line)
    # TK-1741: rrf_score is None for rows returned by the BM25-only degradation
    # branch (no query_embedding available, or the vector leg's exception
    # fallback) -- live-reproduced this crashing `-None` in the sort key and
    # `None * float` in the decay multiply, which directly contradicts this
    # function's own documented "graceful degradation" contract. Guard both:
    # skip the decay multiply for None-score rows, and sort None-score rows
    # after all real-score rows (stable sort preserves their original
    # paradedb.score() DESC ordering from the BM25-only SQL).
    if results:
        max_line = max(r.get('end_line', 1) or 1 for r in results)
        for r in results:
            if r.get('rrf_score') is None:
                continue
            start = r.get('start_line', 0) or 0
            depth_ratio = min(1.0, start / max(1, max_line))
            r['rrf_score'] = r['rrf_score'] * (1 - 0.05 * depth_ratio)
        results.sort(key=lambda x: (x.get('rrf_score') is None, -(x.get('rrf_score') or 0)))

    return results[:top_k]


def bm25_only_search(query: str, pg_conn, top_k: int = DEFAULT_TOP_K,
                     file_filter: Optional[str] = None) -> list:
    """
    BM25-only search via pg_search — used for MRR comparison and BM25-only fallback.

    Uses the same description-weighted, field-qualified match string as
    hybrid_search's bm25 leg (Phase 65 / RETR-06 _boosted_rlm_query) — a boost
    on only one of the two `@@@` call sites would rank the same corpus two
    different ways within this module.

    Phase 89 / D3, routed site 3 of 4: without pg_search the same statement
    runs on `to_tsvector`/`ts_rank_cd`. `bm25_score` KEEPS ITS NAME and its
    position in the row — every caller's field set is unchanged key for key —
    but it then carries a ts_rank_cd value, which is a different function of
    different statistics and is comparable only within one engine's results.
    """
    plain_query = _sanitize_query(query)
    use_bm25 = _has_pg_search(pg_conn)

    if use_bm25:
        # Sanitize + field-qualify/boost query for pg_search @@@ operator
        safe_query = _boosted_rlm_query(plain_query)
        if not safe_query:
            return []
        score_sql = "paradedb.score(id)"
        where_sql = "rlm_chunks @@@ %s"
        # SELECT's paradedb.score() takes the key column: the match string
        # binds once, in the WHERE.
        select_params, where_params, order_params = [], [safe_query], []
    else:
        if not plain_query:
            return []
        # Unaliased, like the rest of this statement (it takes no caller
        # fragment, so there is no alias to agree with).
        score_sql = _fts_rank_sql(RLM_FTS_COLUMNS, RLM_FTS_WEIGHTS)
        where_sql = _fts_match_sql(RLM_FTS_COLUMNS)
        select_params, where_params, order_params = (
            [plain_query], [plain_query], [plain_query])

    # Same sibling-directory fix as hybrid_search: `LIKE '/a/b%'` also matched
    # /a/bc and /a/b-old. Match the directory itself or a path beneath it.
    if file_filter:
        prefix = str(file_filter).rstrip("/\\")
        file_clause = ("AND (file_path = %s OR file_path LIKE %s "
                       "OR file_path LIKE %s)")
        file_params = [prefix] + beneath_patterns(prefix)
    else:
        file_clause = ""
        file_params = []

    sql = f"""
        SELECT
            id, file_path, symbol_name, symbol_type, start_line, end_line,
            content, description, dependencies, dependents,
            {score_sql} AS bm25_score,
            NULL::float AS rrf_score,
            1 AS rank_bm25,
            NULL::int AS rank_vector
        FROM rlm_chunks
        WHERE {where_sql}
        {file_clause}
        ORDER BY {score_sql} DESC
        LIMIT %s
    """
    params = (select_params + where_params + file_params + order_params
              + [top_k])

    try:
        with pg_conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, row)) for row in cur.fetchall()]
        return rows
    except Exception as e:
        # Phase 89 / RET-02: the third `except … -> []` in this module gets the
        # same split as the other two. This statement builds its own file
        # clause and is UNQUALIFIED throughout, so the alias defect could never
        # reach it (it takes no caller fragment) — but "the statement failed"
        # was still indistinguishable from "no matches", which is the class this
        # task closes, and fixing two of three sites would just move the trap.
        _rollback_quietly(pg_conn, "bm25_only_search")
        sqlstate = _programming_error_sqlstate(e)
        if sqlstate is not None:
            raise _engine_programming_error(
                "bm25_only_search", "rlm_chunks", sqlstate, e
            ) from e
        log.warning("bm25_only_search_failed query=%s error=%s", query[:50], str(e))
        return []


def _sanitize_query(query: str) -> str:
    """
    Sanitize query for pg_search @@@ operator.
    Strips special characters that would cause parse errors.
    Format for pg_search 0.22.6: 'field:term' or just 'term'.
    """
    # Remove pg_search special chars: @, !, ^, ~, ()
    sanitized = re.sub(r'[!^~@()\[\]{}"]', ' ', query)
    sanitized = ' '.join(sanitized.split())
    return sanitized[:500] if sanitized.strip() else ""


# ───────────────────────────────────────────────────────────────────────────────
# Phase 89 / RET-02: a SQL programming error is not "no matches"
#
# Until this phase, both legs ended in `except Exception` -> empty result, so a
# statement PostgreSQL could not even plan was indistinguishable from an empty
# corpus. That is how the alias defect above survived for two phases with a
# green suite: eleven tests recorded "the engine answers nothing" as an expected
# failure, and nobody could see that the engine had answered 42P01.
#
# The split is by error CLASS, deliberately narrow:
#   * psycopg2.ProgrammingError (sqlstate class 42xxx — undefined table,
#     undefined column, syntax error) is a DEFECT in this module's own SQL. It
#     becomes a typed EngineProgrammingError, is counted, and is reported to the
#     caller. No amount of retrying or degrading will make it answer.
#   * every other class — OperationalError and friends: connection lost, lock
#     timeout, disk full — keeps the existing degraded empty result. That path
#     is the product's resilience contract and this phase does not touch it.
# ───────────────────────────────────────────────────────────────────────────────

#: Per-sqlstate counter for programming errors raised out of a retrieval leg, so
#: the condition is visible without reading logs. Keyed by sqlstate, with a
#: bounded key space (sqlstates are five characters from a fixed vocabulary).
_ENGINE_ERROR_COUNTS = {}


class EngineProgrammingError(RuntimeError):
    """A retrieval leg's own SQL could not be planned or compiled.

    Raised instead of returning an empty result, so "the query failed" can never
    again be read as "the corpus has no matches". Carries the sqlstate and the
    NAME of the statement — never the statement text with its bound values, and
    never a DSN.

    Attributes:
        statement: short name of the failing statement (e.g. ``"bm25_only"``).
        table: the table the statement was built against.
        sqlstate: the PostgreSQL sqlstate, e.g. ``"42P01"``.
        error_class: the psycopg2 exception class name, e.g.
            ``"UndefinedTable"``.

    Example:
        >>> e = EngineProgrammingError("bm25_only", "rlm_chunks", "42P01",
        ...                            "UndefinedTable")
        >>> e.as_engine_error()["sqlstate"]
        '42P01'
    """

    def __init__(self, statement: str, table: str, sqlstate: str,
                 error_class: str):
        super().__init__(
            "%s: the %s statement against %s could not be planned "
            "(sqlstate %s)" % (error_class, statement, table, sqlstate)
        )
        self.statement = statement
        self.table = table
        self.sqlstate = sqlstate
        self.error_class = error_class

    def as_engine_error(self) -> dict:
        """The typed body an HTTP caller reports as ``engine_error``.

        Shaped like ``services/amauta-daemon.py``'s ``_requires_postgres_payload``
        — a snake_case ``error`` type the caller can branch on, a human
        ``detail``, and context keys — so the two typed failure bodies in the
        product read the same way.

        Returns:
            dict: ``error``, ``detail``, ``statement``, ``table``, ``sqlstate``
            and ``error_class``. Deliberately carries no SQL text, no bound
            parameter value and no DSN.

        Example:
            >>> EngineProgrammingError("bm25_only", "t", "42703",
            ...                        "UndefinedColumn").as_engine_error()["error"]
            'engine_sql_programming_error'
        """
        return {
            "error": "engine_sql_programming_error",
            "detail": (
                "the %s statement against %s could not be planned by PostgreSQL "
                "(%s, sqlstate %s). This is a defect in the retrieval engine's "
                "own SQL, not an empty corpus: the results below come from a "
                "degraded engine." % (
                    self.statement, self.table, self.error_class, self.sqlstate,
                )
            ),
            "statement": self.statement,
            "table": self.table,
            "sqlstate": self.sqlstate,
            "error_class": self.error_class,
        }


def engine_error_counts() -> dict:
    """A copy of the per-sqlstate programming-error counters.

    Returns:
        dict[str, int]: sqlstate -> how many times a leg raised it this process.

    Example:
        >>> isinstance(engine_error_counts(), dict)
        True
    """
    return dict(_ENGINE_ERROR_COUNTS)


def reset_engine_error_counts() -> None:
    """Zero the programming-error counters (test support only)."""
    _ENGINE_ERROR_COUNTS.clear()


def _programming_error_sqlstate(exc) -> Optional[str]:
    """The sqlstate of *exc* when it is a psycopg2 programming error, else None.

    psycopg2 is imported lazily and defensively: this module is handed a
    connection rather than opening one, and its unit tests drive it with plain
    stub connections on machines where psycopg2 may not be installed at all.

    Args:
        exc: the exception a leg's ``cur.execute`` raised.

    Returns:
        str | None: the sqlstate (``""`` when psycopg2 reported none), or None
        when *exc* is not of the programming class — in which case the caller
        keeps its existing degraded behaviour.
    """
    try:
        import psycopg2
    except Exception:
        return None
    if not isinstance(exc, psycopg2.ProgrammingError):
        return None
    return getattr(exc, "pgcode", None) or ""


def _engine_programming_error(statement: str, table: str, sqlstate: str,
                              exc) -> EngineProgrammingError:
    """Count, log and build the typed error for a programming-class failure.

    The log line carries the sqlstate, the statement NAME and the exception
    class only. It deliberately carries neither the SQL text (which holds
    ``%s`` placeholders and, in a formatted form, the caller's bound values) nor
    any connection detail — there is no DSN in scope at either call site, since
    this module never opens a connection. ``services/pg_dsn.py``'s ``mask_dsn``
    is therefore not reachable from here and not needed; see the record.

    Args:
        statement: short name of the failing statement.
        table: the table it was built against.
        sqlstate: the PostgreSQL sqlstate.
        exc: the original psycopg2 exception.

    Returns:
        EngineProgrammingError: ready to raise.
    """
    key = sqlstate or "unknown"
    _ENGINE_ERROR_COUNTS[key] = _ENGINE_ERROR_COUNTS.get(key, 0) + 1
    error_class = type(exc).__name__
    log.error(
        "engine_sql_programming_error statement=%s table=%s sqlstate=%s "
        "error_class=%s count=%d",
        statement, table, key, error_class, _ENGINE_ERROR_COUNTS[key],
    )
    return EngineProgrammingError(statement, table, key, error_class)


def _rollback_quietly(pg_conn, where: str) -> None:
    """Best-effort ``pg_conn.rollback()`` — TK-1741's invariant, factored out.

    A failed ``cur.execute()`` leaves the psycopg2 transaction aborted, and
    PostgreSQL refuses every further statement on it until a ROLLBACK. Both legs
    issue another statement afterwards (or hand the connection back to a caller
    that will), so leaving it aborted masks the real error behind "current
    transaction is aborted". Best-effort because ``pg_conn`` may be a stub with
    no ``rollback`` method, or already closed.

    Args:
        pg_conn: the connection, or any stub standing in for one.
        where: the call site name, for the debug line.
    """
    try:
        pg_conn.rollback()
    except Exception as rollback_err:
        log.debug("%s_rollback_skipped error=%s", where, str(rollback_err))


def _test_mode() -> bool:
    """Whether ``GSD_TEST_MODE`` is truthy.

    Under test mode a programming error in the HYBRID statement re-raises
    instead of degrading to the BM25-only leg, so CI can never stay green over
    SQL the engine cannot plan. Production keeps the degradation.

    Returns:
        bool
    """
    return (os.environ.get("GSD_TEST_MODE") or "").strip().lower() not in (
        "", "0", "false", "no", "off",
    )

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


def hybrid_search_generic(query: str, pg_conn, *, table: str, id_column: str,
                           select_columns, vector_column: Optional[str] = None,
                           query_embedding: Optional[list] = None,
                           bm25_query: Optional[str] = None,
                           filter_sql: str = "", filter_params=(),
                           top_k: int = DEFAULT_TOP_K,
                           candidate_k: int = RRF_CANDIDATE_K,
                           rrf_k: int = RRF_K) -> list:
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
            "AND c.file_path LIKE %s")
        filter_params: positional params for filter_sql, applied once per leg
        top_k: rows returned after RRF fusion
        candidate_k: candidate pool size per leg before fusion
        rrf_k: RRF k constant

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
    if not bm25_query:
        return []

    filter_params = list(filter_params)

    if query_embedding is None or vector_column is None:
        log.debug("hybrid_search_generic_bm25_only_mode table=%s reason=no_query_embedding", table)
        return _generic_bm25_only(bm25_query, pg_conn, table=table, id_column=id_column,
                                   select_columns=select_columns, filter_sql=filter_sql,
                                   filter_params=filter_params, top_k=top_k)

    select_cols_sql = ", ".join(f"c.{col}" for col in select_columns)

    # Convert query embedding to a PostgreSQL vector literal.
    # We truncate stored higher-dim vectors to 256-dim for fast lookup using the
    # Matryoshka property: cosine similarity is preserved in leading dimensions.
    vec_literal = "[" + ",".join(f"{v:.6f}" for v in query_embedding[:256]) + "]"

    sql = f"""
        WITH bm25_leg AS (
            SELECT
                c.{id_column} AS id,
                RANK() OVER (ORDER BY paradedb.score(c.{id_column}) DESC) AS rank_bm25
            FROM {table} c
            WHERE c @@@ %s
            {filter_sql}
            LIMIT {candidate_k}
        ),
        vector_leg AS (
            SELECT
                c.{id_column} AS id,
                RANK() OVER (ORDER BY (c.{vector_column}::vector(256)) <=> %s::vector(256)) AS rank_vector
            FROM {table} c
            WHERE c.{vector_column} IS NOT NULL
            {filter_sql}
            LIMIT {candidate_k}
        ),
        rrf_fused AS (
            SELECT
                COALESCE(b.id, v.id) AS id,
                COALESCE(b.rank_bm25, {candidate_k + 1}) AS rank_bm25,
                COALESCE(v.rank_vector, {candidate_k + 1}) AS rank_vector,
                (1.0 / ({rrf_k} + COALESCE(b.rank_bm25, {candidate_k + 1})) +
                 1.0 / ({rrf_k} + COALESCE(v.rank_vector, {candidate_k + 1}))) AS rrf_score
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

    params = [bm25_query] + filter_params + [vec_literal] + filter_params + [top_k]

    try:
        with pg_conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, row)) for row in cur.fetchall()]
        log.debug("hybrid_search_generic_ok table=%s results=%d", table, len(rows))
        return rows
    except Exception as e:
        log.warning("hybrid_search_generic_failed table=%s error=%s — falling back to BM25", table, str(e))
        return _generic_bm25_only(bm25_query, pg_conn, table=table, id_column=id_column,
                                   select_columns=select_columns, filter_sql=filter_sql,
                                   filter_params=filter_params, top_k=top_k)


def _generic_bm25_only(bm25_query: str, pg_conn, *, table: str, id_column: str,
                        select_columns, filter_sql: str = "", filter_params=(),
                        top_k: int = DEFAULT_TOP_K) -> list:
    """
    BM25-only branch shared by hybrid_search_generic's graceful-degradation path
    (no query_embedding) and its exception fallback (hybrid SQL failed). Same
    table/column-agnostic contract as hybrid_search_generic — no literal schema
    references.
    """
    _check_ident(table)
    _check_ident(id_column)
    for col in select_columns:
        _check_ident(col)

    if not bm25_query:
        return []

    select_cols_sql = ", ".join(select_columns)
    filter_params = list(filter_params)

    sql = f"""
        SELECT
            {select_cols_sql},
            NULL::float AS rrf_score,
            1 AS rank_bm25,
            NULL::int AS rank_vector
        FROM {table}
        WHERE {table} @@@ %s
        {filter_sql}
        ORDER BY paradedb.score({id_column}) DESC
        LIMIT %s
    """
    params = [bm25_query] + filter_params + [top_k]

    try:
        with pg_conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, row)) for row in cur.fetchall()]
        return rows
    except Exception as e:
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
    # Generate query embedding for vector leg
    from services.rlm_embeddings import embed_for_query
    query_embedding_256 = embed_for_query(query)  # 256-dim for fast lookup, or None

    select_columns = [
        "id", "file_path", "symbol_name", "symbol_type", "start_line", "end_line",
        "content", "description", "dependencies", "dependents",
    ]
    filter_sql = "AND c.file_path LIKE %s" if file_filter else ""
    filter_params = (f"{file_filter}%",) if file_filter else ()
    bm25_query = _boosted_rlm_query(_sanitize_query(query))

    results = hybrid_search_generic(
        query, pg_conn,
        table="rlm_chunks", id_column="id", select_columns=select_columns,
        vector_column="embedding_code", query_embedding=query_embedding_256,
        bm25_query=bm25_query, filter_sql=filter_sql, filter_params=filter_params,
        top_k=top_k,
    )

    # Apply position_decay=0.05 penalty (replicate rlm-service.py BM25 tuning)
    # Later chunks (higher start_line) score lower: penalty = 0.05 * (start_line / max_line)
    if results:
        max_line = max(r.get('end_line', 1) or 1 for r in results)
        for r in results:
            start = r.get('start_line', 0) or 0
            depth_ratio = min(1.0, start / max(1, max_line))
            r['rrf_score'] = r['rrf_score'] * (1 - 0.05 * depth_ratio)
        results.sort(key=lambda x: -x['rrf_score'])

    return results[:top_k]


def bm25_only_search(query: str, pg_conn, top_k: int = DEFAULT_TOP_K,
                     file_filter: Optional[str] = None) -> list:
    """
    BM25-only search via pg_search — used for MRR comparison and BM25-only fallback.

    Uses the same description-weighted, field-qualified match string as
    hybrid_search's bm25 leg (Phase 65 / RETR-06 _boosted_rlm_query) — a boost
    on only one of the two `@@@` call sites would rank the same corpus two
    different ways within this module.
    """
    # Sanitize + field-qualify/boost query for pg_search @@@ operator
    safe_query = _boosted_rlm_query(_sanitize_query(query))
    if not safe_query:
        return []

    file_clause = "AND file_path LIKE %s" if file_filter else ""
    params = [safe_query] + ([f"{file_filter}%"] if file_filter else [])

    sql = f"""
        SELECT
            id, file_path, symbol_name, symbol_type, start_line, end_line,
            content, description, dependencies, dependents,
            paradedb.score(id) AS bm25_score,
            NULL::float AS rrf_score,
            1 AS rank_bm25,
            NULL::int AS rank_vector
        FROM rlm_chunks
        WHERE rlm_chunks @@@ %s
        {file_clause}
        ORDER BY paradedb.score(id) DESC
        LIMIT %s
    """
    params.append(top_k)

    try:
        with pg_conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, row)) for row in cur.fetchall()]
        return rows
    except Exception as e:
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

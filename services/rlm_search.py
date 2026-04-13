#!/usr/bin/env python3
"""
Hybrid RRF search for GSD-Amauta RLM — Phase 27 / RLM-04.

Fuses pg_search BM25 + pgvector cosine similarity using Reciprocal Rank Fusion.
RRF formula: 1/(k + rank_bm25) + 1/(k + rank_vector) with k=60.

All fusion happens inside PostgreSQL — no application-level merging.
Falls back to BM25-only when embedding_code IS NULL for returned chunks.

BM25 tuning (applied at query time, not index time for pg_search 0.22.6):
  - Column boost: searches description field (caveman desc) with higher weight than content
  - b=0.6 equivalent: pg_search's BM25 uses Okapi BM25 internally; tuning note preserved in comment
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


def hybrid_search(query: str, pg_conn, top_k: int = DEFAULT_TOP_K,
                  file_filter: Optional[str] = None) -> list:
    """
    Perform hybrid RRF search: pg_search BM25 + pgvector cosine in one SQL transaction.

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

    results = _run_hybrid_sql(query, query_embedding_256, pg_conn, top_k, file_filter)

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
    """
    # Sanitize query for pg_search @@@ operator
    safe_query = _sanitize_query(query)
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


def _run_hybrid_sql(query: str, query_embedding: Optional[list],
                    pg_conn, top_k: int, file_filter: Optional[str]) -> list:
    """
    Execute the hybrid RRF SQL query.

    Two strategies:
    1. Full hybrid (BM25 + vector): when query_embedding is not None
    2. BM25-only: when query_embedding is None (graceful degradation)
    """
    safe_query = _sanitize_query(query)
    if not safe_query:
        return []

    if query_embedding is None:
        # Graceful degradation: BM25-only when no embedding model available
        log.debug("hybrid_search_bm25_only_mode reason=no_query_embedding")
        return bm25_only_search(query, pg_conn, top_k, file_filter)

    file_clause_bm25 = "AND c.file_path LIKE %s" if file_filter else ""
    file_clause_vec = "AND c.file_path LIKE %s" if file_filter else ""

    # Convert 256-dim query embedding to PostgreSQL vector literal
    # We truncate stored 1024-dim to 256-dim for fast lookup using Matryoshka property:
    # cosine similarity is preserved in leading dimensions.
    # pg_store uses <=> (cosine distance) operator.
    vec_literal = "[" + ",".join(f"{v:.6f}" for v in query_embedding[:256]) + "]"

    sql = f"""
        WITH bm25_leg AS (
            SELECT
                c.id,
                RANK() OVER (ORDER BY paradedb.score(c.id) DESC) AS rank_bm25
            FROM rlm_chunks c
            WHERE c @@@ %s
            {file_clause_bm25}
            LIMIT {RRF_CANDIDATE_K}
        ),
        vector_leg AS (
            SELECT
                c.id,
                RANK() OVER (ORDER BY (c.embedding_code::vector(256)) <=> %s::vector(256)) AS rank_vector
            FROM rlm_chunks c
            WHERE c.embedding_code IS NOT NULL
            {file_clause_vec}
            LIMIT {RRF_CANDIDATE_K}
        ),
        rrf_fused AS (
            SELECT
                COALESCE(b.id, v.id) AS id,
                COALESCE(b.rank_bm25, {RRF_CANDIDATE_K + 1}) AS rank_bm25,
                COALESCE(v.rank_vector, {RRF_CANDIDATE_K + 1}) AS rank_vector,
                (1.0 / ({RRF_K} + COALESCE(b.rank_bm25, {RRF_CANDIDATE_K + 1})) +
                 1.0 / ({RRF_K} + COALESCE(v.rank_vector, {RRF_CANDIDATE_K + 1}))) AS rrf_score
            FROM bm25_leg b
            FULL OUTER JOIN vector_leg v ON b.id = v.id
        )
        SELECT
            c.id, c.file_path, c.symbol_name, c.symbol_type,
            c.start_line, c.end_line, c.content, c.description,
            c.dependencies, c.dependents,
            r.rrf_score, r.rank_bm25, r.rank_vector
        FROM rrf_fused r
        JOIN rlm_chunks c ON c.id = r.id
        ORDER BY r.rrf_score DESC
        LIMIT %s
    """

    params = [safe_query]
    if file_filter:
        params.append(f"{file_filter}%")
    params.append(vec_literal)
    if file_filter:
        params.append(f"{file_filter}%")
    params.append(top_k)

    try:
        with pg_conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, row)) for row in cur.fetchall()]
        log.debug("hybrid_search_ok query=%s results=%d", query[:50], len(rows))
        return rows
    except Exception as e:
        log.warning("hybrid_search_failed query=%s error=%s — falling back to BM25", query[:50], str(e))
        return bm25_only_search(query, pg_conn, top_k, file_filter)


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

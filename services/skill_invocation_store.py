#!/usr/bin/env python3
"""
Skill Invocation Store — Phase 43 / SKILL-02.

Persists skill invocations to the `skill_invocations` PG table and provides
hybrid BM25 + pgvector retrieval with Reciprocal Rank Fusion (RRF).

Area 3 decisions (43-CONTEXT.md §Area 3):
  - Embedded payload = skill_name + prompt + args + outcome_class ('pending' if None)
  - Embedding model: voyage-code-3 1024-dim via services/pg_store.py generate_embedding()
  - Retrieval timing: BEFORE skill body executes — inject top-K as agent context
  - Hybrid retrieval: pgvector cosine + BM25 ts_rank with Reciprocal Rank Fusion
  - Top-K = 3, cosine floor = 0.6, recency filter = 90 days
  - RRF k constant = 60 (BMAD-METHOD default)

Public API (3 functions):
  record_invocation   — INSERT pre-execution row; return UUID or None on PG-down
  update_outcome      — UPDATE outcome_class + completed_at by id; return bool
  retrieve_similar    — Hybrid retrieval: pgvector cosine + BM25 RRF → list[dict]

Import safety: mirrors complexity_scorer.py pattern.
  - try psycopg2 → _HAS_PG; graceful fallback if not installed
  - try pg_store.generate_embedding → _HAS_EMBEDDING; graceful fallback if unavailable
  - Module imports cleanly in CI/test environments without DB or voyage-ai
"""

import json
import logging
import os
from typing import Optional

try:
    import psycopg2
    import psycopg2.extras
    _HAS_PG = True
except ImportError:
    _HAS_PG = False

try:
    import sys as _sys
    _pg_store_dir = os.path.dirname(os.path.abspath(__file__))
    if _pg_store_dir not in _sys.path:
        _sys.path.insert(0, _pg_store_dir)
    from pg_store import PGStore as _PGStore
    _HAS_EMBEDDING = True
except Exception:
    _PGStore = None  # type: ignore
    _HAS_EMBEDDING = False

log = logging.getLogger("amauta.skill_invocation_store")

# ═══════════════════════════════════════════════════════
# Module constants (Area 3 locks — do NOT change without 43-CONTEXT.md update)
# ═══════════════════════════════════════════════════════

_DEFAULT_K = 3                  # top-K results returned by retrieve_similar
_DEFAULT_COSINE_FLOOR = 0.6     # min cosine similarity to include a vector result
_DEFAULT_RECENCY_DAYS = 90      # rolling window for retrieval recency filter
_RRF_K = 60                     # BMAD-METHOD / v2.5 RRF standard constant
_BM25_LIMIT = 10                # per-list pre-fusion top-N (larger than final K)
_VECTOR_LIMIT = 10              # per-list pre-fusion top-N

_DEFAULT_PG_URL = "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta"

# ═══════════════════════════════════════════════════════
# Database connection
# ═══════════════════════════════════════════════════════

def _get_conn():
    """Return a psycopg2 connection using DATABASE_URL, GSD_POSTGRES_URL, or default.

    Raises RuntimeError if psycopg2 is not installed.
    """
    if not _HAS_PG:
        raise RuntimeError("psycopg2 not installed — cannot connect to PostgreSQL")
    db_url = (
        os.environ.get("DATABASE_URL")
        or os.environ.get("GSD_POSTGRES_URL")
        or _DEFAULT_PG_URL
    )
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    return conn


# ═══════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════

def _build_invocation_text(
    skill_name: str,
    prompt: str,
    args: dict,
    outcome_class: Optional[str],
) -> str:
    """Build the canonical invocation_text string for embedding + BM25.

    Format (Area 3 embedded-payload contract):
        "<skill_name> <prompt> <json(args)> <outcome_class>"
    outcome_class defaults to 'pending' when None (pre-execution).
    args are JSON-serialized with sorted keys for determinism.
    """
    return f"{skill_name} {prompt} {json.dumps(args, sort_keys=True)} {outcome_class or 'pending'}"


def _generate_embedding(text: str) -> Optional[list]:
    """Generate voyage-code-3 1024-dim embedding via pg_store.PGStore.generate_embedding.

    Returns list[float] of length 1024, or None if embedding is unavailable.
    """
    if not _HAS_EMBEDDING or _PGStore is None:
        return None
    try:
        return _PGStore.generate_embedding(text, input_type="document")
    except Exception as exc:
        log.warning("skill_invocation_store: embedding generation failed — %s", exc)
        return None


def _embedding_to_str(embedding: Optional[list]) -> Optional[str]:
    """Serialize an embedding list to the pgvector string format '[0.1,0.2,...]'."""
    if embedding is None:
        return None
    return "[" + ",".join(str(float(v)) for v in embedding) + "]"


# ═══════════════════════════════════════════════════════
# Query helpers
# ═══════════════════════════════════════════════════════

def _query_vector_neighbors(
    cur: "psycopg2.extensions.cursor",
    skill_name: str,
    embedding_str: str,
    recency_days: int,
    limit: int,
) -> list:
    """Run pgvector cosine similarity query on skill_invocations.

    Returns list of RealDictRow records with keys:
      id, invocation_text, args, outcome_class, invoked_at, distance, similarity
    """
    sql = """
        SELECT id, invocation_text, args, outcome_class, invoked_at,
               context_embedding <=> %s::vector AS distance,
               1.0 - (context_embedding <=> %s::vector) AS similarity
        FROM skill_invocations
        WHERE skill_name = %s
          AND invoked_at > NOW() - (%s || ' days')::interval
          AND context_embedding IS NOT NULL
        ORDER BY context_embedding <=> %s::vector
        LIMIT %s
    """
    cur.execute(sql, (embedding_str, embedding_str, skill_name, str(recency_days), embedding_str, limit))
    return cur.fetchall()


def _query_bm25_neighbors(
    cur: "psycopg2.extensions.cursor",
    skill_name: str,
    query_text: str,
    recency_days: int,
    limit: int,
) -> list:
    """Run BM25 full-text search query on skill_invocations using ts_rank.

    Returns list of RealDictRow records with keys:
      id, invocation_text, args, outcome_class, invoked_at, bm25_score
    """
    sql = """
        SELECT id, invocation_text, args, outcome_class, invoked_at,
               ts_rank(to_tsvector('english', invocation_text), plainto_tsquery('english', %s)) AS bm25_score
        FROM skill_invocations
        WHERE skill_name = %s
          AND invoked_at > NOW() - (%s || ' days')::interval
          AND to_tsvector('english', invocation_text) @@ plainto_tsquery('english', %s)
        ORDER BY bm25_score DESC
        LIMIT %s
    """
    cur.execute(sql, (query_text, skill_name, str(recency_days), query_text, limit))
    return cur.fetchall()


# ═══════════════════════════════════════════════════════
# Reciprocal Rank Fusion
# ═══════════════════════════════════════════════════════

def _reciprocal_rank_fusion(
    vector_results: list,
    bm25_results: list,
    k: int = _RRF_K,
) -> list:
    """Fuse two ranked lists using Reciprocal Rank Fusion.

    Formula: score(doc) = sum over ranked_lists of 1 / (k + rank(doc))
    where rank is 1-indexed within each list.

    Parameters
    ----------
    vector_results : list[dict]
        Rows from pgvector query, each with at least 'id'. May include 'similarity'.
    bm25_results : list[dict]
        Rows from BM25 query, each with at least 'id'. May include 'bm25_score'.
    k : int
        RRF constant (default 60 per BMAD-METHOD).

    Returns
    -------
    list[dict]
        Merged list sorted by descending rrf_score. Each dict carries:
          id, invocation_text, args, outcome_class, invoked_at,
          rrf_score, vector_similarity (if present), bm25_score (if present).
    """
    # Build id → accumulated dict
    scores: dict = {}

    # Process vector results (1-indexed ranks)
    for rank, row in enumerate(vector_results, start=1):
        row_dict = dict(row) if not isinstance(row, dict) else row
        doc_id = str(row_dict.get("id", ""))
        if not doc_id:
            continue
        if doc_id not in scores:
            scores[doc_id] = dict(row_dict)
            scores[doc_id]["rrf_score"] = 0.0
        scores[doc_id]["rrf_score"] += 1.0 / (k + rank)
        # Preserve similarity if present
        if "similarity" in row_dict:
            scores[doc_id]["vector_similarity"] = float(row_dict["similarity"] or 0.0)

    # Process BM25 results (1-indexed ranks)
    for rank, row in enumerate(bm25_results, start=1):
        row_dict = dict(row) if not isinstance(row, dict) else row
        doc_id = str(row_dict.get("id", ""))
        if not doc_id:
            continue
        if doc_id not in scores:
            scores[doc_id] = dict(row_dict)
            scores[doc_id]["rrf_score"] = 0.0
        scores[doc_id]["rrf_score"] += 1.0 / (k + rank)
        # Preserve bm25_score if present
        if "bm25_score" in row_dict:
            scores[doc_id]["bm25_score"] = float(row_dict["bm25_score"] or 0.0)

    # Sort descending by rrf_score
    fused = sorted(scores.values(), key=lambda d: d.get("rrf_score", 0.0), reverse=True)
    return fused


# ═══════════════════════════════════════════════════════
# Public functions
# ═══════════════════════════════════════════════════════

def record_invocation(
    skill_name: str,
    prompt: str,
    args: dict,
    outcome_class: Optional[str] = None,
) -> Optional[str]:
    """Insert a pre-execution skill invocation row into skill_invocations.

    Generates the context embedding via voyage-code-3 1024-dim (pg_store).
    On embedding failure, sets context_embedding = NULL and continues.
    On PG failure, logs a warning and returns None (does NOT raise).

    Parameters
    ----------
    skill_name : str
        Canonical skill name (e.g. 'plan-phase').
    prompt : str
        The user/agent prompt that triggered the invocation.
    args : dict
        Invocation arguments dict.
    outcome_class : str or None
        One of 'success', 'fail', 'escalation', or None (pre-execution default).

    Returns
    -------
    str or None
        UUID string of the inserted row, or None on PG-down.
    """
    if not _HAS_PG:
        log.warning("record_invocation: psycopg2 not installed — skipping PG write")
        return None

    invocation_text = _build_invocation_text(skill_name, prompt, args, outcome_class)

    # Generate embedding — best-effort, continue with NULL on failure
    embedding = _generate_embedding(invocation_text)
    embedding_str = _embedding_to_str(embedding)

    sql = """
        INSERT INTO skill_invocations (skill_name, invocation_text, args, outcome_class, context_embedding)
        VALUES (%s, %s, %s, %s, %s::vector)
        RETURNING id
    """

    try:
        conn = _get_conn()
    except Exception as exc:
        log.warning("record_invocation: PG unavailable for skill %s — %s", skill_name, exc)
        return None

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    sql,
                    (
                        skill_name,
                        invocation_text,
                        json.dumps(args),
                        outcome_class,
                        embedding_str,
                    ),
                )
                row = cur.fetchone()
                return str(row[0]) if row else None
    except Exception as exc:
        log.warning("record_invocation: INSERT failed for skill %s — %s", skill_name, exc)
        return None
    finally:
        try:
            conn.close()
        except Exception:
            pass


def update_outcome(invocation_id: str, outcome_class: str) -> bool:
    """Update outcome_class and completed_at for an existing invocation row.

    Parameters
    ----------
    invocation_id : str
        UUID string of the invocation to update.
    outcome_class : str
        One of 'success', 'fail', 'escalation'. Raises ValueError otherwise.

    Returns
    -------
    bool
        True if exactly one row was updated, False otherwise (missing id, PG-down).

    Raises
    ------
    ValueError
        If outcome_class is not one of the 3 valid values.
    """
    _VALID = {"success", "fail", "escalation"}
    if outcome_class not in _VALID:
        raise ValueError(
            f"update_outcome: outcome_class '{outcome_class}' must be one of {sorted(_VALID)}"
        )

    if not _HAS_PG:
        log.warning("update_outcome: psycopg2 not installed — skipping PG update")
        return False

    sql = """
        UPDATE skill_invocations
        SET outcome_class = %s, completed_at = NOW()
        WHERE id = %s
    """

    try:
        conn = _get_conn()
    except Exception as exc:
        log.warning("update_outcome: PG unavailable — %s", exc)
        return False

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(sql, (outcome_class, invocation_id))
                return cur.rowcount == 1
    except Exception as exc:
        log.warning("update_outcome: UPDATE failed for id %s — %s", invocation_id, exc)
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass


def retrieve_similar(
    skill_name: str,
    prompt: str,
    k: int = _DEFAULT_K,
    cosine_floor: float = _DEFAULT_COSINE_FLOOR,
    recency_days: int = _DEFAULT_RECENCY_DAYS,
) -> list:
    """Retrieve the top-K most similar past invocations via hybrid BM25 + pgvector RRF.

    Retrieval order:
      1. Build query text: "<skill_name> <prompt>" (no args/outcome — only what's known pre-execute)
      2. Generate embedding (best-effort; falls back to BM25-only if unavailable)
      3. Run pgvector cosine query; post-filter by cosine_floor
      4. Run BM25 ts_rank query
      5. Fuse both lists with Reciprocal Rank Fusion (RRF k=60)
      6. Return top-k fused results

    Parameters
    ----------
    skill_name : str
        Canonical skill name to scope the retrieval.
    prompt : str
        The incoming prompt (agent context).
    k : int
        Number of results to return (default 3 per Area 3).
    cosine_floor : float
        Minimum cosine similarity threshold for pgvector results (default 0.6).
    recency_days : int
        Rolling window in days to filter invocations (default 90).

    Returns
    -------
    list[dict]
        Top-k fused results, each with keys:
          id, invocation_text, args, outcome_class, invoked_at,
          rrf_score, vector_similarity (when available), bm25_score (when available).
        Returns [] on any error or PG-down.
    """
    if not _HAS_PG:
        log.debug("retrieve_similar: psycopg2 not installed — returning []")
        return []

    # Query text: skill_name + prompt only (args/outcome not known at retrieve time)
    query_text = f"{skill_name} {prompt}"
    embedding = _generate_embedding(query_text)
    embedding_str = _embedding_to_str(embedding)

    try:
        conn = _get_conn()
    except Exception as exc:
        log.warning("retrieve_similar: PG unavailable — %s", exc)
        return []

    try:
        with conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                # pgvector cosine query (skipped if no embedding)
                vector_results: list = []
                if embedding_str is not None:
                    raw_vector = _query_vector_neighbors(
                        cur, skill_name, embedding_str, recency_days, _VECTOR_LIMIT
                    )
                    # Post-filter: drop rows below cosine_floor
                    for row in raw_vector:
                        sim = float(row.get("similarity") or 0.0)
                        if sim >= cosine_floor:
                            vector_results.append(row)

                # BM25 query (always run)
                bm25_results = _query_bm25_neighbors(
                    cur, skill_name, query_text, recency_days, _BM25_LIMIT
                )
    except Exception as exc:
        log.warning("retrieve_similar: query failed — %s", exc)
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # Reciprocal rank fusion
    fused = _reciprocal_rank_fusion(list(vector_results), list(bm25_results))

    # Trim to top-k and normalize output keys
    result = []
    for row in fused[:k]:
        # Ensure args is a dict (may be JSON string from DB)
        args_val = row.get("args")
        if isinstance(args_val, str):
            try:
                args_val = json.loads(args_val)
            except (json.JSONDecodeError, TypeError):
                args_val = {}
        result.append({
            "id": str(row.get("id", "")),
            "invocation_text": row.get("invocation_text", ""),
            "args": args_val or {},
            "outcome_class": row.get("outcome_class"),
            "invoked_at": str(row.get("invoked_at", "")) if row.get("invoked_at") else None,
            "rrf_score": float(row.get("rrf_score", 0.0)),
            "vector_similarity": float(row["vector_similarity"]) if "vector_similarity" in row else None,
            "bm25_score": float(row["bm25_score"]) if "bm25_score" in row else None,
        })

    return result

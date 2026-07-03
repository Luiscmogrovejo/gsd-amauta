#!/usr/bin/env python3
"""
PostgreSQL store for GSD-Amauta — memory, SKB, and task persistence.

When GSD_POSTGRES_URL is set, the daemon uses this module for:
  - Memory storage/search with source-aware scoring
  - Shared Knowledge Base (SKB) storage/search
  - Task validation audit trail

Falls back gracefully if PG is unavailable — all methods return None/[] and
the daemon continues with subprocess-based amauta.py for task management.

Source-aware scoring (from Amauta spec):
  lesson-learned +4, best-practice +4, auto_learning +3,
  web_search_result +3, session-learning +3, distilled +2,
  rpetd_phase +1, task_event +0, agent +0
"""

import hashlib
import json
import math
import os
import re
import threading
import time
import urllib.request
import urllib.error
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2.pool import ThreadedConnectionPool
    HAS_PG = True
except ImportError:
    HAS_PG = False

# Phase 66 MEMR-03: dual-import of the Phase 65 shared-primitive
# hybrid_search_generic (services/rlm_search.py). Script-launched daemons
# may run with a different sys.path root than pytest/module imports (Phase
# 60/65 silent-import class), so both `services.rlm_search` (package-relative,
# the normal case) and bare `rlm_search` (script launched from services/ with
# services/ itself on sys.path) are tried before giving up. On total failure,
# _HYBRID_GENERIC_AVAILABLE is set False and memory_search's router degrades
# straight to its rung-2 legacy FTS path -- loud stderr warning, never silent.
try:
    from services.rlm_search import hybrid_search_generic, _sanitize_query as _rlm_sanitize_query
    _HYBRID_GENERIC_AVAILABLE = True
except ImportError:
    try:
        from rlm_search import hybrid_search_generic, _sanitize_query as _rlm_sanitize_query
        _HYBRID_GENERIC_AVAILABLE = True
    except ImportError as _hybrid_import_err:
        import sys as _sys
        print(
            f"[pg_store] WARNING: hybrid_search_generic import failed "
            f"({_hybrid_import_err}) -- memory_search will degrade to the "
            f"legacy FTS/ILIKE ranking rungs only. Check sys.path includes "
            f"the repo root (services.rlm_search) or services/ itself "
            f"(rlm_search).",
            file=_sys.stderr,
        )
        _HYBRID_GENERIC_AVAILABLE = False

        def hybrid_search_generic(*_args, **_kwargs):  # pragma: no cover
            """Stub — never called; _HYBRID_GENERIC_AVAILABLE gates all call sites."""
            raise ImportError("hybrid_search_generic unavailable (see startup warning)")

        def _rlm_sanitize_query(q):  # pragma: no cover
            """Stub sanitizer — never called; _HYBRID_GENERIC_AVAILABLE gates rung 1."""
            return q

# Phase 66 MEMR-08: dual-import of services/memory_classifier.py's
# classify_memory_op (fail-open write-time ADD/UPDATE/DELETE/NOOP
# classifier), following the SAME services.-prefixed/bare fallback
# convention as the rlm_search import above (script-launched daemons may
# run with a different sys.path root than pytest/module imports). Imported
# as a bare module-level name so tests can monkeypatch
# `services.pg_store.classify_memory_op` directly (the store methods below
# call the bare name, not a qualified `memory_classifier.classify_memory_op`,
# so a monkeypatched replacement is actually honored). On total failure,
# _MEMORY_CLASSIFIER_AVAILABLE is False and both store methods skip
# classification entirely (plain ADD path only) -- loud stderr warning,
# never silent.
try:
    from services.memory_classifier import classify_memory_op
    _MEMORY_CLASSIFIER_AVAILABLE = True
except ImportError:
    try:
        from memory_classifier import classify_memory_op
        _MEMORY_CLASSIFIER_AVAILABLE = True
    except ImportError as _classifier_import_err:
        import sys as _sys3
        print(
            f"[pg_store] WARNING: memory_classifier import failed "
            f"({_classifier_import_err}) -- memory_store/memory_store_with_embedding "
            f"will skip write-time classification (plain ADD path only). Check "
            f"sys.path includes the repo root (services.memory_classifier) or "
            f"services/ itself (memory_classifier).",
            file=_sys3.stderr,
        )
        _MEMORY_CLASSIFIER_AVAILABLE = False

        def classify_memory_op(*_args, **_kwargs):  # pragma: no cover
            """Stub — never called; _MEMORY_CLASSIFIER_AVAILABLE gates all call sites."""
            return {"op": "ADD", "target_id": None, "reason": "classifier-unavailable"}

# ═══════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════

DEFAULT_PG_URL = "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta"

SOURCE_SCORES = {
    "lesson-learned": 4,
    "best-practice": 4,
    "auto_learning": 3,
    "web_search_result": 3,
    "session-learning": 3,
    "distilled": 2,
    "rpetd_phase": 1,
    "task_event": 0,
    "agent": 0,
}

# MEM-01: Default sources excluded from search (low signal, noise)
DEFAULT_EXCLUDE_SOURCES = ("task_event", "rpetd_phase")

# MEM-03: Recency decay — penalizes old entries so recent memories rank higher
RECENCY_DECAY_PER_30D = float(os.environ.get("GSD_RECENCY_DECAY_PER_30D", "0.5"))
MAX_RECENCY_PENALTY = 3.0  # Cap at 6 months of decay

# Phase 66 MEMR-07: rerank BLENDS with composite score instead of replacing
# it — a stale task_event should not be able to outrank a fresh cited
# lesson-learned merely because Voyage's cross-encoder slightly prefers it.
# final = score_composite + RERANK_BLEND_WEIGHT * rerank_relevance_score
# (rerank_relevance_score in [0, 1], scaled up to compete with the
# source-bonus/citation-boost range in _score_semantic_results).
RERANK_BLEND_WEIGHT = float(os.environ.get("GSD_RERANK_BLEND_WEIGHT", "4.0"))

# MEM-05: Dedup thresholds (audited 2026-04-06)
# - Pre-store cosine dedup: 0.95 (env: GSD_DEDUP_THRESHOLD) -- near-identical detection
#   Threshold 0.95 is correct per industry benchmarks; values >0.98 miss paraphrases,
#   values <0.90 over-deduplicate semantically distinct entries.
# - Distillation grouping: Jaccard 0.7 (in gsd-memory.cjs, threshold || '0.7') -- topic-level grouping
# - Cosine 0.85 for distill grouping deferred to MEM-02 (LLM summarization plan)
#
# MEM-06: Scoring formula (audited 2026-04-06)
# - pg_store.py (daemon path): score = ts_rank * 10 + source_bonus - recency_penalty
#   ts_rank is PostgreSQL full-text search relevance (0.0-1.0 float)
# - amauta.py (direct path): score = SUM(per-term LIKE matches) + source_bonus - recency_penalty
#   LIKE count is integer (number of terms matched)
# - source_bonus values (SOURCE_SCORES dict above) are IDENTICAL across both paths
# - recency_penalty formula is IDENTICAL: min(decay_per_30d * days/30, MAX_RECENCY_PENALTY)
# - Difference in base score method (ts_rank vs LIKE count) is intentional:
#   daemon path uses full PG text search; direct path is a lightweight fallback
# - Both paths apply recency decay -- no gap. (Plan 02-02 scope: MEM-07 semantic gap)
#
# MEM-02/MEM-08: Tiered retention -- archive stale entries by source type
# Permanent: lesson-learned, best-practice, distilled (not in dict = never archived)
# Long: auto_learning, session-learning (not in dict = never archived, decay handles ranking)
# Medium: web_search_result (180 days)
# Short: rpetd_phase (90 days)
# Ephemeral: task_event (30 days)
RETENTION_DAYS = {
    "task_event": 30,
    "rpetd_phase": 90,
    "web_search_result": 180,
}

# MEMR-02/05 (Phase 66): citation boost + merged-source carry-forward
# ─────────────────────────────────────────────────────────────────
# citation_boost = min(log1p(applied_count), CITATION_BOOST_CAP) — bounded so a
# single heavily-cited memory cannot dominate ranking on its own (research
# pitfall 3, "echo chamber"). log1p(0) == 0, so never-cited rows are
# byte-identical to pre-Phase-66 scores.
CITATION_BOOST_CAP = 3.0

# MEMR-03/04 (Phase 66): RRF-fused relevance scale.
# hybrid_search_generic's rrf_score (1/(k+rank_bm25) + 1/(k+rank_vector), k=60)
# tops out around 2/61 ~= 0.033 for a rank-1-both-legs hit. RRF_SCALE maps
# that ceiling to ~10, matching the 0-10 scale _score_memories/
# _score_semantic_results already use for their own relevance term
# (text_rank*10 / similarity*10) -- one scoring vocabulary, not a third
# formula (CONTEXT must_have). Tunable; exact weight is Claude's-discretion
# per CONTEXT.md.
RRF_SCALE = 300.0


def _citation_boost(applied_count):
    """Bounded log1p citation boost. NULL/absent applied_count treated as 0."""
    try:
        n = float(applied_count or 0)
    except (TypeError, ValueError):
        n = 0.0
    if n < 0:
        n = 0.0
    return min(math.log1p(n), CITATION_BOOST_CAP)


def _carried_source_bonus(d, source_bonus):
    """Carry-forward source bonus from a distill merge's metadata.merged_sources.

    Distilled entries keep source='distilled' (+2, DATA-03 exclusion contract
    stays intact) but their metadata may carry `merged_sources` — the list of
    distinct original source strings folded into this entry. The carried bonus
    is the MAX of the entry's own bonus and every merged source's bonus, capped
    at the SOURCE_SCORES ceiling (4) — it can only raise, never lower, the
    entry's own bonus.
    """
    meta = d.get("metadata")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except (TypeError, ValueError):
            meta = None
    if not isinstance(meta, dict):
        return source_bonus
    merged = meta.get("merged_sources") or []
    if not isinstance(merged, list):
        return source_bonus
    carried_max = max((SOURCE_SCORES.get(s, 0) for s in merged), default=0)
    return min(max(source_bonus, carried_max), 4)


# ═══════════════════════════════════════════════════════
# Phase 66 MEMR-03/04: memory hybrid router shared helpers
# ═══════════════════════════════════════════════════════

def _memory_bm25_query(safe_query):
    """Field-qualify a sanitized query against gsd_memory's `text` column for
    the pg_search `@@@` operator.

    Live-verified (2026-07-03) against pg_search 0.24.1: an unqualified bare
    term (no `field:` prefix) parses against the BM25 index's key_field
    (`id`, a `mem-<hex>` VARCHAR string on gsd_memory) instead of the `text`
    column, so a plain-English query word matches zero rows every time
    (`gsd_memory @@@ 'hybrid'` -> 0 rows; `gsd_memory @@@ 'text:hybrid'` ->
    real matches). rlm_chunks' `_boosted_rlm_query` solves the same
    requirement with per-field weighting across three columns; gsd_memory's
    BM25 index only covers (id, text), so this helper just field-qualifies
    against `text` -- no column-boost needed here.
    """
    terms = safe_query.split()
    if not terms:
        return ""
    return " ".join(f"text:{term}" for term in terms)


def _memory_filter_sql(project_id=None, source=None,
                        exclude_sources=DEFAULT_EXCLUDE_SOURCES,
                        tags=None, category=None, valid_only=False):
    """Build the (filter_sql, filter_params) pair every memory_search rung
    applies -- test-row exclusion, project_id, source, exclude_sources,
    tags ?|, category, and (Phase 66 MEMR-08) validity. Identical condition
    set to pre-66-03 memory_search, rendered as " AND ..." fragments for
    hybrid_search_generic's filter_sql contract instead of a WHERE-joined
    list.

    Column names are intentionally NOT table-alias-qualified: every SQL
    context this fragment is spliced into (hybrid_search_generic's per-leg
    CTEs, aliased `c`, and its _generic_bm25_only degradation branch, which
    queries the bare unaliased table name) has exactly one table in scope at
    the splice point, so a bare column name resolves unambiguously in both --
    an alias-qualified fragment would break the unaliased degradation branch.

    Single builder (rather than duplicated inline condition lists per rung)
    is what lets a later wave extend the filter set from one place
    (CONTEXT.md instruction).

    Args:
        valid_only: Phase 66 MEMR-08 -- when True, appends
            "AND invalid_at IS NULL" so only currently-valid memories are
            returned. Callers MUST pass this as `self._has_bitemporal()`
            (never hardcode True) so an un-migrated database (no
            valid_at/invalid_at columns) degrades gracefully instead of
            raising a column-does-not-exist error.
    """
    conditions = []
    params = []

    # DATA-06: exclude test entries from default search
    if project_id != '__test__':
        conditions.append("(project_id IS NULL OR project_id != '__test__')")

    if project_id:
        conditions.append("project_id = %s")
        params.append(project_id)

    if source:
        conditions.append("source = %s")
        params.append(source)

    # MEM-01: exclude low-signal sources by default
    if exclude_sources:
        placeholders = ", ".join(["%s"] * len(exclude_sources))
        conditions.append(f"source NOT IN ({placeholders})")
        params.extend(exclude_sources)

    # Phase 10 LEARN-03 -- tags filter via GIN ?| jsonb operator
    if tags:
        filter_tags = normalize_tags_list(tags)
        if filter_tags:
            conditions.append("tags ?| %s::text[]")
            params.append(filter_tags)

    # Phase 10 LEARN-03 -- category filter via metadata->>'category'
    if category:
        conditions.append("metadata->>'category' = %s")
        params.append(str(category).lower())

    # Phase 66 MEMR-08 -- validity filter (guarded by caller's
    # _has_bitemporal() check; see the `valid_only` docstring above).
    if valid_only:
        conditions.append("invalid_at IS NULL")

    filter_sql = "".join(f" AND {c}" for c in conditions)
    return filter_sql, params


def _jaccard(a, b):
    """Token-set Jaccard similarity, used by memory_search's rung-3 rescue
    scoring (when pg_trgm's similarity() is unavailable) and reused by
    wave 4's no-embedding write-time dedup fallback (MEMR-06).

    Empty-input safe: returns 0.0 rather than dividing by zero when both
    inputs are blank/tokenless (never raises on a degenerate query/text pair).
    """
    set_a = set((a or "").lower().split())
    set_b = set((b or "").lower().split())
    union = set_a | set_b
    if not union:
        return 0.0
    return len(set_a & set_b) / len(union)


def _score_core(d, relevance, now):
    """Shared scoring core (Phase 66 MEMR-02/03/04/05), factored out of
    _score_memories/_score_semantic_results so every ranking path (FTS,
    ILIKE-trigram, ILIKE-jaccard, RRF-fused) applies the SAME source bonus
    (incl. merged_sources carry), citation boost, and recency decay -- one
    scoring vocabulary, not a third formula.

    `relevance` is the caller's ALREADY 0-10-scaled relevance term
    (text_rank*10, similarity*10, or the RRF_SCALE-mapped fused score) --
    this function only adds the bonus/boost/penalty terms on top and does
    not itself apply a *10 multiplier.

    Mutates and returns `d` in place: sets d["score"], serializes
    datetime/Decimal values, and drops the (large, binary) embedding column
    from the output.
    """
    source_bonus = SOURCE_SCORES.get(d.get("source", "agent"), 0)
    source_bonus = _carried_source_bonus(d, source_bonus)
    citation_boost = _citation_boost(d.get("applied_count"))

    recency_penalty = 0.0
    created_at = d.get("created_at")
    if RECENCY_DECAY_PER_30D > 0 and created_at is not None:
        try:
            if isinstance(created_at, str):
                ca = datetime.fromisoformat(created_at)
            else:
                ca = created_at
            if ca.tzinfo is None:
                ca = ca.replace(tzinfo=timezone.utc)
            days_old = max((now - ca).days, 0)
            recency_penalty = min(
                RECENCY_DECAY_PER_30D * (days_old / 30.0),
                MAX_RECENCY_PENALTY,
            )
        except (ValueError, TypeError, AttributeError):
            pass  # unparseable -- no decay

    d["score"] = round(relevance + source_bonus + citation_boost - recency_penalty, 2)

    for key in ("created_at", "updated_at"):
        if key in d and isinstance(d[key], datetime):
            d[key] = d[key].isoformat()
    for key, val in list(d.items()):
        if isinstance(val, Decimal):
            d[key] = float(val)
    d.pop("embedding", None)
    return d


# ═══════════════════════════════════════════════════════
# Tag synonym normalization (shared with sqlite_store.py)
# ═══════════════════════════════════════════════════════
#
# Phase 10 LEARN-04: Tag governance rules are now loaded from
# get-shit-done/config/tag-rules.json (shared with gsd-memory.cjs Node.js path).
# The hardcoded TAG_SYNONYMS dict below is kept as a fallback when the JSON
# config cannot be found (defense in depth — daemon must never crash on a
# missing config file).

TAG_SYNONYMS = {
    "postgres": "postgresql",
    "pg": "postgresql",
    "k8s": "kubernetes",
    "kube": "kubernetes",
    "js": "javascript",
    "ts": "typescript",
    "py": "python",
    "node": "nodejs",
    "react-native": "react",
    "reactnative": "react",
    "mongo": "mongodb",
    "gql": "graphql",
    "tf": "terraform",
    "docker-compose": "docker",
    "compose": "docker",
    # Phase 10 additions (mirror tag-rules.json)
    "db": "database",
    "ci": "ci-cd",
    "cd": "ci-cd",
    "auth": "authentication",
    "oidc": "openid-connect",
    "sso": "single-sign-on",
    "fe": "frontend",
    "be": "backend",
    "e2e": "end-to-end",
    "perf": "performance",
    "mem": "memory",
}


# --- Phase 10 LEARN-04: Tag governance rules loaded from config/tag-rules.json ---
_TAG_RULES_CACHE = None
_TAG_RULES_WARNED = False


def load_tag_rules():
    """Load tag governance rules from get-shit-done/config/tag-rules.json.

    Tries (in order):
      1. Repo-local: ../get-shit-done/config/tag-rules.json relative to this file
      2. ~/.claude/get-shit-done/config/tag-rules.json (installed location)

    Falls back to hardcoded defaults if the file is missing. Cached after
    first successful load so subsequent calls are zero-cost.

    Returns:
        dict with keys: banned, synonyms, vocabulary, tiers
    """
    global _TAG_RULES_CACHE, _TAG_RULES_WARNED
    if _TAG_RULES_CACHE is not None:
        return _TAG_RULES_CACHE

    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(here, "..", "get-shit-done", "config", "tag-rules.json"),
        os.path.join(
            os.environ.get("HOME", ""),
            ".claude",
            "get-shit-done",
            "config",
            "tag-rules.json",
        ),
    ]
    for p in candidates:
        try:
            if os.path.exists(p):
                with open(p, "r") as f:
                    _TAG_RULES_CACHE = json.load(f)
                return _TAG_RULES_CACHE
        except Exception:
            continue

    if not _TAG_RULES_WARNED:
        import sys
        print(
            "[pg_store] tag-rules.json not found; using hardcoded defaults",
            file=sys.stderr,
        )
        _TAG_RULES_WARNED = True
    _TAG_RULES_CACHE = {
        "banned": ["best-practice", "general", "lesson", "insight"],
        "synonyms": dict(TAG_SYNONYMS),
        "vocabulary": {},
        "tiers": {
            "domain": [
                "postgresql", "mysql", "sqlite", "redis", "kubernetes",
                "docker", "react", "vue", "nodejs", "python", "go", "rust",
            ],
            "technique": [
                "connection-pool", "memoization", "idempotency", "pagination",
                "rate-limit", "query-optimization", "n-plus-1",
                "cache-invalidation", "graceful-shutdown",
            ],
            "scope": [
                "backend", "frontend", "database", "api", "testing",
                "infrastructure", "security", "performance", "authentication",
                "caching", "deployment", "monitoring",
            ],
            "meta": [
                "pattern", "pitfall", "convention", "architecture",
                "policy", "workflow", "process", "delivery", "tool-usage",
            ],
        },
    }
    return _TAG_RULES_CACHE


def _tag_tier(tag, rules):
    """Return 0..3 — lower = more specific (kept first during auto-trim).

    Tier ranking:
        0 = domain (postgresql, react, nodejs, ...)
        1 = technique (connection-pool, memoization, ...)
        2 = scope (backend, frontend, testing, ...)
        3 = meta (pattern, pitfall, convention, ...)
    Unknown tags default to 2 (scope).
    """
    tiers = rules.get("tiers", {}) or {}
    if tag in (tiers.get("domain") or []):
        return 0
    if tag in (tiers.get("technique") or []):
        return 1
    if tag in (tiers.get("scope") or []):
        return 2
    if tag in (tiers.get("meta") or []):
        return 3
    return 2  # unknown tags default to "scope" tier


def normalize_tags(input_tags):
    """Phase 10 LEARN-04: Normalize, strip banned, enforce cap of 5 by tier.

    Defense-in-depth tag governance — matches gsd-memory.cjs normalizeTags()
    semantics exactly. The operator's parse-learning path bypasses the Node
    CLI, so this daemon-side function must validate independently.

    Args:
        input_tags: list[str] or comma-separated str (or None/falsy).

    Returns:
        dict: {
            "tags": list[str],           # normalized, stripped, trimmed
            "warnings": list[str],       # non-fatal notes (banned stripped, trimmed)
            "error": str | None,         # set ONLY when all tags are banned
        }
    """
    rules = load_tag_rules()
    warnings = []

    # Accept list, comma-separated string, or None/empty
    if isinstance(input_tags, str):
        tags = [t.strip() for t in input_tags.split(",") if t.strip()]
    elif isinstance(input_tags, list):
        tags = [str(t).strip() for t in input_tags if str(t).strip()]
    else:
        tags = []

    # Lowercase + dedupe + synonym normalization
    synonyms = rules.get("synonyms", {}) or {}
    seen = set()
    normalized = []
    for t in tags:
        tl = t.lower()
        tl = synonyms.get(tl, tl)
        if tl not in seen:
            seen.add(tl)
            normalized.append(tl)
    tags = normalized

    # Strip banned tags
    banned_set = set(rules.get("banned", []) or [])
    stripped = [t for t in tags if t in banned_set]
    tags = [t for t in tags if t not in banned_set]
    if stripped:
        warnings.append("Stripped banned tags: " + ", ".join(stripped))

    # Reject if nothing useful remains (cross-runtime parity with Node error msg)
    if not tags:
        vocab_flat = []
        for domain_tags in (rules.get("vocabulary", {}) or {}).values():
            if isinstance(domain_tags, list):
                vocab_flat.extend(domain_tags[:2])
        suggest = (
            ", ".join(vocab_flat[:4])
            if vocab_flat
            else "postgresql, connection-pool"
        )
        reason = ", ".join(stripped) if stripped else "empty"
        return {
            "tags": [],
            "warnings": warnings,
            "error": (
                f"Rejected: all tags are generic ({reason}). "
                f"Add specific tags like '{suggest}'. "
                "See learning-format.md."
            ),
        }

    # Auto-trim to 5 most specific by tier ranking (domain > technique > scope > meta)
    if len(tags) > 5:
        before = len(tags)
        tags = sorted(tags, key=lambda t: _tag_tier(t, rules))[:5]
        warnings.append(f"Trimmed {before}->5 tags, kept: [{', '.join(tags)}]")

    return {"tags": tags, "warnings": warnings, "error": None}


def normalize_tags_list(input_tags):
    """Backward-compat shim — returns just the normalized tag list.

    Silently drops banned tags and trim warnings. Used by internal paths that
    don't want to surface validation errors (e.g. cross-project search filters).
    """
    result = normalize_tags(input_tags)
    return result.get("tags", [])


# MEM-04: Query embedding cache -- avoids redundant Voyage API calls for repeated searches
_QUERY_EMBED_CACHE: dict = {}   # { cache_key: (embedding_list, timestamp) }
_QUERY_EMBED_TTL = 3600         # 1 hour in seconds
_QUERY_EMBED_MAX = 500          # Max cached entries before eviction


def _clear_query_embed_cache():
    """Clear the query embedding cache. Exposed for test isolation."""
    _QUERY_EMBED_CACHE.clear()


# INF-05/TOK-06: Redis L2 embedding cache (cross-invocation persistence)
_REDIS_EMBED_TTL = 3600  # 1 hour, matches L1 dict TTL
_REDIS_EMBED_PREFIX = "gsd:emb:"


def _redis_embed_get(cache_key):
    """Try to get embedding from Redis L2 cache. Returns list[float] or None."""
    try:
        # Lazy import -- daemon may or may not have redis
        from amauta_daemon_redis import get_redis_client
        client = get_redis_client()
        if not client:
            return None
        raw = client.get(f"{_REDIS_EMBED_PREFIX}{cache_key}")
        if raw:
            return json.loads(raw)
    except Exception:
        pass
    return None


def _redis_embed_set(cache_key, embedding):
    """Write embedding to Redis L2 cache. Silent on failure."""
    try:
        from amauta_daemon_redis import get_redis_client
        client = get_redis_client()
        if not client:
            return
        client.setex(
            f"{_REDIS_EMBED_PREFIX}{cache_key}",
            _REDIS_EMBED_TTL,
            json.dumps(embedding),
        )
    except Exception:
        pass


class PGStore:
    """Thread-safe PostgreSQL store with connection pooling and reconnect."""

    def __init__(self, dsn=None, min_conn=2, max_conn=10):
        """Initialize connection pool.

        Args:
            dsn: PostgreSQL DSN. Falls back to GSD_POSTGRES_URL env, then default.
            min_conn: Minimum pool connections.
            max_conn: Maximum pool connections.
        """
        if not HAS_PG:
            raise ImportError("psycopg2 not installed. Run: pip install psycopg2-binary")

        self.dsn = dsn or os.environ.get("GSD_POSTGRES_URL", DEFAULT_PG_URL)
        self.min_conn = min_conn
        self.max_conn = max_conn
        self._pool = None
        self._lock = threading.Lock()
        self._connect()

    def _connect(self):
        """Create or recreate the connection pool."""
        with self._lock:
            if self._pool is not None:
                try:
                    self._pool.closeall()
                except Exception:
                    pass
            self._pool = ThreadedConnectionPool(
                self.min_conn, self.max_conn, self.dsn
            )

    @contextmanager
    def _get_conn(self):
        """Get a connection from pool with auto-reconnect.
        
        Uses a single-yield pattern to avoid the double-yield bug where a
        contextmanager generator yields twice (reconnect path), causing the
        finally block to run with a stale conn variable and leak the new connection.
        """
        conn = None
        reconnected = False
        try:
            conn = self._pool.getconn()
            conn.autocommit = False
        except (psycopg2.OperationalError, psycopg2.InterfaceError):
            # Initial getconn failed — try reconnecting once
            if conn:
                try:
                    self._pool.putconn(conn, close=True)
                except Exception:
                    pass
                conn = None
            self._connect()
            conn = self._pool.getconn()
            conn.autocommit = False
            reconnected = True
        # INFRA-02: Enable iterative index scans for filtered vector queries (pgvector >= 0.8.0)
        # Phase 66 MEMR-07: corrected from ivfflat -- the only vector index on
        # gsd_memory is idx_gsd_memory_embedding_hnsw (HNSW); the ivfflat GUC
        # was a no-op for every filtered query this connection ever ran.
        with conn.cursor() as _setup_cur:
            try:
                _setup_cur.execute("SET hnsw.iterative_scan = relaxed_order")
            except Exception:
                pass  # Gracefully skip if pgvector not installed (e.g., SQLite fallback)
        try:
            yield conn
            conn.commit()
        except (psycopg2.OperationalError, psycopg2.InterfaceError):
            # Connection died mid-transaction — rollback and re-raise.
            # Do NOT allocate a new connection here: the finally block would
            # putconn() that unused connection, leaking the slot.
            try:
                conn.rollback()
            except Exception:
                pass
            if not reconnected:
                try:
                    self._pool.putconn(conn, close=True)
                    conn = None
                except Exception:
                    pass
                # Just reconnect the pool so the next caller gets a fresh conn
                try:
                    self._connect()
                except Exception:
                    pass
            raise
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            if conn:
                try:
                    self._pool.putconn(conn)
                except Exception:
                    pass

    @staticmethod
    def _sanitize_error(e):
        """Sanitize error message to prevent DSN/password leakage."""
        msg = str(e)
        # Remove anything before @ in a DSN pattern (contains user:password)
        import re as _re
        msg = _re.sub(r'postgresql://[^@]+@', 'postgresql://[redacted]@', msg)
        msg = _re.sub(r'postgres://[^@]+@', 'postgres://[redacted]@', msg)
        return msg

    def _has_bitemporal(self):
        """Phase 66 MEMR-08: cached (per-instance) check for whether
        migration 026's valid_at/invalid_at columns exist on gsd_memory.

        An un-migrated database must degrade gracefully -- every validity
        SQL fragment (the `valid_only` flag on `_memory_filter_sql`, the
        `invalid_at IS NULL` guard in memory_semantic_search and the
        dedup/NN candidate queries) becomes a no-op rather than raising a
        column-does-not-exist error. Cached on `self._bitemporal_cache`
        after the first check (one information_schema query per instance
        lifetime, not per call) -- tests force the un-migrated path by
        setting `store._bitemporal_cache = False` directly.
        """
        if hasattr(self, "_bitemporal_cache"):
            return self._bitemporal_cache
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT COUNT(*) FROM information_schema.columns "
                        "WHERE table_name = 'gsd_memory' "
                        "AND column_name IN ('valid_at', 'invalid_at')"
                    )
                    count = cur.fetchone()[0]
            self._bitemporal_cache = (count == 2)
        except Exception:
            self._bitemporal_cache = False
        return self._bitemporal_cache

    def health(self):
        """Check PG connection health."""
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
                    return {"status": "ok", "dsn_host": self.dsn.split("@")[-1].split("/")[0]}
        except Exception as e:
            return {"status": "error", "error": self._sanitize_error(e)}

    # ═══════════════════════════════════════════════════════
    # Memory Operations
    # ═══════════════════════════════════════════════════════

    def memory_store(self, text, source="agent", agent_id=None, tags=None,
                     metadata=None, project_id=None, applied_count=0,
                     skip_dedup=False):
        """Store a memory entry.

        Phase 10 LEARN-02/04: metadata dict may contain structured fields:
            {
              "what": "...",
              "why": "...",
              "when": "...",
              "category": "pattern",
              "structured": True,
              "structured_version": "1.0"
            }

        Tag validation (LEARN-04) runs here as defense in depth — the operator's
        parse-learning path bypasses the gsd-memory.cjs CLI so the daemon MUST
        also strip banned tags and auto-trim to 5. If all provided tags are
        banned, this raises ValueError and the insert is aborted.

        Kill switch: if env var GSD_D_STRUCTURED=false, structured metadata is
        flattened to plain {} before insert (operator stores the LEARNING body
        as free-text in the `text` column).

        Phase 66 MEMR-02/05: applied_count seeds the citation count on insert —
        used by the distill merge path (gsd-memory.cjs) to carry forward the
        SUM of applied_count across merged entries so citation signal survives
        distillation instead of resetting to zero. Coerced to a non-negative
        int; any bad value (None, non-numeric) silently defaults to 0.

        Phase 66 MEMR-06: no-API-key/no-embedding writes land here directly
        (memory_store_with_embedding falls back to this method when
        generate_embedding() returns None), so THIS path needs its own
        write-time dedup — trigram similarity first, Jaccard token-overlap
        second. Kill-switch semantics: dedup NEVER blocks a write. Any
        exception at either rung is logged (one stderr line) and execution
        falls through to the plain INSERT. Pass skip_dedup=True to bypass
        entirely (e.g. distill's merge-store, which legitimately writes text
        similar to what it is replacing).

        Returns the new memory ID, or a dedup dict identical in shape to
        memory_store_with_embedding's DATA-04 dedup response:
        {"dedup_skipped": True, "existing_id": ..., "similarity": ...}
        """
        import sys

        # Phase 10 LEARN-02 kill switch — disables structured metadata path
        if os.environ.get("GSD_D_STRUCTURED") == "false":
            if metadata and metadata.get("structured"):
                print(
                    "[pg_store] Structured learning disabled "
                    "(GSD_D_STRUCTURED=false), storing as free-text",
                    file=sys.stderr,
                )
                metadata = None

        # Phase 10 LEARN-04 defense-in-depth tag governance
        # TK-1704: empty/None tag list is a valid "no tags" store, not a governance
        # rejection — skip normalize_tags() entirely rather than calling it with []
        # (normalize_tags([]) intentionally rejects empty input; see its own
        # cross-runtime parity contract at line ~281 and its pinned tests).
        if tags:
            tag_result = normalize_tags(tags)
            if tag_result.get("error"):
                raise ValueError(tag_result["error"])
            tags = tag_result.get("tags", [])
            for w in tag_result.get("warnings", []):
                print(f"[pg_store] {w}", file=sys.stderr)
        else:
            tags = []

        try:
            applied_count = max(0, int(applied_count or 0))
        except (TypeError, ValueError):
            applied_count = 0

        # Phase 66 MEMR-06: no-embedding write-time dedup (trigram rung, then
        # Jaccard rung). Never blocks a write.
        # Phase 66 MEMR-08: the trigram rung's SELECT is also the candidate
        # source for the write-time classifier below (LIMIT widened 1 -> 3,
        # `text` column added) -- one query serves both the dedup check
        # (row 0) and the classifier's top-3 nearest valid candidates, not
        # a second query.
        _trigram_top3 = []
        if not skip_dedup:
            dedup_hit = None
            trigram_threshold = float(os.environ.get("GSD_TEXT_DEDUP_THRESHOLD", "0.6"))
            _validity_clause = " AND invalid_at IS NULL" if self._has_bitemporal() else ""
            try:
                with self._get_conn() as conn:
                    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                        cur.execute(f"""
                            SELECT id, text, similarity(text, %s) AS sim
                            FROM gsd_memory
                            WHERE (project_id = %s OR (project_id IS NULL AND %s IS NULL))
                              AND text %% %s
                              {_validity_clause}
                            ORDER BY sim DESC
                            LIMIT 3
                        """, (text, project_id, project_id, text))
                        _trigram_top3 = cur.fetchall()
                        if _trigram_top3 and float(_trigram_top3[0]["sim"]) >= trigram_threshold:
                            dedup_hit = {
                                "dedup_skipped": True,
                                "existing_id": _trigram_top3[0]["id"],
                                "similarity": round(float(_trigram_top3[0]["sim"]), 4),
                            }
            except Exception as e:
                print(
                    f"[pg_store] memory_store trigram dedup rung failed "
                    f"({type(e).__name__}: {e}) — falling back to Jaccard rung",
                    file=sys.stderr,
                )
                _trigram_top3 = []  # rung failed -- no classifier candidates either
                jaccard_threshold = float(
                    os.environ.get("GSD_TEXT_DEDUP_JACCARD_THRESHOLD", "0.85")
                )
                try:
                    with self._get_conn() as conn:
                        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                            cur.execute("""
                                SELECT id, text FROM gsd_memory
                                WHERE (project_id = %s OR (project_id IS NULL AND %s IS NULL))
                                ORDER BY created_at DESC
                                LIMIT 200
                            """, (project_id, project_id))
                            candidates = cur.fetchall()
                    best_id, best_sim = None, 0.0
                    for cand in candidates:
                        sim = _jaccard(text, cand["text"])
                        if sim > best_sim:
                            best_sim, best_id = sim, cand["id"]
                    if best_id is not None and best_sim >= jaccard_threshold:
                        dedup_hit = {
                            "dedup_skipped": True,
                            "existing_id": best_id,
                            "similarity": round(best_sim, 4),
                        }
                except Exception as e2:
                    print(
                        f"[pg_store] memory_store jaccard dedup rung failed "
                        f"({type(e2).__name__}: {e2}) — proceeding to insert without dedup",
                        file=sys.stderr,
                    )
            if dedup_hit:
                return dedup_hit

        # Phase 66 MEMR-08: write-time classifier (ADD/UPDATE/DELETE/NOOP).
        # skip_dedup writes (distill merges) also skip classification -- a
        # distill merge legitimately writes text similar to what it is
        # replacing and must not be classified against its own originals.
        # Zero candidates (empty _trigram_top3, e.g. the trigram rung raised
        # above) skips straight to ADD -- no LLM call wasted.
        _superseded_id = None
        if not skip_dedup and _MEMORY_CLASSIFIER_AVAILABLE and _trigram_top3:
            _classifier_candidates = [
                {"id": r["id"], "text": r["text"]} for r in _trigram_top3
            ]
            try:
                _decision = classify_memory_op(text, _classifier_candidates)
            except Exception as e:
                print(
                    f"[pg_store] memory_store classifier raised "
                    f"({type(e).__name__}: {e}) — proceeding as ADD",
                    file=sys.stderr,
                )
                _decision = {"op": "ADD"}
            _op = _decision.get("op", "ADD")
            _target_id = _decision.get("target_id")
            if _op == "NOOP":
                return {
                    "noop": True,
                    "existing_id": _target_id or _classifier_candidates[0]["id"],
                }
            if _op == "DELETE" and _target_id is not None:
                with self._get_conn() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE gsd_memory SET invalid_at = now() "
                            "WHERE id = %s AND invalid_at IS NULL",
                            (_target_id,),
                        )
                return {"deleted_target": _target_id}
            if _op == "UPDATE" and _target_id is not None:
                with self._get_conn() as conn:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE gsd_memory SET invalid_at = now() "
                            "WHERE id = %s AND invalid_at IS NULL",
                            (_target_id,),
                        )
                _superseded_id = _target_id
            # ADD (and any other/failure outcome) falls through to the
            # plain INSERT below, unchanged.

        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO gsd_memory (text, source, agent_id, tags, metadata, project_id, applied_count)
                    VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)
                    RETURNING id
                """, (
                    text,
                    source,
                    agent_id,
                    json.dumps(tags),
                    json.dumps(metadata or {}),
                    project_id,
                    applied_count,
                ))
                new_id = cur.fetchone()[0]
        if _superseded_id is not None:
            return {"id": new_id, "superseded_id": _superseded_id}
        return new_id

    def memory_search(self, query, project_id=None, source=None, limit=20,
                      exclude_sources=DEFAULT_EXCLUDE_SOURCES,
                      tags=None, category=None):
        """Search memories -- routed onto Phase 65's hybrid_search_generic
        (MEMR-03/04, over-fetch-then-score, relevance-aware at every rung).

        Degradation ladder (kill-switch rule, CONTEXT.md) -- every rung is
        exception-guarded, no rung ever raises to the caller, and no rung
        orders results by recency alone:

          Rung 1 (default): hybrid_search_generic RRF fusion (BM25 + vector),
              or its native BM25-only mode when no query embedding is
              available, over a `limit*4` fused/vector candidate pool.
              Scored via `_score_fused_memories` (RRF_SCALE-mapped relevance
              + the shared bonus/citation/recency core).
          Rung 2: legacy FTS `ts_rank` (unchanged SQL/semantics), but
              over-fetching `limit*4` candidates before truncating to
              `limit` post-score (MEMR-04). Reached when the hybrid helper
              is unavailable, raises, or returns no rows.
          Rung 3: ILIKE candidates (`limit*4`), scored by trigram
              `similarity()` when pg_trgm is installed, else a Python
              `_jaccard` token-overlap fallback. Reached when FTS returns
              nothing. This replaces the pre-66-03 timestamp-ordered ILIKE
              fallback -- every rung here is relevance-aware.

        Args:
            exclude_sources: Tuple/list of source strings to exclude from results.
                             Defaults to DEFAULT_EXCLUDE_SOURCES (task_event, rpetd_phase).
                             Pass None to include all sources.
            tags: Phase 10 LEARN-03 — optional list of tags to filter by. Uses
                  the GIN-indexed `tags ?| %s::text[]` operator so the filter is
                  <50ms even on large gsd_memory tables.
            category: Phase 10 LEARN-03 — optional metadata->>'category' filter
                      (e.g. 'pattern', 'workflow'). Stored in metadata jsonb.
                      Applies on every rung via `_memory_filter_sql`.

        Phase 66 MEMR-08: every rung (hybrid RRF, legacy FTS, ILIKE) shares
        the SAME `_memory_filter_sql` builder, so passing `valid_only` here
        applies the `invalid_at IS NULL` currently-valid filter to all three
        rungs from one call site -- guarded by `_has_bitemporal()` so an
        un-migrated database (no valid_at/invalid_at columns) never raises.
        """
        import sys

        filter_sql, filter_params = _memory_filter_sql(
            project_id=project_id, source=source, exclude_sources=exclude_sources,
            tags=tags, category=category, valid_only=self._has_bitemporal(),
        )

        # Rung 1: hybrid RRF fusion via Phase 65's table-agnostic primitive.
        if _HYBRID_GENERIC_AVAILABLE:
            try:
                query_embedding = self.generate_embedding(query, input_type="query")
                bm25_query = _memory_bm25_query(_rlm_sanitize_query(query))
                with self._get_conn() as conn:
                    rows = hybrid_search_generic(
                        query, conn,
                        table="gsd_memory", id_column="id",
                        select_columns=["id", "text", "source", "agent_id", "tags",
                                        "metadata", "project_id", "created_at",
                                        "updated_at", "applied_count"],
                        vector_column="embedding",
                        query_embedding=query_embedding,
                        bm25_query=bm25_query,
                        filter_sql=filter_sql, filter_params=filter_params,
                        top_k=limit * 4, candidate_k=max(40, limit * 8),
                    )
                if rows:
                    return self._score_fused_memories(rows)[:limit]
                print(
                    f"[pg_store] memory_search rung1->rung2: hybrid_search_generic "
                    f"returned 0 rows for query={query!r}", file=sys.stderr,
                )
            except Exception as e:
                print(
                    f"[pg_store] memory_search rung1->rung2: hybrid_search_generic "
                    f"raised {type(e).__name__}: {e}", file=sys.stderr,
                )
        else:
            print(
                "[pg_store] memory_search rung1 skipped: hybrid_search_generic "
                "unavailable (see module-load warning)", file=sys.stderr,
            )

        # Rung 2: legacy FTS ts_rank -- MEMR-04 over-fetch limit*4, truncate to limit.
        where = "TRUE" + filter_sql
        tsquery = " & ".join(re.sub(r'[^\w\s]', '', query).split())
        if tsquery:
            try:
                with self._get_conn() as conn:
                    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                        sql = f"""
                            SELECT *,
                                ts_rank(to_tsvector('english', text), plainto_tsquery('english', %s)) as text_rank
                            FROM gsd_memory
                            WHERE {where}
                              AND to_tsvector('english', text) @@ plainto_tsquery('english', %s)
                            ORDER BY text_rank DESC
                            LIMIT %s
                        """
                        cur.execute(sql, [tsquery] + filter_params + [tsquery] + [limit * 4])
                        results = cur.fetchall()
                if results:
                    return self._score_memories(results)[:limit]
            except Exception as e:
                print(
                    f"[pg_store] memory_search rung2->rung3: FTS raised "
                    f"{type(e).__name__}: {e}", file=sys.stderr,
                )

        # Rung 3: ILIKE candidates, over-fetched limit*4, relevance-scored via
        # trigram similarity() (pg_trgm) or Python _jaccard -- never ordered
        # by timestamp alone (MEM-H3: the prior recency-only fallback is gone).
        keywords = [kw.replace('%', '').replace('_', '') for kw in query.split()]
        keywords = [kw for kw in keywords if kw]
        if not keywords:
            return []
        ilike_conditions = " OR ".join(["text ILIKE %s"] * len(keywords))
        ilike_params = [f"%{kw}%" for kw in keywords]

        try:
            with self._get_conn() as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    sql = f"""
                        SELECT *, similarity(text, %s) AS text_rank
                        FROM gsd_memory
                        WHERE {where} AND ({ilike_conditions})
                        ORDER BY text_rank DESC
                        LIMIT %s
                    """
                    cur.execute(sql, [query] + filter_params + ilike_params + [limit * 4])
                    results = cur.fetchall()
            return self._score_memories(results)[:limit]
        except Exception as e:
            print(
                f"[pg_store] memory_search rung3(trigram)->rung3(jaccard): "
                f"{type(e).__name__}: {e}", file=sys.stderr,
            )

        # pg_trgm unavailable (or the query above raised) -- Python Jaccard.
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                sql = f"""
                    SELECT *
                    FROM gsd_memory
                    WHERE {where} AND ({ilike_conditions})
                    LIMIT %s
                """
                cur.execute(sql, filter_params + ilike_params + [limit * 4])
                results = cur.fetchall()
        for r in results:
            r["text_rank"] = _jaccard(query, r.get("text", ""))
        return self._score_memories(results)[:limit]

    def _score_fused_memories(self, rows):
        """Score RRF-fused (or BM25-only-degraded) rows from
        hybrid_search_generic (MEMR-03/04).

        relevance = min(float(rrf_score) * RRF_SCALE, 10.0) -- see RRF_SCALE's
        own comment for the scale rationale. `_generic_bm25_only`'s
        degradation SQL (no query embedding, or the hybrid SQL raised) returns
        `rrf_score=NULL` for every row -- it has no numeric RRF value to
        report, only a paradedb.score-ordered row position -- treated as
        relevance=0.0 rather than raising: those rows still rank on source
        bonus/citation/recency (the shared _score_core terms), never crash.
        Every Decimal rrf_score is float()-cast before arithmetic (STATE
        learning: PostgreSQL's bare numeric literals in the RRF SQL arrive as
        decimal.Decimal via psycopg2).
        """
        now = datetime.now(timezone.utc)
        scored = []
        for row in rows:
            d = dict(row)
            rrf_score = d.get("rrf_score")
            relevance = min(float(rrf_score) * RRF_SCALE, 10.0) if rrf_score is not None else 0.0
            _score_core(d, relevance, now)
            scored.append(d)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored

    def _score_memories(self, rows):
        """Apply source-aware scoring with recency decay to memory results
        retrieved via the FTS (rung 2) or ILIKE-trigram/jaccard (rung 3)
        legacy-shaped rows (a `text_rank` key in 0-1 range on every row).

        Score = text_rank * 10 + source_bonus + citation_boost - recency_penalty
        (delegated to the shared `_score_core` -- see its docstring for the
        bonus/boost/penalty formulas). citation_boost (MEMR-02) is bounded so
        citation count alone cannot dominate ranking (echo-chamber guard,
        paired with memory_top1_concentration()). source_bonus (MEMR-05) is
        carried forward from metadata.merged_sources on distilled entries —
        see _carried_source_bonus().
        """
        now = datetime.now(timezone.utc)
        scored = []
        for row in rows:
            d = dict(row)
            text_rank = float(d.get("text_rank", 0) or 0)
            if "text_rank" in d and isinstance(d["text_rank"], Decimal):
                d["text_rank"] = float(d["text_rank"])
            _score_core(d, text_rank * 10, now)
            scored.append(d)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored

    def memory_list(self, project_id=None, source=None, exclude_source=None, limit=50, offset=0):
        """List memories with optional filters.

        Args:
            exclude_source: Single source string or list of sources to exclude from results.
                            Used by distill to skip re-merging source='distilled' entries (DATA-03).

        Phase 66 MEMR-08: intentionally NOT filtered by invalid_at -- unlike
        memory_search/memory_semantic_search, memory_list is lifecycle
        tooling (distill eligibility paging, skb-candidates, etc.) and MUST
        see the full history, including invalidated (superseded/deleted)
        rows, not just currently-valid ones.
        """
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                conditions = []
                params = []
                if project_id:
                    conditions.append("project_id = %s")
                    params.append(project_id)
                if source:
                    conditions.append("source = %s")
                    params.append(source)
                if exclude_source:
                    if isinstance(exclude_source, list):
                        placeholders = ", ".join(["%s"] * len(exclude_source))
                        conditions.append(f"source NOT IN ({placeholders})")
                        params.extend(exclude_source)
                    else:
                        conditions.append("source != %s")
                        params.append(exclude_source)

                where = " AND ".join(conditions) if conditions else "TRUE"
                sql = f"""
                    SELECT id, text, source, agent_id, tags, metadata, applied_count,
                           project_id, created_at
                    FROM gsd_memory
                    WHERE {where}
                    ORDER BY created_at DESC
                    LIMIT %s OFFSET %s
                """
                cur.execute(sql, params + [limit, offset])
                results = cur.fetchall()
                for r in results:
                    for key in ("created_at",):
                        if key in r and isinstance(r[key], datetime):
                            r[key] = r[key].isoformat()
                # RealDictCursor decodes jsonb metadata to a dict automatically —
                # no extra serialization needed for the daemon's JSON response.
                return [dict(r) for r in results]

    def memory_count(self, project_id=None, exclude_source=None):
        """Count total memories, optionally excluding entries by source.

        Args:
            project_id: Optional project filter.
            exclude_source: String or list of source values to exclude from the count.
                            Used by distill-status to exclude source='distilled' entries
                            so the threshold trigger fires on non-distilled content only.
        """
        # MEM-01: normalize exclude_source to list
        if exclude_source is not None and isinstance(exclude_source, str):
            exclude_source = [exclude_source]

        with self._get_conn() as conn:
            with conn.cursor() as cur:
                conditions = []
                params = []

                if project_id:
                    conditions.append("project_id = %s")
                    params.append(project_id)

                if exclude_source:
                    placeholders = ", ".join(["%s"] * len(exclude_source))
                    conditions.append(f"source NOT IN ({placeholders})")
                    params.extend(exclude_source)

                where_clause = ("WHERE " + " AND ".join(conditions)) if conditions else ""
                cur.execute(f"SELECT COUNT(*) FROM gsd_memory {where_clause}", params)
                return cur.fetchone()[0]

    def memory_delete(self, mem_id):
        """Delete a memory entry by ID."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM gsd_memory WHERE id = %s", (mem_id,))

    def memory_get_by_id(self, mem_id):
        """Fetch a single memory entry by ID.

        Phase 10 LEARN-05: used by skb-promote to read the source entry's
        metadata before creating an SKB row and marking it promoted. Returns
        None if not found.
        """
        try:
            with self._get_conn() as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute(
                        """SELECT id, text, source, agent_id, tags, metadata,
                                  applied_count, project_id, created_at
                           FROM gsd_memory WHERE id = %s""",
                        (mem_id,),
                    )
                    row = cur.fetchone()
                    if not row:
                        return None
                    d = dict(row)
                    if isinstance(d.get("created_at"), datetime):
                        d["created_at"] = d["created_at"].isoformat()
                    return d
        except Exception:
            return None

    def memory_patch_metadata(self, mem_id, patch):
        """Merge-patch the metadata jsonb column for a memory entry.

        Phase 10 LEARN-05: used by skb-promote / skb-remove to flip the
        promoted_to_skb flag + skb_id + promoted_at (or demoted_at) timestamps
        without overwriting other metadata fields like citations, what, why.

        Args:
            mem_id: Memory entry ID.
            patch: Dict of keys to merge into existing metadata jsonb. Keys in
                   patch overwrite existing keys; keys not in patch are kept.

        Returns:
            {"ok": True, "metadata": <merged>} on success
            {"ok": False, "error": "memory not found"} when mem_id is missing
        """
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT metadata FROM gsd_memory WHERE id = %s FOR UPDATE",
                        (mem_id,),
                    )
                    row = cur.fetchone()
                    if not row:
                        return {"ok": False, "error": "memory not found"}
                    current = dict(row[0] or {})
                    current.update(patch or {})
                    cur.execute(
                        "UPDATE gsd_memory SET metadata = %s::jsonb WHERE id = %s",
                        (json.dumps(current), mem_id),
                    )
                    return {"ok": True, "metadata": current}
        except Exception as e:
            return {"ok": False, "error": self._sanitize_error(e)}

    def memory_count_by_source(self):
        """Count memories grouped by source."""
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT source, COUNT(*) as cnt FROM gsd_memory GROUP BY source"
                    )
                    return {row[0]: row[1] for row in cur.fetchall()}
        except Exception:
            return {}

    def memory_tag_stats(self):
        """Get tag usage statistics."""
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT tag, COUNT(*) as cnt
                        FROM gsd_memory, jsonb_array_elements_text(tags) AS tag
                        GROUP BY tag
                        ORDER BY cnt DESC
                        LIMIT 20
                    """)
                    rows = cur.fetchall()
                    return {"tags": {r[0]: r[1] for r in rows}, "unique_tags": len(rows)}
        except Exception:
            return {"tags": {}, "unique_tags": 0}

    def memory_increment_applied(self, mem_id, task_id, phase=None, reason=None):
        """Phase 10 LEARN-05: Increment applied_count for a memory entry.

        Deduped by (mem_id, task_id) — citations from the same task are
        idempotent. Citation history is appended to metadata.citations as a
        list of {task_id, phase, cited_at, reason} dicts. metadata.first_cited_at
        and metadata.last_cited_at are also maintained.

        SELECT ... FOR UPDATE acquires a row lock for the duration of the
        transaction, guarding against lost-update races when multiple agents
        cite the same mem_id concurrently from different task_ids. Without
        the lock, two read-modify-write cycles on metadata.citations would
        clobber each other (only one citation kept, applied_count off by one).

        Args:
            mem_id: Memory entry ID (UUID or bigint depending on schema).
            task_id: Citing task ID (e.g. 'TK-0774'). Required for dedup.
            phase: Optional RPETD phase label ('R', 'P', 'E', 'T', 'D').
            reason: Optional free-text reason / quoted snippet.

        Returns:
            dict with:
              {"incremented": bool, "already_cited": bool, "applied_count": int}
            On memory-not-found:
              {"incremented": False, "error": "memory not found", "applied_count": 0}
        """
        from datetime import datetime, timezone
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    # Phase 10 LEARN-05 — row lock prevents lost updates under
                    # concurrent citations from different tasks.
                    cur.execute(
                        "SELECT metadata, applied_count FROM gsd_memory "
                        "WHERE id = %s FOR UPDATE",
                        (mem_id,),
                    )
                    row = cur.fetchone()
                    if not row:
                        return {
                            "incremented": False,
                            "error": "memory not found",
                            "applied_count": 0,
                        }

                    current_metadata, current_count = row
                    current_metadata = dict(current_metadata or {})
                    citations = list(current_metadata.get("citations") or [])

                    # Dedup by (mem_id, task_id) — idempotent per-task
                    already_cited = any(
                        c.get("task_id") == task_id for c in citations
                    )
                    if already_cited:
                        return {
                            "incremented": False,
                            "already_cited": True,
                            "applied_count": current_count,
                        }

                    now_iso = datetime.now(timezone.utc).isoformat()
                    new_citation = {
                        "task_id": task_id,
                        "phase": phase,
                        "cited_at": now_iso,
                        "reason": reason,
                    }
                    citations.append(new_citation)
                    current_metadata["citations"] = citations
                    current_metadata["last_cited_at"] = now_iso
                    if "first_cited_at" not in current_metadata:
                        current_metadata["first_cited_at"] = now_iso

                    cur.execute(
                        """UPDATE gsd_memory
                           SET metadata = %s::jsonb,
                               applied_count = applied_count + 1
                           WHERE id = %s
                           RETURNING applied_count""",
                        (json.dumps(current_metadata), mem_id),
                    )
                    new_count = cur.fetchone()[0]
                    return {
                        "incremented": True,
                        "already_cited": False,
                        "applied_count": new_count,
                    }
        except ValueError:
            raise
        except Exception as e:
            return {
                "incremented": False,
                "error": self._sanitize_error(e),
                "applied_count": 0,
            }

    def memory_skb_candidates(self, rising_min=5, needs_review_min=10, limit=100):
        """Phase 10 LEARN-05: Return SKB promotion candidates.

        Two buckets based on applied_count:
          - rising: rising_min <= applied_count < needs_review_min
          - needs_review: applied_count >= needs_review_min (MUST be manually
                          reviewed before promotion — high citation count may
                          indicate echo-chamber reinforcement)

        Excludes entries already promoted (metadata.promoted_to_skb = 'true').

        Args:
            rising_min: Lower bound of the rising bucket (default 5).
            needs_review_min: Lower bound of the needs_review bucket (default 10).
            limit: Max results.

        Returns:
            list of dicts with:
              {id, what, text_preview, applied_count, category, tags,
               needs_review (bool), rising (bool), first_cited_at, last_cited_at,
               source, created_at}
        """
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """SELECT id, text, tags, metadata, applied_count,
                                  source, created_at
                           FROM gsd_memory
                           WHERE applied_count >= %s
                             AND (metadata->>'promoted_to_skb' IS NULL
                                  OR metadata->>'promoted_to_skb' != 'true')
                           ORDER BY applied_count DESC, created_at DESC
                           LIMIT %s""",
                        (rising_min, limit),
                    )
                    rows = cur.fetchall()
        except Exception:
            return []

        out = []
        for row in rows:
            mid, text, tags, metadata, applied_count, source, created_at = row
            metadata = metadata or {}
            what = metadata.get("what")
            if what:
                preview = what
            elif text:
                preview = (text[:80] + "...") if len(text) > 80 else text
            else:
                preview = ""
            out.append({
                "id": mid,
                "what": what,
                "text_preview": preview,
                "applied_count": applied_count,
                "category": metadata.get("category"),
                "tags": tags or [],
                "needs_review": applied_count >= needs_review_min,
                "rising": rising_min <= applied_count < needs_review_min,
                "first_cited_at": metadata.get("first_cited_at"),
                "last_cited_at": metadata.get("last_cited_at"),
                "source": source,
                "created_at": created_at.isoformat() if created_at else None,
            })
        return out

    def memory_cross_project_search(self, query, tags=None, exclude_project=None,
                                    limit=20, category=None):
        """Search memories across ALL projects, optionally filtered by technology tags.

        Used during new-project initialization to find learnings from similar past projects.

        Args:
            query: Search text.
            tags: List of technology tags to filter by (e.g. ['react', 'postgresql']).
            exclude_project: Project ID to exclude from results (current project).
            limit: Max results.
            category: Phase 10 LEARN-03 — filter by metadata->>'category' (e.g. 'pattern').

        Returns list of scored memory dicts.
        """
        # Phase 10: use silent normalize_tags_list — filter tags should not raise
        # on "all banned" (the caller may be searching with generic tags).
        if tags and len(tags) > 0:
            tags = normalize_tags_list(tags)
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                conditions = []
                params = []

                if exclude_project:
                    conditions.append("(project_id IS NULL OR project_id != %s)")
                    params.append(exclude_project)

                # Filter by technology tags using jsonb containment (GIN-indexed)
                if tags and len(tags) > 0:
                    # Match entries where tags array overlaps with requested tags
                    conditions.append("tags ?| %s")
                    params.append(tags)

                # Phase 10 LEARN-03 — category filter on metadata->>'category'
                if category:
                    conditions.append("metadata->>'category' = %s")
                    params.append(str(category).lower())

                # Boost high-value sources: lesson-learned, best-practice, auto_learning
                conditions.append(
                    "source IN ('lesson-learned', 'best-practice', 'auto_learning', "
                    "'web_search_result', 'session-learning', 'distilled')"
                )

                where = " AND ".join(conditions) if conditions else "TRUE"

                # Try full-text search first
                tsquery = " & ".join(re.sub(r'[^\w\s]', '', query).split())
                if tsquery:
                    sql = f"""
                        SELECT *,
                            ts_rank(to_tsvector('english', text), plainto_tsquery('english', %s)) as text_rank
                        FROM gsd_memory
                        WHERE {where}
                          AND to_tsvector('english', text) @@ plainto_tsquery('english', %s)
                        ORDER BY text_rank DESC
                        LIMIT %s
                    """
                    cur.execute(sql, [tsquery] + params + [tsquery] + [limit])
                    results = cur.fetchall()

                    if results:
                        return self._score_memories(results)

                # Fallback: ILIKE search
                keywords = [kw.replace('%', '').replace('_', '') for kw in query.split()]
                keywords = [kw for kw in keywords if kw]
                if not keywords:
                    return []
                ilike_conditions = " OR ".join(["text ILIKE %s"] * len(keywords))
                ilike_params = [f"%{kw}%" for kw in keywords]

                sql = f"""
                    SELECT *, 0.0 as text_rank
                    FROM gsd_memory
                    WHERE {where} AND ({ilike_conditions})
                    ORDER BY created_at DESC
                    LIMIT %s
                """
                cur.execute(sql, params + ilike_params + [limit])
                results = cur.fetchall()
                return self._score_memories(results)

    # ═══════════════════════════════════════════════════════
    # Shared Knowledge Base (SKB) Operations
    # ═══════════════════════════════════════════════════════

    def skb_store(self, title, content, category=None, agent_id=None,
                  tags=None, importance=5, source_task=None):
        """Store a shared knowledge base entry."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO gsd_shared_kb
                        (title, content, category, agent_id, tags, importance, source_task)
                    VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s)
                    RETURNING id
                """, (
                    title, content, category, agent_id,
                    json.dumps(tags or []), importance, source_task,
                ))
                return cur.fetchone()[0]

    def skb_search(self, query, category=None, limit=20):
        """Search SKB entries with full-text search, fallback to ILIKE."""
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                conditions = []
                params = []

                if category:
                    conditions.append("category = %s")
                    params.append(category)

                where = " AND ".join(conditions) if conditions else "TRUE"

                # Try full-text search
                tsquery = " & ".join(re.sub(r'[^\w\s]', '', query).split())
                if tsquery:
                    sql = f"""
                        SELECT *,
                            ts_rank(
                                to_tsvector('english', title || ' ' || content),
                                plainto_tsquery('english', %s)
                            ) as relevance
                        FROM gsd_shared_kb
                        WHERE {where}
                          AND to_tsvector('english', title || ' ' || content)
                              @@ plainto_tsquery('english', %s)
                        ORDER BY relevance DESC, importance DESC
                        LIMIT %s
                    """
                    cur.execute(sql, [tsquery] + params + [tsquery] + [limit])
                    results = cur.fetchall()
                    if results:
                        return self._format_skb_results(results)

                # Fallback: ILIKE
                keywords = [kw.replace('%', '').replace('_', '') for kw in query.split()]
                keywords = [kw for kw in keywords if kw]
                if not keywords:
                    return []
                ilike_conds = " OR ".join(
                    ["title ILIKE %s OR content ILIKE %s"] * len(keywords)
                )
                ilike_params = []
                for kw in keywords:
                    ilike_params.extend([f"%{kw}%", f"%{kw}%"])

                sql = f"""
                    SELECT *, 0.0 as relevance
                    FROM gsd_shared_kb
                    WHERE {where} AND ({ilike_conds})
                    ORDER BY importance DESC, created_at DESC
                    LIMIT %s
                """
                cur.execute(sql, params + ilike_params + [limit])
                results = cur.fetchall()
                return self._format_skb_results(results)

    def _format_skb_results(self, rows):
        """Format SKB results for JSON output."""
        formatted = []
        for row in rows:
            d = dict(row)
            for key in ("created_at", "updated_at"):
                if key in d and isinstance(d[key], datetime):
                    d[key] = d[key].isoformat()
            # Convert Decimal fields to float for JSON serialization
            for key in ("relevance", "importance"):
                if key in d and isinstance(d[key], Decimal):
                    d[key] = float(d[key])
            formatted.append(d)
        return formatted

    def skb_get_by_id(self, skb_id):
        """Fetch a single SKB entry by ID.

        Phase 10 LEARN-05: used by skb-remove to find the source_mem_id
        before deleting the row so the source memory's promoted_to_skb flag
        can be cleared. Returns None if not found.
        """
        try:
            with self._get_conn() as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute(
                        "SELECT * FROM gsd_shared_kb WHERE id = %s",
                        (skb_id,),
                    )
                    row = cur.fetchone()
                    if not row:
                        return None
                    d = dict(row)
                    for key in ("created_at", "updated_at"):
                        if key in d and isinstance(d[key], datetime):
                            d[key] = d[key].isoformat()
                    for key in ("importance",):
                        if key in d and isinstance(d[key], Decimal):
                            d[key] = float(d[key])
                    return d
        except Exception:
            return None

    def skb_delete(self, skb_id):
        """Delete an SKB entry by ID.

        Phase 10 LEARN-05: used by skb-remove (demotion path). Returns a dict
        indicating whether the delete touched a row.
        """
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM gsd_shared_kb WHERE id = %s RETURNING id",
                        (skb_id,),
                    )
                    row = cur.fetchone()
                    if not row:
                        return {"ok": False, "error": "skb not found"}
                    return {"ok": True, "id": row[0]}
        except Exception as e:
            return {"ok": False, "error": self._sanitize_error(e)}

    def skb_list(self, category=None, limit=50, offset=0):
        """List SKB entries."""
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                conditions = []
                params = []
                if category:
                    conditions.append("category = %s")
                    params.append(category)

                where = " AND ".join(conditions) if conditions else "TRUE"
                sql = f"""
                    SELECT id, title, category, importance, tags, source_task, created_at
                    FROM gsd_shared_kb
                    WHERE {where}
                    ORDER BY importance DESC, created_at DESC
                    LIMIT %s OFFSET %s
                """
                cur.execute(sql, params + [limit, offset])
                results = cur.fetchall()
                for r in results:
                    for key in ("created_at",):
                        if key in r and isinstance(r[key], datetime):
                            r[key] = r[key].isoformat()
                return [dict(r) for r in results]

    # ═══════════════════════════════════════════════════════
    # Task Validation Operations
    # ═══════════════════════════════════════════════════════

    def validation_record(self, task_id, validator_id, status, evidence=None,
                          rejection_reason=None, forced=False):
        """Record a task validation attempt."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                ev = dict(evidence or {})
                if forced:
                    ev["forced"] = True
                cur.execute("""
                    INSERT INTO gsd_task_validations
                        (task_id, validator_id, status, evidence, rejection_reason)
                    VALUES (%s, %s, %s, %s::jsonb, %s)
                    RETURNING id
                """, (
                    task_id, validator_id, status,
                    json.dumps(ev), rejection_reason,
                ))
                return cur.fetchone()[0]

    def validation_history(self, task_id):
        """Get validation history for a task."""
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT * FROM gsd_task_validations
                    WHERE task_id = %s
                    ORDER BY created_at DESC
                """, (task_id,))
                results = cur.fetchall()
                for r in results:
                    for key in ("created_at",):
                        if key in r and isinstance(r[key], datetime):
                            r[key] = r[key].isoformat()
                return [dict(r) for r in results]

    # ═══════════════════════════════════════════════════════
    # Task Dual-Write Operations (PG mirror of tasks.json)
    # ═══════════════════════════════════════════════════════
    # tasks.json remains primary; PG is a best-effort mirror.
    # This enables future PG-primary reads and multi-machine setups.

    def task_upsert(self, item):
        """Upsert a single task item to gsd_tasks (mirror write).
        Silently returns None if PG is unavailable or the write fails.
        """
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO gsd_tasks (
                            id, project_id, type, title, description, details,
                            status, priority, assigned_to, claimed_by, claimed_at,
                            rpetd_r, rpetd_p, rpetd_e, rpetd_t, rpetd_d, rpetd_complete,
                            importance, urgency,
                            success_criteria, deliverables, dependencies,
                            tags, notes, parent_id, validation_notes, validated_by,
                            test_strategy, phase, plan, evidence, outcome, lesson,
                            doc_refs, risks, validation_checklist,
                            estimated_hours, due_date, sprint, children
                        ) VALUES (
                            %(id)s, %(project_id)s, %(type)s, %(title)s, %(description)s, %(details)s,
                            %(status)s, %(priority)s, %(assigned_to)s, %(claimed_by)s, %(claimed_at)s,
                            %(rpetd_r)s, %(rpetd_p)s, %(rpetd_e)s, %(rpetd_t)s, %(rpetd_d)s, %(rpetd_complete)s,
                            %(importance)s, %(urgency)s,
                            %(success_criteria)s::jsonb, %(deliverables)s::jsonb, %(dependencies)s::jsonb,
                            %(tags)s::jsonb, %(notes)s::jsonb, %(parent_id)s, %(validation_notes)s, %(validated_by)s,
                            %(test_strategy)s, %(phase)s, %(plan)s, %(evidence)s::jsonb, %(outcome)s, %(lesson)s,
                            %(doc_refs)s::jsonb, %(risks)s::jsonb, %(validation_checklist)s::jsonb,
                            %(estimated_hours)s, %(due_date)s, %(sprint)s, %(children)s::jsonb
                        )
                        ON CONFLICT (id) DO UPDATE SET
                            type = EXCLUDED.type,
                            title = EXCLUDED.title,
                            description = EXCLUDED.description,
                            details = EXCLUDED.details,
                            status = EXCLUDED.status,
                            priority = EXCLUDED.priority,
                            assigned_to = EXCLUDED.assigned_to,
                            claimed_by = EXCLUDED.claimed_by,
                            claimed_at = EXCLUDED.claimed_at,
                            rpetd_r = EXCLUDED.rpetd_r,
                            rpetd_p = EXCLUDED.rpetd_p,
                            rpetd_e = EXCLUDED.rpetd_e,
                            rpetd_t = EXCLUDED.rpetd_t,
                            rpetd_d = EXCLUDED.rpetd_d,
                            rpetd_complete = EXCLUDED.rpetd_complete,
                            importance = EXCLUDED.importance,
                            urgency = EXCLUDED.urgency,
                            success_criteria = EXCLUDED.success_criteria,
                            deliverables = EXCLUDED.deliverables,
                            dependencies = EXCLUDED.dependencies,
                            tags = EXCLUDED.tags,
                            notes = EXCLUDED.notes,
                            parent_id = EXCLUDED.parent_id,
                            validation_notes = EXCLUDED.validation_notes,
                            validated_by = EXCLUDED.validated_by,
                            test_strategy = EXCLUDED.test_strategy,
                            phase = EXCLUDED.phase,
                            plan = EXCLUDED.plan,
                            evidence = EXCLUDED.evidence,
                            outcome = EXCLUDED.outcome,
                            lesson = EXCLUDED.lesson,
                            doc_refs = EXCLUDED.doc_refs,
                            risks = EXCLUDED.risks,
                            validation_checklist = EXCLUDED.validation_checklist,
                            estimated_hours = EXCLUDED.estimated_hours,
                            due_date = EXCLUDED.due_date,
                            sprint = EXCLUDED.sprint,
                            children = EXCLUDED.children,
                            updated_at = NOW()
                    """, {
                        "id": item.get("id", ""),
                        "project_id": item.get("project_id", "default"),
                        "type": item.get("type", "task"),
                        "title": item.get("title", ""),
                        "description": item.get("description", ""),
                        "details": item.get("details", ""),
                        "status": item.get("status", "pending"),
                        "priority": item.get("priority", "medium"),
                        "assigned_to": item.get("assigned_to", ""),
                        "claimed_by": item.get("claimed_by"),
                        "claimed_at": item.get("claimed_at"),
                        "rpetd_r": (item.get("rpetd_phases") or {}).get("R", ""),
                        "rpetd_p": (item.get("rpetd_phases") or {}).get("P", ""),
                        "rpetd_e": (item.get("rpetd_phases") or {}).get("E", ""),
                        "rpetd_t": (item.get("rpetd_phases") or {}).get("T", ""),
                        "rpetd_d": (item.get("rpetd_phases") or {}).get("D", ""),
                        "rpetd_complete": item.get("rpetd_complete", False),
                        "importance": item.get("importance", 3),
                        "urgency": item.get("urgency", 3),
                        "success_criteria": json.dumps(item.get("success_criteria", [])),
                        "deliverables": json.dumps(item.get("deliverables", [])),
                        "dependencies": json.dumps(item.get("dependencies", [])),
                        "tags": json.dumps(item.get("tags", [])),
                        "notes": json.dumps(item.get("notes", [])),
                        "parent_id": item.get("parent"),
                        "validation_notes": item.get("validation_notes", ""),
                        "validated_by": item.get("validated_by", ""),
                        "test_strategy": item.get("test_strategy", ""),
                        "phase": item.get("phase", ""),
                        "plan": item.get("plan", ""),
                        "evidence": json.dumps(item.get("evidence", {})),
                        "outcome": item.get("outcome", ""),
                        "lesson": item.get("lesson", ""),
                        "doc_refs": json.dumps(item.get("doc_refs", [])),
                        "risks": json.dumps(item.get("risks", [])),
                        "validation_checklist": json.dumps(item.get("validation_checklist", [])),
                        "estimated_hours": item.get("estimated_hours"),
                        "due_date": item.get("due_date"),
                        "sprint": item.get("sprint"),
                        "children": json.dumps(item.get("children", [])),
                    })
                    return item["id"]
        except Exception as e:
            import sys
            print(f"\033[2m[pg-mirror] task_upsert failed for {item.get('id', '?')}: {e}\033[0m", file=sys.stderr)
            self.enqueue_retry(item)
            return None

    def task_upsert_batch(self, items):
        """Upsert a batch of task items. Best-effort, never raises."""
        count = 0
        for item in items:
            if self.task_upsert(item):
                count += 1
        return count

    def task_delete(self, task_id):
        """Delete a task from PG mirror. Best-effort."""
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM gsd_tasks WHERE id = %s", (task_id,))
                    return cur.rowcount > 0
        except Exception:
            return False

    def task_count_by_status(self):
        """Get task counts grouped by status."""
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT status, COUNT(*) as cnt FROM gsd_tasks GROUP BY status"
                    )
                    return {row[0]: row[1] for row in cur.fetchall()}
        except Exception:
            return {}

    # ═══════════════════════════════════════════════════════
    # PG Retry Queue (file-based persistence for failed upserts)
    # ═══════════════════════════════════════════════════════

    RETRY_QUEUE_MAX = 1000

    def _retry_queue_path(self):
        """Path to the retry queue JSON file."""
        data_dir = os.environ.get("AMAUTA_DATA_DIR",
                                   os.path.join(os.path.expanduser("~"), ".amauta"))
        return os.path.join(data_dir, "pg_retry_queue.json")

    def _load_retry_queue(self):
        """Load pending retry items from disk."""
        path = self._retry_queue_path()
        if not os.path.exists(path):
            return []
        try:
            with open(path) as f:
                items = json.load(f)
            return items if isinstance(items, list) else []
        except (json.JSONDecodeError, OSError):
            return []

    def _save_retry_queue(self, items):
        """Persist retry queue to disk. Evicts oldest if over RETRY_QUEUE_MAX."""
        if len(items) > self.RETRY_QUEUE_MAX:
            evicted = len(items) - self.RETRY_QUEUE_MAX
            items = items[-self.RETRY_QUEUE_MAX:]
            import sys
            print(f"\033[93m[pg-retry] queue overflow: evicted {evicted} oldest items\033[0m",
                  file=sys.stderr)
        path = self._retry_queue_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(items, f)
            os.replace(tmp, path)
        except OSError as e:
            import sys
            print(f"\033[91m[pg-retry] save failed: {e}\033[0m", file=sys.stderr)

    def enqueue_retry(self, item):
        """Add a failed task upsert to the retry queue."""
        queue = self._load_retry_queue()
        # Deduplicate: remove existing entry for same task ID
        queue = [q for q in queue if q.get("id") != item.get("id")]
        queue.append(item)
        if len(queue) > 500:
            import sys
            print(f"\033[93m[pg-retry] queue high: {len(queue)} items pending\033[0m",
                  file=sys.stderr)
        self._save_retry_queue(queue)

    def flush_retry_queue(self):
        """Attempt to upsert all queued items. Returns (succeeded, failed, remaining)."""
        queue = self._load_retry_queue()
        if not queue:
            return 0, 0, 0
        succeeded = 0
        still_failed = []
        for item in queue:
            result = self.task_upsert(item)
            if result is not None:
                succeeded += 1
            else:
                still_failed.append(item)
        self._save_retry_queue(still_failed)
        return succeeded, len(still_failed), len(still_failed)

    # ═══════════════════════════════════════════════════════
    # Agent Performance Tracking (Auto-Learning Feedback Loop)
    # ═══════════════════════════════════════════════════════

    def record_agent_performance(self, agent_id, task_id, outcome,
                                  task_type='task', project_id='default',
                                  gate_failed=None, failure_reason=None,
                                  duration_minutes=None, learning_captured=None):
        """Record a validation outcome for agent performance tracking."""
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        INSERT INTO gsd_agent_performance
                            (agent_id, task_id, task_type, project_id, outcome,
                             gate_failed, failure_reason, duration_minutes, learning_captured)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """, (agent_id, task_id, task_type, project_id, outcome,
                          gate_failed, failure_reason, duration_minutes, learning_captured))
                    return True
        except Exception:
            return False

    def agent_performance_summary(self, agent_id, limit=50):
        """Get performance summary for an agent — pass/fail rates and common failure patterns."""
        try:
            with self._get_conn() as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    # Get overall stats
                    cur.execute("""
                        SELECT
                            COUNT(*) as total_tasks,
                            COUNT(*) FILTER (WHERE outcome = 'pass') as pass_count,
                            COUNT(*) FILTER (WHERE outcome = 'fail') as fail_count,
                            ROUND(AVG(duration_minutes) FILTER (WHERE duration_minutes IS NOT NULL)) as avg_duration
                        FROM gsd_agent_performance
                        WHERE agent_id = %s
                    """, (agent_id,))
                    stats = dict(cur.fetchone())
                    total = stats.get('total_tasks', 0) or 0
                    if total == 0:
                        return None  # No history yet

                    stats['pass_rate'] = round(float(stats.get('pass_count', 0) or 0) / total, 3)

                    # Get common failure gates
                    cur.execute("""
                        SELECT gate_failed, COUNT(*) as count
                        FROM gsd_agent_performance
                        WHERE agent_id = %s AND outcome = 'fail' AND gate_failed IS NOT NULL
                        GROUP BY gate_failed
                        ORDER BY count DESC
                        LIMIT 5
                    """, (agent_id,))
                    stats['common_failures'] = [dict(r) for r in cur.fetchall()]

                    # Get recent failures (last 3)
                    cur.execute("""
                        SELECT task_id, failure_reason,
                               EXTRACT(EPOCH FROM (NOW() - created_at))/3600 as hours_ago
                        FROM gsd_agent_performance
                        WHERE agent_id = %s AND outcome = 'fail'
                        ORDER BY created_at DESC
                        LIMIT 3
                    """, (agent_id,))
                    stats['recent_failures'] = [dict(r) for r in cur.fetchall()]

                    stats['agent_id'] = agent_id
                    return stats
        except Exception:
            return None

    # ═══════════════════════════════════════════════════════
    # RPETD Context Operations (Phase 20 HANDOFF-03)
    # ═══════════════════════════════════════════════════════

    def rpetd_context_store(self, task_id, phase, compiled_view, full_context=None,
                            context_version=None, file_hashes=None):
        """Store or update an RPETDContext for a task+phase.

        Uses INSERT ... ON CONFLICT (task_id, phase) DO UPDATE to upsert.
        This ensures exactly one context row per task per phase.

        Args:
            task_id: Task identifier (e.g., 'TK-0051').
            phase: RPETD phase letter ('R', 'P', 'E', 'T', or 'D').
            compiled_view: dict — the RPETDContext.model_dump() output (<= 600 tokens).
            full_context: dict or None — optional raw conversation backup.
            context_version: str or None — SHA-256 hex digest for staleness detection.
            file_hashes: dict or None — {path: sha256_hash} for Phase 21 STALE-01.

        Returns:
            int: The row id of the upserted row.
        """
        phase = phase.upper()
        if phase not in ('R', 'P', 'E', 'T', 'D'):
            raise ValueError(f"Invalid RPETD phase: {phase}. Must be one of: R, P, E, T, D")

        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO rpetd_context (task_id, phase, compiled_view, full_context,
                                                context_version, file_hashes)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (task_id, phase)
                    DO UPDATE SET
                        compiled_view = EXCLUDED.compiled_view,
                        full_context = EXCLUDED.full_context,
                        context_version = EXCLUDED.context_version,
                        file_hashes = EXCLUDED.file_hashes,
                        created_at = NOW()
                    RETURNING id
                """, (
                    task_id,
                    phase,
                    json.dumps(compiled_view) if isinstance(compiled_view, dict) else compiled_view,
                    json.dumps(full_context) if isinstance(full_context, dict) else full_context,
                    context_version,
                    json.dumps(file_hashes or {}),
                ))
                row = cur.fetchone()
                return row[0] if row else None

    def rpetd_context_get(self, task_id, phase):
        """Retrieve the stored RPETDContext for a specific task+phase.

        Args:
            task_id: Task identifier.
            phase: RPETD phase letter ('R', 'P', 'E', 'T', or 'D').

        Returns:
            dict or None: Row as dict with keys {id, task_id, phase, compiled_view,
            full_context, context_version, file_hashes, created_at}, or None if not found.
        """
        phase = phase.upper()
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, task_id, phase, compiled_view, full_context,
                           context_version, file_hashes, created_at
                    FROM rpetd_context
                    WHERE task_id = %s AND phase = %s
                """, (task_id, phase))
                row = cur.fetchone()
                if row:
                    result = dict(row)
                    # Ensure created_at is ISO string for JSON serialization
                    if result.get("created_at"):
                        result["created_at"] = result["created_at"].isoformat()
                    return result
                return None

    def rpetd_context_list(self, task_id):
        """List all stored RPETDContext entries for a task, ordered by created_at.

        Args:
            task_id: Task identifier.

        Returns:
            list[dict]: List of rows as dicts, ordered by created_at ascending.
        """
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, task_id, phase, compiled_view, full_context,
                           context_version, file_hashes, created_at
                    FROM rpetd_context
                    WHERE task_id = %s
                    ORDER BY created_at ASC
                """, (task_id,))
                rows = cur.fetchall()
                results = []
                for row in rows:
                    r = dict(row)
                    if r.get("created_at"):
                        r["created_at"] = r["created_at"].isoformat()
                    results.append(r)
                return results

    # ═══════════════════════════════════════════════════════
    # Embedding / Semantic Search Operations
    # ═══════════════════════════════════════════════════════

    # Embedding provider configuration
    # Priority: GSD_EMBEDDING_PROVIDER env var > auto-detect (voyage > openai)
    EMBEDDING_PROVIDERS = {
        "voyage": {
            "env_key": "VOYAGE_API_KEY",
            "url": "https://api.voyageai.com/v1/embeddings",
            "default_model": "voyage-code-3",  # Best for code retrieval (beats OpenAI by 13.8%)
            "dimensions": 1024,               # Matryoshka: can truncate from 2048 to 1024/512/256
            "max_chars": 32000,               # 32K token context window
            "supports_input_type": True,      # "query" vs "document" improves retrieval
            "rerank_model": "rerank-2.5",     # Post-retrieval reranking (200M free tokens)
            "rerank_url": "https://api.voyageai.com/v1/rerank",
        },
        "openai": {
            "env_key": "OPENAI_API_KEY",
            "url": "https://api.openai.com/v1/embeddings",
            "default_model": "text-embedding-3-small",
            "dimensions": 1024,  # request 1024 dims (model supports flexible dims)
            "max_chars": 32000,
            "supports_input_type": False,
        },
    }

    @staticmethod
    def _detect_embedding_provider():
        """Detect which embedding provider to use.

        Priority: GSD_EMBEDDING_PROVIDER env var > auto-detect (voyage > openai).
        Returns (provider_name, config_dict) or (None, None) if no API key available.
        """
        explicit = os.environ.get("GSD_EMBEDDING_PROVIDER", "").lower().strip()
        if explicit and explicit in PGStore.EMBEDDING_PROVIDERS:
            cfg = PGStore.EMBEDDING_PROVIDERS[explicit]
            if os.environ.get(cfg["env_key"]):
                return explicit, cfg
            # Explicit provider set but no API key — fall through to auto-detect

        # Auto-detect: prefer Voyage (Anthropic-recommended), fall back to OpenAI
        for name in ("voyage", "openai"):
            cfg = PGStore.EMBEDDING_PROVIDERS[name]
            if os.environ.get(cfg["env_key"]):
                return name, cfg

        return None, None

    @staticmethod
    def generate_embedding(text, model=None, input_type=None):
        """Generate a 1024-dimension embedding via Voyage AI or OpenAI API.

        Provider auto-detected: VOYAGE_API_KEY (preferred) or OPENAI_API_KEY.
        Override with GSD_EMBEDDING_PROVIDER=voyage|openai env var.

        Args:
            text: The text to embed.
            model: Override model name (default: provider-specific).
            input_type: For Voyage only — 'query' or 'document' (improves retrieval).

        Returns list[float] of length 1024, or None if no API key available.
        """
        provider_name, cfg = PGStore._detect_embedding_provider()
        if cfg is None:
            return None

        api_key = os.environ.get(cfg["env_key"])
        if not api_key:
            return None

        # Truncate to stay within API limits
        max_chars = cfg.get("max_chars", 32000)
        truncated = text[:max_chars] if len(text) > max_chars else text

        # use_model must be resolved before cache key computation
        use_model = model or cfg["default_model"]

        # MEM-04: Check query embedding cache (query-only -- document embeddings are write-path)
        cache_key = None
        if input_type == "query":
            cache_key = hashlib.sha256(
                f"{truncated}:{input_type}:{use_model}".encode()
            ).hexdigest()[:16]
            cached = _QUERY_EMBED_CACHE.get(cache_key)
            if cached and (time.time() - cached[1]) < _QUERY_EMBED_TTL:
                return cached[0]
            # TOK-06: Check Redis L2 cache (cross-invocation)
            redis_hit = _redis_embed_get(cache_key)
            if redis_hit:
                # Promote to L1 for fast subsequent access
                _QUERY_EMBED_CACHE[cache_key] = (redis_hit, time.time())
                return redis_hit

        # Build payload
        payload_dict = {
            "input": [truncated],  # Both OpenAI and Voyage accept list format
            "model": use_model,
        }

        # Request specific dimensions (both providers support this)
        if cfg.get("dimensions"):
            if provider_name == "openai":
                payload_dict["dimensions"] = cfg["dimensions"]
            elif provider_name == "voyage":
                payload_dict["output_dimension"] = cfg["dimensions"]

        # Voyage supports input_type for better retrieval
        if input_type and cfg.get("supports_input_type"):
            payload_dict["input_type"] = input_type

        payload = json.dumps(payload_dict).encode("utf-8")

        req = urllib.request.Request(
            cfg["url"],
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                embedding = result["data"][0]["embedding"]
                # MEM-04: Cache query embeddings
                if cache_key and embedding:
                    _QUERY_EMBED_CACHE[cache_key] = (embedding, time.time())
                    # TOK-06: Also write to Redis L2
                    _redis_embed_set(cache_key, embedding)
                    # Evict oldest entries if cache exceeds max size
                    if len(_QUERY_EMBED_CACHE) > _QUERY_EMBED_MAX:
                        sorted_keys = sorted(
                            _QUERY_EMBED_CACHE.keys(),
                            key=lambda k: _QUERY_EMBED_CACHE[k][1],
                        )
                        for k in sorted_keys[:100]:
                            del _QUERY_EMBED_CACHE[k]
                return embedding
        except Exception:
            return None

    @staticmethod
    def rerank(query, documents, top_k=10):
        """Re-rank documents using Voyage rerank-2.5 for improved precision.

        Uses cross-encoder scoring to re-order initial retrieval results.
        Returns list of {index, relevance_score} sorted by relevance, or None if unavailable.
        """
        provider_name, cfg = PGStore._detect_embedding_provider()
        if provider_name != "voyage" or not cfg.get("rerank_url"):
            return None

        api_key = os.environ.get(cfg["env_key"])
        if not api_key:
            return None

        payload = json.dumps({
            "query": query,
            "documents": documents[:100],  # API limit
            "model": cfg.get("rerank_model", "rerank-2.5"),
            "top_k": min(top_k, len(documents)),
        }).encode("utf-8")

        req = urllib.request.Request(
            cfg["rerank_url"],
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                return result.get("data", [])
        except Exception:
            return None

    def memory_store_with_embedding(self, text, source="agent", agent_id=None,
                                     tags=None, metadata=None, project_id=None,
                                     applied_count=0, skip_dedup=False):
        """Store a memory entry with auto-generated embedding.

        Falls back to memory_store() without embedding if no API key is set.
        Returns the new memory ID, or a dedup dict if a near-duplicate exists.

        DATA-04: Pre-store dedup — if cosine similarity >= threshold (default 0.95),
        the insert is skipped and a dict is returned instead:
        {"dedup_skipped": True, "existing_id": ..., "similarity": ...}

        Phase 10 LEARN-02/04: honors GSD_D_STRUCTURED=false kill switch and runs
        defense-in-depth tag validation (raises ValueError if all tags are banned).

        Phase 66 MEMR-02/05: applied_count mirrors memory_store()'s semantics —
        coerced to a non-negative int, defaulting to 0 on any bad value.

        Phase 66 MEMR-06: skip_dedup=True bypasses the cosine dedup check below
        AND is forwarded to the no-embedding memory_store() fallback (so the
        seam is honored regardless of which write path is actually taken).
        """
        import sys

        try:
            applied_count = max(0, int(applied_count or 0))
        except (TypeError, ValueError):
            applied_count = 0

        # Phase 10 LEARN-02 kill switch — mirrors memory_store() semantics
        if os.environ.get("GSD_D_STRUCTURED") == "false":
            if metadata and metadata.get("structured"):
                print(
                    "[pg_store] Structured learning disabled "
                    "(GSD_D_STRUCTURED=false), storing as free-text",
                    file=sys.stderr,
                )
                metadata = None

        # Phase 10 LEARN-04 defense-in-depth tag governance
        # TK-1704: empty/None tag list is a valid "no tags" store, not a governance
        # rejection — skip normalize_tags() entirely rather than calling it with []
        # (normalize_tags([]) intentionally rejects empty input; see its own
        # cross-runtime parity contract at line ~281 and its pinned tests).
        if tags:
            tag_result = normalize_tags(tags)
            if tag_result.get("error"):
                raise ValueError(tag_result["error"])
            tags = tag_result.get("tags", [])
            for w in tag_result.get("warnings", []):
                print(f"[pg_store] {w}", file=sys.stderr)
        else:
            tags = []

        # MEM-03 AUDIT (2026-04-06): input_type="document" correct for storage path
        embedding = self.generate_embedding(text, input_type="document")

        if embedding is None:
            # No API key or embedding failed — store without embedding.
            # Pass pre-normalized tags through so memory_store doesn't re-run
            # validation (it will no-op since tags are already clean).
            return self.memory_store(text, source, agent_id, tags, metadata, project_id,
                                      applied_count=applied_count, skip_dedup=skip_dedup)

        # DATA-04: Pre-store dedup — skip insert if near-duplicate exists (cosine > threshold)
        dedup_threshold = float(os.environ.get("GSD_DEDUP_THRESHOLD", "0.95"))

        with self._get_conn() as conn:
            # Sub-block 1: dedup check (Phase 66 MEMR-06: skip_dedup bypasses this)
            # Phase 66 MEMR-08: the SAME nearest-neighbor query also supplies
            # the top-3 currently-valid candidates for the write-time
            # classifier below (LIMIT widened 1 -> 3) -- a byproduct of the
            # existing dedup lookup, not a second query.
            _nn_rows = []
            if not skip_dedup:
                _validity_clause = " AND invalid_at IS NULL" if self._has_bitemporal() else ""
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute(f"""
                        SELECT id, text, (1 - (embedding <=> %s::vector)) as similarity
                        FROM gsd_memory
                        WHERE embedding IS NOT NULL
                          AND (project_id = %s OR (project_id IS NULL AND %s IS NULL))
                          {_validity_clause}
                        ORDER BY embedding <=> %s::vector
                        LIMIT 3
                    """, (str(embedding), project_id, project_id, str(embedding)))
                    _nn_rows = cur.fetchall()
                    if _nn_rows and float(_nn_rows[0]["similarity"]) >= dedup_threshold:
                        top = _nn_rows[0]
                        return {"dedup_skipped": True, "existing_id": top["id"],
                                "similarity": round(float(top["similarity"]), 4)}

            # Phase 66 MEMR-08: write-time classifier (ADD/UPDATE/DELETE/NOOP).
            # skip_dedup writes (distill merges) also skip classification --
            # a distill merge legitimately writes text similar to what it is
            # replacing and must not be classified against its own
            # originals. Zero candidates (no rows / skip_dedup) skips
            # straight to ADD -- no LLM call wasted.
            _superseded_id = None
            if not skip_dedup and _MEMORY_CLASSIFIER_AVAILABLE and _nn_rows:
                _classifier_candidates = [
                    {"id": r["id"], "text": r["text"]} for r in _nn_rows
                ]
                try:
                    _decision = classify_memory_op(text, _classifier_candidates)
                except Exception as e:
                    print(
                        f"[pg_store] memory_store_with_embedding classifier raised "
                        f"({type(e).__name__}: {e}) — proceeding as ADD",
                        file=sys.stderr,
                    )
                    _decision = {"op": "ADD"}
                _op = _decision.get("op", "ADD")
                _target_id = _decision.get("target_id")
                if _op == "NOOP":
                    return {
                        "noop": True,
                        "existing_id": _target_id or _classifier_candidates[0]["id"],
                    }
                if _op == "DELETE" and _target_id is not None:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE gsd_memory SET invalid_at = now() "
                            "WHERE id = %s AND invalid_at IS NULL",
                            (_target_id,),
                        )
                    return {"deleted_target": _target_id}
                if _op == "UPDATE" and _target_id is not None:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE gsd_memory SET invalid_at = now() "
                            "WHERE id = %s AND invalid_at IS NULL",
                            (_target_id,),
                        )
                    _superseded_id = _target_id
                # ADD (and any other/failure outcome) falls through to the
                # plain INSERT below, unchanged.

            # Sub-block 2: insert (same conn, no nested _get_conn)
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO gsd_memory (text, source, agent_id, tags, metadata, project_id, embedding, applied_count)
                    VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s, %s::vector, %s)
                    RETURNING id
                """, (
                    text,
                    source,
                    agent_id,
                    json.dumps(tags or []),
                    json.dumps(metadata or {}),
                    project_id,
                    str(embedding),
                    applied_count,
                ))
                new_id = cur.fetchone()[0]
            if _superseded_id is not None:
                return {"id": new_id, "superseded_id": _superseded_id}
            return new_id

    def memory_semantic_search(self, query, project_id=None, source=None, limit=20,
                               exclude_sources=DEFAULT_EXCLUDE_SOURCES):
        """Search memories using cosine similarity on pgvector embeddings.

        Requires VOYAGE_API_KEY or OPENAI_API_KEY for query embedding generation.
        Returns (results, method) tuple — method is 'vector' or 'text_fallback'.
        Falls back to text-based memory_search() if embeddings unavailable.

        MEMR-04 (Phase 66, over-fetch-then-score, second site — the first is
        memory_search's hybrid router): fetches limit * 4 candidates from the
        vector SQL below (was `limit`), composite-scores ALL of them via
        _score_semantic_results (source bonus/citation boost/recency, same
        formula memory_search uses), then keeps the top limit * 2 as the
        rerank window (a cost cap on the Voyage rerank API call — reranking
        every limit*4 candidate would be 4x the API spend for no benefit,
        since anything outside the top limit*2 by composite score is
        vanishingly unlikely to be rerank-promoted into the final limit).
        MEMR-07 (plan 66-04): rerank output BLENDS with the composite score
        (final = score_composite + RERANK_BLEND_WEIGHT * rerank relevance)
        rather than replacing it, so a stale task_event cannot outrank a
        fresh cited lesson-learned merely because the reranker prefers it.

        Args:
            exclude_sources: Tuple/list of source strings to exclude from results.
                             Defaults to DEFAULT_EXCLUDE_SOURCES (task_event, rpetd_phase).
                             Pass None to include all sources.
        """
        # MEM-03 AUDIT (2026-04-06): input_type="query" correct for search path
        # Generate query embedding (input_type="query" improves Voyage retrieval)
        query_embedding = self.generate_embedding(query, input_type="query")
        if query_embedding is None:
            # No API key — fall back to text search
            return self.memory_search(query, project_id, source, limit,
                                      exclude_sources=exclude_sources), "text_fallback"

        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                conditions = ["embedding IS NOT NULL"]
                params = []

                # DATA-06: Exclude test entries from default search
                if project_id != '__test__':
                    conditions.append("(project_id IS NULL OR project_id != '__test__')")

                if project_id:
                    conditions.append("project_id = %s")
                    params.append(project_id)

                if source:
                    conditions.append("source = %s")
                    params.append(source)

                # MEM-01: Exclude low-signal sources by default
                if exclude_sources:
                    placeholders = ", ".join(["%s"] * len(exclude_sources))
                    conditions.append(f"source NOT IN ({placeholders})")
                    params.extend(exclude_sources)

                # Phase 66 MEMR-08: currently-valid filter, guarded by
                # _has_bitemporal() so an un-migrated database (no
                # valid_at/invalid_at columns) never raises.
                if self._has_bitemporal():
                    conditions.append("invalid_at IS NULL")

                where = " AND ".join(conditions)

                # Cosine distance: 1 - (a <=> b) gives similarity in [0, 1]
                # MEMR-04: over-fetch limit * 4 candidates (was `limit`) so
                # composite scoring below can rescue a high-bonus/cited entry
                # ranked outside the raw top-`limit` cosine window.
                sql = f"""
                    SELECT *,
                        (1 - (embedding <=> %s::vector)) as semantic_similarity
                    FROM gsd_memory
                    WHERE {where}
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                """
                vec_str = str(query_embedding)
                cur.execute(sql, [vec_str] + params + [vec_str] + [limit * 4])
                results = cur.fetchall()

                if not results:
                    # No embeddings stored yet — fall back to text search.
                    # TK-1763 (:2049 bug): exclude_sources was silently
                    # dropped on this branch — the caller's source filter
                    # (e.g. a distill-status caller excluding 'distilled')
                    # would vanish on the no-embeddings fallback path. Fixed:
                    # forwarded identically to the query_embedding-is-None
                    # fallback above, which already did this correctly.
                    return self.memory_search(query, project_id, source, limit,
                                              exclude_sources=exclude_sources), "text_fallback"

                scored = self._score_semantic_results(results)
                # MEMR-04: rerank window is the top limit*2 by composite
                # score, not the full limit*4 over-fetch pool (rerank API
                # cost cap).
                rerank_window = scored[:limit * 2]

                # Post-retrieval reranking via Voyage rerank-2.5 (free tier: 200M tokens)
                # Improves precision by cross-encoder scoring on top-K candidates.
                # MEMR-07: rerank BLENDS with composite score, it does not
                # replace ordering wholesale — every entry in rerank_window
                # keeps score_composite; entries the reranker actually scored
                # get final score = score_composite + RERANK_BLEND_WEIGHT *
                # relevance_score; entries outside the reranker's own top_k
                # (it is asked for `limit` out of a `limit*2` window) keep a
                # composite-only score. The full window is then re-sorted by
                # final score and truncated to `limit`.
                try:
                    docs = [r.get("text", "")[:500] for r in rerank_window]
                    reranked = PGStore.rerank(query, docs, top_k=limit)
                    if reranked:
                        reranked_idx = set()
                        for item in reranked:
                            idx = item.get("index", 0)
                            if idx < len(rerank_window):
                                entry = rerank_window[idx]
                                entry["score_composite"] = entry["score"]
                                relevance = float(item.get("relevance_score", 0))
                                entry["rerank_score"] = round(relevance, 4)
                                entry["score"] = round(
                                    entry["score_composite"] + RERANK_BLEND_WEIGHT * relevance, 2
                                )
                                reranked_idx.add(idx)
                        for idx, entry in enumerate(rerank_window):
                            if idx not in reranked_idx:
                                entry["score_composite"] = entry["score"]
                        blended = sorted(rerank_window, key=lambda e: e["score"], reverse=True)
                        return blended[:limit], "vector+rerank"
                except Exception:
                    pass  # Reranking is optional — fall back to vector-only

                # Non-rerank return path truncates the scored list to `limit`.
                return scored[:limit], "vector"

    def _score_semantic_results(self, rows):
        """Score semantic search results with source bonuses and recency decay.

        Score = similarity * 10 + source_bonus + citation_boost - recency_penalty
        citation_boost (MEMR-02) = min(log1p(applied_count), CITATION_BOOST_CAP) —
        identical bounded formula to _score_memories(), so a memory ranks
        consistently whether retrieved via FTS or vector search. source_bonus
        (MEMR-05) is carried forward from metadata.merged_sources — see
        _carried_source_bonus().
        """
        now = datetime.now(timezone.utc)
        scored = []
        for row in rows:
            d = dict(row)
            source_bonus = SOURCE_SCORES.get(d.get("source", "agent"), 0)
            source_bonus = _carried_source_bonus(d, source_bonus)
            citation_boost = _citation_boost(d.get("applied_count"))
            similarity = float(d.get("semantic_similarity", 0))
            # MEM-03: Recency decay
            recency_penalty = 0.0
            created_at = d.get("created_at")
            if RECENCY_DECAY_PER_30D > 0 and created_at is not None:
                try:
                    if isinstance(created_at, str):
                        ca = datetime.fromisoformat(created_at)
                    else:
                        ca = created_at
                    if ca.tzinfo is None:
                        ca = ca.replace(tzinfo=timezone.utc)
                    days_old = max((now - ca).days, 0)
                    recency_penalty = min(
                        RECENCY_DECAY_PER_30D * (days_old / 30.0),
                        MAX_RECENCY_PENALTY,
                    )
                except (ValueError, TypeError, AttributeError):
                    pass  # unparseable — no decay
            # Composite: semantic similarity (0-1) * 10 + source bonus (0-4)
            # + citation boost (MEMR-02, bounded) - recency
            d["score"] = round(similarity * 10 + source_bonus + citation_boost - recency_penalty, 2)
            d["semantic_similarity"] = round(similarity, 4)
            # Convert types that don't JSON-serialize
            for key in ("created_at", "updated_at"):
                if key in d and isinstance(d[key], datetime):
                    d[key] = d[key].isoformat()
            for key, val in d.items():
                if isinstance(val, Decimal):
                    d[key] = float(val)
            # Remove embedding from output (large binary)
            d.pop("embedding", None)
            scored.append(d)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored

    def memory_top1_concentration(self, queries, limit=5):
        """Echo-chamber canary metric (Phase 66, research pitfall 3).

        The citation boost (MEMR-02) intentionally rewards heavily-cited
        memories, which risks one entry dominating every unrelated query
        ("echo chamber") if the boost is not bounded correctly. This method
        runs memory_search() over a fixed set of queries and measures how
        concentrated the top-1 result is:

        - max_top1_share close to 1.0 means one memory wins almost every
          query — a red flag the boost/carry formula is too aggressive.
        - max_top1_share close to 1/answered means a healthy spread across
          distinct top-1 winners.

        Record this metric (before/after) whenever the ranking formula in
        _score_memories / _score_semantic_results changes — it is the
        required companion canary for any citation/source-bonus tuning.

        Args:
            queries: iterable of query strings.
            limit: per-query memory_search() limit (default 5, matching the
                   shadow-mode snapshot convention).

        Returns:
            {
              "total_queries": int,
              "answered": int,            # queries with >=1 result
              "distinct_top1": int,       # distinct ids that won rank 1
              "max_top1_share": float,    # 0.0 when answered == 0
              "top1_ids": {id: count},
            }
        """
        queries = list(queries or [])
        top1_ids = {}
        answered = 0
        for q in queries:
            try:
                results = self.memory_search(q, limit=limit)
            except Exception:
                results = []
            if not results:
                continue
            answered += 1
            top1 = results[0].get("id")
            top1_ids[top1] = top1_ids.get(top1, 0) + 1

        max_top1_share = round(max(top1_ids.values()) / answered, 4) if answered > 0 else 0.0

        return {
            "total_queries": len(queries),
            "answered": answered,
            "distinct_top1": len(top1_ids),
            "max_top1_share": max_top1_share,
            "top1_ids": top1_ids,
        }

    def memory_backfill_embeddings(self, batch_size=50):
        """Backfill embeddings for memories that don't have one yet.

        Requires VOYAGE_API_KEY or OPENAI_API_KEY.
        Returns dict with counts of processed, succeeded, failed.
        """
        provider_name, cfg = PGStore._detect_embedding_provider()
        if cfg is None:
            return {"error": "No embedding API key set (VOYAGE_API_KEY or OPENAI_API_KEY)", "processed": 0}

        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT id, text FROM gsd_memory
                    WHERE embedding IS NULL
                    ORDER BY created_at DESC
                    LIMIT %s
                """, (batch_size,))
                rows = cur.fetchall()

        if not rows:
            return {"processed": 0, "succeeded": 0, "failed": 0, "remaining": 0}

        succeeded = 0
        failed = 0
        for row in rows:
            # MEM-03 AUDIT (2026-04-06): input_type="document" correct for backfill path
            embedding = self.generate_embedding(row["text"], input_type="document")
            if embedding:
                try:
                    with self._get_conn() as conn:
                        with conn.cursor() as cur:
                            cur.execute("""
                                UPDATE gsd_memory SET embedding = %s::vector
                                WHERE id = %s
                            """, (str(embedding), row["id"]))
                    succeeded += 1
                except Exception:
                    failed += 1
            else:
                failed += 1

        # Count remaining
        remaining = 0
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE embedding IS NULL")
                remaining = cur.fetchone()[0]

        return {
            "processed": len(rows),
            "succeeded": succeeded,
            "failed": failed,
            "remaining": remaining,
        }

    def memory_embedding_stats(self):
        """Get statistics about embedding coverage and active provider."""
        provider_name, cfg = PGStore._detect_embedding_provider()
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT
                        COUNT(*) as total,
                        COUNT(embedding) as with_embedding,
                        COUNT(*) - COUNT(embedding) as without_embedding
                    FROM gsd_memory
                """)
                row = cur.fetchone()
                return {
                    "total": row[0],
                    "with_embedding": row[1],
                    "without_embedding": row[2],
                    "coverage_pct": round(row[1] / max(row[0], 1) * 100, 1),
                    "provider": provider_name or "none",
                    "model": cfg["default_model"] if cfg else "none",
                    "dimensions": cfg["dimensions"] if cfg else 0,
                }

    # ═══════════════════════════════════════════════════════
    # Memory Retention (MEM-02: Tiered archival)
    # ═══════════════════════════════════════════════════════

    def _ensure_archive_table(self):
        """Create gsd_memory_archive table if it doesn't exist (lazy init)."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS gsd_memory_archive (
                        id          VARCHAR(64) PRIMARY KEY,
                        text        TEXT NOT NULL,
                        agent_id    VARCHAR(64),
                        source      VARCHAR(64),
                        tags        JSONB DEFAULT '[]'::jsonb,
                        metadata    JSONB DEFAULT '{}'::jsonb,
                        project_id  VARCHAR(128),
                        embedding   vector(1024),
                        created_at  TIMESTAMPTZ,
                        updated_at  TIMESTAMPTZ,
                        archived_at TIMESTAMPTZ DEFAULT NOW()
                    )
                """)

    def memory_retention_cleanup(self):
        """Archive stale memory entries based on RETENTION_DAYS policy.

        Moves entries to gsd_memory_archive (soft delete -- no data lost).
        Tiers: task_event (30d), rpetd_phase (90d), web_search_result (180d).
        High-value sources (auto_learning, lesson-learned, best-practice, distilled)
        are never archived.

        Returns dict: {"task_event_archived": N, "rpetd_phase_archived": M, "web_search_result_archived": P, "total": N+M+P}
        """
        self._ensure_archive_table()
        results = {}
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                for source, days in RETENTION_DAYS.items():
                    # Move matching entries to archive table
                    cur.execute("""
                        INSERT INTO gsd_memory_archive
                            (id, text, agent_id, source, tags, metadata,
                             project_id, embedding, created_at, updated_at)
                        SELECT id, text, agent_id, source, tags, metadata,
                               project_id, embedding, created_at, updated_at
                        FROM gsd_memory
                        WHERE source = %s
                          AND created_at < NOW() - make_interval(days => %s)
                        ON CONFLICT (id) DO NOTHING
                    """, (source, days))
                    moved = cur.rowcount
                    # Remove from active table
                    cur.execute("""
                        DELETE FROM gsd_memory
                        WHERE source = %s
                          AND created_at < NOW() - make_interval(days => %s)
                    """, (source, days))
                    results[f"{source}_archived"] = moved
        results["total"] = sum(results.values())
        return results

    # ═══════════════════════════════════════════════════════
    # Audit Log Operations (Append-Only)
    # ═══════════════════════════════════════════════════════
    # CRITICAL: No UPDATE or DELETE on gsd_audit_log — only INSERT and SELECT.

    def audit_log(self, task_id, event_type, agent_id=None, actor=None,
                  phase=None, status=None, gate_results=None, content=None,
                  metadata=None):
        """Insert an immutable audit log entry. Returns the new row ID."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO gsd_audit_log
                        (task_id, event_type, agent_id, actor, phase, status,
                         gate_results, content, metadata)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb)
                    RETURNING id
                """, (
                    task_id, event_type, agent_id, actor, phase, status,
                    json.dumps(gate_results) if gate_results else None,
                    content,
                    json.dumps(metadata or {}),
                ))
                return cur.fetchone()[0]

    def audit_query(self, task_id=None, event_type=None, start_date=None,
                    end_date=None, limit=100):
        """Query audit log entries with optional filters.

        Args:
            task_id: Filter by task ID.
            event_type: Filter by event type.
            start_date: ISO date string for range start.
            end_date: ISO date string for range end.
            limit: Max rows returned.

        Returns list of dicts.
        """
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                conditions = []
                params = []

                if task_id:
                    conditions.append("task_id = %s")
                    params.append(task_id)
                if event_type:
                    conditions.append("event_type = %s")
                    params.append(event_type)
                if start_date:
                    conditions.append("created_at >= %s::timestamptz")
                    params.append(start_date)
                if end_date:
                    conditions.append("created_at <= %s::timestamptz")
                    params.append(end_date)

                where = " AND ".join(conditions) if conditions else "TRUE"
                sql = f"""
                    SELECT * FROM gsd_audit_log
                    WHERE {where}
                    ORDER BY created_at DESC
                    LIMIT %s
                """
                cur.execute(sql, params + [limit])
                results = cur.fetchall()
                for r in results:
                    for key in ("created_at",):
                        if key in r and isinstance(r[key], datetime):
                            r[key] = r[key].isoformat()
                    # Ensure gate_results and metadata are dicts (not strings)
                    for key in ("gate_results", "metadata"):
                        if key in r and r[key] is None:
                            r[key] = None
                return [dict(r) for r in results]

    def audit_count(self):
        """Count total audit log entries."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM gsd_audit_log")
                return cur.fetchone()[0]

    # ═══════════════════════════════════════════════════════
    # Backup Export / Import (Phase 8: Data Durability)
    # ═══════════════════════════════════════════════════════

    def _rows_to_dicts(self, rows):
        """Convert RealDictCursor rows to plain dicts with JSON-safe types."""
        results = []
        for row in rows:
            d = dict(row)
            for key, val in d.items():
                if isinstance(val, datetime):
                    d[key] = val.isoformat()
                elif isinstance(val, Decimal):
                    d[key] = float(val)
            # Remove embedding from exports (large binary, not portable)
            d.pop("embedding", None)
            results.append(d)
        return results

    def export_all_memory(self):
        """Export all rows from gsd_memory."""
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT * FROM gsd_memory ORDER BY id")
                return self._rows_to_dicts(cur.fetchall())

    def export_all_tasks(self):
        """Export all rows from gsd_tasks."""
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT * FROM gsd_tasks ORDER BY id")
                return self._rows_to_dicts(cur.fetchall())

    def export_all_skb(self):
        """Export all rows from gsd_shared_kb."""
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT * FROM gsd_shared_kb ORDER BY id")
                return self._rows_to_dicts(cur.fetchall())

    def export_all_validations(self):
        """Export all rows from gsd_task_validations."""
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("SELECT * FROM gsd_task_validations ORDER BY id")
                return self._rows_to_dicts(cur.fetchall())

    def export_all_agent_performance(self):
        """Export all rows from gsd_agent_performance (if table exists)."""
        try:
            with self._get_conn() as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute("SELECT * FROM gsd_agent_performance ORDER BY id")
                    return self._rows_to_dicts(cur.fetchall())
        except Exception:
            return []

    def export_all_audit(self):
        """Export all rows from gsd_audit_log (if table exists)."""
        try:
            with self._get_conn() as conn:
                with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    cur.execute("SELECT * FROM gsd_audit_log ORDER BY id")
                    return self._rows_to_dicts(cur.fetchall())
        except Exception:
            return []

    def import_audit(self, rows, mode="merge"):
        """Import audit log rows from backup.

        Merge mode: INSERT ... ON CONFLICT (id) DO NOTHING — preserves existing history.
        Replace mode: TRUNCATE + INSERT — mirrors behavior of all other import methods.
        Note: replace mode is the only case where append-only semantics are relaxed;
        the user explicitly requested a full restore, so existing records are dropped.

        Args:
            rows: List of row dicts from export_all_audit().
            mode: 'merge' or 'replace'.

        Returns:
            Number of rows imported.
        """
        if not rows:
            return 0
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if mode == "replace":
                    cur.execute("TRUNCATE gsd_audit_log CASCADE")
                count = 0
                for row in rows:
                    try:
                        cur.execute("""
                            INSERT INTO gsd_audit_log
                                (id, task_id, event_type, agent_id, actor, phase, status,
                                 gate_results, content, metadata, created_at)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb, %s)
                            ON CONFLICT (id) DO NOTHING
                        """, (
                            row.get("id"),
                            row.get("task_id"),
                            row.get("event_type"),
                            row.get("agent_id"),
                            row.get("actor"),
                            row.get("phase"),
                            row.get("status"),
                            json.dumps(row.get("gate_results", {})) if isinstance(row.get("gate_results"), (list, dict)) else row.get("gate_results", "{}"),
                            row.get("content"),
                            json.dumps(row.get("metadata", {})) if isinstance(row.get("metadata"), (list, dict)) else row.get("metadata", "{}"),
                            row.get("created_at"),
                        ))
                        count += cur.rowcount
                    except Exception:
                        pass
                return count

    def import_memory(self, rows, mode="merge"):
        """Import memory rows from backup.

        Args:
            rows: List of row dicts.
            mode: 'merge' (INSERT ... ON CONFLICT DO NOTHING) or
                  'replace' (TRUNCATE + INSERT).

        Returns:
            Number of rows imported.
        """
        if not rows:
            return 0
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if mode == "replace":
                    cur.execute("TRUNCATE gsd_memory CASCADE")
                count = 0
                for row in rows:
                    try:
                        cur.execute("""
                            INSERT INTO gsd_memory (id, text, source, agent_id, tags, metadata, project_id, created_at, updated_at)
                            VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s)
                            ON CONFLICT (id) DO NOTHING
                        """, (
                            row.get("id"),
                            row.get("text", ""),
                            row.get("source", "agent"),
                            row.get("agent_id"),
                            json.dumps(row.get("tags", [])) if isinstance(row.get("tags"), (list, dict)) else row.get("tags", "[]"),
                            json.dumps(row.get("metadata", {})) if isinstance(row.get("metadata"), (list, dict)) else row.get("metadata", "{}"),
                            row.get("project_id"),
                            row.get("created_at"),
                            row.get("updated_at"),
                        ))
                        count += cur.rowcount
                    except Exception:
                        pass  # Skip bad rows
                return count

    def import_tasks(self, rows, mode="merge"):
        """Import task rows from backup."""
        if not rows:
            return 0
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if mode == "replace":
                    cur.execute("TRUNCATE gsd_tasks CASCADE")
                count = 0
                for row in rows:
                    try:
                        cur.execute("""
                            INSERT INTO gsd_tasks (
                                id, project_id, type, title, description, details,
                                status, priority, assigned_to, claimed_by, claimed_at,
                                rpetd_r, rpetd_p, rpetd_e, rpetd_t, rpetd_d, rpetd_complete,
                                importance, urgency,
                                success_criteria, deliverables, dependencies,
                                tags, notes, parent_id, validation_notes, validated_by,
                                test_strategy, phase, plan, evidence, outcome, lesson,
                                created_at, updated_at
                            ) VALUES (
                                %s, %s, %s, %s, %s, %s,
                                %s, %s, %s, %s, %s,
                                %s, %s, %s, %s, %s, %s,
                                %s, %s,
                                %s::jsonb, %s::jsonb, %s::jsonb,
                                %s::jsonb, %s::jsonb, %s, %s, %s,
                                %s, %s, %s, %s::jsonb, %s, %s,
                                %s, %s
                            )
                            ON CONFLICT (id) DO NOTHING
                        """, (
                            row.get("id"), row.get("project_id", "default"),
                            row.get("type", "task"), row.get("title", ""),
                            row.get("description", ""), row.get("details", ""),
                            row.get("status", "pending"), row.get("priority", "medium"),
                            row.get("assigned_to", ""), row.get("claimed_by"),
                            row.get("claimed_at"),
                            row.get("rpetd_r", ""), row.get("rpetd_p", ""),
                            row.get("rpetd_e", ""), row.get("rpetd_t", ""),
                            row.get("rpetd_d", ""), row.get("rpetd_complete", False),
                            row.get("importance", 3), row.get("urgency", 3),
                            json.dumps(row.get("success_criteria", [])) if isinstance(row.get("success_criteria"), (list, dict)) else row.get("success_criteria", "[]"),
                            json.dumps(row.get("deliverables", [])) if isinstance(row.get("deliverables"), (list, dict)) else row.get("deliverables", "[]"),
                            json.dumps(row.get("dependencies", [])) if isinstance(row.get("dependencies"), (list, dict)) else row.get("dependencies", "[]"),
                            json.dumps(row.get("tags", [])) if isinstance(row.get("tags"), (list, dict)) else row.get("tags", "[]"),
                            json.dumps(row.get("notes", [])) if isinstance(row.get("notes"), (list, dict)) else row.get("notes", "[]"),
                            row.get("parent_id"), row.get("validation_notes", ""),
                            row.get("validated_by", ""),
                            row.get("test_strategy", ""), row.get("phase", ""),
                            row.get("plan", ""),
                            json.dumps(row.get("evidence", {})) if isinstance(row.get("evidence"), (list, dict)) else row.get("evidence", "{}"),
                            row.get("outcome", ""), row.get("lesson", ""),
                            row.get("created_at"), row.get("updated_at"),
                        ))
                        count += cur.rowcount
                    except Exception:
                        pass
                return count

    def import_skb(self, rows, mode="merge"):
        """Import SKB rows from backup."""
        if not rows:
            return 0
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if mode == "replace":
                    cur.execute("TRUNCATE gsd_shared_kb CASCADE")
                count = 0
                for row in rows:
                    try:
                        cur.execute("""
                            INSERT INTO gsd_shared_kb (id, title, content, category, agent_id, tags, importance, source_task, created_at, updated_at)
                            VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s)
                            ON CONFLICT (id) DO NOTHING
                        """, (
                            row.get("id"), row.get("title", ""),
                            row.get("content", ""), row.get("category"),
                            row.get("agent_id"),
                            json.dumps(row.get("tags", [])) if isinstance(row.get("tags"), (list, dict)) else row.get("tags", "[]"),
                            row.get("importance", 5), row.get("source_task"),
                            row.get("created_at"), row.get("updated_at"),
                        ))
                        count += cur.rowcount
                    except Exception:
                        pass
                return count

    def import_validations(self, rows, mode="merge"):
        """Import validation rows from backup."""
        if not rows:
            return 0
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if mode == "replace":
                    cur.execute("TRUNCATE gsd_task_validations CASCADE")
                count = 0
                for row in rows:
                    try:
                        cur.execute("""
                            INSERT INTO gsd_task_validations (task_id, validator_id, status, evidence, rejection_reason, created_at)
                            VALUES (%s, %s, %s, %s::jsonb, %s, %s)
                        """, (
                            row.get("task_id"), row.get("validator_id"),
                            row.get("status"),
                            json.dumps(row.get("evidence", {})) if isinstance(row.get("evidence"), (list, dict)) else row.get("evidence", "{}"),
                            row.get("rejection_reason"),
                            row.get("created_at"),
                        ))
                        count += cur.rowcount
                    except Exception:
                        pass
                return count

    def import_agent_performance(self, rows, mode="merge"):
        """Import agent performance rows from backup."""
        if not rows:
            return 0
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    if mode == "replace":
                        cur.execute("TRUNCATE gsd_agent_performance CASCADE")
                    count = 0
                    for row in rows:
                        try:
                            cur.execute("""
                                INSERT INTO gsd_agent_performance
                                    (agent_id, task_id, task_type, project_id, outcome,
                                     gate_failed, failure_reason, duration_minutes, learning_captured, created_at)
                                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                            """, (
                                row.get("agent_id"), row.get("task_id"),
                                row.get("task_type", "task"), row.get("project_id", "default"),
                                row.get("outcome", "pass"),
                                row.get("gate_failed"), row.get("failure_reason"),
                                row.get("duration_minutes"), row.get("learning_captured"),
                                row.get("created_at"),
                            ))
                            count += cur.rowcount
                        except Exception:
                            pass
                    return count
        except Exception:
            return 0

    # ═══════════════════════════════════════════════════════
    # Semantic Cache Operations (Phase 24 / SEMANTIC-01..03)
    # ═══════════════════════════════════════════════════════

    def semantic_cache_lookup(self, query_text, threshold=0.90):
        """Look up a semantically similar cached response.

        Uses pgvector cosine similarity. Returns the cached response if
        similarity >= threshold, otherwise None.

        Args:
            query_text: The research query to look up.
            threshold: Minimum cosine similarity (default 0.90).

        Returns:
            dict with {id, query_text, response, response_tokens, similarity, source_file_hashes}
            or None if no match above threshold.
        """
        query_embedding = self.generate_embedding(query_text, input_type="query")
        if query_embedding is None:
            return None

        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                # cosine distance <= (1 - threshold) means similarity >= threshold
                max_distance = 1.0 - threshold
                cur.execute("""
                    SELECT id, query_text, response, response_tokens,
                           source_file_hashes,
                           (1 - (query_embedding <=> %s::vector)) as similarity
                    FROM semantic_cache
                    WHERE valid = TRUE
                      AND (query_embedding <=> %s::vector) <= %s
                    ORDER BY query_embedding <=> %s::vector
                    LIMIT 1
                """, (str(query_embedding), str(query_embedding),
                      max_distance, str(query_embedding)))
                row = cur.fetchone()
                if row:
                    return {
                        "id": row["id"],
                        "query_text": row["query_text"],
                        "response": row["response"],
                        "response_tokens": row["response_tokens"],
                        "similarity": round(float(row["similarity"]), 4),
                        "source_file_hashes": row["source_file_hashes"] or {},
                    }
        return None

    def semantic_cache_store(self, query_text, response, response_tokens=0,
                             source_file_hashes=None, provider="perplexity"):
        """Store a research response in the semantic cache.

        Args:
            query_text: The original query.
            response: The LLM/API response text.
            response_tokens: Estimated token count of the response.
            source_file_hashes: dict of {file_path: sha256_hash} for staleness.
            provider: Source provider name (default: "perplexity").

        Returns:
            The new cache entry ID, or None on failure.
        """
        # Must match lookup's input_type for cosine parity (SEMANTIC-01 checker note)
        query_embedding = self.generate_embedding(query_text, input_type="query")
        if query_embedding is None:
            return None

        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO semantic_cache
                        (query_text, query_embedding, response, response_tokens,
                         source_file_hashes, provider)
                    VALUES (%s, %s::vector, %s, %s, %s::jsonb, %s)
                    RETURNING id
                """, (
                    query_text,
                    str(query_embedding),
                    response,
                    response_tokens,
                    json.dumps(source_file_hashes or {}),
                    provider,
                ))
                return cur.fetchone()[0]

    def semantic_cache_invalidate(self, file_path, new_hash):
        """Invalidate cache entries where a source file hash has changed.

        Sets valid=false for entries whose source_file_hashes contains the
        given file_path with a different hash than new_hash.

        Args:
            file_path: The file that changed.
            new_hash: The new SHA-256 hash of the file.

        Returns:
            Number of entries invalidated.
        """
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                # Find entries that reference this file with a different hash
                cur.execute("""
                    UPDATE semantic_cache
                    SET valid = FALSE
                    WHERE valid = TRUE
                      AND source_file_hashes ? %s
                      AND source_file_hashes ->> %s != %s
                    RETURNING id
                """, (file_path, file_path, new_hash))
                return cur.rowcount

    def semantic_cache_stats(self):
        """Get cache statistics.

        Returns:
            dict with {entries, valid_entries} counts.
        """
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute("""
                    SELECT
                        COUNT(*) as total_entries,
                        COUNT(*) FILTER (WHERE valid = TRUE) as valid_entries
                    FROM semantic_cache
                """)
                row = cur.fetchone()
                return {
                    "entries": row["total_entries"],
                    "valid_entries": row["valid_entries"],
                }

    # ═══════════════════════════════════════════════════════
    # Cleanup
    # ═══════════════════════════════════════════════════════

    def close(self):
        """Close all pool connections."""
        if self._pool:
            try:
                self._pool.closeall()
            except Exception:
                pass
            self._pool = None

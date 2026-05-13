#!/usr/bin/env python3
"""
services/agent_hydrator.py — Phase 47 HYDRA-01

Agent-specific dynamic hydration helper. Queries 4 data sources concurrently
(PG memory, blackboard agent_findings, Valkey cache, security pipeline) and
returns a schema_version "1.0" JSON payload for use by the operator before
spawning a subagent.

Frozen contract: async def hydrate(agent_name, task_id=None) -> dict
Output shape: schema_version "1.0" — see 47-CONTEXT.md §Specifics

Import-safety: _HAS_PG and _HAS_REDIS guards ensure clean import
without psycopg2 or redis installed (matches Phase 42/43/45/46 convention).
"""

import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ── Import-safety guards (mandatory per Phase 42/43/45/46 convention) ─────────

try:
    from services.pg_store import PGStore, generate_embedding  # type: ignore
    _HAS_PG = True
except Exception:
    try:
        import sys as _sys
        _pg_dir = os.path.dirname(os.path.abspath(__file__))
        if _pg_dir not in _sys.path:
            _sys.path.insert(0, _pg_dir)
        from pg_store import PGStore, generate_embedding  # type: ignore
        _HAS_PG = True
    except Exception:
        PGStore = None  # type: ignore
        generate_embedding = None  # type: ignore
        _HAS_PG = False

try:
    import redis as _redis_lib
    _HAS_REDIS = True
except Exception:
    _redis_lib = None  # type: ignore
    _HAS_REDIS = False

# ── Frozen module-level constants (Phase 47 HYDRA-01 locks) ───────────────────

SCHEMA_VERSION = "1.0"

MEMORY_TOP_K = 3
MEMORY_COSINE_FLOOR = 0.6
MEMORY_RECENCY_DAYS = 90

BLACKBOARD_LIMIT = 5

SECURITY_LIMIT = 3
SECURITY_WINDOW_HOURS = 24

# Per-source timeout: 400ms. Total p95 < 500ms via parallel gather.
PER_SOURCE_TIMEOUT_S = 0.4

# Vocabulary for the security section (Form A: hardcoded IN list in SQL).
# Exported for test_security_finding_types_vocabulary — NOT bound in SQL execute().
SECURITY_FINDING_TYPES = ("security_alert", "lint_violation", "circuit_breaker_open")

# Valkey key template for agent recent activity (formatted at call time)
VALKEY_KEY_TEMPLATE = "agent:{name}:recent_activity"

# ── Helper: humanize a timestamp into a short relative age string ─────────────


def _humanize_age(ts: Optional[Any]) -> str:
    """Return e.g. '3m', '2h', '5d' relative to now (UTC).

    Handles both timezone-aware and naive datetimes safely.
    Returns '' if ts is None.
    """
    if ts is None:
        return ""
    try:
        now = datetime.now(timezone.utc)
        if hasattr(ts, "tzinfo") and ts.tzinfo is None:
            # Naive datetime — assume UTC
            ts = ts.replace(tzinfo=timezone.utc)
        delta_secs = (now - ts).total_seconds()
        if delta_secs < 3600:
            return f"{int(delta_secs // 60)}m"
        elif delta_secs < 86400:
            return f"{int(delta_secs // 3600)}h"
        else:
            return f"{int(delta_secs // 86400)}d"
    except Exception:
        return ""


# ── Helper: load agent description from frontmatter ──────────────────────────


def _load_agent_role(agent_name: str) -> str:
    """Read agents/gsd-{agent_name}.md and return the YAML frontmatter description field.

    Strips the 'gsd-' prefix from agent_name if present to build the canonical path.
    Returns empty string if file or field is absent — NO raise on missing.

    Used by hydrate() to build the memory embedding query.
    """
    # Normalise name: strip leading 'gsd-' if present, then rebuild path
    base = agent_name.lstrip("gsd-") if agent_name.startswith("gsd-") else agent_name
    # Always try agents/gsd-{base}.md first, then agents/{agent_name}.md as fallback
    candidates = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agents", f"gsd-{base}.md"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agents", f"{agent_name}.md"),
    ]
    for path in candidates:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                content = fh.read()
        except OSError:
            continue
        # Extract YAML frontmatter between first two '---' delimiters
        match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
        if not match:
            continue
        frontmatter = match.group(1)
        # Parse description: field (handles quoted and unquoted values)
        desc_match = re.search(r'^\s*description:\s*"?([^"\n]+)"?', frontmatter, re.MULTILINE)
        if desc_match:
            return desc_match.group(1).strip()
    return ""


# ── Source fetcher stubs (bodies filled in 47-01-02..47-01-05) ───────────────


async def _fetch_memory(agent_name: str, agent_role: str) -> dict:
    """Phase 43 hybrid BM25+pgvector memory query for this agent.

    Top-K=MEMORY_TOP_K (3), cosine_floor=MEMORY_COSINE_FLOOR (0.6),
    recency=MEMORY_RECENCY_DAYS (90d). Runs sync psycopg2 query inside
    asyncio.to_thread() for true concurrency when called via asyncio.gather.

    Decision (v1): cosine-only path (no BM25 hybrid) for v1 simplicity.
    BM25 hybrid (Phase 43 RRF) is deferred to a future iteration when BM25
    recall matters more. Embedding-only path already covers semantic matches
    for the agent_name + agent_role query string.
    If embedding is None (Voyage API down), returns unavailable cleanly.
    """
    if not _HAS_PG:
        return {"status": "unavailable", "items": []}

    def _sync_fetch() -> dict:
        try:
            query_text = f"{agent_name} {agent_role}"
            embedding = generate_embedding(query_text, input_type="query")
            if embedding is None:
                # Voyage/OpenAI API unavailable — skip gracefully (v1 cosine-only decision)
                return {"status": "unavailable", "items": [], "error": "embedding_unavailable"}
            emb_str = "[" + ",".join(str(float(v)) for v in embedding) + "]"
            store = PGStore()
            with store._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, text,"
                        " 1 - (embedding <=> %s::vector) AS cosine,"
                        " EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0 AS age_days"
                        " FROM gsd_memory"
                        " WHERE embedding IS NOT NULL"
                        "   AND created_at >= NOW() - INTERVAL '%s days'"
                        " ORDER BY embedding <=> %s::vector"
                        " LIMIT %s",
                        (emb_str, str(MEMORY_RECENCY_DAYS), emb_str, MEMORY_TOP_K),
                    )
                    rows = cur.fetchall()
            items = []
            for row in rows:
                cosine = float(row[2]) if row[2] is not None else 0.0
                if cosine < MEMORY_COSINE_FLOOR:
                    continue
                text_trunc = (row[1] or "")[:200]
                items.append({
                    "id": str(row[0]),
                    "summary": text_trunc,
                    "cosine": cosine,
                    "age_days": float(row[3]) if row[3] is not None else 0.0,
                })
            return {"status": "ok", "items": items}
        except Exception as exc:
            return {"status": "unavailable", "items": [], "error": str(exc)[:200]}

    return await asyncio.to_thread(_sync_fetch)


async def _fetch_blackboard(agent_name: str, task_id: Optional[str]) -> dict:
    """Blackboard agent_findings query (recipient_agent IS NULL OR recipient_agent = agent_name).

    Content AS summary alias. Two SQL branches: task_id present + absent.
    Body implemented in task 47-01-03.
    """
    return {"status": "ok", "items": []}


async def _fetch_valkey(agent_name: str) -> dict:
    """Read agent:{name}:recent_activity key from Valkey/Redis.

    Body implemented in task 47-01-04.
    """
    return {"status": "ok", "data": None}


async def _fetch_security() -> dict:
    """Security pipeline query: finding_type IN ('security_alert', 'lint_violation', 'circuit_breaker_open'), 24h window.

    Body implemented in task 47-01-05.
    """
    return {"status": "ok", "items": []}


async def hydrate(agent_name: str, task_id: Optional[str] = None) -> dict:
    """Hydrate agent context by querying 4 sources concurrently.

    Signature LOCKED per 47-CONTEXT.md. NEVER raises — all errors degrade to
    'unavailable' status per source. Returns schema_version '1.0' JSON payload.

    Body implemented in task 47-01-05.
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "agent_name": agent_name,
        "task_id": task_id,
        "sources_status": {
            "memory": "unavailable",
            "blackboard": "unavailable",
            "valkey": "unavailable",
            "security": "unavailable",
        },
        "memory": [],
        "blackboard": [],
        "recent_activity": None,
        "security": [],
    }

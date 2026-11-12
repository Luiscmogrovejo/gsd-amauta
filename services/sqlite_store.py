#!/usr/bin/env python3
"""
SQLite store for GSD-Amauta — fallback when PostgreSQL is unavailable.

Mirrors the PGStore interface (pg_store.py) for core operations:
  - Memory storage/search with source-aware scoring
  - Shared Knowledge Base (SKB) storage/search
  - Task validation audit trail
  - Task upsert (mirror)

Uses SQLite FTS5 for full-text search. Schema is self-migrating
(created on first use).

Limitations vs PGStore:
  - No pgvector embeddings (semantic search falls back to FTS)
  - No JSONB operators (tags stored as JSON text, searched via LIKE)
  - No connection pooling (SQLite is single-writer anyway)
  - No cross-encoder reranking
"""

import json
import os
import re
import sqlite3
import threading
import hashlib
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone


# ═══════════════════════════════════════════════════════
# Source-aware scoring (same as pg_store.py)
# ═══════════════════════════════════════════════════════

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

# ═══════════════════════════════════════════════════════
# Tag synonym normalization (shared with pg_store.py)
# ═══════════════════════════════════════════════════════

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
}


def normalize_tags(tags):
    """Normalize tag variations to canonical forms."""
    if not tags:
        return tags
    normalized = []
    seen = set()
    for tag in tags:
        canonical = TAG_SYNONYMS.get(tag.lower().strip(), tag.lower().strip())
        if canonical not in seen:
            normalized.append(canonical)
            seen.add(canonical)
    return normalized


def _gen_id(prefix="mem"):
    """Generate a short random ID matching PG's format."""
    rand = hashlib.md5(os.urandom(16)).hexdigest()[:12]
    return f"{prefix}-{rand}"


def _gen_uuid():
    """Generate a UUID string.

    The blackboard / handoff / metrics tables use `UUID PRIMARY KEY DEFAULT
    gen_random_uuid()` on PostgreSQL (migrations 014-017). SQLite has no UUID
    type and no default generator, so ids are minted in Python and stored as
    TEXT in the same canonical 8-4-4-4-12 form, which keeps every id the HTTP
    API hands out shaped identically on both backends.
    """
    return str(uuid.uuid4())


def _utc_now_iso():
    """Current UTC time as an ISO-8601 string with milliseconds.

    PG's TIMESTAMPTZ columns come back as datetimes the daemon calls
    `.isoformat()` on. SQLite stores text, so the store writes the ISO form
    directly and readers return it unchanged — same wire shape, no parsing
    round-trip. Millisecond precision (SQLite's `datetime('now')` is
    second-resolution) matters because handoff/finding ordering is
    `created_at DESC` and several rows can land inside one second.
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "+00:00"


def normalize_phase_number(raw):
    """Normalize a phase identifier to int when integral, else float.

    Phase 41's `step_handoffs.phase_number` is INTEGER on PostgreSQL, but GSD
    inserts urgent work as decimal phases (`/amauta:insert-phase` 72.1). The
    SQLite column is TEXT so it carries both; this is the one place that
    decides what "72", "72.0" and "72.1" mean.

    Raises ValueError when `raw` is not a number at all.
    """
    val = float(raw)
    if val != val or val in (float("inf"), float("-inf")):
        raise ValueError(f"phase must be a finite number, got {raw!r}")
    if val.is_integer():
        return int(val)
    return val


class SQLiteStore:
    """Thread-safe SQLite store with FTS5 search."""

    def __init__(self, db_path=None):
        """Initialize SQLite store.

        Args:
            db_path: Path to SQLite database file. Defaults to
                     GSD_SQLITE_PATH env or ~/.amauta/data/gsd_amauta.db.
        """
        self.db_path = db_path or os.environ.get(
            "GSD_SQLITE_PATH",
            os.path.join(
                os.environ.get("GSD_DATA_DIR", os.path.expanduser("~/.amauta/data")),
                "gsd_amauta.db",
            ),
        )
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._lock = threading.Lock()
        self._ensure_schema()

    @contextmanager
    def _get_conn(self):
        """Get a SQLite connection with WAL mode and row factory."""
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _ensure_schema(self):
        """Create tables and FTS indexes on first use."""
        with self._get_conn() as conn:
            conn.executescript("""
                -- Memory table
                CREATE TABLE IF NOT EXISTS gsd_memory (
                    id          TEXT PRIMARY KEY,
                    text        TEXT NOT NULL,
                    agent_id    TEXT,
                    source      TEXT DEFAULT 'agent',
                    tags        TEXT DEFAULT '[]',
                    metadata    TEXT DEFAULT '{}',
                    project_id  TEXT,
                    created_at  TEXT DEFAULT (datetime('now')),
                    updated_at  TEXT DEFAULT (datetime('now'))
                );

                -- Memory FTS5 index
                CREATE VIRTUAL TABLE IF NOT EXISTS gsd_memory_fts USING fts5(
                    text,
                    content='gsd_memory',
                    content_rowid='rowid'
                );

                -- Triggers to keep FTS in sync
                CREATE TRIGGER IF NOT EXISTS gsd_memory_ai AFTER INSERT ON gsd_memory BEGIN
                    INSERT INTO gsd_memory_fts(rowid, text) VALUES (new.rowid, new.text);
                END;
                CREATE TRIGGER IF NOT EXISTS gsd_memory_ad AFTER DELETE ON gsd_memory BEGIN
                    INSERT INTO gsd_memory_fts(gsd_memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
                END;
                CREATE TRIGGER IF NOT EXISTS gsd_memory_au AFTER UPDATE ON gsd_memory BEGIN
                    INSERT INTO gsd_memory_fts(gsd_memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
                    INSERT INTO gsd_memory_fts(rowid, text) VALUES (new.rowid, new.text);
                END;

                -- Shared Knowledge Base
                CREATE TABLE IF NOT EXISTS gsd_shared_kb (
                    id          TEXT PRIMARY KEY,
                    title       TEXT NOT NULL,
                    content     TEXT NOT NULL,
                    category    TEXT,
                    agent_id    TEXT,
                    tags        TEXT DEFAULT '[]',
                    importance  INTEGER DEFAULT 5,
                    source_task TEXT,
                    created_at  TEXT DEFAULT (datetime('now')),
                    updated_at  TEXT DEFAULT (datetime('now'))
                );

                -- SKB FTS5 index
                CREATE VIRTUAL TABLE IF NOT EXISTS gsd_shared_kb_fts USING fts5(
                    title,
                    content_text,
                    content='gsd_shared_kb',
                    content_rowid='rowid'
                );

                CREATE TRIGGER IF NOT EXISTS gsd_skb_ai AFTER INSERT ON gsd_shared_kb BEGIN
                    INSERT INTO gsd_shared_kb_fts(rowid, title, content_text)
                        VALUES (new.rowid, new.title, new.content);
                END;
                CREATE TRIGGER IF NOT EXISTS gsd_skb_ad AFTER DELETE ON gsd_shared_kb BEGIN
                    INSERT INTO gsd_shared_kb_fts(gsd_shared_kb_fts, rowid, title, content_text)
                        VALUES ('delete', old.rowid, old.title, old.content);
                END;
                CREATE TRIGGER IF NOT EXISTS gsd_skb_au AFTER UPDATE ON gsd_shared_kb BEGIN
                    INSERT INTO gsd_shared_kb_fts(gsd_shared_kb_fts, rowid, title, content_text)
                        VALUES ('delete', old.rowid, old.title, old.content);
                    INSERT INTO gsd_shared_kb_fts(rowid, title, content_text)
                        VALUES (new.rowid, new.title, new.content);
                END;

                -- Tasks (mirror of tasks.json)
                CREATE TABLE IF NOT EXISTS gsd_tasks (
                    id               TEXT PRIMARY KEY,
                    project_id       TEXT NOT NULL DEFAULT 'default',
                    type             TEXT DEFAULT 'task',
                    title            TEXT NOT NULL,
                    description      TEXT,
                    details          TEXT,
                    status           TEXT DEFAULT 'pending',
                    priority         TEXT DEFAULT 'medium',
                    assigned_to      TEXT DEFAULT 'unassigned',
                    claimed_by       TEXT,
                    claimed_at       TEXT,
                    phase            TEXT,
                    plan             TEXT,
                    rpetd_r          TEXT,
                    rpetd_p          TEXT,
                    rpetd_e          TEXT,
                    rpetd_t          TEXT,
                    rpetd_d          TEXT,
                    rpetd_complete   INTEGER DEFAULT 0,
                    importance       INTEGER DEFAULT 3,
                    urgency          INTEGER DEFAULT 3,
                    success_criteria TEXT DEFAULT '[]',
                    test_strategy    TEXT,
                    deliverables     TEXT DEFAULT '[]',
                    validation_notes TEXT,
                    validated_by     TEXT,
                    parent_id        TEXT,
                    dependencies     TEXT DEFAULT '[]',
                    evidence         TEXT DEFAULT '{}',
                    outcome          TEXT,
                    lesson           TEXT,
                    tags             TEXT DEFAULT '[]',
                    notes            TEXT DEFAULT '[]',
                    created_at       TEXT DEFAULT (datetime('now')),
                    updated_at       TEXT DEFAULT (datetime('now'))
                );

                -- Task validations
                CREATE TABLE IF NOT EXISTS gsd_task_validations (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id          TEXT NOT NULL,
                    validator_id     TEXT NOT NULL,
                    status           TEXT NOT NULL,
                    evidence         TEXT DEFAULT '{}',
                    rejection_reason TEXT,
                    created_at       TEXT DEFAULT (datetime('now'))
                );

                -- Audit Log (append-only, immutable)
                CREATE TABLE IF NOT EXISTS gsd_audit_log (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id     TEXT NOT NULL,
                    event_type  TEXT NOT NULL,
                    agent_id    TEXT,
                    actor       TEXT,
                    phase       TEXT,
                    status      TEXT,
                    gate_results TEXT,
                    content     TEXT,
                    metadata    TEXT DEFAULT '{}',
                    created_at  TEXT DEFAULT (datetime('now'))
                );

                -- Memory archive (MEM-02: soft-delete for retention cleanup)
                CREATE TABLE IF NOT EXISTS gsd_memory_archive (
                    id          TEXT PRIMARY KEY,
                    text        TEXT NOT NULL,
                    agent_id    TEXT,
                    source      TEXT,
                    tags        TEXT DEFAULT '[]',
                    metadata    TEXT DEFAULT '{}',
                    project_id  TEXT,
                    created_at  TEXT,
                    updated_at  TEXT,
                    archived_at TEXT DEFAULT (datetime('now'))
                );

                -- ── Blackboard: agent findings (PG migrations 014 + 020/021/023/027) ──
                -- Column set mirrors agent_findings after every extension
                -- migration, so the daemon's /api/findings handlers read and
                -- write the same field names on both backends. UUID -> TEXT,
                -- TIMESTAMPTZ -> ISO-8601 TEXT, BOOLEAN -> INTEGER.
                CREATE TABLE IF NOT EXISTS agent_findings (
                    id              TEXT PRIMARY KEY,
                    agent_name      TEXT NOT NULL,
                    task_id         TEXT,            -- nullable since migration 027
                    finding_type    TEXT NOT NULL,
                    content         TEXT NOT NULL,
                    confidence      REAL DEFAULT 0.8,
                    created_at      TEXT NOT NULL,
                    recipient_agent TEXT,            -- migration 020
                    severity        TEXT,            -- migration 020
                    session_id      TEXT,            -- migration 021
                    decision_type   TEXT,            -- migration 023
                    rule_id         TEXT,            -- migration 027
                    domain          TEXT,
                    file_path       TEXT,
                    evidence        TEXT,
                    suggested_fix   TEXT,
                    dedup_key       TEXT,
                    status          TEXT DEFAULT 'open',
                    ticket_id       TEXT,
                    audit_run_id    TEXT
                );

                -- ── Blackboard: agent messages (PG migration 015) ──
                CREATE TABLE IF NOT EXISTS agent_messages (
                    id                TEXT PRIMARY KEY,
                    from_agent        TEXT NOT NULL,
                    to_agent          TEXT NOT NULL,
                    task_id           TEXT NOT NULL,
                    message_type      TEXT NOT NULL,
                    content           TEXT NOT NULL,
                    response          TEXT,
                    status            TEXT DEFAULT 'pending',
                    operator_approved INTEGER DEFAULT 0,
                    created_at        TEXT NOT NULL,
                    responded_at      TEXT
                );

                -- ── Sharded workflows: step handoffs (PG migration 017) ──
                -- phase_number is TEXT here, not INTEGER: SQLite carries the
                -- decimal phases (`72.1`) that /amauta:insert-phase creates and
                -- that the PG INTEGER column cannot hold. JSON/array columns
                -- (TEXT[]/JSONB on PG) are JSON text.
                CREATE TABLE IF NOT EXISTS step_handoffs (
                    id               TEXT PRIMARY KEY,
                    workflow_name    TEXT NOT NULL,
                    step_id          TEXT NOT NULL,
                    task_id          TEXT NOT NULL,
                    phase_number     TEXT NOT NULL,
                    completed_steps  TEXT DEFAULT '[]',
                    context_snapshot TEXT NOT NULL,
                    artifacts        TEXT DEFAULT '{}',
                    decisions        TEXT DEFAULT '[]',
                    user_inputs      TEXT DEFAULT '[]',
                    next_step        TEXT,
                    escalation_flags TEXT DEFAULT '[]',
                    created_at       TEXT NOT NULL
                );

                -- ── Agent lifecycle metrics (PG migration 016) ──
                CREATE TABLE IF NOT EXISTS agent_metrics (
                    id                 TEXT PRIMARY KEY,
                    agent_name         TEXT NOT NULL,
                    task_id            TEXT NOT NULL,
                    completion_time_ms INTEGER,
                    token_usage        INTEGER,
                    error_count        INTEGER DEFAULT 0,
                    outcome            TEXT NOT NULL,
                    created_at         TEXT NOT NULL
                );

                -- Indexes
                CREATE INDEX IF NOT EXISTS idx_findings_task ON agent_findings(task_id);
                CREATE INDEX IF NOT EXISTS idx_findings_dedup ON agent_findings(dedup_key, status);
                CREATE INDEX IF NOT EXISTS idx_findings_domain ON agent_findings(domain, severity);
                CREATE INDEX IF NOT EXISTS idx_findings_recipient ON agent_findings(recipient_agent, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_messages_task ON agent_messages(task_id);
                CREATE INDEX IF NOT EXISTS idx_messages_to ON agent_messages(to_agent, status);
                CREATE INDEX IF NOT EXISTS idx_handoffs_task ON step_handoffs(task_id, workflow_name);
                CREATE INDEX IF NOT EXISTS idx_handoffs_latest ON step_handoffs(workflow_name, phase_number, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_metrics_agent ON agent_metrics(agent_name);
                CREATE INDEX IF NOT EXISTS idx_memory_project ON gsd_memory(project_id);
                CREATE INDEX IF NOT EXISTS idx_memory_source ON gsd_memory(source);
                CREATE INDEX IF NOT EXISTS idx_memory_created ON gsd_memory(created_at);
                CREATE INDEX IF NOT EXISTS idx_tasks_status ON gsd_tasks(status);
                CREATE INDEX IF NOT EXISTS idx_tasks_project ON gsd_tasks(project_id);
                CREATE INDEX IF NOT EXISTS idx_validations_task ON gsd_task_validations(task_id);
                CREATE INDEX IF NOT EXISTS idx_skb_category ON gsd_shared_kb(category);
                CREATE INDEX IF NOT EXISTS idx_skb_importance ON gsd_shared_kb(importance);
                CREATE INDEX IF NOT EXISTS idx_audit_task ON gsd_audit_log(task_id);
                CREATE INDEX IF NOT EXISTS idx_audit_type ON gsd_audit_log(event_type);
                CREATE INDEX IF NOT EXISTS idx_audit_created ON gsd_audit_log(created_at);
            """)

    # ═══════════════════════════════════════════════════════
    # Health
    # ═══════════════════════════════════════════════════════

    def health(self):
        """Check SQLite health."""
        try:
            with self._get_conn() as conn:
                conn.execute("SELECT 1")
                return {"status": "ok", "backend": "sqlite", "path": self.db_path}
        except Exception as e:
            return {"status": "error", "backend": "sqlite", "error": str(e)}

    # ═══════════════════════════════════════════════════════
    # Memory Operations
    # ═══════════════════════════════════════════════════════

    def memory_store(self, text, source="agent", agent_id=None, tags=None,
                     metadata=None, project_id=None):
        """Store a memory entry. Returns the new memory ID."""
        tags = normalize_tags(tags) if tags else []
        mem_id = _gen_id("mem")
        with self._get_conn() as conn:
            conn.execute(
                """INSERT INTO gsd_memory (id, text, source, agent_id, tags, metadata, project_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (mem_id, text, source, agent_id,
                 json.dumps(tags), json.dumps(metadata or {}),
                 project_id),
            )
        return mem_id

    def memory_store_with_embedding(self, text, source="agent", agent_id=None,
                                     tags=None, metadata=None, project_id=None):
        """Store memory (no embedding support in SQLite — falls through to plain store)."""
        return self.memory_store(text, source, agent_id, tags, metadata, project_id)

    def memory_search(self, query, project_id=None, source=None, limit=20,
                      exclude_sources=DEFAULT_EXCLUDE_SOURCES,
                      tags=None, category=None):
        """Search memories using FTS5 with source-aware scoring.

        Args:
            exclude_sources: Tuple/list of source strings to exclude from results.
                             Defaults to DEFAULT_EXCLUDE_SOURCES (task_event, rpetd_phase).
                             Pass None to include all sources.
            tags: Phase 10 LEARN-03 — optional list of tags; a row matches when it
                  carries ANY of them (same `?|` "overlap" semantics as PG's
                  GIN-indexed filter). SQLite has no JSONB operators, so the
                  stored `["a","b"]` JSON text is matched with LIKE '%"a"%',
                  which is exact at the element level because the quotes are
                  part of the pattern. Tags are normalized first, so `pg` and
                  `postgres` both match a row tagged `postgresql`.
            category: Phase 10 LEARN-03 — optional metadata->>'category' filter.
                      Matched against the JSON metadata text via SQLite's
                      json_extract so a key named "category" nested elsewhere
                      cannot produce a false hit.

        The daemon forwards both kwargs on /api/memory/search for either
        backend; before they existed here every filtered search raised
        TypeError and the endpoint answered 500.
        """
        if tags:
            tags = normalize_tags(tags)
        with self._get_conn() as conn:
            # Try FTS5 first
            conditions = []
            params = []

            # DATA-06: Exclude test entries from default search
            if project_id != '__test__':
                conditions.append("(m.project_id IS NULL OR m.project_id != '__test__')")

            if project_id:
                conditions.append("m.project_id = ?")
                params.append(project_id)
            if source:
                conditions.append("m.source = ?")
                params.append(source)

            # MEM-01: Exclude low-signal sources by default
            if exclude_sources:
                placeholders = ", ".join(["?"] * len(exclude_sources))
                conditions.append(f"m.source NOT IN ({placeholders})")
                params.extend(exclude_sources)

            # LEARN-03: tag overlap filter (ANY-of, like PG's `tags ?| array`)
            if tags:
                tag_conds = " OR ".join(["m.tags LIKE ?"] * len(tags))
                conditions.append(f"({tag_conds})")
                params.extend([f'%"{t}"%' for t in tags])

            # LEARN-03: metadata->>'category' equivalent
            if category:
                conditions.append("json_extract(m.metadata, '$.category') = ?")
                params.append(category)

            where_extra = (" AND " + " AND ".join(conditions)) if conditions else ""

            # FTS5 search
            fts_query = " OR ".join(
                w for w in re.sub(r"[^\w\s]", "", query).split() if w
            )
            if fts_query:
                sql = f"""
                    SELECT m.*, rank as text_rank
                    FROM gsd_memory m
                    JOIN gsd_memory_fts fts ON m.rowid = fts.rowid
                    WHERE gsd_memory_fts MATCH ?
                    {where_extra}
                    ORDER BY rank
                    LIMIT ?
                """
                rows = conn.execute(sql, [fts_query] + params + [limit]).fetchall()
                if rows:
                    return self._score_memories(rows)

            # Fallback: LIKE search
            keywords = [kw for kw in query.split() if kw]
            if not keywords:
                return []
            like_conds = " OR ".join(["m.text LIKE ?"] * len(keywords))
            like_params = [f"%{kw}%" for kw in keywords]

            sql = f"""
                SELECT m.*, 0.0 as text_rank
                FROM gsd_memory m
                WHERE ({like_conds})
                {where_extra}
                ORDER BY m.created_at DESC
                LIMIT ?
            """
            rows = conn.execute(sql, like_params + params + [limit]).fetchall()
            return self._score_memories(rows)

    def _score_memories(self, rows):
        """Apply source-aware scoring with recency decay to memory results.

        Returns dicts with the same keys/types as PGStore._score_memories():
          id, text, source, agent_id, tags (list), metadata (dict),
          project_id, created_at (str), updated_at (str), score (float),
          text_rank (float). No 'rowid' key.

        Score = norm_rank * 10 + source_bonus - recency_penalty
        """
        now = datetime.now(timezone.utc)
        scored = []
        for row in rows:
            d = dict(row)
            # Remove rowid — PG does not return it
            d.pop("rowid", None)
            source_bonus = SOURCE_SCORES.get(d.get("source", "agent"), 0)
            text_rank = abs(float(d.get("text_rank", 0)))
            # FTS5 rank is negative (more negative = more relevant)
            # Normalize: use min(rank/10, 1) for the text component
            norm_rank = min(text_rank / 10.0, 1.0) if text_rank else 0
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
            d["score"] = round(norm_rank * 10 + source_bonus - recency_penalty, 2)
            d["text_rank"] = round(norm_rank, 4)
            # Parse JSON fields
            for key in ("tags", "metadata"):
                if key in d and isinstance(d[key], str):
                    try:
                        d[key] = json.loads(d[key])
                    except (json.JSONDecodeError, TypeError):
                        pass
            scored.append(d)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored

    def memory_list(self, project_id=None, source=None, exclude_source=None, limit=50, offset=0):
        """List memories with optional filters.

        Args:
            exclude_source: Single source string or list of sources to exclude from results.
                            Used by distill to skip re-merging source='distilled' entries (DATA-03).
        """
        with self._get_conn() as conn:
            conditions = []
            params = []
            if project_id:
                conditions.append("project_id = ?")
                params.append(project_id)
            if source:
                conditions.append("source = ?")
                params.append(source)
            if exclude_source:
                if isinstance(exclude_source, list):
                    placeholders = ", ".join(["?"] * len(exclude_source))
                    conditions.append(f"source NOT IN ({placeholders})")
                    params.extend(exclude_source)
                else:
                    conditions.append("source != ?")
                    params.append(exclude_source)

            where = " AND ".join(conditions) if conditions else "1=1"
            sql = f"""
                SELECT id, text, source, agent_id, tags, project_id, created_at
                FROM gsd_memory
                WHERE {where}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
            """
            rows = conn.execute(sql, params + [limit, offset]).fetchall()
            results = []
            for r in rows:
                d = dict(r)
                if "tags" in d and isinstance(d["tags"], str):
                    try:
                        d["tags"] = json.loads(d["tags"])
                    except (json.JSONDecodeError, TypeError):
                        pass
                results.append(d)
            return results

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
            conditions = []
            params = []

            if project_id:
                conditions.append("project_id = ?")
                params.append(project_id)

            if exclude_source:
                placeholders = ", ".join(["?"] * len(exclude_source))
                conditions.append(f"source NOT IN ({placeholders})")
                params.extend(exclude_source)

            where_clause = ("WHERE " + " AND ".join(conditions)) if conditions else ""
            row = conn.execute(
                f"SELECT COUNT(*) FROM gsd_memory {where_clause}", params
            ).fetchone()
            return row[0]

    def memory_delete(self, mem_id):
        """Delete a memory entry by ID. Returns True when a row was removed.

        Used to return None unconditionally, so POST /api/memory/delete
        answered `{"deleted": true}` for ids that were never in the table.
        """
        with self._get_conn() as conn:
            cur = conn.execute("DELETE FROM gsd_memory WHERE id = ?", (mem_id,))
            return cur.rowcount > 0

    def memory_archive_and_delete(self, mem_id):
        """Copy one memory row into gsd_memory_archive, then delete it.

        Soft delete for the distill carry-forward: the text survives in
        gsd_memory_archive (same table memory_retention_cleanup() uses) while
        leaving the live table, so a distilled summary does not sit beside the
        rows it summarizes.

        Returns {"id", "archived", "already_archived", "deleted", "found"} with
        row counts, matching PGStore. A missing id reports found False. Insert
        and delete share one transaction: a delete never commits without its
        archive copy.
        """
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT id FROM gsd_memory WHERE id = ?", (mem_id,)
            ).fetchone()
            if row is None:
                return {"id": mem_id, "archived": 0, "already_archived": False,
                        "deleted": 0, "found": False}
            archived = conn.execute("""
                INSERT OR IGNORE INTO gsd_memory_archive
                    (id, text, agent_id, source, tags, metadata,
                     project_id, created_at, updated_at)
                SELECT id, text, agent_id, source, tags, metadata,
                       project_id, created_at, updated_at
                FROM gsd_memory WHERE id = ?
            """, (mem_id,)).rowcount > 0
            deleted = conn.execute(
                "DELETE FROM gsd_memory WHERE id = ?", (mem_id,)
            ).rowcount > 0
            # Same shape as PGStore.memory_archive_and_delete, so the
            # /api/memory/archive-delete endpoint serves both backends.
            return {"id": mem_id, "archived": int(archived),
                    "already_archived": not archived,
                    "deleted": int(deleted), "found": True}

    def memory_count_by_source(self):
        """Count memories grouped by source."""
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT source, COUNT(*) as cnt FROM gsd_memory GROUP BY source"
            ).fetchall()
            return {r["source"]: r["cnt"] for r in rows}

    def memory_tag_stats(self):
        """Get tag usage statistics."""
        with self._get_conn() as conn:
            rows = conn.execute("SELECT tags FROM gsd_memory WHERE tags != '[]'").fetchall()
            tag_counts = {}
            for row in rows:
                try:
                    tags = json.loads(row["tags"]) if isinstance(row["tags"], str) else row["tags"]
                    for tag in (tags or []):
                        tag_counts[tag] = tag_counts.get(tag, 0) + 1
                except (json.JSONDecodeError, TypeError):
                    pass
            # Sort by count descending, take top 20
            sorted_tags = sorted(tag_counts.items(), key=lambda x: x[1], reverse=True)[:20]
            return {"tags": dict(sorted_tags), "unique_tags": len(tag_counts)}

    def memory_cross_project_search(self, query, tags=None, exclude_project=None, limit=20):
        """Search memories across ALL projects (simplified for SQLite)."""
        if tags:
            tags = normalize_tags(tags)
        with self._get_conn() as conn:
            conditions = []
            params = []

            if exclude_project:
                conditions.append("(project_id IS NULL OR project_id != ?)")
                params.append(exclude_project)

            # Only high-value sources
            conditions.append(
                "source IN ('lesson-learned', 'best-practice', 'auto_learning', "
                "'web_search_result', 'session-learning', 'distilled')"
            )

            where = " AND ".join(conditions) if conditions else "1=1"

            # Tag filtering via LIKE (no JSONB in SQLite)
            if tags:
                tag_conds = " OR ".join(["tags LIKE ?"] * len(tags))
                where += f" AND ({tag_conds})"
                params.extend([f'%"{t}"%' for t in tags])

            keywords = [kw for kw in query.split() if kw]
            if not keywords:
                return []
            like_conds = " OR ".join(["text LIKE ?"] * len(keywords))
            like_params = [f"%{kw}%" for kw in keywords]

            sql = f"""
                SELECT *, 0.0 as text_rank
                FROM gsd_memory
                WHERE {where} AND ({like_conds})
                ORDER BY created_at DESC
                LIMIT ?
            """
            rows = conn.execute(sql, params + like_params + [limit]).fetchall()
            return self._score_memories(rows)

    def memory_semantic_search(self, query, project_id=None, source=None, limit=20,
                               exclude_sources=DEFAULT_EXCLUDE_SOURCES):
        """Semantic search not available in SQLite — falls back to FTS."""
        return self.memory_search(query, project_id, source, limit,
                                  exclude_sources=exclude_sources), "text_fallback"

    def memory_embedding_stats(self):
        """No embeddings in SQLite mode."""
        count = self.memory_count()
        return {
            "total": count,
            "with_embedding": 0,
            "without_embedding": count,
            "coverage_pct": 0.0,
            "provider": "none",
            "model": "none",
            "dimensions": 0,
        }

    def memory_backfill_embeddings(self, batch_size=50):
        """No embeddings in SQLite mode."""
        return {
            "error": "Embeddings not available in SQLite mode. Use PostgreSQL with pgvector.",
            "processed": 0,
        }

    # ═══════════════════════════════════════════════════════
    # Memory Retention (MEM-02: Tiered archival)
    # ═══════════════════════════════════════════════════════

    def memory_retention_cleanup(self):
        """Archive stale memory entries based on RETENTION_DAYS policy.

        Moves entries to gsd_memory_archive (soft delete -- no data lost).
        Tiers: task_event (30d), rpetd_phase (90d), web_search_result (180d).
        High-value sources (auto_learning, lesson-learned, best-practice, distilled)
        are never archived.

        Returns dict: {"task_event_archived": N, "rpetd_phase_archived": M, "web_search_result_archived": P, "total": N+M+P}
        """
        results = {}
        with self._get_conn() as conn:
            for source, days in RETENTION_DAYS.items():
                # Move matching entries to archive table
                conn.execute("""
                    INSERT OR IGNORE INTO gsd_memory_archive
                        (id, text, agent_id, source, tags, metadata,
                         project_id, created_at, updated_at)
                    SELECT id, text, agent_id, source, tags, metadata,
                           project_id, created_at, updated_at
                    FROM gsd_memory
                    WHERE source = ?
                      AND created_at < datetime('now', ? || ' days')
                """, (source, f"-{days}"))
                moved = conn.execute("""
                    SELECT changes()
                """).fetchone()[0]
                # Remove from active table
                conn.execute("""
                    DELETE FROM gsd_memory
                    WHERE source = ?
                      AND created_at < datetime('now', ? || ' days')
                """, (source, f"-{days}"))
                results[f"{source}_archived"] = moved
        results["total"] = sum(results.values())
        return results

    # ═══════════════════════════════════════════════════════
    # Blackboard: agent findings + agent messages
    # (Phase 38 COMM-01/02, Phase 78/79 audit substrate)
    #
    # These mirror the raw SQL the daemon runs against PostgreSQL. The daemon
    # dispatches to them when the active store is SQLite; the PG path is
    # unchanged. Every method returns plain dicts with ISO-8601 timestamp
    # strings, so the daemon's JSON payloads are identical on both backends.
    # ═══════════════════════════════════════════════════════

    @staticmethod
    def _finding_row(row):
        """Shape one agent_findings row the way the sweep endpoint reports it."""
        return {
            "id": row["id"],
            "agent_name": row["agent_name"],
            "task_id": row["task_id"],
            "finding_type": row["finding_type"],
            "severity": row["severity"],
            "domain": row["domain"],
            "file_path": row["file_path"],
            "rule_id": row["rule_id"],
            "status": row["status"],
            "content": row["content"],
            "created_at": row["created_at"],
        }

    def findings_sweep(self, status="open", domain=None, severity=None,
                       finding_type=None, since=None, limit=200):
        """Audit sweep over agent_findings (GET /api/findings)."""
        clauses = ["status = ?"]
        args = [status]
        if domain:
            clauses.append("domain = ?")
            args.append(domain)
        if severity:
            clauses.append("severity = ?")
            args.append(severity)
        if finding_type:
            clauses.append("finding_type = ?")
            args.append(finding_type)
        if since:
            clauses.append("created_at >= ?")
            args.append(since)
        sql = (
            "SELECT * FROM agent_findings WHERE " + " AND ".join(clauses) +
            " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        )
        with self._get_conn() as conn:
            rows = conn.execute(sql, args + [limit]).fetchall()
        return [self._finding_row(r) for r in rows]

    def findings_by_task(self, task_id):
        """All findings for one task (GET /api/findings/:task_id)."""
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT id, agent_name, task_id, finding_type, content, confidence,"
                " created_at FROM agent_findings WHERE task_id = ?"
                " ORDER BY created_at DESC, rowid DESC",
                (task_id,),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "agent_name": r["agent_name"],
                "task_id": r["task_id"],
                "finding_type": r["finding_type"],
                "content": r["content"],
                "confidence": r["confidence"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def finding_insert(self, agent_name, finding_type, content, task_id=None,
                       confidence=0.8, severity=None, rule_id=None, domain=None,
                       file_path=None, evidence=None, suggested_fix=None,
                       status="open", audit_run_id=None, dedup_key=None):
        """Insert a finding, deduplicating on dedup_key (SUBS-05 Layer A).

        Returns {"deduped": True, "existing_id": ...} when an open/ticketed
        finding already carries the same dedup_key, else
        {"id": ..., "created_at": ...}. Same contract as the PG branch; the
        caller computes dedup_key, never the client.
        """
        with self._get_conn() as conn:
            if dedup_key is not None:
                existing = conn.execute(
                    "SELECT id FROM agent_findings WHERE dedup_key = ?"
                    " AND status IN ('open','ticketed')"
                    " ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    (dedup_key,),
                ).fetchone()
                if existing:
                    return {"deduped": True, "existing_id": existing["id"]}
            fid = _gen_uuid()
            created_at = _utc_now_iso()
            conn.execute(
                "INSERT INTO agent_findings"
                " (id, agent_name, task_id, finding_type, content, confidence,"
                "  severity, rule_id, domain, file_path, evidence, suggested_fix,"
                "  status, audit_run_id, dedup_key, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (fid, agent_name, task_id, finding_type, content, float(confidence),
                 severity, rule_id, domain, file_path, evidence, suggested_fix,
                 status, audit_run_id, dedup_key, created_at),
            )
            return {"id": fid, "created_at": created_at}

    def finding_update(self, finding_id, status=None, ticket_id=None,
                       ticket_id_present=False):
        """Transition a finding's status/ticket (PATCH /api/findings/:id).

        `ticket_id_present` distinguishes "ticket_id was supplied as null"
        (clear it) from "ticket_id was not in the body" (leave it), which the
        PG branch expresses with `"ticket_id" in body`. Returns None when no
        such finding exists.
        """
        updates = []
        params = []
        if status:
            updates.append("status = ?")
            params.append(status)
        if ticket_id_present:
            updates.append("ticket_id = ?")
            params.append(ticket_id)
        if not updates:
            return None
        params.append(finding_id)
        with self._get_conn() as conn:
            cur = conn.execute(
                f"UPDATE agent_findings SET {', '.join(updates)} WHERE id = ?",
                params,
            )
            if cur.rowcount == 0:
                return None
            row = conn.execute(
                "SELECT id, status, ticket_id FROM agent_findings WHERE id = ?",
                (finding_id,),
            ).fetchone()
        if row is None:
            return None
        return {"id": row["id"], "status": row["status"], "ticket_id": row["ticket_id"]}

    def messages_for_agent(self, agent_name, statuses=None):
        """Inbox: messages addressed to one agent, by status.

        Args:
            agent_name: the recipient (``to_agent``).
            statuses: statuses to return. Default ``("pending", "approved")`` —
                the behaviour before plan 89-05, so no existing caller changes.
                The daemon validates the vocabulary against its own
                ``MESSAGE_STATUSES`` before calling; an empty or None sequence
                means the default, never "no statuses".

        Returns:
            list[dict]: one dict per message, ``response`` included. A message
            answered with ``status='responded'`` is readable with
            ``statuses=("responded",)`` — on PostgreSQL the same call shape
            returns the same fields.
        """
        wanted = tuple(statuses) if statuses else ("pending", "approved")
        placeholders = ", ".join(["?"] * len(wanted))
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM agent_messages WHERE to_agent = ?"
                f" AND status IN ({placeholders})"
                " ORDER BY created_at ASC, rowid ASC",
                (agent_name, *wanted),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "from_agent": r["from_agent"],
                "to_agent": r["to_agent"],
                "task_id": r["task_id"],
                "message_type": r["message_type"],
                "content": r["content"],
                "response": r["response"],
                "status": r["status"],
                # BOOLEAN -> INTEGER on SQLite; the API contract is a JSON bool.
                "operator_approved": bool(r["operator_approved"]),
                "created_at": r["created_at"],
                "responded_at": r["responded_at"],
            }
            for r in rows
        ]

    def message_insert(self, from_agent, to_agent, task_id, message_type,
                       content, status="pending", operator_approved=False):
        """Send a message. Returns {"id": ..., "created_at": ...}."""
        mid = _gen_uuid()
        created_at = _utc_now_iso()
        with self._get_conn() as conn:
            conn.execute(
                "INSERT INTO agent_messages"
                " (id, from_agent, to_agent, task_id, message_type, content,"
                "  status, operator_approved, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (mid, from_agent, to_agent, task_id, message_type, content,
                 status, 1 if operator_approved else 0, created_at),
            )
        return {"id": mid, "created_at": created_at}

    def message_update(self, msg_id, status=None, response=None,
                       response_present=False, operator_approved=None):
        """Approve / deny / respond to a message. None when the id is absent.

        Setting a response also stamps responded_at, matching the PG branch's
        `responded_at = NOW()`.
        """
        updates = []
        params = []
        if status:
            updates.append("status = ?")
            params.append(status)
        if response_present:
            updates.append("response = ?")
            params.append(response)
            updates.append("responded_at = ?")
            params.append(_utc_now_iso())
        if operator_approved is not None:
            updates.append("operator_approved = ?")
            params.append(1 if operator_approved else 0)
        if not updates:
            return None
        params.append(msg_id)
        with self._get_conn() as conn:
            cur = conn.execute(
                f"UPDATE agent_messages SET {', '.join(updates)} WHERE id = ?",
                params,
            )
            if cur.rowcount == 0:
                return None
            row = conn.execute(
                "SELECT id, status, operator_approved, responded_at"
                " FROM agent_messages WHERE id = ?",
                (msg_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "status": row["status"],
            "operator_approved": bool(row["operator_approved"]),
            "responded_at": row["responded_at"],
        }

    # ═══════════════════════════════════════════════════════
    # Sharded workflows: step handoffs (Phase 41 SHARD-04)
    # ═══════════════════════════════════════════════════════

    @staticmethod
    def _loads(raw, default):
        try:
            return json.loads(raw) if raw else default
        except (json.JSONDecodeError, TypeError):
            return default

    def step_handoff_latest(self, workflow_name, phase_number):
        """Most recent handoff for a workflow+phase, or None.

        `phase_number` is normalized before lookup so "72", 72 and 72.0 all
        find the same rows, and "72.1" finds only the decimal phase.
        """
        key = str(normalize_phase_number(phase_number))
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT * FROM step_handoffs WHERE workflow_name = ?"
                " AND phase_number = ?"
                " ORDER BY created_at DESC, rowid DESC LIMIT 1",
                (workflow_name, key),
            ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "workflow_name": row["workflow_name"],
            "step_id": row["step_id"],
            "task_id": row["task_id"],
            "phase_number": normalize_phase_number(row["phase_number"]),
            "completed_steps": self._loads(row["completed_steps"], []),
            "context_snapshot": self._loads(row["context_snapshot"], {}),
            "artifacts": self._loads(row["artifacts"], {}),
            "decisions": self._loads(row["decisions"], []),
            "user_inputs": self._loads(row["user_inputs"], []),
            "next_step": row["next_step"],
            "escalation_flags": self._loads(row["escalation_flags"], []),
            "created_at": row["created_at"],
        }

    def step_handoff_insert(self, workflow_name, phase_number, step_id="",
                            task_id="", completed_steps=None,
                            context_snapshot=None, artifacts=None,
                            decisions=None, user_inputs=None, next_step=None,
                            escalation_flags=None):
        """Append one handoff row. Returns {"id": ..., "created_at": ...}.

        Append-only, like the PG table — handoffs are a log, never upserted.
        """
        key = str(normalize_phase_number(phase_number))
        hid = _gen_uuid()
        created_at = _utc_now_iso()
        with self._get_conn() as conn:
            conn.execute(
                "INSERT INTO step_handoffs"
                " (id, workflow_name, step_id, task_id, phase_number,"
                "  completed_steps, context_snapshot, artifacts, decisions,"
                "  user_inputs, next_step, escalation_flags, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (hid, workflow_name, step_id or "", task_id or "", key,
                 json.dumps(completed_steps or []),
                 json.dumps(context_snapshot or {}),
                 json.dumps(artifacts or {}),
                 json.dumps(decisions or []),
                 json.dumps(user_inputs or []),
                 next_step,
                 json.dumps(escalation_flags or []),
                 created_at),
            )
        return {"id": hid, "created_at": created_at}

    # ═══════════════════════════════════════════════════════
    # Agent lifecycle metrics (Phase 39 LIFE-02)
    # ═══════════════════════════════════════════════════════

    def agent_metric_insert(self, agent_name, task_id, outcome,
                            completion_time_ms=None, token_usage=None,
                            error_count=0):
        """Record one agent execution metric."""
        mid = _gen_uuid()
        created_at = _utc_now_iso()
        with self._get_conn() as conn:
            conn.execute(
                "INSERT INTO agent_metrics"
                " (id, agent_name, task_id, completion_time_ms, token_usage,"
                "  error_count, outcome, created_at)"
                " VALUES (?,?,?,?,?,?,?,?)",
                (mid, agent_name, task_id, completion_time_ms, token_usage,
                 int(error_count or 0), outcome, created_at),
            )
        return {"id": mid, "created_at": created_at}

    def agent_metrics_stats(self):
        """Per-agent aggregates, matching the PG GROUP BY in /api/metrics/stats.

        `AVG(...)::int` becomes a Python round-to-int, and PG's
        `COUNT(*) FILTER (WHERE outcome = 'pass')` becomes a SUM over a CASE —
        SQLite has no FILTER clause before 3.30 on every platform, and the CASE
        form is equivalent everywhere.
        """
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT agent_name,"
                " COUNT(*) AS tasks_completed,"
                " AVG(completion_time_ms) AS avg_time_ms,"
                " AVG(token_usage) AS avg_tokens,"
                " (CAST(SUM(error_count) AS REAL) / COUNT(*)) AS error_rate,"
                " (CAST(SUM(CASE WHEN outcome = 'pass' THEN 1 ELSE 0 END) AS REAL)"
                "   / COUNT(*)) AS pass_rate"
                " FROM agent_metrics GROUP BY agent_name ORDER BY agent_name"
            ).fetchall()
        return [
            {
                "agent_name": r["agent_name"],
                "tasks_completed": r["tasks_completed"],
                "avg_time_ms": int(round(r["avg_time_ms"])) if r["avg_time_ms"] is not None else None,
                "avg_tokens": int(round(r["avg_tokens"])) if r["avg_tokens"] is not None else None,
                "error_rate": float(r["error_rate"]) if r["error_rate"] is not None else None,
                "pass_rate": float(r["pass_rate"]) if r["pass_rate"] is not None else None,
            }
            for r in rows
        ]

    # ═══════════════════════════════════════════════════════
    # Degraded-mode reporting
    # ═══════════════════════════════════════════════════════

    #: Features that exist only on the PostgreSQL backend. The daemon reports
    #: this list on /health and refuses the matching endpoints with a typed
    #: 503 rather than a dialect-error 500.
    PG_ONLY_FEATURES = (
        "vector_search",
        "rlm_index",
        "semantic_cache",
        "a2a",
        "party_sessions",
        "skill_invocations",
        "task_completions",
    )

    def degraded_counts(self):
        """Cheap counts for the /health degraded section.

        Three COUNT(*)s at most, no table scan of content. `rlm_chunks` and
        embeddings do not exist on SQLite, so they report 0 rather than being
        omitted — a consumer graphing coverage sees a real zero, not a gap.
        """
        counts = {"memory_rows": 0, "memory_rows_with_embeddings": 0, "rlm_chunks": 0}
        try:
            with self._get_conn() as conn:
                counts["memory_rows"] = conn.execute(
                    "SELECT COUNT(*) FROM gsd_memory"
                ).fetchone()[0]
        except Exception:
            counts["memory_rows"] = -1
        return counts

    # ═══════════════════════════════════════════════════════
    # Shared Knowledge Base (SKB) Operations
    # ═══════════════════════════════════════════════════════

    def skb_store(self, title, content, category=None, agent_id=None,
                  tags=None, importance=5, source_task=None):
        """Store a shared knowledge base entry."""
        skb_id = _gen_id("skb")
        with self._get_conn() as conn:
            conn.execute(
                """INSERT INTO gsd_shared_kb
                       (id, title, content, category, agent_id, tags, importance, source_task)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (skb_id, title, content, category, agent_id,
                 json.dumps(tags or []), importance, source_task),
            )
        return skb_id

    def skb_search(self, query, category=None, limit=20):
        """Search SKB entries using FTS5."""
        with self._get_conn() as conn:
            conditions = []
            params = []

            if category:
                conditions.append("s.category = ?")
                params.append(category)

            where_extra = (" AND " + " AND ".join(conditions)) if conditions else ""

            # FTS5 search
            fts_query = " OR ".join(
                w for w in re.sub(r"[^\w\s]", "", query).split() if w
            )
            if fts_query:
                sql = f"""
                    SELECT s.*, rank as relevance
                    FROM gsd_shared_kb s
                    JOIN gsd_shared_kb_fts fts ON s.rowid = fts.rowid
                    WHERE gsd_shared_kb_fts MATCH ?
                    {where_extra}
                    ORDER BY rank
                    LIMIT ?
                """
                rows = conn.execute(sql, [fts_query] + params + [limit]).fetchall()
                if rows:
                    return self._format_skb_results(rows)

            # Fallback: LIKE
            keywords = [kw for kw in query.split() if kw]
            if not keywords:
                return []
            like_conds = " OR ".join(
                ["s.title LIKE ? OR s.content LIKE ?"] * len(keywords)
            )
            like_params = []
            for kw in keywords:
                like_params.extend([f"%{kw}%", f"%{kw}%"])

            sql = f"""
                SELECT s.*, 0.0 as relevance
                FROM gsd_shared_kb s
                WHERE ({like_conds})
                {where_extra}
                ORDER BY s.importance DESC, s.created_at DESC
                LIMIT ?
            """
            rows = conn.execute(sql, like_params + params + [limit]).fetchall()
            return self._format_skb_results(rows)

    def _format_skb_results(self, rows):
        """Format SKB results for JSON output."""
        formatted = []
        for row in rows:
            d = dict(row)
            if "tags" in d and isinstance(d["tags"], str):
                try:
                    d["tags"] = json.loads(d["tags"])
                except (json.JSONDecodeError, TypeError):
                    pass
            if "relevance" in d:
                d["relevance"] = abs(float(d["relevance"])) if d["relevance"] else 0.0
            formatted.append(d)
        return formatted

    def skb_list(self, category=None, limit=50, offset=0):
        """List SKB entries."""
        with self._get_conn() as conn:
            conditions = []
            params = []
            if category:
                conditions.append("category = ?")
                params.append(category)

            where = " AND ".join(conditions) if conditions else "1=1"
            sql = f"""
                SELECT id, title, category, importance, tags, source_task, created_at
                FROM gsd_shared_kb
                WHERE {where}
                ORDER BY importance DESC, created_at DESC
                LIMIT ? OFFSET ?
            """
            rows = conn.execute(sql, params + [limit, offset]).fetchall()
            results = []
            for r in rows:
                d = dict(r)
                if "tags" in d and isinstance(d["tags"], str):
                    try:
                        d["tags"] = json.loads(d["tags"])
                    except (json.JSONDecodeError, TypeError):
                        pass
                results.append(d)
            return results

    # ═══════════════════════════════════════════════════════
    # Task Validation Operations
    # ═══════════════════════════════════════════════════════

    def validation_record(self, task_id, validator_id, status, evidence=None,
                          rejection_reason=None, forced=False):
        """Record a task validation attempt."""
        with self._get_conn() as conn:
            ev = dict(evidence or {})
            if forced:
                ev["forced"] = True
            cur = conn.execute(
                """INSERT INTO gsd_task_validations
                       (task_id, validator_id, status, evidence, rejection_reason)
                   VALUES (?, ?, ?, ?, ?)""",
                (task_id, validator_id, status, json.dumps(ev), rejection_reason),
            )
            return cur.lastrowid

    def validation_history(self, task_id):
        """Get validation history for a task."""
        with self._get_conn() as conn:
            rows = conn.execute(
                """SELECT * FROM gsd_task_validations
                   WHERE task_id = ?
                   ORDER BY created_at DESC""",
                (task_id,),
            ).fetchall()
            results = []
            for r in rows:
                d = dict(r)
                if "evidence" in d and isinstance(d["evidence"], str):
                    try:
                        d["evidence"] = json.loads(d["evidence"])
                    except (json.JSONDecodeError, TypeError):
                        pass
                results.append(d)
            return results

    # ═══════════════════════════════════════════════════════
    # Task Dual-Write Operations
    # ═══════════════════════════════════════════════════════

    def task_upsert(self, item):
        """Upsert a single task item. Best-effort, never raises."""
        try:
            with self._get_conn() as conn:
                conn.execute(
                    """INSERT INTO gsd_tasks (
                           id, project_id, type, title, description, details,
                           status, priority, assigned_to, claimed_by, claimed_at,
                           rpetd_r, rpetd_p, rpetd_e, rpetd_t, rpetd_d, rpetd_complete,
                           importance, urgency,
                           success_criteria, deliverables, dependencies,
                           tags, notes, parent_id, validation_notes, validated_by,
                           test_strategy, phase, plan, evidence, outcome, lesson
                       ) VALUES (
                           ?, ?, ?, ?, ?, ?,
                           ?, ?, ?, ?, ?,
                           ?, ?, ?, ?, ?, ?,
                           ?, ?,
                           ?, ?, ?,
                           ?, ?, ?, ?, ?,
                           ?, ?, ?, ?, ?, ?
                       )
                       ON CONFLICT(id) DO UPDATE SET
                           type=excluded.type, title=excluded.title,
                           description=excluded.description, details=excluded.details,
                           status=excluded.status, priority=excluded.priority,
                           assigned_to=excluded.assigned_to, claimed_by=excluded.claimed_by,
                           claimed_at=excluded.claimed_at,
                           rpetd_r=excluded.rpetd_r, rpetd_p=excluded.rpetd_p,
                           rpetd_e=excluded.rpetd_e, rpetd_t=excluded.rpetd_t,
                           rpetd_d=excluded.rpetd_d, rpetd_complete=excluded.rpetd_complete,
                           importance=excluded.importance, urgency=excluded.urgency,
                           success_criteria=excluded.success_criteria,
                           deliverables=excluded.deliverables,
                           dependencies=excluded.dependencies,
                           tags=excluded.tags, notes=excluded.notes,
                           parent_id=excluded.parent_id,
                           validation_notes=excluded.validation_notes,
                           validated_by=excluded.validated_by,
                           test_strategy=excluded.test_strategy,
                           phase=excluded.phase, plan=excluded.plan,
                           evidence=excluded.evidence, outcome=excluded.outcome,
                           lesson=excluded.lesson,
                           updated_at=datetime('now')
                    """,
                    (
                        item.get("id", ""),
                        item.get("project_id", "default"),
                        item.get("type", "task"),
                        item.get("title", ""),
                        item.get("description", ""),
                        item.get("details", ""),
                        item.get("status", "pending"),
                        item.get("priority", "medium"),
                        item.get("assigned_to", ""),
                        item.get("claimed_by"),
                        item.get("claimed_at"),
                        (item.get("rpetd_phases") or {}).get("R", ""),
                        (item.get("rpetd_phases") or {}).get("P", ""),
                        (item.get("rpetd_phases") or {}).get("E", ""),
                        (item.get("rpetd_phases") or {}).get("T", ""),
                        (item.get("rpetd_phases") or {}).get("D", ""),
                        1 if item.get("rpetd_complete") else 0,
                        item.get("importance", 3),
                        item.get("urgency", 3),
                        json.dumps(item.get("success_criteria", [])),
                        json.dumps(item.get("deliverables", [])),
                        json.dumps(item.get("dependencies", [])),
                        json.dumps(item.get("tags", [])),
                        json.dumps(item.get("notes", [])),
                        item.get("parent"),
                        item.get("validation_notes", ""),
                        item.get("validated_by", ""),
                        item.get("test_strategy", ""),
                        item.get("phase", ""),
                        item.get("plan", ""),
                        json.dumps(item.get("evidence", {})),
                        item.get("outcome", ""),
                        item.get("lesson", ""),
                    ),
                )
            return item["id"]
        except Exception as e:
            import sys
            print(
                f"\033[2m[sqlite-mirror] task_upsert failed for "
                f"{item.get('id', '?')}: {e}\033[0m",
                file=sys.stderr,
            )
            return None

    def task_upsert_batch(self, items):
        """Upsert a batch of task items. Best-effort."""
        count = 0
        for item in items:
            if self.task_upsert(item):
                count += 1
        return count

    def task_delete(self, task_id):
        """Delete a task from SQLite mirror."""
        try:
            with self._get_conn() as conn:
                cur = conn.execute(
                    "DELETE FROM gsd_tasks WHERE id = ?", (task_id,)
                )
                return cur.rowcount > 0
        except Exception:
            return False

    def task_count_by_status(self):
        """Get task counts grouped by status."""
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) as cnt FROM gsd_tasks GROUP BY status"
            ).fetchall()
            return {r["status"]: r["cnt"] for r in rows}

    # ═══════════════════════════════════════════════════════
    # Audit Log Operations (Append-Only)
    # ═══════════════════════════════════════════════════════
    # CRITICAL: No UPDATE or DELETE on gsd_audit_log — only INSERT and SELECT.

    def audit_log(self, task_id, event_type, agent_id=None, actor=None,
                  phase=None, status=None, gate_results=None, content=None,
                  metadata=None):
        """Insert an immutable audit log entry. Returns the new row ID."""
        with self._get_conn() as conn:
            cur = conn.execute(
                """INSERT INTO gsd_audit_log
                       (task_id, event_type, agent_id, actor, phase, status,
                        gate_results, content, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    task_id, event_type, agent_id, actor, phase, status,
                    json.dumps(gate_results) if gate_results else None,
                    content,
                    json.dumps(metadata or {}),
                ),
            )
            return cur.lastrowid

    def audit_query(self, task_id=None, event_type=None, start_date=None,
                    end_date=None, limit=100):
        """Query audit log entries with optional filters. Returns list of dicts."""
        with self._get_conn() as conn:
            conditions = []
            params = []

            if task_id:
                conditions.append("task_id = ?")
                params.append(task_id)
            if event_type:
                conditions.append("event_type = ?")
                params.append(event_type)
            if start_date:
                conditions.append("created_at >= ?")
                params.append(start_date)
            if end_date:
                conditions.append("created_at <= ?")
                params.append(end_date)

            where = " AND ".join(conditions) if conditions else "1=1"
            sql = f"""
                SELECT * FROM gsd_audit_log
                WHERE {where}
                ORDER BY created_at DESC
                LIMIT ?
            """
            rows = conn.execute(sql, params + [limit]).fetchall()
            results = []
            for r in rows:
                d = dict(r)
                # Parse JSON fields
                for key in ("gate_results", "metadata"):
                    if key in d and isinstance(d[key], str):
                        try:
                            d[key] = json.loads(d[key])
                        except (json.JSONDecodeError, TypeError):
                            pass
                results.append(d)
            return results

    def audit_count(self):
        """Count total audit log entries."""
        with self._get_conn() as conn:
            row = conn.execute("SELECT COUNT(*) FROM gsd_audit_log").fetchone()
            return row[0]

    # ═══════════════════════════════════════════════════════
    # PG Retry Queue (no-op — SQLite is not a mirror target)
    # ═══════════════════════════════════════════════════════

    def enqueue_retry(self, item):
        """No-op for SQLite (SQLite is not a mirror target)."""
        pass

    def flush_retry_queue(self):
        """No-op for SQLite."""
        return 0, 0, 0

    # ═══════════════════════════════════════════════════════
    # Agent Performance (stub — no table in SQLite for now)
    # ═══════════════════════════════════════════════════════

    def record_agent_performance(self, **kwargs):
        """Not available in SQLite mode."""
        return False

    def agent_performance_summary(self, agent_id, limit=50):
        """Not available in SQLite mode."""
        return None

    # ═══════════════════════════════════════════════════════
    # Backup Export / Import (Phase 8: Data Durability)
    # ═══════════════════════════════════════════════════════

    def _rows_to_dicts(self, rows):
        """Convert sqlite3.Row objects to plain dicts with parsed JSON fields."""
        results = []
        json_fields = {"tags", "metadata", "evidence", "success_criteria",
                        "deliverables", "dependencies", "notes", "gate_results"}
        for row in rows:
            d = dict(row)
            d.pop("rowid", None)
            for key in json_fields:
                if key in d and isinstance(d[key], str):
                    try:
                        d[key] = json.loads(d[key])
                    except (json.JSONDecodeError, TypeError):
                        pass
            results.append(d)
        return results

    def export_all_memory(self):
        """Export all rows from gsd_memory."""
        with self._get_conn() as conn:
            rows = conn.execute("SELECT * FROM gsd_memory ORDER BY id").fetchall()
            return self._rows_to_dicts(rows)

    def export_all_tasks(self):
        """Export all rows from gsd_tasks."""
        with self._get_conn() as conn:
            rows = conn.execute("SELECT * FROM gsd_tasks ORDER BY id").fetchall()
            return self._rows_to_dicts(rows)

    def export_all_skb(self):
        """Export all rows from gsd_shared_kb."""
        with self._get_conn() as conn:
            rows = conn.execute("SELECT * FROM gsd_shared_kb ORDER BY id").fetchall()
            return self._rows_to_dicts(rows)

    def export_all_validations(self):
        """Export all rows from gsd_task_validations."""
        with self._get_conn() as conn:
            rows = conn.execute("SELECT * FROM gsd_task_validations ORDER BY id").fetchall()
            return self._rows_to_dicts(rows)

    def export_all_agent_performance(self):
        """Export all rows from gsd_agent_performance (not available in SQLite)."""
        return []

    def export_all_audit(self):
        """Export all rows from gsd_audit_log."""
        try:
            with self._get_conn() as conn:
                rows = conn.execute("SELECT * FROM gsd_audit_log ORDER BY id").fetchall()
                return self._rows_to_dicts(rows)
        except Exception:
            return []

    def import_audit(self, rows, mode="merge"):
        """Import audit log rows from backup.

        Merge mode: INSERT OR IGNORE — skips rows with colliding IDs (append-only log safe).
        Replace mode: DELETE + INSERT — mirrors other import methods; user explicitly chose replace.

        Args:
            rows: List of row dicts from export_all_audit().
            mode: 'merge' or 'replace'.

        Returns:
            Number of rows imported.
        """
        if not rows:
            return 0
        with self._get_conn() as conn:
            if mode == "replace":
                conn.execute("DELETE FROM gsd_audit_log")
            count = 0
            for row in rows:
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO gsd_audit_log
                               (id, task_id, event_type, agent_id, actor, phase, status,
                                gate_results, content, metadata, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
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
                        ),
                    )
                    count += conn.execute("SELECT changes()").fetchone()[0]
                except Exception:
                    pass
            return count

    def import_memory(self, rows, mode="merge"):
        """Import memory rows from backup.

        Args:
            rows: List of row dicts.
            mode: 'merge' (INSERT OR IGNORE) or 'replace' (DELETE ALL + INSERT).

        Returns:
            Number of rows imported.
        """
        if not rows:
            return 0
        with self._get_conn() as conn:
            if mode == "replace":
                conn.execute("DELETE FROM gsd_memory")
            count = 0
            for row in rows:
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO gsd_memory
                               (id, text, source, agent_id, tags, metadata, project_id, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            row.get("id"),
                            row.get("text", ""),
                            row.get("source", "agent"),
                            row.get("agent_id"),
                            json.dumps(row.get("tags", [])) if isinstance(row.get("tags"), (list, dict)) else row.get("tags", "[]"),
                            json.dumps(row.get("metadata", {})) if isinstance(row.get("metadata"), (list, dict)) else row.get("metadata", "{}"),
                            row.get("project_id"),
                            row.get("created_at"),
                            row.get("updated_at"),
                        ),
                    )
                    count += conn.execute("SELECT changes()").fetchone()[0]
                except Exception:
                    pass
            return count

    def import_tasks(self, rows, mode="merge"):
        """Import task rows from backup."""
        if not rows:
            return 0
        with self._get_conn() as conn:
            if mode == "replace":
                conn.execute("DELETE FROM gsd_tasks")
            count = 0
            for row in rows:
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO gsd_tasks (
                               id, project_id, type, title, description, details,
                               status, priority, assigned_to, claimed_by, claimed_at,
                               rpetd_r, rpetd_p, rpetd_e, rpetd_t, rpetd_d, rpetd_complete,
                               importance, urgency,
                               success_criteria, deliverables, dependencies,
                               tags, notes, parent_id, validation_notes, validated_by,
                               test_strategy, phase, plan, evidence, outcome, lesson,
                               created_at, updated_at
                           ) VALUES (
                               ?, ?, ?, ?, ?, ?,
                               ?, ?, ?, ?, ?,
                               ?, ?, ?, ?, ?, ?,
                               ?, ?,
                               ?, ?, ?,
                               ?, ?, ?, ?, ?,
                               ?, ?, ?, ?, ?, ?,
                               ?, ?
                           )""",
                        (
                            row.get("id"), row.get("project_id", "default"),
                            row.get("type", "task"), row.get("title", ""),
                            row.get("description", ""), row.get("details", ""),
                            row.get("status", "pending"), row.get("priority", "medium"),
                            row.get("assigned_to", ""), row.get("claimed_by"),
                            row.get("claimed_at"),
                            row.get("rpetd_r", ""), row.get("rpetd_p", ""),
                            row.get("rpetd_e", ""), row.get("rpetd_t", ""),
                            row.get("rpetd_d", ""),
                            1 if row.get("rpetd_complete") else 0,
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
                        ),
                    )
                    count += conn.execute("SELECT changes()").fetchone()[0]
                except Exception:
                    pass
            return count

    def import_skb(self, rows, mode="merge"):
        """Import SKB rows from backup."""
        if not rows:
            return 0
        with self._get_conn() as conn:
            if mode == "replace":
                conn.execute("DELETE FROM gsd_shared_kb")
            count = 0
            for row in rows:
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO gsd_shared_kb
                               (id, title, content, category, agent_id, tags, importance, source_task, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            row.get("id"), row.get("title", ""),
                            row.get("content", ""), row.get("category"),
                            row.get("agent_id"),
                            json.dumps(row.get("tags", [])) if isinstance(row.get("tags"), (list, dict)) else row.get("tags", "[]"),
                            row.get("importance", 5), row.get("source_task"),
                            row.get("created_at"), row.get("updated_at"),
                        ),
                    )
                    count += conn.execute("SELECT changes()").fetchone()[0]
                except Exception:
                    pass
            return count

    def import_validations(self, rows, mode="merge"):
        """Import validation rows from backup."""
        if not rows:
            return 0
        with self._get_conn() as conn:
            if mode == "replace":
                conn.execute("DELETE FROM gsd_task_validations")
            count = 0
            for row in rows:
                try:
                    conn.execute(
                        """INSERT INTO gsd_task_validations
                               (task_id, validator_id, status, evidence, rejection_reason, created_at)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (
                            row.get("task_id"), row.get("validator_id"),
                            row.get("status"),
                            json.dumps(row.get("evidence", {})) if isinstance(row.get("evidence"), (list, dict)) else row.get("evidence", "{}"),
                            row.get("rejection_reason"),
                            row.get("created_at"),
                        ),
                    )
                    count += conn.execute("SELECT changes()").fetchone()[0]
                except Exception:
                    pass
            return count

    def import_agent_performance(self, rows, mode="merge"):
        """Import agent performance rows (no-op in SQLite)."""
        return 0

    # ═══════════════════════════════════════════════════════
    # Cleanup
    # ═══════════════════════════════════════════════════════

    def close(self):
        """No-op for SQLite (connections are per-operation)."""
        pass

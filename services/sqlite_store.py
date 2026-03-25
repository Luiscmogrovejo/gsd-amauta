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
from contextlib import contextmanager
from datetime import datetime


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

                -- Indexes
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

    def memory_search(self, query, project_id=None, source=None, limit=20):
        """Search memories using FTS5 with source-aware scoring."""
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
        """Apply source-aware scoring to memory results.

        Returns dicts with the same keys/types as PGStore._score_memories():
          id, text, source, agent_id, tags (list), metadata (dict),
          project_id, created_at (str), updated_at (str), score (float),
          text_rank (float). No 'rowid' key.
        """
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
            d["score"] = round(norm_rank * 10 + source_bonus, 2)
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

    def memory_count(self, project_id=None):
        """Count total memories."""
        with self._get_conn() as conn:
            if project_id:
                row = conn.execute(
                    "SELECT COUNT(*) FROM gsd_memory WHERE project_id = ?",
                    (project_id,),
                ).fetchone()
            else:
                row = conn.execute("SELECT COUNT(*) FROM gsd_memory").fetchone()
            return row[0]

    def memory_delete(self, mem_id):
        """Delete a memory entry by ID."""
        with self._get_conn() as conn:
            conn.execute("DELETE FROM gsd_memory WHERE id = ?", (mem_id,))

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

    def memory_semantic_search(self, query, project_id=None, source=None, limit=20):
        """Semantic search not available in SQLite — falls back to FTS."""
        return self.memory_search(query, project_id, source, limit), "text_fallback"

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

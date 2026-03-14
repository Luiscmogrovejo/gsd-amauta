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

import json
import os
import re
import threading
import urllib.request
import urllib.error
from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2.pool import ThreadedConnectionPool
    HAS_PG = True
except ImportError:
    HAS_PG = False

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
                     metadata=None, project_id=None):
        """Store a memory entry.

        Returns the new memory ID.
        """
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO gsd_memory (text, source, agent_id, tags, metadata, project_id)
                    VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s)
                    RETURNING id
                """, (
                    text,
                    source,
                    agent_id,
                    json.dumps(tags or []),
                    json.dumps(metadata or {}),
                    project_id,
                ))
                return cur.fetchone()[0]

    def memory_search(self, query, project_id=None, source=None, limit=20):
        """Search memories with source-aware scoring.

        Scoring: text relevance (ts_rank) + source bonus.
        Falls back to ILIKE if full-text search returns nothing.
        """
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                # Build base conditions
                conditions = []
                params = []

                if project_id:
                    conditions.append("project_id = %s")
                    params.append(project_id)

                if source:
                    conditions.append("source = %s")
                    params.append(source)

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

    def _score_memories(self, rows):
        """Apply source-aware scoring to memory results."""
        scored = []
        for row in rows:
            d = dict(row)
            source_bonus = SOURCE_SCORES.get(d.get("source", "agent"), 0)
            text_rank = float(d.get("text_rank", 0))
            # Composite score: text relevance (0-1 range) * 10 + source bonus
            d["score"] = round(text_rank * 10 + source_bonus, 2)
            # Convert Decimal text_rank to float for JSON serialization
            if "text_rank" in d and isinstance(d["text_rank"], Decimal):
                d["text_rank"] = float(d["text_rank"])
            # Convert datetime objects to strings for JSON serialization
            for key in ("created_at", "updated_at"):
                if key in d and isinstance(d[key], datetime):
                    d[key] = d[key].isoformat()
            # Remove embedding from output (large binary)
            d.pop("embedding", None)
            scored.append(d)
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored

    def memory_list(self, project_id=None, source=None, limit=50, offset=0):
        """List memories with optional filters."""
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

                where = " AND ".join(conditions) if conditions else "TRUE"
                sql = f"""
                    SELECT id, text, source, agent_id, tags, project_id, created_at
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
                return [dict(r) for r in results]

    def memory_count(self, project_id=None):
        """Count total memories."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                if project_id:
                    cur.execute("SELECT COUNT(*) FROM gsd_memory WHERE project_id = %s", (project_id,))
                else:
                    cur.execute("SELECT COUNT(*) FROM gsd_memory")
                return cur.fetchone()[0]

    def memory_delete(self, mem_id):
        """Delete a memory entry by ID."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM gsd_memory WHERE id = %s", (mem_id,))

    def memory_cross_project_search(self, query, tags=None, exclude_project=None, limit=20):
        """Search memories across ALL projects, optionally filtered by technology tags.

        Used during new-project initialization to find learnings from similar past projects.

        Args:
            query: Search text.
            tags: List of technology tags to filter by (e.g. ['react', 'postgresql']).
            exclude_project: Project ID to exclude from results (current project).
            limit: Max results.

        Returns list of scored memory dicts.
        """
        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                conditions = []
                params = []

                if exclude_project:
                    conditions.append("(project_id IS NULL OR project_id != %s)")
                    params.append(exclude_project)

                # Filter by technology tags using jsonb containment
                if tags and len(tags) > 0:
                    # Match entries where tags array overlaps with requested tags
                    conditions.append("tags ?| %s")
                    params.append(tags)

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
                          rejection_reason=None):
        """Record a task validation attempt."""
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO gsd_task_validations
                        (task_id, validator_id, status, evidence, rejection_reason)
                    VALUES (%s, %s, %s, %s::jsonb, %s)
                    RETURNING id
                """, (
                    task_id, validator_id, status,
                    json.dumps(evidence or {}), rejection_reason,
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
                            test_strategy, phase, plan, evidence, outcome, lesson
                        ) VALUES (
                            %(id)s, %(project_id)s, %(type)s, %(title)s, %(description)s, %(details)s,
                            %(status)s, %(priority)s, %(assigned_to)s, %(claimed_by)s, %(claimed_at)s,
                            %(rpetd_r)s, %(rpetd_p)s, %(rpetd_e)s, %(rpetd_t)s, %(rpetd_d)s, %(rpetd_complete)s,
                            %(importance)s, %(urgency)s,
                            %(success_criteria)s::jsonb, %(deliverables)s::jsonb, %(dependencies)s::jsonb,
                            %(tags)s::jsonb, %(notes)s::jsonb, %(parent_id)s, %(validation_notes)s, %(validated_by)s,
                            %(test_strategy)s, %(phase)s, %(plan)s, %(evidence)s::jsonb, %(outcome)s, %(lesson)s
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
                    })
                    return item["id"]
        except Exception as e:
            # Best-effort — never block task operations, but log so mismatches are diagnosable
            import sys
            print(f"\033[2m[pg-mirror] task_upsert failed for {item.get('id', '?')}: {e}\033[0m", file=sys.stderr)
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
    # Embedding / Semantic Search Operations
    # ═══════════════════════════════════════════════════════

    # Embedding provider configuration
    # Priority: GSD_EMBEDDING_PROVIDER env var > auto-detect (voyage > openai)
    EMBEDDING_PROVIDERS = {
        "voyage": {
            "env_key": "VOYAGE_API_KEY",
            "url": "https://api.voyageai.com/v1/embeddings",
            "default_model": "voyage-code-3",  # optimized for code retrieval
            "dimensions": 1024,
            "max_chars": 32000,  # ~8000 tokens
            "supports_input_type": True,
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

        # Build payload
        use_model = model or cfg["default_model"]
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
                return result["data"][0]["embedding"]
        except Exception:
            return None

    def memory_store_with_embedding(self, text, source="agent", agent_id=None,
                                     tags=None, metadata=None, project_id=None):
        """Store a memory entry with auto-generated embedding.

        Falls back to memory_store() without embedding if no API key is set.
        Returns the new memory ID.
        """
        embedding = self.generate_embedding(text, input_type="document")

        if embedding is None:
            # No API key or embedding failed — store without embedding
            return self.memory_store(text, source, agent_id, tags, metadata, project_id)

        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO gsd_memory (text, source, agent_id, tags, metadata, project_id, embedding)
                    VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s, %s::vector)
                    RETURNING id
                """, (
                    text,
                    source,
                    agent_id,
                    json.dumps(tags or []),
                    json.dumps(metadata or {}),
                    project_id,
                    str(embedding),
                ))
                return cur.fetchone()[0]

    def memory_semantic_search(self, query, project_id=None, source=None, limit=20):
        """Search memories using cosine similarity on pgvector embeddings.

        Requires VOYAGE_API_KEY or OPENAI_API_KEY for query embedding generation.
        Returns (results, method) tuple — method is 'vector' or 'text_fallback'.
        Falls back to text-based memory_search() if embeddings unavailable.
        """
        # Generate query embedding (input_type="query" improves Voyage retrieval)
        query_embedding = self.generate_embedding(query, input_type="query")
        if query_embedding is None:
            # No API key — fall back to text search
            return self.memory_search(query, project_id, source, limit), "text_fallback"

        with self._get_conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                conditions = ["embedding IS NOT NULL"]
                params = []

                if project_id:
                    conditions.append("project_id = %s")
                    params.append(project_id)

                if source:
                    conditions.append("source = %s")
                    params.append(source)

                where = " AND ".join(conditions)

                # Cosine distance: 1 - (a <=> b) gives similarity in [0, 1]
                sql = f"""
                    SELECT *,
                        (1 - (embedding <=> %s::vector)) as semantic_similarity
                    FROM gsd_memory
                    WHERE {where}
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                """
                vec_str = str(query_embedding)
                cur.execute(sql, [vec_str] + params + [vec_str] + [limit])
                results = cur.fetchall()

                if not results:
                    # No embeddings stored yet — fall back to text search
                    return self.memory_search(query, project_id, source, limit), "text_fallback"

                return self._score_semantic_results(results), "vector"

    def _score_semantic_results(self, rows):
        """Score semantic search results with source bonuses."""
        scored = []
        for row in rows:
            d = dict(row)
            source_bonus = SOURCE_SCORES.get(d.get("source", "agent"), 0)
            similarity = float(d.get("semantic_similarity", 0))
            # Composite: semantic similarity (0-1) * 10 + source bonus (0-4)
            d["score"] = round(similarity * 10 + source_bonus, 2)
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

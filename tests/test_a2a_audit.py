#!/usr/bin/env python3
"""
tests/test_a2a_audit.py — Phase 56 A2A-07: Audit endpoint tests.

Structural tests (no daemon/PG required):
  TestAuditEndpointStructure — /a2a/exchanges handler present in daemon source
  TestAuditResponseSchema    — response schema_version "1.0" in source
  TestAuditQueryParams       — since/from/to param parsing in source

PG integration tests (GSD_PG_INTEGRATION=1 required):
  TestAuditEndpointPGIntegration — live insert + query via PG directly
"""

import os
import sys
import ast
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

GSD_PG_INTEGRATION = os.environ.get("GSD_PG_INTEGRATION") == "1"

DAEMON_PATH = os.path.join(_REPO_ROOT, "services", "amauta-daemon.py")


def _daemon_source():
    with open(DAEMON_PATH, "r", encoding="utf-8") as f:
        return f.read()


class TestAuditEndpointStructure(unittest.TestCase):
    """5 structural tests — verify /a2a/exchanges handler present in daemon source."""

    def test_handler_path_present(self):
        """'/a2a/exchanges' path literal must appear in daemon source."""
        self.assertIn('"/a2a/exchanges"', _daemon_source())

    def test_schema_version_1_0_present(self):
        """schema_version '1.0' response key must appear in daemon source."""
        self.assertIn('"schema_version": "1.0"', _daemon_source())

    def test_next_cursor_key_present(self):
        """next_cursor key must appear in daemon source (cursor-based pagination)."""
        self.assertIn("next_cursor", _daemon_source())

    def test_exchanges_key_present(self):
        """'exchanges' response key must appear in daemon source."""
        self.assertIn('"exchanges"', _daemon_source())

    def test_daemon_syntax_valid(self):
        """Daemon source must parse without syntax errors."""
        src = _daemon_source()
        try:
            ast.parse(src)
        except SyntaxError as e:
            self.fail(f"amauta-daemon.py syntax error: {e}")


class TestAuditResponseSchema(unittest.TestCase):
    """3 structural tests — verify response construction logic in daemon source."""

    def test_since_default_24h_present(self):
        """Default since=now-24h must use timedelta(hours=24) in daemon source."""
        self.assertIn("timedelta(hours=24)", _daemon_source())

    def test_from_filter_present(self):
        """from_agent = %s SQL fragment must appear in daemon source."""
        self.assertIn("from_agent = %s", _daemon_source())

    def test_to_filter_present(self):
        """to_agent = %s SQL fragment must appear in daemon source."""
        self.assertIn("to_agent = %s", _daemon_source())


class TestAuditQueryParams(unittest.TestCase):
    """3 structural tests — verify query parameter parsing in daemon source."""

    def test_from_param_parsed(self):
        """from_filter variable must appear in daemon source (parses ?from= param)."""
        self.assertIn("from_filter", _daemon_source())

    def test_to_param_parsed(self):
        """to_filter variable must appear in daemon source (parses ?to= param)."""
        self.assertIn("to_filter", _daemon_source())

    def test_since_param_parsed(self):
        """since_raw or since_ts variable must appear in daemon source."""
        src = _daemon_source()
        self.assertTrue(
            "since_raw" in src or "since_ts" in src,
            "Expected 'since_raw' or 'since_ts' in daemon source for ?since= param parsing",
        )


@unittest.skipUnless(GSD_PG_INTEGRATION, "Set GSD_PG_INTEGRATION=1 to run PG integration tests")
class TestAuditEndpointPGIntegration(unittest.TestCase):
    """4 PG integration tests — live query via PG directly (no HTTP daemon required)."""

    @classmethod
    def setUpClass(cls):
        """Connect to PG and set up test table state."""
        import psycopg2
        import psycopg2.extras
        db_url = os.environ.get("DATABASE_URL", "postgresql://localhost/gsd_amauta")
        cls.conn = psycopg2.connect(db_url)
        cls.conn.autocommit = False
        # Use a savepoint so we can rollback all inserts after each test
        cls._inserted_ids = []

    @classmethod
    def tearDownClass(cls):
        """Clean up any inserted test rows and close connection."""
        if cls._inserted_ids:
            with cls.conn.cursor() as cur:
                for cid in cls._inserted_ids:
                    cur.execute("DELETE FROM a2a_messages WHERE correlation_id = %s", (cid,))
        cls.conn.commit()
        cls.conn.close()

    def _insert_row(self, from_agent, to_agent, capability="test.cap", kind="request",
                    status="pending", payload=None):
        """Helper: insert a test a2a_messages row; record ID for cleanup."""
        import psycopg2.extras
        if payload is None:
            payload = {}
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO a2a_messages (from_agent, to_agent, capability, payload, kind, status) "
                "VALUES (%s, %s, %s, %s::jsonb, %s, %s) RETURNING correlation_id",
                (from_agent, to_agent, capability, psycopg2.extras.Json(payload), kind, status),
            )
            cid = cur.fetchone()[0]
            self.__class__._inserted_ids.append(str(cid))
        self.conn.commit()
        return str(cid)

    def _query_exchanges(self, from_agent=None, to_agent=None, since=None):
        """Execute the same SQL the daemon uses and return (rows, next_cursor)."""
        import psycopg2.extras
        import datetime as dt

        if since is None:
            since_ts = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=24)
        else:
            since_ts = since

        conditions = ["created_at >= %s"]
        params = [since_ts]
        if from_agent:
            conditions.append("from_agent = %s")
            params.append(from_agent)
        if to_agent:
            conditions.append("to_agent = %s")
            params.append(to_agent)

        where_clause = " AND ".join(conditions)
        sql = (
            "SELECT correlation_id::text, parent_correlation_id::text, "
            "from_agent, to_agent, capability, payload, kind, status, "
            "created_at, responded_at "
            "FROM a2a_messages "
            f"WHERE {where_clause} "
            "ORDER BY created_at ASC"
        )

        with self.conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

        max_created_at = None
        for r in rows:
            if r["created_at"] and (max_created_at is None or r["created_at"] > max_created_at):
                max_created_at = r["created_at"]

        import datetime as dt
        if max_created_at:
            next_cursor = (max_created_at + dt.timedelta(milliseconds=1)).isoformat()
        else:
            next_cursor = dt.datetime.now(dt.timezone.utc).isoformat()

        return rows, next_cursor

    def test_empty_exchanges_when_no_data(self):
        """Query with far-future since returns empty exchanges (not error)."""
        import datetime as dt
        future = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=3650)
        rows, _ = self._query_exchanges(since=future)
        self.assertEqual(rows, [])

    def test_exchanges_list_for_recent_inserts(self):
        """Insert a row; query with past since returns at least that row."""
        import datetime as dt
        cid = self._insert_row("agent-a-test-audit", "agent-b-test-audit")
        past = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)
        rows, _ = self._query_exchanges(since=past)
        cids = [str(r["correlation_id"]) for r in rows]
        self.assertIn(cid, cids)

    def test_from_filter(self):
        """Insert 2 rows with different from_agent; filter returns only matching row."""
        import datetime as dt
        cid1 = self._insert_row("agent-filter-x", "agent-target")
        cid2 = self._insert_row("agent-filter-y", "agent-target")  # noqa: F841 — inserted for filter contrast
        past = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)
        rows, _ = self._query_exchanges(from_agent="agent-filter-x", since=past)
        cids = [str(r["correlation_id"]) for r in rows]
        self.assertIn(cid1, cids)
        for r in rows:
            self.assertEqual(r["from_agent"], "agent-filter-x",
                             "All returned rows must match from_filter")

    def test_next_cursor_advances(self):
        """next_cursor must be a later timestamp than the since param used."""
        import datetime as dt
        self._insert_row("agent-cursor-test", "agent-cursor-dest")
        since_ts = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)
        rows, next_cursor = self._query_exchanges(since=since_ts)
        self.assertGreater(len(rows), 0, "Expected at least 1 row for cursor advancement test")
        # next_cursor should be parseable ISO string
        cursor_dt = dt.datetime.fromisoformat(next_cursor.replace("Z", "+00:00"))
        self.assertGreater(cursor_dt, since_ts,
                           "next_cursor must be strictly after the since param")


if __name__ == "__main__":
    unittest.main()

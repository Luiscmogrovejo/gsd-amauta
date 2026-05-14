#!/usr/bin/env python3
"""
tests/test_a2a_threading.py — Phase 56 A2A-06: Conversation threading tests.

Structural tests (no PG needed):
  TestThreadingConstants — constant values
  TestGetThreadSignature — function signature and return contract
  TestGetThreadSQLStructure — CTE SQL present in source

PG integration tests (GSD_PG_INTEGRATION=1 required):
  TestGetThreadPGIntegration — 3-turn dialogue, depth limit, empty on stale ID
"""

import inspect
import json
import os
import sys
import unittest
import uuid

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.a2a_client import (
    SCHEMA_VERSION,
    THREAD_DEFAULT_DEPTH_LIMIT,
    get_thread,
)

GSD_PG_INTEGRATION = os.environ.get("GSD_PG_INTEGRATION") == "1"


# ── TestThreadingConstants ────────────────────────────────────────────────────

class TestThreadingConstants(unittest.TestCase):
    """A2A-06 threading module-level constants."""

    def test_thread_depth_limit_constant(self):
        """THREAD_DEFAULT_DEPTH_LIMIT is locked to 10."""
        self.assertEqual(THREAD_DEFAULT_DEPTH_LIMIT, 10)

    def test_schema_version_unchanged(self):
        """SCHEMA_VERSION is still '1.0' (Phase 55 frozen value)."""
        self.assertEqual(SCHEMA_VERSION, "1.0")


# ── TestGetThreadSignature ────────────────────────────────────────────────────

class TestGetThreadSignature(unittest.TestCase):
    """get_thread() function contract — callable, return type, default params."""

    def test_get_thread_callable(self):
        """get_thread is callable (exported from services.a2a_client)."""
        self.assertTrue(callable(get_thread))

    def test_get_thread_returns_list_on_missing_pg(self):
        """get_thread with random UUID and no PG returns [] (not raises)."""
        random_uuid = str(uuid.uuid4())
        result = get_thread(random_uuid)
        self.assertIsInstance(result, list)
        self.assertEqual(result, [])

    def test_depth_limit_default_param(self):
        """depth_limit default parameter value is 10."""
        sig = inspect.signature(get_thread)
        default = sig.parameters["depth_limit"].default
        self.assertEqual(default, 10)

    def test_get_thread_returns_list_type(self):
        """get_thread('00000000-0000-0000-0000-000000000000') returns a list instance."""
        result = get_thread("00000000-0000-0000-0000-000000000000")
        self.assertIsInstance(result, list)


# ── TestGetThreadSQLStructure ─────────────────────────────────────────────────

class TestGetThreadSQLStructure(unittest.TestCase):
    """Inspect source of get_thread for required CTE SQL keywords."""

    @classmethod
    def setUpClass(cls):
        cls.src = inspect.getsource(get_thread)

    def test_cte_keyword_present(self):
        """get_thread source contains 'WITH RECURSIVE thread AS'."""
        self.assertIn("WITH RECURSIVE thread AS", self.src)

    def test_ordered_by_created_at(self):
        """get_thread source contains 'ORDER BY created_at ASC'."""
        self.assertIn("ORDER BY created_at ASC", self.src)

    def test_depth_limit_in_cte(self):
        """get_thread source contains depth < %s (CTE depth guard)."""
        # Matches 't.depth < %s' or 'depth < %s'
        self.assertTrue(
            "depth < %s" in self.src or "t.depth < %s" in self.src,
            "Expected 'depth < %s' or 't.depth < %s' in get_thread source"
        )


# ── TestGetThreadPGIntegration ────────────────────────────────────────────────

@unittest.skipUnless(GSD_PG_INTEGRATION, "GSD_PG_INTEGRATION=1 required for PG tests")
class TestGetThreadPGIntegration(unittest.TestCase):
    """Live PG integration tests — require GSD_PG_INTEGRATION=1.

    Inserts rows directly via psycopg2 cursor (no a2a_client send_* helpers)
    to avoid test coupling. Cleans up inserted rows in tearDown.
    """

    def setUp(self):
        """Establish PG connection and track inserted IDs for cleanup."""
        from services.pg_store import PGStore
        self._store = PGStore()
        self._conn = self._store._get_conn().__enter__()
        self._inserted_ids = []

    def tearDown(self):
        """Delete inserted rows and close connection."""
        if self._inserted_ids:
            with self._conn.cursor() as cur:
                for rid in self._inserted_ids:
                    cur.execute(
                        "DELETE FROM a2a_messages WHERE correlation_id = %s::uuid",
                        (rid,),
                    )
        self._conn.commit()
        self._store._get_conn().__exit__(None, None, None)

    def _insert_row(self, *, from_agent, to_agent, capability, payload,
                    kind, status, parent_id=None):
        """Insert a raw a2a_messages row; track and return correlation_id (str)."""
        import psycopg2.extras
        with self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                INSERT INTO a2a_messages
                  (parent_correlation_id, from_agent, to_agent, capability,
                   payload, kind, status)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s)
                RETURNING correlation_id::text
                """,
                (
                    parent_id,
                    from_agent, to_agent, capability,
                    json.dumps(payload), kind, status,
                ),
            )
            row = cur.fetchone()
        self._conn.commit()
        cid = row["correlation_id"]
        self._inserted_ids.append(cid)
        return cid

    def _build_three_turn_thread(self):
        """Insert root request → child response → grandchild follow-up.

        Returns (root_id, child_id, grandchild_id).
        """
        root_id = self._insert_row(
            from_agent="agent-a", to_agent="agent-b",
            capability="discuss", payload={"turn": 0},
            kind="request", status="pending",
        )
        child_id = self._insert_row(
            from_agent="agent-b", to_agent="agent-a",
            capability="discuss", payload={"turn": 1},
            kind="response", status="delivered",
            parent_id=root_id,
        )
        grandchild_id = self._insert_row(
            from_agent="agent-a", to_agent="agent-b",
            capability="discuss", payload={"turn": 2},
            kind="request", status="pending",
            parent_id=child_id,
        )
        return root_id, child_id, grandchild_id

    def test_empty_list_on_unknown_root(self):
        """get_thread with unknown UUID returns [] (not raises)."""
        result = get_thread("00000000-0000-0000-0000-000000000000", conn=self._conn)
        self.assertIsInstance(result, list)
        self.assertEqual(result, [])

    def test_three_turn_dialogue(self):
        """3-turn thread returns 3 rows in chronological order with correct linkage."""
        root_id, child_id, grandchild_id = self._build_three_turn_thread()

        result = get_thread(root_id, conn=self._conn)

        self.assertEqual(len(result), 3)
        # Chronological order: root, child, grandchild
        self.assertEqual(result[0]["correlation_id"], root_id)
        self.assertIsNone(result[0]["parent_correlation_id"])
        self.assertEqual(result[0]["depth"], 0)

        self.assertEqual(result[1]["correlation_id"], child_id)
        self.assertEqual(result[1]["parent_correlation_id"], root_id)
        self.assertEqual(result[1]["depth"], 1)

        self.assertEqual(result[2]["correlation_id"], grandchild_id)
        self.assertEqual(result[2]["parent_correlation_id"], child_id)
        self.assertEqual(result[2]["depth"], 2)

    def test_depth_limit_one_returns_root_only(self):
        """depth_limit=1 returns root + 1 child (2 rows at depths 0 and 1)."""
        root_id, child_id, grandchild_id = self._build_three_turn_thread()

        result = get_thread(root_id, depth_limit=1, conn=self._conn)

        self.assertEqual(len(result), 2)
        depths = [r["depth"] for r in result]
        self.assertIn(0, depths)
        self.assertIn(1, depths)
        ids = [r["correlation_id"] for r in result]
        self.assertNotIn(grandchild_id, ids)

    def test_depth_limit_zero_returns_root_only(self):
        """depth_limit=0 returns only the root row (1 row at depth 0)."""
        root_id, child_id, grandchild_id = self._build_three_turn_thread()

        result = get_thread(root_id, depth_limit=0, conn=self._conn)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["correlation_id"], root_id)
        self.assertEqual(result[0]["depth"], 0)

    def test_returned_dict_has_required_keys(self):
        """Each dict in the result has all required keys including depth and schema_version."""
        root_id, _, _ = self._build_three_turn_thread()
        result = get_thread(root_id, conn=self._conn)

        required_keys = {
            "correlation_id",
            "parent_correlation_id",
            "from_agent",
            "to_agent",
            "capability",
            "payload",
            "kind",
            "status",
            "created_at",
            "depth",
            "schema_version",
        }
        for row in result:
            missing = required_keys - set(row.keys())
            self.assertEqual(
                missing, set(),
                f"Row missing required keys: {missing}"
            )
            self.assertEqual(row["schema_version"], "1.0")
            self.assertIsInstance(row["depth"], int)


if __name__ == "__main__":
    unittest.main()

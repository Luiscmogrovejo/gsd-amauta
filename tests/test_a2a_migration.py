"""
tests/test_a2a_migration.py — Structural tests for Phase 55 A2A-01 migration 024.

Verifies that migrations/024-a2a-messages.sql and its DOWN file contain the
correct schema without requiring a live PG connection.
Mirrors test_stab02_redis_watchdog.py structural pattern (Phase 54).

No PG connection required. Never skips.
"""

import os
import unittest

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
MIGRATION_UP = os.path.join(REPO_ROOT, "migrations", "024-a2a-messages.sql")
MIGRATION_DOWN = os.path.join(REPO_ROOT, "migrations", "024-a2a-messages-DOWN.sql")


class TestA2AMigrationStructure(unittest.TestCase):
    """Structural tests: verify migration 024 contains the correct schema."""

    def setUp(self):
        with open(MIGRATION_UP) as f:
            self.up_sql = f.read()
        with open(MIGRATION_DOWN) as f:
            self.down_sql = f.read()

    def test_up_is_wrapped_in_transaction(self):
        """Migration UP uses BEGIN/COMMIT transaction wrap."""
        self.assertIn("BEGIN;", self.up_sql)
        self.assertIn("COMMIT;", self.up_sql)

    def test_down_is_wrapped_in_transaction(self):
        """Migration DOWN uses BEGIN/COMMIT transaction wrap."""
        self.assertIn("BEGIN;", self.down_sql)
        self.assertIn("COMMIT;", self.down_sql)

    def test_table_created_with_if_not_exists(self):
        """CREATE TABLE uses IF NOT EXISTS guard for idempotency."""
        self.assertIn("CREATE TABLE IF NOT EXISTS a2a_messages", self.up_sql)

    def test_all_ten_columns_present(self):
        """All 10 required columns appear in the migration."""
        required_cols = [
            "correlation_id",
            "parent_correlation_id",
            "from_agent",
            "to_agent",
            "capability",
            "payload",
            "kind",
            "status",
            "created_at",
            "responded_at",
        ]
        for col in required_cols:
            self.assertIn(col, self.up_sql, f"Required column '{col}' missing from migration")

    def test_payload_is_jsonb_not_null(self):
        """payload column is JSONB NOT NULL (empty body convention)."""
        self.assertIn("JSONB NOT NULL", self.up_sql.upper(),
            "payload must be JSONB NOT NULL per gray-area decision 8")

    def test_kind_check_constraint_frozen_vocab(self):
        """kind column has CHECK constraint with frozen 4-value vocabulary."""
        # All 4 frozen values must appear in the CHECK constraint
        for vocab in ("request", "response", "error", "retried"):
            self.assertIn(vocab, self.up_sql,
                f"Frozen kind vocab '{vocab}' missing from CHECK constraint")

    def test_to_agent_status_index_present(self):
        """(to_agent, status) index for inbox queries is present."""
        self.assertIn("idx_a2a_messages_to_agent_status", self.up_sql)
        self.assertIn("to_agent, status", self.up_sql)

    def test_comment_on_table_references_phase(self):
        """COMMENT ON TABLE references Phase 55 and A2A-01."""
        self.assertIn("Phase 55", self.up_sql)
        self.assertIn("A2A-01", self.up_sql)

    def test_down_drops_a2a_messages_cascade(self):
        """DOWN file drops a2a_messages with CASCADE."""
        self.assertIn("DROP TABLE IF EXISTS a2a_messages CASCADE", self.down_sql)

    def test_a2a_messages_distinct_from_agent_messages(self):
        """Migration comment distinguishes a2a_messages from agent_messages (Phase 38 blackboard)."""
        self.assertIn("agent_messages", self.up_sql,
            "Comment must reference agent_messages to distinguish the two tables")


if __name__ == "__main__":
    unittest.main()

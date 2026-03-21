#!/usr/bin/env python3
"""Tests for the gsd_audit_log system (Phase 6: Audit Log).

Tests the append-only audit log across SQLite store operations:
  - INSERT (audit_log) works and returns an ID
  - Query filters work correctly (task_id, event_type, date range)
  - No UPDATE/DELETE methods exist on the audit table
  - Export format coverage (JSON records, CSV structure)
  - Show for a specific task returns correct entries

Run with:
  python3 tests/test_audit.py
  python3 -m pytest tests/test_audit.py -v
"""
import csv
import io
import json
import os
import sys
import tempfile
import unittest

# Prevent module-level side effects during import
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services"))

from sqlite_store import SQLiteStore


class TestAuditLogInsert(unittest.TestCase):
    """Test audit_log INSERT operations."""

    def setUp(self):
        self.tmpfile = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmpfile.close()
        self.store = SQLiteStore(db_path=self.tmpfile.name)

    def tearDown(self):
        self.store.close()
        os.unlink(self.tmpfile.name)

    def test_basic_insert(self):
        """audit_log should return a positive integer row ID."""
        row_id = self.store.audit_log(
            task_id="TK-0001",
            event_type="validation",
            agent_id="validator",
            status="pass",
            content="Validated OK",
        )
        self.assertIsInstance(row_id, int)
        self.assertGreater(row_id, 0)

    def test_insert_with_gate_results(self):
        """audit_log should accept structured gate_results as JSON."""
        gate_results = [
            {"gate": "RPETD_COMPLETE", "status": "PASS", "reason": "All 5 phases"},
            {"gate": "BRANCH_EVIDENCE", "status": "FAIL", "reason": "No branch"},
        ]
        row_id = self.store.audit_log(
            task_id="TK-0002",
            event_type="validation",
            agent_id="validator",
            gate_results=gate_results,
            status="fail",
        )
        self.assertGreater(row_id, 0)

        # Verify the gate results are stored and retrievable
        results = self.store.audit_query(task_id="TK-0002")
        self.assertEqual(len(results), 1)
        entry = results[0]
        self.assertEqual(len(entry["gate_results"]), 2)
        self.assertEqual(entry["gate_results"][0]["gate"], "RPETD_COMPLETE")

    def test_insert_rpetd_phase(self):
        """RPETD phase events should record agent and phase letter."""
        row_id = self.store.audit_log(
            task_id="TK-0003",
            event_type="rpetd_phase",
            agent_id="executor-backend",
            phase="R",
            content="R: Researched architecture...",
        )
        self.assertGreater(row_id, 0)
        results = self.store.audit_query(task_id="TK-0003")
        self.assertEqual(results[0]["phase"], "R")
        self.assertEqual(results[0]["agent_id"], "executor-backend")

    def test_insert_claim_event(self):
        """Claim events should be logged."""
        row_id = self.store.audit_log(
            task_id="TK-0004",
            event_type="claim",
            agent_id="executor-backend",
        )
        self.assertGreater(row_id, 0)

    def test_insert_status_change(self):
        """Status change events should be logged with old/new status."""
        row_id = self.store.audit_log(
            task_id="TK-0005",
            event_type="status_change",
            status="validation",
            metadata={"old_status": "in-progress", "new_status": "validation"},
        )
        self.assertGreater(row_id, 0)
        results = self.store.audit_query(task_id="TK-0005")
        self.assertEqual(results[0]["metadata"]["old_status"], "in-progress")

    def test_insert_with_all_fields(self):
        """All fields should be accepted."""
        row_id = self.store.audit_log(
            task_id="TK-0006",
            event_type="validation",
            agent_id="validator",
            actor="sso-user@example.com",
            phase=None,
            status="force",
            gate_results=[{"gate": "RPETD_COMPLETE", "status": "FAIL", "reason": "test"}],
            content="Forced pass due to urgency",
            metadata={"forced": True, "reason": "urgent"},
        )
        self.assertGreater(row_id, 0)
        results = self.store.audit_query(task_id="TK-0006")
        entry = results[0]
        self.assertEqual(entry["actor"], "sso-user@example.com")
        self.assertEqual(entry["status"], "force")
        self.assertTrue(entry["metadata"]["forced"])


class TestAuditLogQuery(unittest.TestCase):
    """Test audit_query filter operations."""

    def setUp(self):
        self.tmpfile = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmpfile.close()
        self.store = SQLiteStore(db_path=self.tmpfile.name)
        # Seed test data
        self.store.audit_log("TK-0010", "validation", agent_id="validator", status="pass")
        self.store.audit_log("TK-0010", "rpetd_phase", agent_id="executor-backend", phase="R")
        self.store.audit_log("TK-0010", "rpetd_phase", agent_id="executor-backend", phase="P")
        self.store.audit_log("TK-0010", "claim", agent_id="executor-backend")
        self.store.audit_log("TK-0011", "validation", agent_id="validator", status="fail")
        self.store.audit_log("TK-0011", "status_change", status="pending")

    def tearDown(self):
        self.store.close()
        os.unlink(self.tmpfile.name)

    def test_filter_by_task_id(self):
        """Query with task_id filter should return only matching entries."""
        results = self.store.audit_query(task_id="TK-0010")
        self.assertEqual(len(results), 4)
        for r in results:
            self.assertEqual(r["task_id"], "TK-0010")

    def test_filter_by_event_type(self):
        """Query with event_type filter should return only matching entries."""
        results = self.store.audit_query(event_type="validation")
        self.assertEqual(len(results), 2)
        for r in results:
            self.assertEqual(r["event_type"], "validation")

    def test_filter_by_task_and_type(self):
        """Combined task_id + event_type filter."""
        results = self.store.audit_query(task_id="TK-0010", event_type="rpetd_phase")
        self.assertEqual(len(results), 2)

    def test_limit(self):
        """Query should respect limit parameter."""
        results = self.store.audit_query(limit=2)
        self.assertEqual(len(results), 2)

    def test_no_filters_returns_all(self):
        """Query with no filters returns all entries."""
        results = self.store.audit_query()
        self.assertEqual(len(results), 6)

    def test_count(self):
        """audit_count returns total number of entries."""
        count = self.store.audit_count()
        self.assertEqual(count, 6)

    def test_show_for_specific_task(self):
        """Simulates 'audit show TK-0010' — returns full trail for task."""
        results = self.store.audit_query(task_id="TK-0010")
        event_types = {r["event_type"] for r in results}
        self.assertIn("validation", event_types)
        self.assertIn("rpetd_phase", event_types)
        self.assertIn("claim", event_types)


class TestAuditLogImmutability(unittest.TestCase):
    """Test that audit log is append-only — no UPDATE/DELETE methods."""

    def setUp(self):
        self.tmpfile = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmpfile.close()
        self.store = SQLiteStore(db_path=self.tmpfile.name)

    def tearDown(self):
        self.store.close()
        os.unlink(self.tmpfile.name)

    def test_no_audit_update_method(self):
        """SQLiteStore should NOT have an audit_update method."""
        self.assertFalse(hasattr(self.store, "audit_update"))

    def test_no_audit_delete_method(self):
        """SQLiteStore should NOT have an audit_delete method."""
        self.assertFalse(hasattr(self.store, "audit_delete"))

    def test_no_audit_modify_method(self):
        """SQLiteStore should NOT have an audit_modify method."""
        self.assertFalse(hasattr(self.store, "audit_modify"))

    def test_only_insert_and_select(self):
        """The only audit methods should be audit_log (INSERT), audit_query (SELECT), audit_count (SELECT)."""
        audit_methods = [m for m in dir(self.store) if m.startswith("audit_")]
        self.assertEqual(sorted(audit_methods), ["audit_count", "audit_log", "audit_query"])


class TestAuditLogExport(unittest.TestCase):
    """Test export format (JSON records and CSV structure)."""

    def setUp(self):
        self.tmpfile = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmpfile.close()
        self.store = SQLiteStore(db_path=self.tmpfile.name)
        # Seed data
        self.store.audit_log(
            "TK-0020", "validation", agent_id="validator", status="pass",
            gate_results=[{"gate": "RPETD_COMPLETE", "status": "PASS", "reason": "All 5"}],
            content="All gates passed",
        )
        self.store.audit_log(
            "TK-0020", "rpetd_phase", agent_id="executor-backend", phase="D",
            content="D: Summary. LEARNING: SQLite audit works",
        )

    def tearDown(self):
        self.store.close()
        os.unlink(self.tmpfile.name)

    def test_export_json_format(self):
        """Exported data should be valid JSON with expected fields."""
        results = self.store.audit_query()
        self.assertEqual(len(results), 2)
        for entry in results:
            self.assertIn("id", entry)
            self.assertIn("task_id", entry)
            self.assertIn("event_type", entry)
            self.assertIn("created_at", entry)
            # Should be JSON-serializable
            json_str = json.dumps(entry)
            self.assertIsInstance(json_str, str)

    def test_export_csv_format(self):
        """Exported data should be convertible to valid CSV."""
        results = self.store.audit_query()
        output = io.StringIO()
        if results:
            writer = csv.DictWriter(output, fieldnames=results[0].keys())
            writer.writeheader()
            for row in results:
                flat = {}
                for k, v in row.items():
                    flat[k] = json.dumps(v) if isinstance(v, (dict, list)) else v
                writer.writerow(flat)
        csv_text = output.getvalue()
        self.assertIn("task_id", csv_text)
        self.assertIn("event_type", csv_text)
        self.assertIn("TK-0020", csv_text)
        # Verify it parses back
        reader = csv.DictReader(io.StringIO(csv_text))
        rows = list(reader)
        self.assertEqual(len(rows), 2)

    def test_gate_results_in_export(self):
        """Gate results should be preserved as structured data in JSON export."""
        results = self.store.audit_query(event_type="validation")
        self.assertEqual(len(results), 1)
        entry = results[0]
        self.assertIsInstance(entry["gate_results"], list)
        self.assertEqual(entry["gate_results"][0]["gate"], "RPETD_COMPLETE")


if __name__ == "__main__":
    unittest.main()

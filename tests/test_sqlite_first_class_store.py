#!/usr/bin/env python3
"""Store-level tests for the SQLite first-class fallback (sqlite_store.py).

Covers the operations that previously existed only as PostgreSQL migrations
or PG-only kwargs:
  - agent_findings    (sweep, by-task, insert, dedup, status transition)
  - agent_messages    (inbox, insert, approve/respond)
  - step_handoffs     (append-only log, latest-wins, DECIMAL phase numbers)
  - agent_metrics     (insert + per-agent aggregates)
  - memory_search(tags=, category=)  — used to raise TypeError
  - memory_delete                     — used to return None unconditionally
  - memory_archive_and_delete         — did not exist
  - degraded_counts                   — feeds /health

Every test uses its own temp database file; nothing touches
~/.amauta/data/gsd_amauta.db.

Run: /opt/homebrew/bin/python3 -m pytest tests/test_sqlite_first_class_store.py -v
"""
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest

_SERVICES = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "services")
if _SERVICES not in sys.path:
    sys.path.insert(0, _SERVICES)

_spec = importlib.util.spec_from_file_location(
    "sqlite_store_under_test", os.path.join(_SERVICES, "sqlite_store.py")
)
sqlite_store = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sqlite_store)
SQLiteStore = sqlite_store.SQLiteStore


class _StoreCase(unittest.TestCase):
    """Base: a throwaway SQLiteStore on its own temp file."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sqlite-first-class-")
        self.store = SQLiteStore(db_path=os.path.join(self.tmp, "t.db"))

    def tearDown(self):
        try:
            self.store.close()
        except Exception:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)


# ── Schema ───────────────────────────────────────────────────────────────────

class TestSchemaCreatesBlackboardTables(_StoreCase):

    def test_schema_creates_blackboard_tables(self):
        """The four formerly PG-only tables exist after schema init."""
        with self.store._get_conn() as conn:
            names = {
                r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
        for table in ("agent_findings", "agent_messages", "step_handoffs", "agent_metrics"):
            self.assertIn(table, names, f"{table} missing from the SQLite schema")

    def test_agent_findings_has_every_extension_column(self):
        """agent_findings carries the columns migrations 020/021/023/027 added.

        The daemon's audit sweep selects severity/domain/file_path/rule_id/
        status and writes dedup_key/ticket_id/audit_run_id; a narrower table
        would 500 at query time rather than at schema time.
        """
        with self.store._get_conn() as conn:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(agent_findings)").fetchall()}
        for col in ("recipient_agent", "severity", "session_id", "decision_type",
                    "rule_id", "domain", "file_path", "evidence", "suggested_fix",
                    "dedup_key", "status", "ticket_id", "audit_run_id"):
            self.assertIn(col, cols, f"agent_findings.{col} missing")


# ── Findings ─────────────────────────────────────────────────────────────────

class TestFindings(_StoreCase):

    def test_insert_and_read_back_by_task(self):
        created = self.store.finding_insert("gsd-planner", "observation", "note", task_id="TK-0001")
        self.assertIn("id", created)
        rows = self.store.findings_by_task("TK-0001")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["content"], "note")
        self.assertEqual(rows[0]["agent_name"], "gsd-planner")
        self.assertEqual(rows[0]["id"], created["id"])

    def test_sweep_filters_are_conjunctive(self):
        self.store.finding_insert("a", "audit", "c1", severity="warning", domain="backend")
        self.store.finding_insert("a", "audit", "c2", severity="critical", domain="frontend")
        self.store.finding_insert("a", "observation", "c3", severity="warning", domain="backend")
        self.assertEqual(len(self.store.findings_sweep()), 3)
        self.assertEqual(len(self.store.findings_sweep(domain="backend")), 2)
        self.assertEqual(len(self.store.findings_sweep(severity="critical")), 1)
        self.assertEqual(
            len(self.store.findings_sweep(domain="backend", finding_type="audit")), 1
        )
        self.assertEqual(len(self.store.findings_sweep(status="fixed")), 0)

    def test_dedup_key_blocks_a_second_open_finding(self):
        """SUBS-05 Layer A: same dedup_key while open/ticketed -> dedupe, no new row."""
        first = self.store.finding_insert("a", "audit", "c", dedup_key="R1:abc")
        second = self.store.finding_insert("a", "audit", "c again", dedup_key="R1:abc")
        self.assertTrue(second.get("deduped"))
        self.assertEqual(second["existing_id"], first["id"])
        self.assertEqual(len(self.store.findings_sweep()), 1)

    def test_dedup_key_allows_a_new_finding_once_the_old_one_is_closed(self):
        first = self.store.finding_insert("a", "audit", "c", dedup_key="R1:abc")
        self.store.finding_update(first["id"], status="fixed")
        second = self.store.finding_insert("a", "audit", "c again", dedup_key="R1:abc")
        self.assertFalse(second.get("deduped"), f"must not dedupe against a fixed finding: {second}")
        self.assertNotEqual(second["id"], first["id"])

    def test_update_status_and_ticket(self):
        created = self.store.finding_insert("a", "audit", "c")
        updated = self.store.finding_update(created["id"], status="ticketed", ticket_id="TK-9",
                                            ticket_id_present=True)
        self.assertEqual(updated["status"], "ticketed")
        self.assertEqual(updated["ticket_id"], "TK-9")

    def test_update_unknown_finding_returns_none(self):
        self.assertIsNone(self.store.finding_update("no-such-id", status="fixed"))

    def test_task_id_may_be_null(self):
        """Migration 027 relaxed task_id; a standalone audit finding has none."""
        created = self.store.finding_insert("gsd-auditor-backend", "audit", "standalone")
        self.assertIn("id", created)
        self.assertEqual(self.store.findings_sweep()[0]["task_id"], None)


# ── Messages ─────────────────────────────────────────────────────────────────

class TestMessages(_StoreCase):

    def test_inbox_returns_pending_and_approved_only(self):
        self.store.message_insert("a", "b", "TK-1", "ASK_QUESTION", "q1", status="pending")
        self.store.message_insert("a", "b", "TK-1", "SHARE_FINDING", "q2", status="approved",
                                  operator_approved=True)
        self.store.message_insert("a", "b", "TK-1", "ASK_QUESTION", "q3", status="denied")
        self.store.message_insert("a", "c", "TK-1", "ASK_QUESTION", "q4")
        inbox = self.store.messages_for_agent("b")
        self.assertEqual([m["content"] for m in inbox], ["q1", "q2"])

    def test_operator_approved_is_a_bool_not_an_int(self):
        """SQLite stores BOOLEAN as INTEGER; the API contract is a JSON bool."""
        self.store.message_insert("a", "b", "TK-1", "SHARE_FINDING", "x",
                                  status="approved", operator_approved=True)
        self.assertIs(self.store.messages_for_agent("b")[0]["operator_approved"], True)

    def test_respond_sets_responded_at_and_leaves_the_inbox(self):
        created = self.store.message_insert("a", "b", "TK-1", "ASK_QUESTION", "q")
        updated = self.store.message_update(created["id"], status="responded",
                                            response="answer", response_present=True)
        self.assertEqual(updated["status"], "responded")
        self.assertIsNotNone(updated["responded_at"])
        self.assertEqual(self.store.messages_for_agent("b"), [])

    def test_update_unknown_message_returns_none(self):
        self.assertIsNone(self.store.message_update("no-such-id", status="approved"))


# ── Step handoffs ────────────────────────────────────────────────────────────

class TestStepHandoffs(_StoreCase):

    def test_latest_wins_on_an_append_only_log(self):
        self.store.step_handoff_insert("execute-phase", 72, step_id="s1", task_id="TK-1",
                                       context_snapshot={"n": 1})
        self.store.step_handoff_insert("execute-phase", 72, step_id="s2", task_id="TK-1",
                                       context_snapshot={"n": 2})
        latest = self.store.step_handoff_latest("execute-phase", 72)
        self.assertEqual(latest["step_id"], "s2")
        self.assertEqual(latest["context_snapshot"], {"n": 2})
        with self.store._get_conn() as conn:
            total = conn.execute("SELECT COUNT(*) FROM step_handoffs").fetchone()[0]
        self.assertEqual(total, 2, "handoffs are appended, never upserted")

    def test_decimal_phase_is_stored_and_found_as_itself(self):
        """/amauta:insert-phase creates 72.1; it must not collapse into 72."""
        self.store.step_handoff_insert("execute-phase", 72, step_id="whole",
                                       context_snapshot={})
        self.store.step_handoff_insert("execute-phase", "72.1", step_id="decimal",
                                       context_snapshot={})
        self.assertEqual(self.store.step_handoff_latest("execute-phase", "72.1")["step_id"],
                         "decimal")
        self.assertEqual(self.store.step_handoff_latest("execute-phase", 72)["step_id"],
                         "whole")
        self.assertEqual(self.store.step_handoff_latest("execute-phase", "72.1")["phase_number"],
                         72.1)

    def test_phase_spellings_of_the_same_number_agree(self):
        self.store.step_handoff_insert("execute-phase", "72", step_id="s", context_snapshot={})
        for spelling in (72, 72.0, "72", "72.0"):
            self.assertIsNotNone(
                self.store.step_handoff_latest("execute-phase", spelling),
                f"phase spelling {spelling!r} did not find the row",
            )

    def test_json_columns_round_trip(self):
        self.store.step_handoff_insert(
            "execute-phase", 5, step_id="s", task_id="TK-1",
            completed_steps=["a", "b"], context_snapshot={"k": [1, 2]},
            artifacts={"f": "x.md"}, decisions=[{"d": 1}], user_inputs=["yes"],
            next_step="validate", escalation_flags=["divergence"],
        )
        row = self.store.step_handoff_latest("execute-phase", 5)
        self.assertEqual(row["completed_steps"], ["a", "b"])
        self.assertEqual(row["context_snapshot"], {"k": [1, 2]})
        self.assertEqual(row["artifacts"], {"f": "x.md"})
        self.assertEqual(row["decisions"], [{"d": 1}])
        self.assertEqual(row["user_inputs"], ["yes"])
        self.assertEqual(row["escalation_flags"], ["divergence"])

    def test_missing_handoff_is_none_not_an_error(self):
        self.assertIsNone(self.store.step_handoff_latest("execute-phase", 999))

    def test_non_numeric_phase_raises_valueerror(self):
        with self.assertRaises(ValueError):
            self.store.step_handoff_latest("execute-phase", "not-a-number")


# ── Agent metrics ────────────────────────────────────────────────────────────

class TestAgentMetrics(_StoreCase):

    def test_stats_aggregate_per_agent(self):
        self.store.agent_metric_insert("a", "TK-1", "pass", completion_time_ms=100, token_usage=10)
        self.store.agent_metric_insert("a", "TK-2", "fail", completion_time_ms=300, token_usage=30,
                                       error_count=2)
        self.store.agent_metric_insert("b", "TK-3", "pass", completion_time_ms=50, token_usage=5)
        stats = {s["agent_name"]: s for s in self.store.agent_metrics_stats()}
        self.assertEqual(stats["a"]["tasks_completed"], 2)
        self.assertEqual(stats["a"]["avg_time_ms"], 200)
        self.assertEqual(stats["a"]["avg_tokens"], 20)
        self.assertAlmostEqual(stats["a"]["pass_rate"], 0.5)
        self.assertAlmostEqual(stats["a"]["error_rate"], 1.0)
        self.assertEqual(stats["b"]["tasks_completed"], 1)
        self.assertAlmostEqual(stats["b"]["pass_rate"], 1.0)

    def test_stats_on_an_empty_table(self):
        self.assertEqual(self.store.agent_metrics_stats(), [])


# ── Memory ───────────────────────────────────────────────────────────────────

class TestMemoryFilters(_StoreCase):

    def setUp(self):
        super().setUp()
        self.hit = self.store.memory_store(
            "needle in a haystack", source="lesson-learned",
            tags=["postgresql", "backend"], metadata={"category": "pattern"},
        )
        self.miss = self.store.memory_store(
            "needle elsewhere", source="lesson-learned",
            tags=["frontend"], metadata={"category": "workflow"},
        )

    def test_tags_kwarg_is_accepted_and_filters(self):
        """Used to raise TypeError, which the daemon reported as a 500."""
        ids = [r["id"] for r in self.store.memory_search("needle", tags=["postgresql"])]
        self.assertEqual(ids, [self.hit])

    def test_tag_synonyms_are_normalized(self):
        ids = [r["id"] for r in self.store.memory_search("needle", tags=["pg"])]
        self.assertEqual(ids, [self.hit], "tag synonyms must resolve like PG's filter")

    def test_tags_are_any_of_not_all_of(self):
        results = self.store.memory_search("needle", tags=["postgresql", "frontend"])
        self.assertEqual(len(results), 2)

    def test_unknown_tag_yields_nothing(self):
        self.assertEqual(self.store.memory_search("needle", tags=["nope"]), [])

    def test_category_kwarg_is_accepted_and_filters(self):
        ids = [r["id"] for r in self.store.memory_search("needle", category="pattern")]
        self.assertEqual(ids, [self.hit])

    def test_category_matches_the_metadata_key_not_a_substring(self):
        self.store.memory_store("needle decoy", source="lesson-learned",
                                metadata={"notes": "category pattern"})
        ids = [r["id"] for r in self.store.memory_search("needle", category="pattern")]
        self.assertEqual(ids, [self.hit])

    def test_tags_and_category_combine(self):
        self.assertEqual(
            len(self.store.memory_search("needle", tags=["postgresql"], category="workflow")), 0
        )


class TestMemoryDelete(_StoreCase):

    def test_delete_reports_a_real_removal(self):
        mem_id = self.store.memory_store("to be deleted")
        self.assertIs(self.store.memory_delete(mem_id), True)

    def test_delete_of_a_missing_id_reports_false(self):
        """Used to return None, so the API always answered deleted:true."""
        self.assertIs(self.store.memory_delete("mem-does-not-exist"), False)

    def test_delete_is_not_idempotently_truthy(self):
        mem_id = self.store.memory_store("x")
        self.assertIs(self.store.memory_delete(mem_id), True)
        self.assertIs(self.store.memory_delete(mem_id), False)


class TestMemoryArchiveAndDelete(_StoreCase):

    def test_row_moves_to_the_archive_table(self):
        mem_id = self.store.memory_store("archive me", source="task_event")
        result = self.store.memory_archive_and_delete(mem_id)
        self.assertEqual(result, {"archived": True, "deleted": True, "id": mem_id})
        with self.store._get_conn() as conn:
            live = conn.execute("SELECT COUNT(*) FROM gsd_memory WHERE id = ?", (mem_id,)).fetchone()[0]
            archived = conn.execute(
                "SELECT text FROM gsd_memory_archive WHERE id = ?", (mem_id,)
            ).fetchone()
        self.assertEqual(live, 0, "row must leave the live table")
        self.assertIsNotNone(archived, "row must survive in the archive")
        self.assertEqual(archived[0], "archive me")

    def test_missing_id_is_reported_not_raised(self):
        self.assertEqual(
            self.store.memory_archive_and_delete("mem-nope"),
            {"archived": False, "deleted": False, "id": "mem-nope"},
        )


class TestDegradedCounts(_StoreCase):

    def test_counts_reflect_the_live_table(self):
        for i in range(3):
            self.store.memory_store(f"row {i}")
        counts = self.store.degraded_counts()
        self.assertEqual(counts["memory_rows"], 3)
        self.assertEqual(counts["memory_rows_with_embeddings"], 0)
        self.assertEqual(counts["rlm_chunks"], 0)


# ── Phase normalization helper ───────────────────────────────────────────────

class TestNormalizePhaseNumber(unittest.TestCase):

    def test_integral_values_become_ints(self):
        for raw in (72, 72.0, "72", "72.0"):
            self.assertEqual(sqlite_store.normalize_phase_number(raw), 72)
            self.assertIsInstance(sqlite_store.normalize_phase_number(raw), int)

    def test_decimal_values_stay_floats(self):
        self.assertEqual(sqlite_store.normalize_phase_number("72.1"), 72.1)

    def test_garbage_raises(self):
        for raw in ("abc", "", None, "72.1.3"):
            with self.assertRaises((ValueError, TypeError)):
                sqlite_store.normalize_phase_number(raw)

    def test_infinity_is_rejected(self):
        with self.assertRaises(ValueError):
            sqlite_store.normalize_phase_number("inf")


if __name__ == "__main__":
    unittest.main()

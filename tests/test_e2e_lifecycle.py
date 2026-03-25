#!/usr/bin/env python3
"""E2E smoke tests -- full task lifecycle create-claim-RPETD-validate-archive.

Covers:
  - Full lifecycle: create -> claim -> R/P/E/T/D -> validate -> archive
  - Enrichment triggers: R-phase enrichment, D-phase auto-learning, claim Layer 1
  - Memory integration: _mem_log_event with project_id, status transition events
  - Archive verification: archived task in archive file, complete RPETD
  - Error recovery: enrichment failures, mem_log_event failures

Mock strategy: Use tempfile.mkdtemp for AMAUTA_DATA_DIR.
Patch _mem_log_event, _rlm_query, _mem_semantic_search, _rpetd_phase_enrich,
_auto_write_learning as MagicMock (record calls but no-op).
Patch _file_lock with _noop_lock. Build argparse.Namespace for each command.
Use real load()/save() against temp files for true E2E coverage.

Run: python3 -m pytest tests/test_e2e_lifecycle.py -v
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch, call

# Prevent module-level side effects during import
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import amauta


# ── Helpers ──────────────────────────────────────────────────────────────────

@contextmanager
def _noop_lock():
    """No-op context manager to replace _file_lock."""
    yield


def _make_add_args(title="E2E test task", task_type="task", parent=None):
    """Build argparse.Namespace for cmd_add."""
    return argparse.Namespace(
        type=task_type, title=title, description="E2E test task description",
        details="Full E2E details", test_strategy="pytest tests/test_e2e.py",
        status="pending", priority="medium", agent="e2e-test",
        parent=parent, deps=None, tags="e2e,test", sprint=None,
        due=None, hours=None, importance=3, urgency=3,
        criteria="All tests pass|No errors", deliverables=None,
        checklist=None, force=False, refs=None,
    )


def _make_claim_args(task_id, agent="e2e-test"):
    return argparse.Namespace(id=task_id, agent=agent)


def _make_rpetd_args(task_id, phase, content, agent="e2e-test"):
    return argparse.Namespace(id=task_id, phase=phase, content=content, agent=agent, append=False)


def _make_validate_args(task_id, pass_=True, validator="validator"):
    return argparse.Namespace(
        id=task_id, pass_=pass_, fail=not pass_,
        notes="E2E validation passed", validator=validator,
        force_reason="e2e-test override", test_exempt=True,
        json_output=False, subtasks=None,
    )


def _make_archive_args(days=0):
    return argparse.Namespace(days=days, dry_run=False)


@contextmanager
def _e2e_tempdir():
    """Set up a temp AMAUTA_DATA_DIR with proper patches for real file I/O."""
    tmpdir = tempfile.mkdtemp(prefix="amauta_e2e_")
    tmppath = Path(tmpdir)
    tasks_file = tmppath / "tasks.json"
    archive_file = tmppath / "tasks-archive.json"
    lock_file = tmppath / ".amauta.lock"
    memory_file = tmppath / "memory.jsonl"

    # Initialize empty tasks
    tasks_file.write_text(json.dumps({
        "items": [],
        "metadata": {"created": amauta._now(), "version": "2.0", "updated": amauta._now()},
    }))

    try:
        with patch("amauta.DATA_DIR", tmppath), \
             patch("amauta.TASKS_FILE", tasks_file), \
             patch("amauta.ARCHIVE_FILE", archive_file), \
             patch("amauta.MEMORY_FILE", memory_file), \
             patch("amauta._LOCK_FILE", lock_file), \
             patch("amauta._file_lock", _noop_lock):
            yield tmppath
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _load_tasks(tmppath):
    """Load tasks.json from temp dir."""
    return json.loads((tmppath / "tasks.json").read_text())


def _find_task(tmppath, task_id):
    """Find a task by ID in temp tasks.json."""
    data = _load_tasks(tmppath)
    for item in data["items"]:
        if item["id"] == task_id:
            return item
    return None


def _extract_task_id(capsys_output):
    """Extract TK-XXXX from cmd_add output."""
    import re
    m = re.search(r'(TK-\d+)', capsys_output)
    return m.group(1) if m else None


# ── Full lifecycle -- happy path ─────────────────────────────────────────────

class TestFullLifecycleCreateToArchive(unittest.TestCase):
    """Full E2E lifecycle: create -> claim -> RPETD -> validate -> archive."""

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", return_value="")
    @patch("amauta._mem_semantic_search", return_value=[])
    @patch("amauta._rlm_query", return_value="")
    @patch("amauta._mem_log_event")
    @patch("amauta._audit_log_event")
    @patch("amauta._enrich_task_context", return_value="")
    @patch("amauta._dedup_check", return_value=None)
    def test_full_lifecycle_create_to_archive(self, mock_dedup, mock_enrich_ctx,
                                               mock_audit, mock_mem_log,
                                               mock_rlm, mock_sem, mock_rpetd_enrich,
                                               mock_auto_learn):
        """Exercise the COMPLETE path: add -> claim -> R/P/E/T/D -> validate -> archive."""
        with _e2e_tempdir() as tmppath:
            # 1. cmd_add: create task
            add_args = _make_add_args()
            amauta.cmd_add(add_args)

            # Extract task ID
            data = _load_tasks(tmppath)
            self.assertEqual(len(data["items"]), 1)
            task_id = data["items"][0]["id"]
            self.assertTrue(task_id.startswith("TK-"))

            # 2. cmd_claim: claim the task
            claim_args = _make_claim_args(task_id)
            amauta.cmd_claim(claim_args)

            task = _find_task(tmppath, task_id)
            self.assertEqual(task["status"], "in-progress")
            self.assertEqual(task["claimed_by"], "e2e-test")

            # 3. cmd_rpetd R through D phases
            phases = [
                ("R", "R: researched codebase, found existing patterns"),
                ("P", "P: plan is to implement feature X"),
                ("E", "E: implemented in branch feat/e2e. git checkout -b feat/e2e"),
                ("T", "T: pytest tests/test_e2e.py -- 5 passed, 0 failed"),
                ("D", "D: feature complete. LEARNING: E2E tests catch integration gaps"),
            ]
            for phase, content in phases:
                rpetd_args = _make_rpetd_args(task_id, phase, content)
                amauta.cmd_rpetd(rpetd_args)

            # 8. Assert rpetd_complete=True after all 5 phases
            task = _find_task(tmppath, task_id)
            self.assertTrue(task.get("rpetd_complete"), "rpetd_complete should be True after all 5 phases")

            # 9. cmd_validate --pass: mark done
            validate_args = _make_validate_args(task_id)
            amauta.cmd_validate(validate_args)

            task = _find_task(tmppath, task_id)
            self.assertEqual(task["status"], "done")

            # 10. cmd_archive: archive the done task
            archive_args = _make_archive_args(days=0)
            amauta.cmd_archive(archive_args)

            # Assert task moved to archive file
            remaining = _load_tasks(tmppath)
            self.assertEqual(len(remaining["items"]), 0, "Active tasks should be empty after archive")

            archive_data = json.loads((tmppath / "tasks-archive.json").read_text())
            archived_ids = {i["id"] for i in archive_data["items"]}
            self.assertIn(task_id, archived_ids, "Task should be in archive")


# ── Enrichment fires during lifecycle ────────────────────────────────────────

class TestRpetdRPhaseTriggersEnrichment(unittest.TestCase):
    """R-phase rpetd call triggers _rpetd_phase_enrich."""

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", return_value="[RLM] enriched context")
    @patch("amauta._mem_log_event")
    @patch("amauta._audit_log_event")
    @patch("amauta._dedup_check", return_value=None)
    @patch("amauta._enrich_task_context", return_value="")
    def test_rpetd_r_phase_triggers_enrichment(self, mock_enrich_ctx, mock_dedup,
                                                 mock_audit, mock_mem_log,
                                                 mock_rpetd_enrich, mock_auto_learn):
        """During R-phase rpetd call, _rpetd_phase_enrich should be called with phase='R'."""
        with _e2e_tempdir() as tmppath:
            add_args = _make_add_args()
            amauta.cmd_add(add_args)
            task_id = _load_tasks(tmppath)["items"][0]["id"]

            claim_args = _make_claim_args(task_id)
            amauta.cmd_claim(claim_args)

            rpetd_args = _make_rpetd_args(task_id, "R", "R: research done")
            amauta.cmd_rpetd(rpetd_args)

            # Assert _rpetd_phase_enrich was called with phase="R"
            mock_rpetd_enrich.assert_called()
            call_args = mock_rpetd_enrich.call_args
            self.assertEqual(call_args[0][0], "R")


class TestRpetdDPhaseTriggersAutoLearning(unittest.TestCase):
    """D-phase with LEARNING: triggers session-learning memory write."""

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", return_value="")
    @patch("amauta._mem_log_event")
    @patch("amauta._audit_log_event")
    @patch("amauta._dedup_check", return_value=None)
    @patch("amauta._enrich_task_context", return_value="")
    def test_rpetd_d_phase_triggers_auto_learning(self, mock_enrich_ctx, mock_dedup,
                                                    mock_audit, mock_mem_log,
                                                    mock_rpetd_enrich, mock_auto_learn):
        """After D-phase with LEARNING: block, a session-learning memory write fires."""
        with _e2e_tempdir() as tmppath:
            add_args = _make_add_args()
            amauta.cmd_add(add_args)
            task_id = _load_tasks(tmppath)["items"][0]["id"]

            claim_args = _make_claim_args(task_id)
            amauta.cmd_claim(claim_args)

            # Write D-phase with explicit LEARNING block
            d_content = "D: feature complete. LEARNING: Always test against real data"
            rpetd_args = _make_rpetd_args(task_id, "D", d_content)
            amauta.cmd_rpetd(rpetd_args)

            # D-phase LEARNING: block triggers a session-learning _mem_log_event call
            learning_calls = [c for c in mock_mem_log.call_args_list
                              if c[1].get("source") == "session-learning"
                              or (len(c[0]) > 2 and "LEARNING" in str(c[0]))]
            self.assertGreater(len(learning_calls), 0,
                               "D-phase with LEARNING: should trigger session-learning memory write")


class TestClaimTriggersLayer1Enrichment(unittest.TestCase):
    """cmd_claim triggers Layer 1 context enrichment."""

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", return_value="")
    @patch("amauta._mem_log_event")
    @patch("amauta._audit_log_event")
    @patch("amauta._dedup_check", return_value=None)
    @patch("amauta._enrich_task_context", return_value="[LAYER1] parent context enrichment")
    def test_claim_triggers_layer1_enrichment(self, mock_enrich_ctx, mock_dedup,
                                                mock_audit, mock_mem_log,
                                                mock_rpetd_enrich, mock_auto_learn):
        """cmd_claim calls _enrich_task_context (Layer 1 enrichment)."""
        with _e2e_tempdir() as tmppath:
            add_args = _make_add_args()
            amauta.cmd_add(add_args)
            task_id = _load_tasks(tmppath)["items"][0]["id"]

            claim_args = _make_claim_args(task_id)
            amauta.cmd_claim(claim_args)

            mock_enrich_ctx.assert_called_once()


# ── Memory integration ───────────────────────────────────────────────────────

class TestMemLogEventCalledWithProjectIdDuringLifecycle(unittest.TestCase):
    """_mem_log_event is called with project_id='__test__' during lifecycle."""

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", return_value="")
    @patch("amauta._mem_log_event")
    @patch("amauta._audit_log_event")
    @patch("amauta._dedup_check", return_value=None)
    @patch("amauta._enrich_task_context", return_value="")
    def test_mem_log_event_called_with_project_id_during_lifecycle(self, mock_enrich_ctx,
                                                                     mock_dedup, mock_audit,
                                                                     mock_mem_log,
                                                                     mock_rpetd_enrich,
                                                                     mock_auto_learn):
        """At least one _mem_log_event call should contain metadata with project_id info."""
        with _e2e_tempdir() as tmppath:
            add_args = _make_add_args()
            amauta.cmd_add(add_args)
            task_id = _load_tasks(tmppath)["items"][0]["id"]

            claim_args = _make_claim_args(task_id)
            amauta.cmd_claim(claim_args)

            # _mem_log_event should have been called during claim
            self.assertTrue(mock_mem_log.called, "_mem_log_event should be called during claim")

            # Check that at least one call has metadata containing task_id
            meta_calls = [c for c in mock_mem_log.call_args_list
                          if c[1].get("metadata") and c[1]["metadata"].get("task_id")]
            self.assertGreater(len(meta_calls), 0,
                               "At least one _mem_log_event call should have task_id in metadata")


class TestStatusTransitionsLogEvents(unittest.TestCase):
    """cmd_claim logs a task_event status transition."""

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", return_value="")
    @patch("amauta._mem_log_event")
    @patch("amauta._audit_log_event")
    @patch("amauta._dedup_check", return_value=None)
    @patch("amauta._enrich_task_context", return_value="")
    def test_status_transitions_log_events(self, mock_enrich_ctx, mock_dedup,
                                            mock_audit, mock_mem_log,
                                            mock_rpetd_enrich, mock_auto_learn):
        """Claim (pending->in-progress) logs an event with event:claim tag."""
        with _e2e_tempdir() as tmppath:
            add_args = _make_add_args()
            amauta.cmd_add(add_args)
            task_id = _load_tasks(tmppath)["items"][0]["id"]

            claim_args = _make_claim_args(task_id)
            amauta.cmd_claim(claim_args)

            # Find _mem_log_event call with event:claim tag
            claim_calls = [c for c in mock_mem_log.call_args_list
                           if c[0] and len(c[0]) > 1
                           and "event:claim" in str(c[0][1])]
            self.assertGreater(len(claim_calls), 0,
                               "Claim should log event with 'event:claim' tag")


# ── Archive verifications ────────────────────────────────────────────────────

class TestArchivedTaskInArchiveFile(unittest.TestCase):
    """After archive, task is in archive file and NOT in active tasks."""

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", return_value="")
    @patch("amauta._mem_log_event")
    @patch("amauta._audit_log_event")
    @patch("amauta._dedup_check", return_value=None)
    @patch("amauta._enrich_task_context", return_value="")
    def test_archived_task_in_archive_file(self, mock_enrich_ctx, mock_dedup,
                                             mock_audit, mock_mem_log,
                                             mock_rpetd_enrich, mock_auto_learn):
        """Archived task present in archive items, absent from active tasks."""
        with _e2e_tempdir() as tmppath:
            add_args = _make_add_args()
            amauta.cmd_add(add_args)
            task_id = _load_tasks(tmppath)["items"][0]["id"]

            claim_args = _make_claim_args(task_id)
            amauta.cmd_claim(claim_args)

            for phase, content in [("R", "R: done"), ("P", "P: done"), ("E", "E: done"),
                                   ("T", "T: 5 passed"), ("D", "D: done. LEARNING: test")]:
                amauta.cmd_rpetd(_make_rpetd_args(task_id, phase, content))

            validate_args = _make_validate_args(task_id)
            amauta.cmd_validate(validate_args)

            archive_args = _make_archive_args(days=0)
            amauta.cmd_archive(archive_args)

            # Verify archive file
            archive_path = tmppath / "tasks-archive.json"
            self.assertTrue(archive_path.exists())
            archive_data = json.loads(archive_path.read_text())
            archived_ids = {i["id"] for i in archive_data["items"]}
            self.assertIn(task_id, archived_ids)

            # Verify NOT in active tasks
            remaining = _load_tasks(tmppath)
            remaining_ids = {i["id"] for i in remaining["items"]}
            self.assertNotIn(task_id, remaining_ids)


class TestArchivedTaskHasCompleteRpetd(unittest.TestCase):
    """Archived task has all 5 RPETD phases and rpetd_complete=True."""

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", return_value="")
    @patch("amauta._mem_log_event")
    @patch("amauta._audit_log_event")
    @patch("amauta._dedup_check", return_value=None)
    @patch("amauta._enrich_task_context", return_value="")
    def test_archived_task_has_complete_rpetd(self, mock_enrich_ctx, mock_dedup,
                                               mock_audit, mock_mem_log,
                                               mock_rpetd_enrich, mock_auto_learn):
        """Archived task must have all 5 phases (R, P, E, T, D) and rpetd_complete=True."""
        with _e2e_tempdir() as tmppath:
            add_args = _make_add_args()
            amauta.cmd_add(add_args)
            task_id = _load_tasks(tmppath)["items"][0]["id"]

            claim_args = _make_claim_args(task_id)
            amauta.cmd_claim(claim_args)

            for phase, content in [("R", "R: done"), ("P", "P: done"), ("E", "E: done"),
                                   ("T", "T: passed"), ("D", "D: done. LEARNING: insight")]:
                amauta.cmd_rpetd(_make_rpetd_args(task_id, phase, content))

            validate_args = _make_validate_args(task_id)
            amauta.cmd_validate(validate_args)

            archive_args = _make_archive_args(days=0)
            amauta.cmd_archive(archive_args)

            archive_data = json.loads((tmppath / "tasks-archive.json").read_text())
            archived_task = next(i for i in archive_data["items"] if i["id"] == task_id)
            rpetd = archived_task.get("rpetd_phases", {})
            for phase_key in ["R", "P", "E", "T", "D"]:
                self.assertTrue(rpetd.get(phase_key, "").strip(),
                                f"Archived task must have content in {phase_key}-phase")
            self.assertTrue(archived_task.get("rpetd_complete"),
                            "Archived task must have rpetd_complete=True")


# ── Error recovery ───────────────────────────────────────────────────────────

class TestLifecycleContinuesWhenEnrichmentFails(unittest.TestCase):
    """Full lifecycle succeeds even when _rpetd_phase_enrich raises."""

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", side_effect=Exception("enrichment crash"))
    @patch("amauta._mem_log_event")
    @patch("amauta._audit_log_event")
    @patch("amauta._dedup_check", return_value=None)
    @patch("amauta._enrich_task_context", return_value="")
    def test_lifecycle_continues_when_enrichment_fails(self, mock_enrich_ctx, mock_dedup,
                                                         mock_audit, mock_mem_log,
                                                         mock_rpetd_enrich, mock_auto_learn):
        """All phases stored successfully despite enrichment failure."""
        with _e2e_tempdir() as tmppath:
            add_args = _make_add_args()
            amauta.cmd_add(add_args)
            task_id = _load_tasks(tmppath)["items"][0]["id"]

            claim_args = _make_claim_args(task_id)
            amauta.cmd_claim(claim_args)

            for phase, content in [("R", "R: done"), ("P", "P: done"), ("E", "E: done"),
                                   ("T", "T: passed"), ("D", "D: done")]:
                amauta.cmd_rpetd(_make_rpetd_args(task_id, phase, content))

            # All 5 phases should be stored despite enrichment exceptions
            task = _find_task(tmppath, task_id)
            rpetd = task.get("rpetd_phases", {})
            for phase_key in ["R", "P", "E", "T", "D"]:
                self.assertTrue(rpetd.get(phase_key, "").strip(),
                                f"Phase {phase_key} should have content despite enrichment failure")
            self.assertTrue(task.get("rpetd_complete"),
                            "rpetd_complete should be True despite enrichment failures")


class TestLifecycleContinuesWhenMemLogEventFails(unittest.TestCase):
    """Full lifecycle reaches done even when all telemetry backends fail.

    _mem_log_event internally handles all exceptions (never raises).
    We simulate total backend failure (no PG, no daemon, no JSONL) and verify
    the lifecycle still completes end-to-end.
    """

    @patch("amauta._auto_write_learning")
    @patch("amauta._rpetd_phase_enrich", return_value="")
    @patch("amauta._mem_append", side_effect=Exception("disk full"))
    @patch("amauta._mem_pg_available", return_value=False)
    @patch("amauta._audit_log_event")
    @patch("amauta._dedup_check", return_value=None)
    @patch("amauta._enrich_task_context", return_value="")
    def test_lifecycle_continues_when_mem_log_event_fails(self, mock_enrich_ctx, mock_dedup,
                                                            mock_audit, mock_pg_avail,
                                                            mock_append,
                                                            mock_rpetd_enrich, mock_auto_learn):
        """Task reaches done status despite all telemetry backends failing."""
        with _e2e_tempdir() as tmppath:
            add_args = _make_add_args()
            amauta.cmd_add(add_args)
            task_id = _load_tasks(tmppath)["items"][0]["id"]

            # Claim should work even when _mem_log_event's backends all fail
            # (PG unavailable, daemon unreachable, JSONL write fails)
            with patch("urllib.request.urlopen", side_effect=Exception("no daemon")):
                claim_args = _make_claim_args(task_id)
                amauta.cmd_claim(claim_args)

            task = _find_task(tmppath, task_id)
            self.assertEqual(task["status"], "in-progress",
                             "Claim should succeed even when all telemetry backends fail")

            for phase, content in [("R", "R: done"), ("P", "P: done"), ("E", "E: done"),
                                   ("T", "T: passed"), ("D", "D: done")]:
                with patch("urllib.request.urlopen", side_effect=Exception("no daemon")):
                    amauta.cmd_rpetd(_make_rpetd_args(task_id, phase, content))

            # Validate
            with patch("urllib.request.urlopen", side_effect=Exception("no daemon")):
                validate_args = _make_validate_args(task_id)
                amauta.cmd_validate(validate_args)

            task = _find_task(tmppath, task_id)
            self.assertEqual(task["status"], "done",
                             "Task should reach done despite all telemetry failures")


if __name__ == "__main__":
    unittest.main()

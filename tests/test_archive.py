#!/usr/bin/env python3
"""Tests for cmd_archive and show --archive fallback in amauta.py.

Covers:
  - Dry-run accuracy (no mutations)
  - Age threshold filtering (--days)
  - Archive file persistence (idempotent, no duplicates)
  - Genealogy update -- FIX-09 (parent.children cleanup)
  - cmd_show archive fallback (found / not found)

Run: python3 -m pytest tests/test_archive.py -v
"""
import argparse
import json
import os
import sys
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch, call

# Prevent module-level side effects during import
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import amauta


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _ago_iso(days=0, minutes=0):
    """Return ISO timestamp for N days/minutes ago."""
    dt = datetime.now(timezone.utc) - timedelta(days=days, minutes=minutes)
    return dt.isoformat()


def _make_task(task_id, status="done", days_ago=10, title="Test task"):
    """Build a minimal task dict for archive tests."""
    return {
        "id": task_id,
        "type": "task",
        "title": title,
        "status": status,
        "updated_at": _ago_iso(days=days_ago),
        "created_at": _ago_iso(days=days_ago + 1),
    }


def _make_data(items):
    """Wrap items in the standard data envelope."""
    return {
        "items": items,
        "metadata": {"created": _now_iso(), "version": "2.0", "updated": _now_iso()},
    }


def _empty_archive():
    return {"items": [], "metadata": {"created": _now_iso(), "version": "2.0", "updated": _now_iso(), "type": "archive"}}


@contextmanager
def _noop_lock():
    """No-op context manager to replace _file_lock."""
    yield


def _make_archive_args(days=7, dry_run=False):
    return argparse.Namespace(days=days, dry_run=dry_run)


def _make_show_args(item_id, json_out=False, archive=False):
    return argparse.Namespace(id=item_id, json=json_out, archive=archive)


# ── Dry-run accuracy ────────────────────────────────────────────────────────

class TestArchiveDryRun(unittest.TestCase):

    @patch("amauta._file_lock", new=_noop_lock)
    @patch("amauta.save")
    @patch("amauta._save_archive")
    @patch("amauta.load")
    def test_archive_dry_run_prints_candidates_without_mutation(self, mock_load, mock_save_arch, mock_save):
        """Dry-run lists old done tasks but never calls save() or _save_archive()."""
        tasks = [
            _make_task("TK-OLD1", days_ago=10),
            _make_task("TK-OLD2", days_ago=15),
            _make_task("TK-NEW", days_ago=2),
        ]
        mock_load.return_value = _make_data(tasks)

        amauta.cmd_archive(_make_archive_args(days=7, dry_run=True))

        mock_save.assert_not_called()
        mock_save_arch.assert_not_called()

    @patch("amauta._file_lock", new=_noop_lock)
    @patch("amauta.save")
    @patch("amauta.load")
    def test_archive_dry_run_no_candidates_prints_nothing(self, mock_load, mock_save):
        """Dry-run with no eligible tasks prints 'No done tasks' message."""
        tasks = [_make_task("TK-RECENT", days_ago=2)]
        mock_load.return_value = _make_data(tasks)

        amauta.cmd_archive(_make_archive_args(days=7, dry_run=True))

        mock_save.assert_not_called()


# ── Age threshold ────────────────────────────────────────────────────────────

class TestArchiveAgeThreshold(unittest.TestCase):

    @patch("amauta._file_lock", new=_noop_lock)
    @patch("amauta._save_archive")
    @patch("amauta._load_archive")
    @patch("amauta.save")
    @patch("amauta.load")
    def test_archive_days_7_filters_recent(self, mock_load, mock_save, mock_load_arch, mock_save_arch):
        """Only tasks done > 7 days ago get archived; recent ones stay."""
        tasks = [
            _make_task("TK-3D", days_ago=3),   # too recent
            _make_task("TK-10D", days_ago=10),  # old enough
        ]
        mock_load.return_value = _make_data(tasks)
        mock_load_arch.return_value = _empty_archive()

        amauta.cmd_archive(_make_archive_args(days=7))

        # save() should have been called with TK-3D still in items
        saved_data = mock_save.call_args[0][0]
        remaining_ids = [i["id"] for i in saved_data["items"]]
        self.assertIn("TK-3D", remaining_ids)
        self.assertNotIn("TK-10D", remaining_ids)

    @patch("amauta._file_lock", new=_noop_lock)
    @patch("amauta._save_archive")
    @patch("amauta._load_archive")
    @patch("amauta.save")
    @patch("amauta.load")
    def test_archive_days_0_archives_all_done(self, mock_load, mock_save, mock_load_arch, mock_save_arch):
        """days=0 archives ALL done tasks regardless of age."""
        tasks = [
            _make_task("TK-A", days_ago=0),
            _make_task("TK-B", days_ago=0),
        ]
        # Make sure updated_at is at least a bit in the past so age >= 0
        for t in tasks:
            t["updated_at"] = _ago_iso(minutes=1)
        mock_load.return_value = _make_data(tasks)
        mock_load_arch.return_value = _empty_archive()

        amauta.cmd_archive(_make_archive_args(days=0))

        saved_data = mock_save.call_args[0][0]
        self.assertEqual(len(saved_data["items"]), 0, "All done tasks should be removed from active")

    @patch("amauta._file_lock", new=_noop_lock)
    @patch("amauta.save")
    @patch("amauta.load")
    def test_archive_ignores_non_done_status(self, mock_load, mock_save):
        """Tasks with status != 'done' are never archived, even if old."""
        tasks = [
            _make_task("TK-IP", status="in-progress", days_ago=30),
            _make_task("TK-PEN", status="pending", days_ago=60),
        ]
        mock_load.return_value = _make_data(tasks)

        amauta.cmd_archive(_make_archive_args(days=0))

        mock_save.assert_not_called()


# ── Daemon mirror / archive persistence ──────────────────────────────────────

class TestArchivePersistence(unittest.TestCase):

    @patch("amauta._file_lock", new=_noop_lock)
    @patch("amauta._save_archive")
    @patch("amauta._load_archive")
    @patch("amauta.save")
    @patch("amauta.load")
    def test_archive_saves_to_archive_file(self, mock_load, mock_save, mock_load_arch, mock_save_arch):
        """Eligible tasks are appended to archive file."""
        tasks = [
            _make_task("TK-X1", days_ago=10),
            _make_task("TK-X2", days_ago=12),
        ]
        mock_load.return_value = _make_data(tasks)
        mock_load_arch.return_value = _empty_archive()

        amauta.cmd_archive(_make_archive_args(days=7))

        arch_data = mock_save_arch.call_args[0][0]
        arch_ids = [i["id"] for i in arch_data["items"]]
        self.assertIn("TK-X1", arch_ids)
        self.assertIn("TK-X2", arch_ids)

    @patch("amauta._file_lock", new=_noop_lock)
    @patch("amauta._save_archive")
    @patch("amauta._load_archive")
    @patch("amauta.save")
    @patch("amauta.load")
    def test_archive_idempotent_no_duplicates(self, mock_load, mock_save, mock_load_arch, mock_save_arch):
        """If a task is already in the archive, it is not appended again."""
        existing_task = _make_task("TK-DUP", days_ago=10)
        tasks = [_make_task("TK-DUP", days_ago=10)]
        mock_load.return_value = _make_data(tasks)
        archive = _empty_archive()
        archive["items"].append(existing_task)
        mock_load_arch.return_value = archive

        amauta.cmd_archive(_make_archive_args(days=7))

        arch_data = mock_save_arch.call_args[0][0]
        dup_count = sum(1 for i in arch_data["items"] if i["id"] == "TK-DUP")
        self.assertEqual(dup_count, 1, "Duplicate should not be appended")


# ── Genealogy update -- FIX-09 ──────────────────────────────────────────────

class TestArchiveGenealogy(unittest.TestCase):

    @patch("amauta._file_lock", new=_noop_lock)
    @patch("amauta._save_archive")
    @patch("amauta._load_archive")
    @patch("amauta.save")
    @patch("amauta.load")
    def test_archive_removes_child_from_parent_children(self, mock_load, mock_save, mock_load_arch, mock_save_arch):
        """Archiving TK-01 removes it from parent EP-01's children array."""
        parent = {
            "id": "EP-01", "type": "epic", "title": "Parent epic",
            "status": "in-progress", "children": ["TK-01", "TK-02"],
            "updated_at": _ago_iso(days=1),
        }
        child = _make_task("TK-01", days_ago=10)
        mock_load.return_value = _make_data([parent, child])
        mock_load_arch.return_value = _empty_archive()

        amauta.cmd_archive(_make_archive_args(days=7))

        saved = mock_save.call_args[0][0]
        remaining_parent = next(i for i in saved["items"] if i["id"] == "EP-01")
        self.assertEqual(remaining_parent["children"], ["TK-02"])

    @patch("amauta._file_lock", new=_noop_lock)
    @patch("amauta._save_archive")
    @patch("amauta._load_archive")
    @patch("amauta.save")
    @patch("amauta.load")
    def test_archive_parent_without_children_key_unaffected(self, mock_load, mock_save, mock_load_arch, mock_save_arch):
        """Parent without 'children' key does not raise KeyError."""
        parent = {
            "id": "EP-02", "type": "epic", "title": "Parent no children key",
            "status": "in-progress",
            "updated_at": _ago_iso(days=1),
        }
        child = _make_task("TK-CHILD", days_ago=10)
        mock_load.return_value = _make_data([parent, child])
        mock_load_arch.return_value = _empty_archive()

        # Should not raise
        amauta.cmd_archive(_make_archive_args(days=7))

        saved = mock_save.call_args[0][0]
        remaining_parent = next(i for i in saved["items"] if i["id"] == "EP-02")
        self.assertNotIn("children", remaining_parent)


# ── Show --archive fallback ─────────────────────────────────────────────────

class TestShowArchiveFallback(unittest.TestCase):

    @patch("amauta._print_item_full")
    @patch("amauta._load_archive")
    @patch("amauta.load")
    def test_show_falls_back_to_archive(self, mock_load, mock_load_arch, mock_print):
        """cmd_show finds task in archive when not in active items."""
        mock_load.return_value = _make_data([])
        archived_task = _make_task("TK-ARCH", days_ago=30)
        archive = _empty_archive()
        archive["items"].append(archived_task)
        mock_load_arch.return_value = archive

        args = _make_show_args("TK-ARCH")
        amauta.cmd_show(args)

        # _print_item_full should have been called with the archived task
        mock_print.assert_called_once()
        printed_item = mock_print.call_args[0][0]
        self.assertEqual(printed_item["id"], "TK-ARCH")

    @patch("amauta._load_archive")
    @patch("amauta.load")
    def test_show_archive_not_found_exits_1(self, mock_load, mock_load_arch):
        """Task not in active or archive triggers sys.exit(1)."""
        mock_load.return_value = _make_data([])
        mock_load_arch.return_value = _empty_archive()

        args = _make_show_args("TK-GHOST")
        with self.assertRaises(SystemExit) as ctx:
            amauta.cmd_show(args)
        self.assertEqual(ctx.exception.code, 1)


if __name__ == "__main__":
    unittest.main()

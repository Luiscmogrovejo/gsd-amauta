#!/usr/bin/env python3
"""Tests for RLM incremental indexing (MtimeIndex class).

Verifies that the mtime index correctly tracks file changes,
persists across reloads, and prunes stale entries.

Run: python3 tests/test_rlm_incremental.py
"""
import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest

# Prevent module-level side effects during import
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"

# Import MtimeIndex from rlm-service.py (hyphenated filename needs importlib)
_rlm_path = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "services", "rlm-service.py"
)
_spec = importlib.util.spec_from_file_location("rlm_service", _rlm_path)
_rlm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rlm)
MtimeIndex = _rlm.MtimeIndex


class TestMtimeIndex(unittest.TestCase):
    """Tests for the MtimeIndex persistent file modification tracker."""

    def setUp(self):
        """Create a temp directory for each test."""
        self._tmpdir = tempfile.mkdtemp()
        self._index_path = os.path.join(self._tmpdir, "test-index.json")

    def tearDown(self):
        """Clean up temp files."""
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _make_file(self, name, content="hello"):
        """Create a temp file and return its path."""
        fpath = os.path.join(self._tmpdir, name)
        with open(fpath, "w") as f:
            f.write(content)
        return fpath

    # ── Core behavior tests ───────────────────────────────────────────────

    def test_new_file_is_changed(self):
        """A file not in the index should be reported as changed."""
        idx = MtimeIndex(index_path=self._index_path)
        fpath = self._make_file("new.py")
        self.assertTrue(idx.is_changed(fpath))

    def test_update_marks_unchanged(self):
        """After update(), the same file should be reported as unchanged."""
        idx = MtimeIndex(index_path=self._index_path)
        fpath = self._make_file("tracked.py")
        idx.update(fpath)
        self.assertFalse(idx.is_changed(fpath))

    def test_modified_file_detected(self):
        """Changing a file's mtime should make is_changed return True."""
        idx = MtimeIndex(index_path=self._index_path)
        fpath = self._make_file("modify.py", "original")
        idx.update(fpath)
        self.assertFalse(idx.is_changed(fpath))

        # Wait briefly and rewrite to change mtime
        time.sleep(0.05)
        with open(fpath, "w") as f:
            f.write("modified content")
        self.assertTrue(idx.is_changed(fpath))

    def test_persist_and_reload(self):
        """Index should survive save/reload cycle."""
        idx1 = MtimeIndex(index_path=self._index_path)
        fpath = self._make_file("persist.py")
        idx1.update(fpath)
        idx1.save_if_dirty()

        # Create a new instance from the same file
        idx2 = MtimeIndex(index_path=self._index_path)
        self.assertFalse(idx2.is_changed(fpath))
        self.assertEqual(idx2.size, 1)

    def test_prune_removes_stale(self):
        """Prune should remove entries for files not in the existing_files set."""
        idx = MtimeIndex(index_path=self._index_path)
        f1 = self._make_file("keep.py")
        f2 = self._make_file("stale.py")
        idx.update(f1)
        idx.update(f2)
        self.assertEqual(idx.size, 2)

        # Prune with only f1 in the existing set
        idx.prune({f1})
        self.assertEqual(idx.size, 1)
        self.assertFalse(idx.is_changed(f1))
        self.assertTrue(idx.is_changed(f2))  # was removed, now "new"

    def test_empty_index_size(self):
        """A fresh index should have size 0."""
        idx = MtimeIndex(index_path=self._index_path)
        self.assertEqual(idx.size, 0)

    def test_nonexistent_file(self):
        """is_changed for a nonexistent file should return True."""
        idx = MtimeIndex(index_path=self._index_path)
        self.assertTrue(idx.is_changed("/nonexistent/path/file.py"))

    def test_save_creates_directory(self):
        """save_if_dirty should create parent directories if they don't exist."""
        nested_path = os.path.join(self._tmpdir, "deep", "nested", "index.json")
        idx = MtimeIndex(index_path=nested_path)
        fpath = self._make_file("nested.py")
        idx.update(fpath)
        idx.save_if_dirty()
        self.assertTrue(os.path.exists(nested_path))

        # Verify the saved content is valid JSON
        with open(nested_path, "r") as f:
            data = json.load(f)
        self.assertIn(fpath, data)

    def test_multiple_updates_track_latest(self):
        """Multiple updates to the same file should track the latest mtime."""
        idx = MtimeIndex(index_path=self._index_path)
        fpath = self._make_file("multi.py", "v1")
        idx.update(fpath)
        self.assertFalse(idx.is_changed(fpath))

        time.sleep(0.05)
        with open(fpath, "w") as f:
            f.write("v2")
        self.assertTrue(idx.is_changed(fpath))

        idx.update(fpath)
        self.assertFalse(idx.is_changed(fpath))
        self.assertEqual(idx.size, 1)

    def test_corrupted_index_file(self):
        """A corrupted index file should be handled gracefully."""
        with open(self._index_path, "w") as f:
            f.write("not valid json {{{")
        idx = MtimeIndex(index_path=self._index_path)
        self.assertEqual(idx.size, 0)  # Should start fresh


if __name__ == "__main__":
    unittest.main()

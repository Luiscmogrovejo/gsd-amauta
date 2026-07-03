#!/usr/bin/env python3
"""Tests for RLM incremental indexing (SHA-256 staleness authority).

Phase 65 / RETR-04: the persistent mtime-based index class was retired.
SHA-256 (services.rlm_ingestion.file_sha256 / is_stale) is now the SINGLE
staleness authority across every path (hybrid ingest + legacy fallback).
This module verifies that authority directly against a fake PG connection,
and asserts the retired index no longer exists anywhere in rlm-service.py.

Run: python3 -m pytest tests/test_rlm_incremental.py -v
"""
import importlib.util
import os
import tempfile
import unittest

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"

from services.rlm_ingestion import file_sha256, is_stale  # noqa: E402


class _FakeCursor:
    """Minimal cursor context manager returning a single configurable row."""

    def __init__(self, row):
        self._row = row

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, query, params=None):
        self._executed = (query, params)

    def fetchone(self):
        return self._row


class _FakePgConn:
    """Fake psycopg2-like connection whose cursor() always returns the
    same configured row for is_stale()'s SELECT sha256 ... LIMIT 1 query."""

    def __init__(self, stored_sha=None):
        self._row = (stored_sha,) if stored_sha is not None else None

    def cursor(self):
        return _FakeCursor(self._row)


class TestFileSha256(unittest.TestCase):
    """Tests for the surviving staleness primitive: file_sha256()."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _make_file(self, name, content="hello"):
        fpath = os.path.join(self._tmpdir, name)
        with open(fpath, "w") as f:
            f.write(content)
        return fpath

    def test_missing_file_returns_empty_string(self):
        """file_sha256 returns '' for a missing file (RETR-04 requirement e)."""
        result = file_sha256(os.path.join(self._tmpdir, "does-not-exist.py"))
        self.assertEqual(result, "")

    def test_same_content_same_sha(self):
        """Identical content produces identical sha256 across two files."""
        f1 = self._make_file("a.py", "identical content")
        f2 = self._make_file("b.py", "identical content")
        self.assertEqual(file_sha256(f1), file_sha256(f2))

    def test_different_content_different_sha(self):
        f1 = self._make_file("a.py", "content one")
        f2 = self._make_file("b.py", "content two")
        self.assertNotEqual(file_sha256(f1), file_sha256(f2))


class TestIsStale(unittest.TestCase):
    """Tests for is_stale() against a fake PG connection (RETR-04 requirements a-d)."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _make_file(self, name, content="hello"):
        fpath = os.path.join(self._tmpdir, name)
        with open(fpath, "w") as f:
            f.write(content)
        return fpath

    def test_unindexed_file_is_stale(self):
        """(a) fetchone() returns None (never indexed) -- file is stale."""
        fpath = self._make_file("new.py")
        pg = _FakePgConn(stored_sha=None)
        self.assertTrue(is_stale(fpath, pg))

    def test_matching_sha_with_char64_padding_is_not_stale(self):
        """(b) stored sha256 matches current content, including CHAR(64)
        trailing-space padding -- file is NOT stale."""
        fpath = self._make_file("tracked.py", "def zz(): pass")
        current_sha = file_sha256(fpath)
        padded_sha = current_sha + "   "  # simulate CHAR(64) trailing-space padding
        pg = _FakePgConn(stored_sha=padded_sha)
        self.assertFalse(is_stale(fpath, pg))

    def test_content_change_flips_stale_true(self):
        """(c) stored sha256 no longer matches current content -- stale flips True."""
        fpath = self._make_file("modify.py", "original content")
        original_sha = file_sha256(fpath)
        pg_before = _FakePgConn(stored_sha=original_sha)
        self.assertFalse(is_stale(fpath, pg_before))

        with open(fpath, "w") as f:
            f.write("modified content")

        pg_after = _FakePgConn(stored_sha=original_sha)  # PG still has the OLD sha
        self.assertTrue(is_stale(fpath, pg_after))

    def test_unreadable_path_is_stale(self):
        """(d) an unreadable/nonexistent path is treated as stale (file_sha256 -> '')."""
        pg = _FakePgConn(stored_sha="anything")
        self.assertTrue(is_stale("/nonexistent/path/file.py", pg))


class TestMtimeIndexFullyRetired(unittest.TestCase):
    """(f) RETR-04: the persistent mtime-based index class must no longer
    exist anywhere in rlm-service.py -- SHA-256 governs all paths."""

    def test_mtime_index_fully_retired(self):
        rlm_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "services", "rlm-service.py"
        )
        with open(rlm_path, "r") as f:
            src = f.read()
        self.assertNotIn("MtimeIndex", src)
        self.assertNotIn("MTIME_INDEX", src)


if __name__ == "__main__":
    unittest.main()

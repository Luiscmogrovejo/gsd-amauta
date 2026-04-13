#!/usr/bin/env python3
"""Tests for ContextValidator — hash-based staleness detection.

Phase 21 / STALE-01 + STALE-02 + STALE-03.
Run: pytest tests/test_context_validator.py -v
"""

import hashlib
import os
import tempfile
import pytest
from unittest.mock import patch, MagicMock


# ── STALE-01: compute_file_hash Tests ──

class TestComputeFileHash:

    def test_hash_is_sha256_hex_64_chars(self):
        """compute_file_hash returns a 64-char hex string."""
        from services.context_validator import ContextValidator
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            f.write(b"test content for hashing")
            f.flush()
            path = f.name
        try:
            h = ContextValidator.compute_file_hash(path)
            assert h is not None
            assert len(h) == 64
            assert all(c in "0123456789abcdef" for c in h)
        finally:
            os.unlink(path)

    def test_hash_matches_manual_sha256(self):
        """Hash matches independently computed SHA-256."""
        from services.context_validator import ContextValidator
        content = b"deterministic content for verification"
        expected = hashlib.sha256(content).hexdigest()
        with tempfile.NamedTemporaryFile(delete=False, suffix=".py") as f:
            f.write(content)
            f.flush()
            path = f.name
        try:
            assert ContextValidator.compute_file_hash(path) == expected
        finally:
            os.unlink(path)

    def test_hash_stable_when_file_unchanged(self):
        """Same file content produces same hash on repeated calls."""
        from services.context_validator import ContextValidator
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            f.write(b"stable content")
            f.flush()
            path = f.name
        try:
            h1 = ContextValidator.compute_file_hash(path)
            h2 = ContextValidator.compute_file_hash(path)
            assert h1 == h2
        finally:
            os.unlink(path)

    def test_hash_changes_when_file_modified(self):
        """Modifying file content produces a different hash."""
        from services.context_validator import ContextValidator
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt", mode="wb") as f:
            f.write(b"original content")
            f.flush()
            path = f.name
        try:
            h1 = ContextValidator.compute_file_hash(path)
            with open(path, "wb") as f:
                f.write(b"modified content")
            h2 = ContextValidator.compute_file_hash(path)
            assert h1 != h2
        finally:
            os.unlink(path)

    def test_hash_returns_none_for_nonexistent_file(self):
        """Nonexistent file returns None, not an exception."""
        from services.context_validator import ContextValidator
        assert ContextValidator.compute_file_hash("/nonexistent/path/file.txt") is None

    def test_compute_file_hashes_batch(self):
        """compute_file_hashes returns dict for multiple files, skipping unreadable."""
        from services.context_validator import ContextValidator
        paths = []
        try:
            for i in range(3):
                with tempfile.NamedTemporaryFile(delete=False, suffix=f"_{i}.txt") as f:
                    f.write(f"content {i}".encode())
                    f.flush()
                    paths.append(f.name)
            # Add a nonexistent path
            all_paths = paths + ["/nonexistent/path.txt"]
            result = ContextValidator.compute_file_hashes(all_paths)
            assert len(result) == 3  # Only the 3 real files
            for p in paths:
                assert p in result
                assert len(result[p]) == 64
            assert "/nonexistent/path.txt" not in result
        finally:
            for p in paths:
                os.unlink(p)


# ── STALE-02: changed_since Tests ──

class TestChangedSince:

    def test_no_commit_ref_returns_all_files(self):
        """Missing commit_ref means all files are considered changed."""
        from services.context_validator import ContextValidator
        context = {
            "file_hashes": {"a.py": "abc123", "b.py": "def456"},
            "commit_ref": "",
        }
        result = ContextValidator.changed_since(context)
        assert set(result) == {"a.py", "b.py"}

    def test_empty_file_hashes_returns_empty(self):
        """No tracked files means nothing to check."""
        from services.context_validator import ContextValidator
        context = {"file_hashes": {}, "commit_ref": "abc123"}
        assert ContextValidator.changed_since(context) == []

    @patch("services.context_validator.subprocess.run")
    def test_git_diff_returns_changed_files(self, mock_run):
        """Git diff output is intersected with file_hashes keys."""
        from services.context_validator import ContextValidator
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="a.py\nc.py\nuntracked.py\n",
        )
        context = {
            "file_hashes": {"a.py": "hash_a", "b.py": "hash_b", "c.py": "hash_c"},
            "commit_ref": "abc123def456",
        }
        result = ContextValidator.changed_since(context)
        # a.py and c.py are in both git diff AND file_hashes
        # untracked.py is in git diff but NOT in file_hashes — excluded
        # b.py is in file_hashes but NOT in git diff — not changed
        assert set(result) == {"a.py", "c.py"}
        mock_run.assert_called_once()
        call_args = mock_run.call_args
        assert "git" in call_args[0][0]
        assert "diff" in call_args[0][0]
        assert "--name-only" in call_args[0][0]
        assert "abc123def456" in call_args[0][0]

    @patch("services.context_validator.subprocess.run")
    def test_git_diff_failure_returns_all(self, mock_run):
        """Git diff failure treats all files as changed (safe fallback)."""
        from services.context_validator import ContextValidator
        mock_run.return_value = MagicMock(returncode=128, stderr="fatal: bad revision")
        context = {
            "file_hashes": {"a.py": "hash_a", "b.py": "hash_b"},
            "commit_ref": "bad_ref",
        }
        result = ContextValidator.changed_since(context)
        assert set(result) == {"a.py", "b.py"}


# ── STALE-03: selective_refresh Tests ──

class TestSelectiveRefresh:

    def test_10_files_2_stale_refreshes_exactly_2(self):
        """In a 10-file context where 2 are stale, description_fn is called exactly 2 times."""
        from services.context_validator import ContextValidator
        # Create 10 temp files
        paths = []
        try:
            for i in range(10):
                with tempfile.NamedTemporaryFile(delete=False, suffix=f"_{i}.txt") as f:
                    f.write(f"content {i}".encode())
                    f.flush()
                    paths.append(f.name)

            file_hashes = {p: ContextValidator.compute_file_hash(p) for p in paths}
            file_descriptions = {p: f"description for file {i}" for i, p in enumerate(paths)}
            context = {
                "file_hashes": file_hashes,
                "file_descriptions": file_descriptions,
            }

            # Mark 2 files as stale
            stale = [paths[0], paths[5]]
            call_count = {"n": 0}

            def mock_description_fn(path):
                call_count["n"] += 1
                return f"NEW description for {path}"

            result = ContextValidator.selective_refresh(context, stale, mock_description_fn)

            assert call_count["n"] == 2
            assert result["refreshed_count"] == 2
            assert result["cached_count"] == 8

            # Stale files got new descriptions
            assert result["file_descriptions"][paths[0]].startswith("NEW description")
            assert result["file_descriptions"][paths[5]].startswith("NEW description")

            # Unchanged files retained original descriptions
            for i in [1, 2, 3, 4, 6, 7, 8, 9]:
                assert result["file_descriptions"][paths[i]] == f"description for file {i}"
        finally:
            for p in paths:
                os.unlink(p)

    def test_no_stale_files_calls_description_fn_zero_times(self):
        """When no files are stale, description_fn is never called."""
        from services.context_validator import ContextValidator
        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            f.write(b"content")
            f.flush()
            path = f.name
        try:
            context = {
                "file_hashes": {path: ContextValidator.compute_file_hash(path)},
                "file_descriptions": {path: "cached desc"},
            }
            call_count = {"n": 0}

            def mock_fn(p):
                call_count["n"] += 1
                return "should not be called"

            result = ContextValidator.selective_refresh(context, [], mock_fn)
            assert call_count["n"] == 0
            assert result["refreshed_count"] == 0
            assert result["cached_count"] == 1
            assert result["file_descriptions"][path] == "cached desc"
        finally:
            os.unlink(path)

    def test_stale_log_line_emitted(self):
        """The [STALE] log line is emitted during selective_refresh."""
        from services.context_validator import ContextValidator
        import logging

        with tempfile.NamedTemporaryFile(delete=False, suffix=".txt") as f:
            f.write(b"content")
            f.flush()
            path = f.name
        try:
            context = {
                "file_hashes": {path: "old_hash"},
                "file_descriptions": {path: "old desc"},
            }
            with patch("services.context_validator.log") as mock_log:
                ContextValidator.selective_refresh(context, [path], lambda p: "new desc")
                # Verify the [STALE] log line was emitted
                mock_log.info.assert_called()
                log_msg = mock_log.info.call_args[0][0]
                assert "[STALE]" in log_msg
        finally:
            os.unlink(path)

#!/usr/bin/env python3
"""Integration tests for ContextValidator staleness detection pipeline.

Phase 21 / STALE-04.
Run: pytest tests/test_context_validator_integration.py -v
"""

import hashlib
import os
import tempfile
import pytest
from unittest.mock import MagicMock, patch


# ── validate_context orchestration Tests (STALE-04) ──

class TestValidateContext:

    def test_no_pg_store_returns_empty(self):
        """validate_context with no PGStore returns empty result."""
        from services.context_validator import validate_context
        result = validate_context("TK-001", "P", pg_store=None)
        assert result["had_prior_context"] is False
        assert result["changed_files"] == []
        assert result["refreshed_count"] == 0

    def test_r_phase_has_no_prior(self):
        """R phase has no prior phase to look up — returns empty."""
        from services.context_validator import validate_context
        mock_store = MagicMock()
        result = validate_context("TK-001", "R", pg_store=mock_store)
        assert result["had_prior_context"] is False
        mock_store.rpetd_context_get.assert_not_called()

    def test_p_phase_looks_up_r_context(self):
        """P phase looks up R phase context for staleness check."""
        from services.context_validator import validate_context
        mock_store = MagicMock()
        mock_store.rpetd_context_get.return_value = None  # No R context stored
        result = validate_context("TK-001", "P", pg_store=mock_store)
        mock_store.rpetd_context_get.assert_called_once_with("TK-001", "R")
        assert result["had_prior_context"] is False

    @patch("services.context_validator.subprocess.run")
    def test_with_stored_context_and_no_changes(self, mock_run):
        """When git diff shows no changes, all files are cached."""
        from services.context_validator import validate_context
        mock_run.return_value = MagicMock(returncode=0, stdout="")
        mock_store = MagicMock()
        mock_store.rpetd_context_get.return_value = {
            "file_hashes": {
                "a.py": "hash_a",
                "b.py": "hash_b",
                "__commit_ref__": "abc123",
            },
            "compiled_view": {
                "file_descriptions": {"a.py": "desc a", "b.py": "desc b"},
            },
        }
        result = validate_context("TK-001", "E", pg_store=mock_store)
        assert result["had_prior_context"] is True
        assert result["changed_files"] == []
        assert result["cached_count"] == 2
        assert result["refreshed_count"] == 0

    @patch("services.context_validator.subprocess.run")
    def test_with_stored_context_and_changes(self, mock_run):
        """When git diff shows changes, only changed files are refreshed."""
        from services.context_validator import validate_context, ContextValidator

        # Create a real temp file for a.py to make compute_file_hash work
        with tempfile.NamedTemporaryFile(delete=False, suffix="_a.py") as f:
            f.write(b"new content for a")
            f.flush()
            real_path = f.name

        # Mock git diff to return real_path as a changed file
        mock_run.return_value = MagicMock(returncode=0, stdout=real_path + "\n")

        try:
            mock_store = MagicMock()
            mock_store.rpetd_context_get.return_value = {
                "file_hashes": {
                    real_path: "old_hash_a",
                    "b.py": "hash_b",
                    "__commit_ref__": "abc123",
                },
                "compiled_view": {
                    "file_descriptions": {real_path: "old desc a", "b.py": "desc b"},
                },
            }
            result = validate_context(
                "TK-001", "E",
                pg_store=mock_store,
                description_fn=lambda p: f"NEW desc for {p}",
            )
            assert result["had_prior_context"] is True
            assert real_path in result["changed_files"]
            assert result["refreshed_count"] == 1
            assert result["cached_count"] == 1
        finally:
            os.unlink(real_path)


# ── End-to-end staleness flow (STALE-03 + STALE-04 combined) ──

class TestEndToEndStaleness:

    @patch("services.context_validator.subprocess.run")
    def test_10_files_2_changed_end_to_end(self, mock_run):
        """Full pipeline: 10 files, 2 changed by git diff, exactly 2 refreshed."""
        from services.context_validator import validate_context, ContextValidator

        # Create 10 temp files
        paths = []
        try:
            for i in range(10):
                with tempfile.NamedTemporaryFile(delete=False, suffix=f"_{i}.py") as f:
                    f.write(f"content {i}".encode())
                    f.flush()
                    paths.append(f.name)

            # Build stored context with hashes for all 10 files
            file_hashes = {}
            file_descriptions = {}
            for i, p in enumerate(paths):
                file_hashes[p] = ContextValidator.compute_file_hash(p)
                file_descriptions[p] = f"original description {i}"
            file_hashes["__commit_ref__"] = "prior_commit_sha"

            # Mock git diff to say files 3 and 7 changed
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout=f"{paths[3]}\n{paths[7]}\n",
            )

            mock_store = MagicMock()
            mock_store.rpetd_context_get.return_value = {
                "file_hashes": dict(file_hashes),
                "compiled_view": {"file_descriptions": dict(file_descriptions)},
            }

            call_count = {"n": 0}
            def counting_description_fn(path):
                call_count["n"] += 1
                return f"REFRESHED description for {path}"

            result = validate_context(
                "TK-E2E", "P",
                pg_store=mock_store,
                description_fn=counting_description_fn,
            )

            # Exactly 2 files refreshed, 8 cached
            assert result["refreshed_count"] == 2
            assert result["cached_count"] == 8
            assert call_count["n"] == 2

            # Changed files identified correctly
            assert set(result["changed_files"]) == {paths[3], paths[7]}

            # Refreshed files got new descriptions
            assert "REFRESHED" in result["file_descriptions"][paths[3]]
            assert "REFRESHED" in result["file_descriptions"][paths[7]]

            # Unchanged files retained original descriptions
            for i in [0, 1, 2, 4, 5, 6, 8, 9]:
                assert result["file_descriptions"][paths[i]] == f"original description {i}"

        finally:
            for p in paths:
                os.unlink(p)

    def test_stale_log_line_in_validate_context(self):
        """The [STALE] log line appears during validate_context execution."""
        from services.context_validator import validate_context

        with tempfile.NamedTemporaryFile(delete=False, suffix=".py") as f:
            f.write(b"test content")
            f.flush()
            path = f.name
        try:
            mock_store = MagicMock()
            mock_store.rpetd_context_get.return_value = {
                "file_hashes": {path: "old_hash", "__commit_ref__": ""},
                "compiled_view": {"file_descriptions": {path: "old desc"}},
            }

            with patch("services.context_validator.log") as mock_log:
                validate_context("TK-LOG", "P", pg_store=mock_store)
                # Check that [STALE] log line was emitted
                info_calls = [str(c) for c in mock_log.info.call_args_list]
                stale_calls = [c for c in info_calls if "STALE" in c]
                assert len(stale_calls) >= 1, f"Expected [STALE] log line, got: {info_calls}"
        finally:
            os.unlink(path)

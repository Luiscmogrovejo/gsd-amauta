#!/usr/bin/env python3
"""Tests for RPETDContext model and PGStore rpetd_context methods.

Phase 20 / HANDOFF-01 + HANDOFF-03.
Run: pytest tests/test_rpetd_context.py -v
"""

import json
import hashlib
import pytest
from unittest.mock import MagicMock, patch

# ── RPETDContext Model Tests (HANDOFF-01) ──

class TestRPETDContextModel:

    def test_construction_with_all_fields(self):
        """Model accepts all 8 fields and stores them."""
        from services.rpetd_context import RPETDContext
        ctx = RPETDContext(
            task_id="TK-001",
            original_intent="Fix the login bug",
            completed_work=["R: analyzed auth.py"],
            current_state={"auth.py": "modified"},
            active_constraints=["scope ceiling: 40 LOC"],
            relevant_files=["auth.py", "tests/test_auth.py"],
            next_actions=["implement fix"],
            context_version="will-be-overwritten",
        )
        assert ctx.task_id == "TK-001"
        assert ctx.original_intent == "Fix the login bug"
        assert ctx.completed_work == ["R: analyzed auth.py"]
        assert ctx.current_state == {"auth.py": "modified"}
        assert ctx.active_constraints == ["scope ceiling: 40 LOC"]
        assert ctx.relevant_files == ["auth.py", "tests/test_auth.py"]
        assert ctx.next_actions == ["implement fix"]
        # context_version is auto-computed (not the passed value)
        assert len(ctx.context_version) == 64

    def test_construction_with_minimal_fields(self):
        """Model works with only required fields (task_id, original_intent)."""
        from services.rpetd_context import RPETDContext
        ctx = RPETDContext(task_id="TK-002", original_intent="test intent")
        assert ctx.task_id == "TK-002"
        assert ctx.completed_work == []
        assert ctx.current_state == {}
        assert ctx.active_constraints == []
        assert ctx.relevant_files == []
        assert ctx.next_actions == []
        assert len(ctx.context_version) == 64

    def test_model_dump_round_trip(self):
        """model_dump() and from_compiled_view() round-trip without loss."""
        from services.rpetd_context import RPETDContext
        original = RPETDContext(
            task_id="TK-003",
            original_intent="Deploy the service",
            completed_work=["R: found 3 files", "P: created 2 tasks"],
            current_state={"deploy.yml": "created"},
            active_constraints=["no downtime"],
            relevant_files=["deploy.yml", "k8s/"],
            next_actions=["run integration tests"],
        )
        dumped = original.model_dump()
        restored = RPETDContext.from_compiled_view(dumped)
        assert restored.task_id == original.task_id
        assert restored.original_intent == original.original_intent
        assert restored.completed_work == original.completed_work
        assert restored.current_state == original.current_state
        assert restored.active_constraints == original.active_constraints
        assert restored.relevant_files == original.relevant_files
        assert restored.next_actions == original.next_actions
        # context_version recomputed on construction -- should match
        assert restored.context_version == original.context_version

    def test_context_version_is_sha256(self):
        """context_version is SHA-256 of the 7 non-version fields."""
        from services.rpetd_context import RPETDContext
        ctx = RPETDContext(task_id="TK-004", original_intent="hash test")
        payload = {
            "task_id": "TK-004",
            "original_intent": "hash test",
            "completed_work": [],
            "current_state": {},
            "active_constraints": [],
            "relevant_files": [],
            "next_actions": [],
        }
        expected = hashlib.sha256(
            json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        assert ctx.context_version == expected

    def test_context_version_changes_on_content_change(self):
        """Changing any field produces a different context_version."""
        from services.rpetd_context import RPETDContext
        ctx1 = RPETDContext(task_id="TK-005", original_intent="version A")
        ctx2 = RPETDContext(task_id="TK-005", original_intent="version B")
        assert ctx1.context_version != ctx2.context_version

    def test_validation_error_on_missing_required_fields(self):
        """Model raises ValidationError when task_id or original_intent missing."""
        from services.rpetd_context import RPETDContext
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            RPETDContext()  # missing task_id and original_intent
        with pytest.raises(ValidationError):
            RPETDContext(task_id="TK-006")  # missing original_intent

    def test_to_compiled_view(self):
        """to_compiled_view() returns a JSON-serializable dict."""
        from services.rpetd_context import RPETDContext
        ctx = RPETDContext(task_id="TK-007", original_intent="compile test")
        view = ctx.to_compiled_view()
        assert isinstance(view, dict)
        assert view["task_id"] == "TK-007"
        # Verify JSON serializable
        serialized = json.dumps(view)
        assert isinstance(serialized, str)


# ── PGStore rpetd_context Methods Tests (HANDOFF-03) ──

class TestPGStoreRPETDContext:

    def _make_mock_store(self):
        """Create a PGStore-like object with mocked PG connection."""
        import services.pg_store as pg_mod
        store = MagicMock(spec=pg_mod.PGStore)
        # Re-attach the real methods under test
        store.rpetd_context_store = pg_mod.PGStore.rpetd_context_store.__get__(store)
        store.rpetd_context_get = pg_mod.PGStore.rpetd_context_get.__get__(store)
        store.rpetd_context_list = pg_mod.PGStore.rpetd_context_list.__get__(store)
        return store

    def test_store_validates_phase(self):
        """rpetd_context_store rejects invalid phase letters."""
        store = self._make_mock_store()
        with pytest.raises(ValueError, match="Invalid RPETD phase"):
            store.rpetd_context_store("TK-001", "X", {"task_id": "TK-001"})

    def test_store_accepts_valid_phases(self):
        """rpetd_context_store accepts all 5 valid phases."""
        store = self._make_mock_store()
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = (42,)
        mock_conn.cursor.return_value.__enter__ = lambda s: mock_cursor
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        store._get_conn.return_value.__enter__ = lambda s: mock_conn
        store._get_conn.return_value.__exit__ = MagicMock(return_value=False)

        for phase in ('R', 'P', 'E', 'T', 'D'):
            result = store.rpetd_context_store("TK-001", phase, {"data": "test"})
            assert result == 42

    def test_get_returns_none_when_not_found(self):
        """rpetd_context_get returns None for nonexistent task+phase."""
        store = self._make_mock_store()
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchone.return_value = None
        mock_conn.cursor.return_value.__enter__ = lambda s: mock_cursor
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        store._get_conn.return_value.__enter__ = lambda s: mock_conn
        store._get_conn.return_value.__exit__ = MagicMock(return_value=False)

        result = store.rpetd_context_get("TK-999", "R")
        assert result is None

    def test_list_returns_empty_for_unknown_task(self):
        """rpetd_context_list returns [] for a task with no contexts."""
        store = self._make_mock_store()
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = []
        mock_conn.cursor.return_value.__enter__ = lambda s: mock_cursor
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        store._get_conn.return_value.__enter__ = lambda s: mock_conn
        store._get_conn.return_value.__exit__ = MagicMock(return_value=False)

        result = store.rpetd_context_list("TK-999")
        assert result == []

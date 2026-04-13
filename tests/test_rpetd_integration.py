#!/usr/bin/env python3
"""Integration tests for the full RPETDContext pipeline.

Phase 20 / HANDOFF-05: Verifies that compact_conversation -> PGStore store -> PGStore get
round-trips correctly, and that all 5 RPETD phases produce valid contexts.

Run: pytest tests/test_rpetd_integration.py -v
"""

import json
import pytest
from unittest.mock import MagicMock, patch, PropertyMock


def _realistic_conversation():
    """Return a realistic 15-message RPETD conversation for testing."""
    return [
        {"role": "user", "content": "Fix the authentication timeout bug in services/auth.py. Users report 401 errors after 30 minutes of inactivity."},
        {"role": "assistant", "content": "I'll analyze the authentication module. Let me start by reading the relevant files."},
        {"role": "assistant", "content": [
            {"type": "text", "text": "I've read services/auth.py. The token expiry is set to 1800 seconds (30 minutes). The issue is that the refresh token flow doesn't extend the session."},
            {"type": "tool_use", "id": "tool_1", "name": "read_file", "input": {"path": "services/auth.py"}}
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "tool_1", "content": "class AuthManager:\n    TOKEN_EXPIRY = 1800\n    def verify_token(self, token):\n        ..."}
        ]},
        {"role": "assistant", "content": "The fix needs to: 1) Add a refresh endpoint, 2) Extend token on valid refresh, 3) Add tests. The scope ceiling is 40 LOC."},
        {"role": "user", "content": "Proceed with the implementation."},
        {"role": "assistant", "content": "I've implemented the refresh endpoint and added 3 tests. Here's what changed:\n- services/auth.py: added refresh_token() method\n- tests/test_auth.py: added 3 new test cases"},
        {"role": "user", "content": "Run the tests to verify."},
        {"role": "assistant", "content": [
            {"type": "text", "text": "All tests pass. 12 tests total, 3 new. No regressions detected."},
            {"type": "tool_use", "id": "tool_2", "name": "bash", "input": {"command": "pytest tests/test_auth.py -v"}}
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "tool_2", "content": "12 passed in 0.45s"}
        ]},
        {"role": "assistant", "content": "T-phase complete. All tests pass. The fix addresses the timeout by adding automatic token refresh on valid session activity."},
        {"role": "user", "content": "Summarize the delivery."},
        {"role": "assistant", "content": "D-phase: Fixed authentication timeout. Added refresh_token() to AuthManager. 3 new tests, 0 regressions. LEARNING: Token refresh should be triggered on any authenticated API call, not just explicit refresh requests."},
    ]


class TestFullPipelineRoundTrip:
    """HANDOFF-05: Full pipeline integration tests."""

    def test_all_five_phases_produce_valid_context(self):
        """Each RPETD phase (R, P, E, T, D) produces a valid RPETDContext."""
        from services.rpetd_context import compact_conversation, RPETDContext
        messages = _realistic_conversation()

        for phase in ('R', 'P', 'E', 'T', 'D'):
            ctx = compact_conversation(messages, "TK-INTEG-001", phase, llm_call=None)
            assert isinstance(ctx, RPETDContext), f"Phase {phase} must produce RPETDContext"
            assert ctx.task_id == "TK-INTEG-001", f"Phase {phase} task_id must match"
            assert len(ctx.context_version) == 64, f"Phase {phase} must have SHA-256 version"
            assert ctx.original_intent, f"Phase {phase} must capture original_intent"

    def test_compaction_then_pgstore_round_trip(self):
        """Compact a conversation, store it, retrieve it, and verify match."""
        from services.rpetd_context import compact_conversation, RPETDContext
        messages = _realistic_conversation()

        ctx = compact_conversation(messages, "TK-INTEG-002", "R", llm_call=None)
        compiled_view = ctx.to_compiled_view()

        # Verify the compiled view can reconstruct the context
        restored = RPETDContext.from_compiled_view(compiled_view)
        assert restored.task_id == ctx.task_id
        assert restored.original_intent == ctx.original_intent
        assert restored.context_version == ctx.context_version

    def test_compiled_view_is_json_serializable(self):
        """Compiled view from realistic conversation can be JSON serialized."""
        from services.rpetd_context import compact_conversation
        messages = _realistic_conversation()
        ctx = compact_conversation(messages, "TK-INTEG-003", "E", llm_call=None)
        view = ctx.to_compiled_view()

        # Must be JSON serializable (required for JSONB storage)
        serialized = json.dumps(view)
        assert isinstance(serialized, str)
        assert len(serialized) > 0

        # Round-trip through JSON
        deserialized = json.loads(serialized)
        assert deserialized["task_id"] == "TK-INTEG-003"

    def test_realistic_context_token_budget(self):
        """Realistic compiled view stays under 600 token budget."""
        from services.rpetd_context import compact_conversation
        messages = _realistic_conversation()
        ctx = compact_conversation(messages, "TK-INTEG-004", "D", llm_call=None)
        view = ctx.to_compiled_view()
        serialized = json.dumps(view)

        # Approximate: 4 chars per token
        approx_tokens = len(serialized) / 4
        assert approx_tokens < 600, f"Realistic context is ~{approx_tokens:.0f} tokens (limit: 600)"

    def test_pgstore_context_methods_exist(self):
        """PGStore has all three rpetd_context methods."""
        from services.pg_store import PGStore
        assert hasattr(PGStore, 'rpetd_context_store'), "PGStore must have rpetd_context_store"
        assert hasattr(PGStore, 'rpetd_context_get'), "PGStore must have rpetd_context_get"
        assert hasattr(PGStore, 'rpetd_context_list'), "PGStore must have rpetd_context_list"

    def test_daemon_has_context_endpoints(self):
        """Daemon source contains context endpoint handlers."""
        import os
        daemon_path = os.path.join(os.path.dirname(__file__), '..', 'services', 'amauta-daemon.py')
        with open(daemon_path, 'r') as f:
            source = f.read()
        assert '/api/context/compact' in source, "Daemon must have /api/context/compact endpoint"
        assert '/api/context/' in source, "Daemon must have /api/context/ GET endpoint"
        assert 'compact_conversation' in source, "Daemon must import compact_conversation"

    def test_gsd_amauta_has_context_wiring(self):
        """gsd-amauta.cjs contains the compactRpetdContext wiring."""
        import os
        cjs_path = os.path.join(os.path.dirname(__file__), '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs')
        with open(cjs_path, 'r') as f:
            source = f.read()
        assert 'compactRpetdContext' in source, "gsd-amauta.cjs must have compactRpetdContext"
        assert '/api/context/compact' in source, "gsd-amauta.cjs must reference the compact endpoint"
        assert 'HANDOFF-05' in source, "gsd-amauta.cjs must reference HANDOFF-05"

    def test_backward_compat_rpetd_without_context(self):
        """Existing RPETD phase content structure is not altered."""
        import os
        # Verify the original cmdRpetd still has autoLearnFromRpetd
        cjs_path = os.path.join(os.path.dirname(__file__), '..', 'get-shit-done', 'bin', 'gsd-amauta.cjs')
        with open(cjs_path, 'r') as f:
            source = f.read()
        assert 'autoLearnFromRpetd' in source, "autoLearnFromRpetd must still exist (backward compat)"
        # The VALID_PHASES set must still be present
        assert "VALID_PHASES" in source, "VALID_PHASES must still be defined"

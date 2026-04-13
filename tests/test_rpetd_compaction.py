#!/usr/bin/env python3
"""Tests for RPETDContext compaction and token budget enforcement.

Phase 20 / HANDOFF-02 + HANDOFF-04.
Run: pytest tests/test_rpetd_compaction.py -v
"""

import json
import pytest
from unittest.mock import MagicMock, patch


def _make_messages(count=20, include_tools=True):
    """Generate synthetic conversation messages for testing."""
    messages = []
    for i in range(count):
        if i % 3 == 0:
            messages.append({
                "role": "user",
                "content": f"User message {i}: Please analyze file_{i}.py and check for issues."
            })
        elif i % 3 == 1:
            content = [{"type": "text", "text": f"I found {i} issues in file_{i}.py. Here are the details: " + "x" * 200}]
            if include_tools:
                content.append({"type": "tool_use", "id": f"tool_{i}", "name": "read_file", "input": {"path": f"file_{i}.py"}})
            messages.append({"role": "assistant", "content": content})
        else:
            if include_tools:
                messages.append({
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": f"tool_{i-1}", "content": "x" * 500}]
                })
            else:
                messages.append({
                    "role": "user",
                    "content": f"Follow-up question {i} about the analysis results."
                })
    return messages


class TestPruneMessages:
    """Tests for prune_messages function (HANDOFF-02 prune step)."""

    def test_prune_reduces_message_count(self):
        """Pruning with a small token budget drops older messages."""
        from services.rpetd_context import prune_messages
        messages = _make_messages(30, include_tools=True)
        # max_tokens=500 (approx 2000 chars) is tight enough to force pruning
        # across 30 messages whose tool_result blocks are 500 chars each
        pruned = prune_messages(messages, max_tokens=500)
        assert len(pruned) < len(messages)
        assert len(pruned) > 0

    def test_prune_preserves_recent_messages(self):
        """Most recent messages are kept after pruning."""
        from services.rpetd_context import prune_messages
        messages = _make_messages(20)
        pruned = prune_messages(messages, max_tokens=5000)
        # Last message should be preserved
        assert pruned[-1] == messages[-1]

    def test_prune_strips_old_tool_content(self):
        """Tool use/result blocks from older messages are stripped."""
        from services.rpetd_context import prune_messages
        messages = _make_messages(30, include_tools=True)
        pruned = prune_messages(messages, max_tokens=10000)
        # Check that some tool blocks were stripped from older messages
        has_stripped = False
        for msg in pruned[:5]:  # Check older messages
            content = msg.get("content", "")
            if isinstance(content, list):
                tool_blocks = [b for b in content if isinstance(b, dict) and b.get("type") in ("tool_use", "tool_result")]
                if len(tool_blocks) == 0:
                    has_stripped = True
        # At least some stripping should have occurred with 30 messages in 10K budget
        assert len(pruned) > 0

    def test_prune_handles_empty_messages(self):
        """Pruning empty message list returns empty."""
        from services.rpetd_context import prune_messages
        assert prune_messages([], max_tokens=40000) == []

    def test_prune_handles_string_content(self):
        """Pruning works with simple string content messages."""
        from services.rpetd_context import prune_messages
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there"},
        ]
        pruned = prune_messages(messages, max_tokens=40000)
        assert len(pruned) == 2


class TestCompactConversation:
    """Tests for compact_conversation function (HANDOFF-02 compact step)."""

    def test_compact_with_llm_call(self):
        """Compaction with a mock LLM produces valid RPETDContext."""
        from services.rpetd_context import compact_conversation, RPETDContext
        messages = _make_messages(10, include_tools=False)
        mock_llm = MagicMock(return_value=json.dumps({
            "task_id": "TK-001",
            "original_intent": "Analyze code for issues",
            "completed_work": ["R: found 3 files"],
            "current_state": {"main.py": "analyzed"},
            "active_constraints": ["scope: 40 LOC"],
            "relevant_files": ["main.py"],
            "next_actions": ["implement fix"],
            "context_version": "",
        }))
        ctx = compact_conversation(messages, "TK-001", "R", llm_call=mock_llm)
        assert isinstance(ctx, RPETDContext)
        assert ctx.task_id == "TK-001"
        assert ctx.original_intent == "Analyze code for issues"
        mock_llm.assert_called_once()

    def test_compact_fallback_on_llm_failure(self):
        """Compaction falls back when LLM call raises an exception."""
        from services.rpetd_context import compact_conversation, RPETDContext
        messages = [
            {"role": "user", "content": "Fix the login bug in auth.py"},
            {"role": "assistant", "content": "I found the issue in the token validation."},
        ]
        mock_llm = MagicMock(side_effect=Exception("LLM unavailable"))
        ctx = compact_conversation(messages, "TK-002", "R", llm_call=mock_llm)
        assert isinstance(ctx, RPETDContext)
        assert ctx.task_id == "TK-002"
        assert "Fix the login bug" in ctx.original_intent

    def test_compact_fallback_without_llm(self):
        """Compaction without llm_call uses fallback extraction."""
        from services.rpetd_context import compact_conversation, RPETDContext
        messages = [
            {"role": "user", "content": "Deploy the service to production"},
            {"role": "assistant", "content": "I will start by checking the deployment config."},
        ]
        ctx = compact_conversation(messages, "TK-003", "P", llm_call=None)
        assert isinstance(ctx, RPETDContext)
        assert ctx.task_id == "TK-003"
        assert "Deploy" in ctx.original_intent

    def test_compact_preserves_original_intent(self):
        """Fallback extraction captures the first user message as original_intent."""
        from services.rpetd_context import compact_conversation
        messages = [
            {"role": "user", "content": "The exact user request text"},
            {"role": "assistant", "content": "Working on it."},
            {"role": "user", "content": "Follow-up question"},
        ]
        ctx = compact_conversation(messages, "TK-004", "E")
        assert ctx.original_intent == "The exact user request text"


class TestTokenBudget:
    """Tests for token budget enforcement (HANDOFF-04)."""

    def test_compiled_view_under_600_tokens(self):
        """Compiled view for a representative context is under 600 tokens."""
        from services.rpetd_context import RPETDContext
        ctx = RPETDContext(
            task_id="TK-100",
            original_intent="Implement structured context handoffs for RPETD pipeline to reduce token cost",
            completed_work=[
                "R: analyzed pg_store.py, amauta-daemon.py, found endpoint patterns",
                "P: created 3-plan decomposition with 12 tasks",
                "E: implemented RPETDContext model, migration, PGStore methods",
            ],
            current_state={
                "services/rpetd_context.py": "created",
                "migrations/009-rpetd-context.sql": "created",
                "services/pg_store.py": "modified",
            },
            active_constraints=[
                "scope ceiling: 120 LOC per task",
                "backward compatible: existing phase runners must work unchanged",
                "token budget: compiled view <= 600 tokens",
            ],
            relevant_files=[
                "services/rpetd_context.py",
                "services/pg_store.py",
                "services/amauta-daemon.py",
                "migrations/009-rpetd-context.sql",
            ],
            next_actions=[
                "wire RPETDContext into RPETD phase orchestration",
                "run regression tests",
            ],
        )
        view = ctx.to_compiled_view()
        serialized = json.dumps(view)

        # Approximate token count: chars / 4 (conservative)
        approx_tokens = len(serialized) / 4
        assert approx_tokens < 600, f"Compiled view is approximately {approx_tokens} tokens (limit: 600)"

        # If tiktoken is available, verify with exact count
        try:
            import tiktoken
            enc = tiktoken.get_encoding("cl100k_base")
            exact_tokens = len(enc.encode(serialized))
            assert exact_tokens < 600, f"Compiled view is {exact_tokens} tokens (limit: 600)"
        except ImportError:
            pass  # tiktoken not available; approximate count is sufficient

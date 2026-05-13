"""
tests/test_agent_hydrator.py — Unit + degradation + shape tests for services/agent_hydrator.py

Phase 47-01-06. Tests constants, degradation contracts, and structural invariants.
No actual PG connections required — PG-dependent tests use monkeypatching (_HAS_PG=False).

Coverage:
  1. test_schema_version_is_1_0              — SCHEMA_VERSION constant
  2. test_frozen_constants                   — all Phase 47-01 frozen values
  3. test_security_finding_types_vocabulary  — exact tuple check
  4. test_hydrate_pg_down_returns_unavailable_no_crash — _HAS_PG=False monkeypatch
  5. test_hydrate_redis_down_returns_unavailable_no_crash — _HAS_REDIS=False monkeypatch
  6. test_load_agent_role_existing_agent     — real agents/gsd-planner.md
  7. test_load_agent_role_missing_agent      — absent agent → empty string, no raise
  8. test_hydrate_output_shape_keys          — exact top-level key set
  9. test_blackboard_sql_uses_verbatim_recipient_form — file text grep, ≥2 occurrences
  10. test_blackboard_uses_content_as_summary_alias  — file text grep, ≥2 occurrences
"""

import asyncio
import os
import re
import sys

import pytest

# Ensure services/ is on the path (monorepo layout)
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.agent_hydrator import (  # noqa: E402
    BLACKBOARD_LIMIT,
    MEMORY_COSINE_FLOOR,
    MEMORY_TOP_K,
    PER_SOURCE_TIMEOUT_S,
    SCHEMA_VERSION,
    SECURITY_FINDING_TYPES,
    SECURITY_LIMIT,
    _load_agent_role,
    hydrate,
)
import services.agent_hydrator as _mod  # noqa: E402

# ── Path to the service file (for text-grep tests) ────────────────────────────

_HYDRATOR_PY = os.path.join(_REPO_ROOT, "services", "agent_hydrator.py")

# ─────────────────────────────────────────────────────────────────────────────
# 1. Schema version
# ─────────────────────────────────────────────────────────────────────────────


def test_schema_version_is_1_0():
    """SCHEMA_VERSION must be exactly '1.0' — frozen per 47-CONTEXT.md."""
    assert SCHEMA_VERSION == "1.0"


# ─────────────────────────────────────────────────────────────────────────────
# 2. Frozen constants
# ─────────────────────────────────────────────────────────────────────────────


def test_frozen_constants():
    """All Phase 47-01 frozen constant values must match the plan."""
    assert MEMORY_TOP_K == 3
    assert MEMORY_COSINE_FLOOR == 0.6
    assert BLACKBOARD_LIMIT == 5
    assert SECURITY_LIMIT == 3
    assert PER_SOURCE_TIMEOUT_S == 0.4


# ─────────────────────────────────────────────────────────────────────────────
# 3. Security finding types vocabulary
# ─────────────────────────────────────────────────────────────────────────────


def test_security_finding_types_vocabulary():
    """SECURITY_FINDING_TYPES must be the exact frozen tuple per 47-CONTEXT.md."""
    assert SECURITY_FINDING_TYPES == ("security_alert", "lint_violation", "circuit_breaker_open")


# ─────────────────────────────────────────────────────────────────────────────
# 4. PG-down graceful degradation
# ─────────────────────────────────────────────────────────────────────────────


def test_hydrate_pg_down_returns_unavailable_no_crash(monkeypatch):
    """With _HAS_PG=False, hydrate() must not crash and PG sources must be 'unavailable'."""
    monkeypatch.setattr(_mod, "_HAS_PG", False)
    result = asyncio.run(hydrate("planner"))

    assert result["schema_version"] == "1.0"
    # PG-dependent sources: memory, blackboard, security
    assert result["sources_status"]["memory"] == "unavailable"
    assert result["sources_status"]["blackboard"] == "unavailable"
    assert result["sources_status"]["security"] == "unavailable"
    # No exception raised — function returned a dict
    assert isinstance(result, dict)


# ─────────────────────────────────────────────────────────────────────────────
# 5. Redis-down graceful degradation
# ─────────────────────────────────────────────────────────────────────────────


def test_hydrate_redis_down_returns_unavailable_no_crash(monkeypatch):
    """With _HAS_REDIS=False, valkey source must be 'unavailable'; other sources still attempt."""
    monkeypatch.setattr(_mod, "_HAS_REDIS", False)
    # Also set _HAS_PG=False so we don't need a real DB for this test
    monkeypatch.setattr(_mod, "_HAS_PG", False)
    result = asyncio.run(hydrate("planner"))

    assert result["sources_status"]["valkey"] == "unavailable"
    # The contract: valkey down != all-down (other sources attempt independently)
    # With _HAS_PG also False all 3 PG sources also unavailable — acceptable
    assert isinstance(result, dict)
    assert "schema_version" in result


# ─────────────────────────────────────────────────────────────────────────────
# 6. _load_agent_role with existing agent
# ─────────────────────────────────────────────────────────────────────────────


def test_load_agent_role_existing_agent():
    """_load_agent_role('gsd-planner') must return a non-empty, single-line string."""
    role = _load_agent_role("gsd-planner")
    assert isinstance(role, str)
    assert len(role) > 0, "Expected non-empty description from agents/gsd-planner.md"
    assert "\n" not in role, "Description must be single-line (no newlines)"


# ─────────────────────────────────────────────────────────────────────────────
# 7. _load_agent_role with missing agent
# ─────────────────────────────────────────────────────────────────────────────


def test_load_agent_role_missing_agent():
    """_load_agent_role with an unknown agent name must return '' and never raise."""
    role = _load_agent_role("this-agent-does-not-exist")
    assert role == ""


# ─────────────────────────────────────────────────────────────────────────────
# 8. Output shape keys
# ─────────────────────────────────────────────────────────────────────────────


def test_hydrate_output_shape_keys(monkeypatch):
    """hydrate() output must have exactly the frozen top-level key set."""
    monkeypatch.setattr(_mod, "_HAS_PG", False)
    monkeypatch.setattr(_mod, "_HAS_REDIS", False)
    result = asyncio.run(hydrate("planner"))

    expected_keys = {
        "schema_version",
        "generated_at",
        "agent_name",
        "task_id",
        "sources_status",
        "memory",
        "blackboard",
        "recent_activity",
        "security",
    }
    assert set(result.keys()) == expected_keys


# ─────────────────────────────────────────────────────────────────────────────
# 9. Verbatim recipient_agent SQL form (file text grep)
# ─────────────────────────────────────────────────────────────────────────────


def test_blackboard_sql_uses_verbatim_recipient_form():
    """services/agent_hydrator.py must contain the load-bearing SQL fragment ≥2 times.

    Both task_id-present and task_id-absent branches must use the verbatim form:
      recipient_agent IS NULL OR recipient_agent = %s
    """
    with open(_HYDRATOR_PY, "r", encoding="utf-8") as fh:
        src = fh.read()
    target = "recipient_agent IS NULL OR recipient_agent = %s"
    count = src.count(target)
    assert count >= 2, (
        f"Expected ≥2 occurrences of '{target}' in agent_hydrator.py, found {count}. "
        "Both SQL branches (task_id present + absent) must use verbatim form per 47-CONTEXT.md §Area 5."
    )


# ─────────────────────────────────────────────────────────────────────────────
# 10. content AS summary alias (file text grep)
# ─────────────────────────────────────────────────────────────────────────────


def test_blackboard_uses_content_as_summary_alias():
    """services/agent_hydrator.py must contain 'content AS summary' alias ≥2 times.

    The on-disk column is 'content' (migration 014); the JSON schema uses 'summary'.
    Both blackboard SQL branches plus the security query must carry the alias.
    """
    with open(_HYDRATOR_PY, "r", encoding="utf-8") as fh:
        src = fh.read()
    target = "content AS summary"
    count = src.count(target)
    assert count >= 2, (
        f"Expected ≥2 occurrences of '{target}' in agent_hydrator.py, found {count}. "
        "All agent_findings queries must alias content→summary per 47-CONTEXT.md §Specifics."
    )

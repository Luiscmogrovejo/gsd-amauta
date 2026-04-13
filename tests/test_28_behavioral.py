"""
tests/test_28_behavioral.py — Wave 1 behavioral upgrade tests (BEHAV-01/02/03)
Python mirror of key assertions from 28-behavioral-upgrade.test.cjs.
"""
import json
import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ─── BEHAV-02: JSON schema files ─────────────────────────────────────────────

def test_circuit_breaker_schema_parses():
    """circuit-breaker.schema.json is parseable and has required properties."""
    schema_path = os.path.join(ROOT, "schemas", "circuit-breaker.schema.json")
    with open(schema_path) as f:
        schema = json.load(f)
    assert schema["type"] == "object"
    assert "state" in schema["required"]
    assert "failures" in schema["required"]
    assert schema["additionalProperties"] is False
    enum_values = schema["properties"]["state"]["enum"]
    assert "closed" in enum_values
    assert "open" in enum_values
    assert "half_open" in enum_values


def test_divergence_memory_schema_parses():
    """divergence-memory.schema.json is parseable with all required fields."""
    schema_path = os.path.join(ROOT, "schemas", "divergence-memory.schema.json")
    with open(schema_path) as f:
        schema = json.load(f)
    assert schema["type"] == "array"
    required = schema["items"]["required"]
    for field in ["task_id", "timestamp", "agent", "divergence_type",
                  "what_failed", "why", "what_to_try_next"]:
        assert field in required, f"'{field}' missing from divergence-memory schema required"
    assert schema["items"]["additionalProperties"] is False


def test_divergence_memory_schema_enum_all_four_types():
    """divergence-memory.schema.json enum includes all 4 divergence types."""
    schema_path = os.path.join(ROOT, "schemas", "divergence-memory.schema.json")
    with open(schema_path) as f:
        schema = json.load(f)
    dt_enum = schema["items"]["properties"]["divergence_type"]["enum"]
    for dt in ["manifest_violation", "plan_amauta_drift",
               "scope_expansion", "rationalization_detected"]:
        assert dt in dt_enum, f"'{dt}' missing from divergence_type enum"
    assert len(dt_enum) == 4, f"Expected exactly 4 divergence types, got {len(dt_enum)}"


# ─── BEHAV-02: amauta-daemon.py endpoints ────────────────────────────────────

def test_amauta_daemon_has_circuit_breaker_endpoints():
    """services/amauta-daemon.py contains circuit-breaker POST and GET endpoints."""
    daemon_path = os.path.join(ROOT, "services", "amauta-daemon.py")
    with open(daemon_path) as f:
        content = f.read()
    assert "/api/circuit-breaker/record" in content, "Missing POST /api/circuit-breaker/record"
    assert "/api/circuit-breaker/" in content, "Missing GET /api/circuit-breaker/ route"
    # gsd-executor-general exempt in both routes
    assert "CB_EXEMPT" in content or "executor-general" in content
    # valkey_unavailable 503 handling
    assert "valkey_unavailable" in content


# ─── BEHAV-03: divergence-protocol.md version ────────────────────────────────

def test_divergence_protocol_version_1_2_0():
    """divergence-protocol.md version is 1.2.0 (Reflexion Memory Hook)."""
    proto_path = os.path.join(ROOT, "get-shit-done", "references", "divergence-protocol.md")
    with open(proto_path) as f:
        content = f.read()
    assert 'version: "1.2.0"' in content, "version header not updated to 1.2.0"
    assert "Protocol version: 1.2.0" in content, "Protocol version footer not updated to 1.2.0"
    assert "14. Reflexion Memory Hook" in content, "Section 14 not found"


# ─── BEHAV-01: execute-phase.md AGENTS.md discovery ─────────────────────────

def test_execute_phase_has_agents_md_discovery():
    """execute-phase.md initialize step includes AGENTS.md discovery block."""
    ep_path = os.path.join(ROOT, "get-shit-done", "workflows", "execute-phase.md")
    with open(ep_path) as f:
        content = f.read()
    assert "AGENTS.md Discovery" in content
    assert re.search(r"closest file wins|walk upward", content, re.IGNORECASE)
    assert "additive" in content
    assert "AGENTS.md: none found" in content

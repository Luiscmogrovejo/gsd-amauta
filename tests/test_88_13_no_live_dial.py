"""Plan 88-13: the CLI helpers that POST to the daemon or the RLM service dial nothing in test mode.

Incident (2026-11-11, plan 88-13 task 05): five hand-run ``amauta.py claim`` commands with the
plan's pinned environment (``GSD_TEST_MODE=1``, daemon ports 0, DSNs blank) still sent
``POST /query`` to the operator's live RLM on 127.0.0.1:18798, because ``_rlm_query`` had no
test-mode check and ``GSD_RLM_PORT`` was not in the pinned block.

Every helper below is best-effort and swallows its own exceptions, so a stub that raises would
be swallowed too. The stubs here RECORD the attempt instead and the tests assert the record is
empty. Nothing dials a real port: ``urlopen`` and ``socket.connect`` are both replaced.
"""
import os
import socket
import sys
import urllib.request
from pathlib import Path

import pytest

os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import amauta  # noqa: E402

PORT_VARS = ("GSD_RLM_PORT", "GSD_DAEMON_PORT", "GSD_AMAUTA_PORT")


@pytest.fixture()
def dials(monkeypatch, tmp_path):
    """Record every attempted connection instead of making one."""
    attempts = []

    def fake_urlopen(req, *a, **k):
        attempts.append(getattr(req, "full_url", str(req)))
        raise OSError("recorded, not dialed")

    def fake_connect(self, address, *a, **k):
        attempts.append(("socket.connect", address))
        raise OSError("recorded, not dialed")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(socket.socket, "connect", fake_connect)
    monkeypatch.setattr(amauta, "MEMORY_FILE", tmp_path / "memory.jsonl")
    monkeypatch.setenv("GSD_TEST_MODE", "1")
    monkeypatch.setenv("AMAUTA_MEMORY_DATABASE_URL", "")
    monkeypatch.setenv("GSD_POSTGRES_URL", "")
    for var in PORT_VARS:
        monkeypatch.delenv(var, raising=False)
    return attempts


def _call_every_helper():
    amauta._rlm_query("what exists for this task?", task_id="TK-1")
    amauta._agent_performance_summary("agent-x")
    amauta._record_agent_performance("agent-x", "TK-1", "pass")
    amauta._audit_log_event("TK-1", "status_change", agent_id="agent-x")
    amauta._mem_semantic_search("anything at all", top_k=3)
    amauta._mem_log_event("agent-x", ["test"], "a memory event for TK-0001")


def test_helpers_dial_nothing_with_every_port_variable_unset(dials):
    """The case that bit us: test mode on, the port variables absent (defaults 18798 and 18799)."""
    _call_every_helper()
    assert dials == []


@pytest.mark.parametrize("value", ["0", "18798", "18799", ""])
def test_helpers_dial_nothing_when_the_port_is_zero_or_the_live_default(dials, monkeypatch, value):
    for var in PORT_VARS:
        monkeypatch.setenv(var, value)
    _call_every_helper()
    assert dials == []


def test_rlm_query_returns_empty_string_and_summary_returns_none(dials):
    assert amauta._rlm_query("q") == ""
    assert amauta._agent_performance_summary("agent-x") is None
    assert dials == []


def test_a_fixture_service_on_an_ephemeral_port_is_still_reachable(dials, monkeypatch):
    """The check is not a blanket ban: a test that points a port at its own fixture service works."""
    monkeypatch.setenv("GSD_RLM_PORT", "54321")
    monkeypatch.setenv("GSD_AMAUTA_PORT", "54322")
    monkeypatch.setenv("GSD_DAEMON_PORT", "54323")
    amauta._rlm_query("q")
    amauta._agent_performance_summary("agent-x")
    amauta._record_agent_performance("agent-x", "TK-1", "pass")
    urls = [a for a in dials if isinstance(a, str)]
    assert any(":54321/" in u for u in urls), urls
    assert any(":54322/" in u for u in urls), urls


def test_live_port_blocked_is_off_outside_test_mode(monkeypatch):
    """Pure predicate, no call into a helper: outside test mode behaviour is unchanged."""
    monkeypatch.delenv("GSD_TEST_MODE", raising=False)
    monkeypatch.delenv("GSD_RLM_PORT", raising=False)
    assert amauta._live_port_blocked("GSD_RLM_PORT", "18798") is False
    monkeypatch.setenv("GSD_TEST_MODE", "0")
    assert amauta._live_port_blocked("GSD_RLM_PORT", "18798") is False
    monkeypatch.setenv("GSD_TEST_MODE", "1")
    assert amauta._live_port_blocked("GSD_RLM_PORT", "18798") is True
    monkeypatch.setenv("GSD_RLM_PORT", "40123")
    assert amauta._live_port_blocked("GSD_RLM_PORT", "18798") is False

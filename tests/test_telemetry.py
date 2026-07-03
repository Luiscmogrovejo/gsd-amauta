#!/usr/bin/env python3
"""tests/test_telemetry.py — Phase 62 TEL-02 (contribution): Python telemetry
mirror tests.

Covers: pre-consent zero collection, LOCKED 6-key envelope parity, unknown
event-type rejection, bounded-cap oldest-dropped eviction, salted
project_hash, the GSD_TELEMETRY_CONFIG_PATH authoritative-exclusive seam,
cross-runtime buffer-path identity (Python vs Node, Phase 60
test_buffer_dir_identical_across_runtimes precedent), envelope parity with
the Node emit() sibling, party_session() create() wiring (source-level +
PG-gated readiness proof), and the fail-open never-raises guarantee.

Fixture idioms mirror tests/test_capability_access.py: monkeypatch.setenv +
tmp_path sandboxes — the real repo data/ dir and .planning/config.json are
NEVER touched by these tests.

Run: pytest tests/test_telemetry.py -v
"""

import json
import os
import re
import subprocess
import sys

import pytest

# ── sys.path: ensure repo root is importable from any cwd ────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from services.telemetry import (
    EVENT_TYPES,
    SCHEMA_VERSION,
    buffer_path,
    build_event,
    emit_event,
    is_enabled,
    project_hash,
    read_telemetry_config,
)

_NODE_TELEMETRY_CJS = os.path.join(_ROOT, "get-shit-done", "bin", "lib", "telemetry.cjs")


def _has_node():
    """True when a `node` binary is reachable on PATH."""
    try:
        subprocess.run(["node", "--version"], capture_output=True, timeout=5)
        return True
    except Exception:
        return False


_NODE_AVAILABLE = _has_node()


def _pg_conn_or_none():
    """Open a psycopg2 connection to GSD_POSTGRES_URL. Returns None on any
    exception so PG-gated tests can skip cleanly (test_65_hybrid_generic.py
    precedent)."""
    try:
        import psycopg2
        dsn = os.environ.get("GSD_POSTGRES_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta")
        return psycopg2.connect(dsn)
    except Exception:
        return None


def _fresh_env(monkeypatch, tmp_path, enabled=True, extra_config=None):
    """Sandbox a config file + data dir under tmp_path and point the module's
    env seams at them. Returns (config_path, data_dir)."""
    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    config = {"telemetry": {"enabled": enabled}}
    if extra_config:
        config["telemetry"].update(extra_config)
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(config))

    monkeypatch.setenv("GSD_TELEMETRY_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(data_dir))
    monkeypatch.delenv("GSD_TELEMETRY", raising=False)
    monkeypatch.delenv("GSD_TELEMETRY_BUFFER_CAP", raising=False)
    return str(config_path), str(data_dir)


# ═══════════════════════════ 1. Default zero collection ════════════════════

def test_default_zero_collection(tmp_path, monkeypatch):
    _fresh_env(monkeypatch, tmp_path, enabled=False)
    result = emit_event("phase_start", {})
    assert result == {"emitted": False, "reason": "disabled"}
    assert not os.path.exists(buffer_path())


# ═══════════════════════════ 2. Envelope keys LOCKED ════════════════════════

def test_envelope_keys_locked(tmp_path, monkeypatch):
    _fresh_env(monkeypatch, tmp_path, enabled=True)
    result = emit_event("phase_start", {"phase": "62"})
    assert result == {"emitted": True}

    with open(buffer_path(), "r") as f:
        line = f.readlines()[-1]
    event = json.loads(line)
    assert sorted(event.keys()) == [
        "event_id", "event_type", "payload", "project_hash", "schema_version", "ts",
    ]
    assert event["schema_version"] == "1.0" == SCHEMA_VERSION


# ═══════════════════════════ 3. Unknown event type dropped ══════════════════

def test_unknown_event_type_dropped(tmp_path, monkeypatch):
    _fresh_env(monkeypatch, tmp_path, enabled=True)
    result = emit_event("nope", {})
    assert result == {"emitted": False, "reason": "unknown_event_type"}
    assert not os.path.exists(buffer_path())


# ═══════════════════════════ 4. Cap oldest dropped ══════════════════════════

def test_cap_oldest_dropped(tmp_path, monkeypatch):
    _fresh_env(monkeypatch, tmp_path, enabled=True)
    monkeypatch.setenv("GSD_TELEMETRY_BUFFER_CAP", "10")

    for seq in range(15):
        r = emit_event("phase_start", {"seq": seq})
        assert r == {"emitted": True}

    with open(buffer_path(), "r") as f:
        lines = [l for l in f.read().split("\n") if l.strip()]
    assert len(lines) == 10
    first = json.loads(lines[0])
    assert first["payload"]["seq"] == 5


# ═══════════════════════════ 5. Salted project hash ═════════════════════════

def test_project_hash_salted(tmp_path, monkeypatch):
    _fresh_env(monkeypatch, tmp_path, enabled=True, extra_config={"salt": "s3cr3t"})
    ph = project_hash()
    assert re.fullmatch(r"[0-9a-f]{16}", ph)

    result = emit_event("phase_start", {})
    assert result == {"emitted": True}
    with open(buffer_path(), "r") as f:
        raw = f.read()
    repo_basename = os.path.basename(os.path.normpath(_ROOT))
    assert repo_basename not in raw
    assert "s3cr3t" not in raw


# ═══════════════════════════ 6. Config seam exclusive ═══════════════════════

def test_config_seam_exclusive(tmp_path, monkeypatch):
    # A real enabled config exists at the fallback (.planning/config.json)
    # location, but GSD_TELEMETRY_CONFIG_PATH points at a nonexistent file —
    # the seam is AUTHORITATIVE-EXCLUSIVE: is_enabled() must be False, no
    # fallthrough to the real repo config (v3.4 env-seam learning).
    monkeypatch.delenv("GSD_TELEMETRY", raising=False)
    nonexistent = tmp_path / "does-not-exist" / "config.json"
    monkeypatch.setenv("GSD_TELEMETRY_CONFIG_PATH", str(nonexistent))
    assert is_enabled() is False


# ═══════════════════ 7. Cross-runtime buffer-path identity ══════════════════

@pytest.mark.skipif(not _NODE_AVAILABLE, reason="node not on PATH")
def test_buffer_dir_identical_across_runtimes(tmp_path, monkeypatch):
    monkeypatch.delenv("AMAUTA_DATA_DIR", raising=False)
    repo = subprocess.check_output(["git", "rev-parse", "--show-toplevel"]).decode().strip()
    assert os.path.realpath(buffer_path()) == os.path.realpath(
        os.path.join(repo, "data", "telemetry-buffer.jsonl")
    )

    monkeypatch.setenv("AMAUTA_DATA_DIR", str(tmp_path))
    py_path = os.path.realpath(buffer_path())

    proc = subprocess.run(
        ["node", "-e", f"console.log(require({json.dumps(_NODE_TELEMETRY_CJS)}).bufferPath())"],
        env={**os.environ},
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    node_path = os.path.realpath(proc.stdout.strip())
    assert py_path == node_path


# ═══════════════════ 8. Envelope parity with Node emit() ════════════════════

@pytest.mark.skipif(not _NODE_AVAILABLE, reason="node not on PATH")
def test_envelope_parity_with_node(tmp_path, monkeypatch):
    _fresh_env(monkeypatch, tmp_path, enabled=True)

    py_result = emit_event("phase_start", {})
    assert py_result == {"emitted": True}

    node_env = {**os.environ, "GSD_TELEMETRY": "on", "AMAUTA_DATA_DIR": os.environ["AMAUTA_DATA_DIR"]}
    proc = subprocess.run(
        [
            "node", "-e",
            f"require({json.dumps(_NODE_TELEMETRY_CJS)}).emit('phase_start', {{}});",
        ],
        env=node_env,
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr

    with open(buffer_path(), "r") as f:
        lines = [l for l in f.read().split("\n") if l.strip()]
    assert len(lines) == 2
    py_event = json.loads(lines[0])
    node_event = json.loads(lines[1])
    assert sorted(py_event.keys()) == sorted(node_event.keys())


# ═══════════════════ 9. party_session create() wiring ═══════════════════════

def test_party_create_wiring_source():
    """Source-level check: the emit call sits inside create() with a
    bare-except guard, additive around the existing return."""
    party_path = os.path.join(_ROOT, "services", "party_session.py")
    with open(party_path, "r") as f:
        src = f.read()

    create_match = re.search(r"def create\(.*?\n(?:.*\n)*?\n\ndef start\(", src)
    assert create_match, "create() function body not found"
    body = create_match.group(0)

    assert '"party_session"' in body
    assert "participants_count" in body
    assert "except Exception:" in body
    assert "from services.telemetry import emit_event" in body
    assert "from telemetry import emit_event" in body  # plain-import fallback


def test_party_create_wiring_behavioral(tmp_path, monkeypatch):
    """Behavioral proof, readiness-gated: attempt a real party_session.create()
    only if a PG connection is constructible from GSD_POSTGRES_URL, else skip
    cleanly (Phase 60 E2E precedent). Cleans up the created row afterward so
    the live test database is left byte-unchanged."""
    conn = _pg_conn_or_none()
    if conn is None:
        pytest.skip("live PostgreSQL unavailable (GSD_POSTGRES_URL)")

    _fresh_env(monkeypatch, tmp_path, enabled=True)
    from services import party_session

    session_id = None
    try:
        result = party_session.create(["agent-alpha", "agent-beta"], conn=conn)
        session_id = result["session_id"]
        conn.commit()

        with open(buffer_path(), "r") as f:
            lines = [l for l in f.read().split("\n") if l.strip()]
        assert lines, "expected at least one buffered telemetry event"
        last_event = json.loads(lines[-1])
        assert last_event["event_type"] == "party_session"
        assert last_event["payload"]["session_id"] == session_id
        assert last_event["payload"]["participants_count"] == 2
    finally:
        if session_id is not None:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM party_sessions WHERE session_id = %s", (session_id,))
            conn.commit()
        conn.close()


# ═══════════════════════════ 10. Emit never raises ══════════════════════════

def test_emit_never_raises(tmp_path, monkeypatch):
    # Point AMAUTA_DATA_DIR at a FILE (not a directory) so makedirs/append fails.
    bad_dir = tmp_path / "not-a-directory"
    bad_dir.write_text("i am a file, not a dir")

    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"telemetry": {"enabled": True}}))

    monkeypatch.setenv("GSD_TELEMETRY_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(bad_dir))
    monkeypatch.delenv("GSD_TELEMETRY", raising=False)

    result = emit_event("phase_start", {})
    assert isinstance(result, dict)
    assert result.get("emitted") is False

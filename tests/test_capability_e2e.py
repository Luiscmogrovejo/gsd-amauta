"""E2E for Phase 60 success criterion 3 — readiness-checked, never a fixed
delay (E2E-02 discipline). Skips when daemon or PG is unavailable.

NOTE: gsd_audit_log is append-only (INSERT/SELECT only) — E2E rows with
the "__test__-cap-e2e" task id are the accepted residue; keep them
uniquely prefixed so E2E-03 (Phase 70) can sweep them.
"""

import glob
import json
import os
import subprocess
import urllib.error
import urllib.request

import pytest

PORT = os.environ.get("GSD_AMAUTA_PORT", "18799")
BASE = f"http://127.0.0.1:{PORT}"
E2E_TASK_ID = "__test__-cap-e2e"  # 16 chars — fits VARCHAR(20); __test__-scoped


def _daemon_ready():
    try:
        urllib.request.urlopen(f"{BASE}/api/capability/list", timeout=2)
        return True
    except Exception:
        return False


requires_daemon = pytest.mark.skipif(not _daemon_ready(), reason="daemon unreachable — E2E skipped")


def _repo_root():
    return subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True
    ).strip()


def _buffer_path():
    override = os.environ.get("AMAUTA_DATA_DIR")
    data_dir = override if override else os.path.join(_repo_root(), "data")
    return os.path.join(data_dir, "capability-audit-buffer.jsonl")


def _post_json(path, payload):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_json(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


@requires_daemon
def test_capability_list_via_daemon():
    data = _get_json("/api/capability/list")
    assert data["count"] == 3
    for entry in data["entries"]:
        assert entry["auth"]["method"]
        assert entry["security_class"]


@requires_daemon
def test_access_produces_queryable_audit_row():
    resp = _post_json(
        "/api/capability/access",
        {
            "entry": "amauta-daemon-http",
            "agent_id": "gsd-executor-backend",
            "task_id": E2E_TASK_ID,
        },
    )

    if resp.get("logged"):
        query = _get_json(
            f"/api/audit/query?event_type=capability_access&task_id={E2E_TASK_ID}&limit=5"
        )
        results = query.get("results", [])
        matches = [
            r for r in results
            if r.get("agent_id") == "gsd-executor-backend"
            and (r.get("metadata") or {}).get("target") is not None
            and r.get("created_at") is not None
        ]
        assert matches, f"expected a queryable audit row, got: {results}"
    elif resp.get("buffered"):
        bpath = _buffer_path()
        assert os.path.isfile(bpath), f"expected buffer file at {bpath}"
        with open(bpath, "r") as f:
            content = f.read()
        assert E2E_TASK_ID in content, "expected E2E task id in degraded JSONL buffer"
        pytest.skip("PG down — verified JSONL degraded path instead")
    else:
        pytest.fail(f"unexpected /api/capability/access response shape: {resp}")


@requires_daemon
def test_audit_endpoint_reports_all_executors():
    data = _get_json("/api/capability/audit")
    repo_root = _repo_root()
    expected = len(glob.glob(os.path.join(repo_root, "get-shit-done", "agents", "gsd-executor-*")))
    assert data["executor_count"] == expected


@requires_daemon
def test_unlisted_access_warn_mode():
    resp = _post_json(
        "/api/capability/access",
        {"entry": "__test__-not-listed", "agent_id": "gsd-executor-backend", "task_id": E2E_TASK_ID},
    )
    assert resp["allowed"] is True
    assert resp["outcome"] == "unlisted_warn"

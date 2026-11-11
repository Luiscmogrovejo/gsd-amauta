"""E2E for Phase 60 success criterion 3 — readiness-checked, never a fixed
delay (E2E-02 discipline). Runs against the hermetic ``fixture_daemon``
(plan 88-08-03), not the operator's live daemon.

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

E2E_TASK_ID = "__test__-cap-e2e"  # 16 chars — fits VARCHAR(20); __test__-scoped

# Plan 88-08-03: these tests used to probe the operator's live daemon at import
# time (``_daemon_ready()``) and skip when nothing answered. That is not
# hermetic: the probe ran during collection, and every test then wrote
# capability audit rows into whichever store the live daemon owned. They now run
# against the ``fixture_daemon`` fixture (tests/conftest.py): a private daemon on
# an ephemeral port with its own SQLite data dir, torn down after each test.


def _repo_root():
    return subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True
    ).strip()


def _buffer_path(fixture_daemon):
    return os.path.join(str(fixture_daemon.data_dir), "capability-audit-buffer.jsonl")


def _post_json(base, path, payload):
    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_json(base, path):
    with urllib.request.urlopen(f"{base}{path}", timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _base(fixture_daemon):
    return f"http://127.0.0.1:{fixture_daemon.port}"


def test_capability_list_via_daemon(fixture_daemon):
    data = _get_json(_base(fixture_daemon), "/api/capability/list")
    # The seeded catalog had 3 entries (0b21321); 68-03-02 (3d9e249) registered 4 mobile
    # local-tool entries, so the literal 3 went stale. Derive the expectation from the
    # catalog file the daemon serves, so the count cannot go stale a second time.
    catalog_path = os.path.join(_repo_root(), "get-shit-done", "config", "capability-catalog.json")
    with open(catalog_path, "r", encoding="utf-8") as fh:
        expected = len(json.load(fh)["entries"])
    assert data["count"] == expected
    assert expected >= 3
    for entry in data["entries"]:
        assert entry["auth"]["method"]
        assert entry["security_class"]


def test_access_produces_queryable_audit_row(fixture_daemon):
    base = _base(fixture_daemon)
    resp = _post_json(
        base,
        "/api/capability/access",
        {
            "entry": "amauta-daemon-http",
            "agent_id": "gsd-executor-backend",
            "task_id": E2E_TASK_ID,
        },
    )

    if resp.get("logged"):
        query = _get_json(
            base,
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
        bpath = _buffer_path(fixture_daemon)
        assert os.path.isfile(bpath), f"expected buffer file at {bpath}"
        with open(bpath, "r") as f:
            content = f.read()
        assert E2E_TASK_ID in content, "expected E2E task id in degraded JSONL buffer"
        pytest.skip("PG down — verified JSONL degraded path instead")
    else:
        pytest.fail(f"unexpected /api/capability/access response shape: {resp}")


def test_audit_endpoint_reports_all_executors(fixture_daemon):
    data = _get_json(_base(fixture_daemon), "/api/capability/audit")
    repo_root = _repo_root()
    expected = len(glob.glob(os.path.join(repo_root, "get-shit-done", "agents", "gsd-executor-*")))
    assert data["executor_count"] == expected


def test_unlisted_access_warn_mode(fixture_daemon):
    resp = _post_json(
        _base(fixture_daemon),
        "/api/capability/access",
        {"entry": "__test__-not-listed", "agent_id": "gsd-executor-backend", "task_id": E2E_TASK_ID},
    )
    assert resp["allowed"] is True
    assert resp["outcome"] == "unlisted_warn"

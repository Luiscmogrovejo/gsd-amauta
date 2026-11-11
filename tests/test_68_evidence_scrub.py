#!/usr/bin/env python3
"""tests/test_68_evidence_scrub.py — Phase 68 MOBL-04

Tests for services/evidence_scrub.py (load_patterns/scrub_text), the
services/amauta-daemon.py wiring (_scrub_evidence_args + the
/api/memory/store choke point), and the shared cross-runtime fixture file
that also backs tests/68-evidence-scrub-node.test.cjs.

Covers:
  - Realistic multi-line xcodebuild/Gradle fixtures -- every secret
    replaced by its named [scrubbed:<name>] marker, benign lines untouched.
  - GSD_EVIDENCE_SCRUB=off kill switch round-trips input unchanged.
  - Fail-open: a nonexistent/corrupt patterns file degrades scrub_text() to
    unchanged passthrough, never raising.
  - Daemon wiring smoke (-k daemon): the /api/memory/store choke point
    (_EVIDENCE_SCRUB_AVAILABLE + scrub_text imported and reachable from the
    daemon module).
  - MCP-transport case (-k mcp_transport): _scrub_evidence_args() exercised
    with the EXACT body shape bin/mcp-server.cjs's rpetd-log sends
    ({id, phase, content} -> POST /api/rpetd, no Node CLI in the path) plus
    a non-evidence passthrough case (search args untouched). An optional
    live-daemon check is included and SKIPS (never fails) when the daemon
    is unreachable or its subprocess-based /api/rpetd path is degraded --
    outcome separation per the Phase 69 E2E precedent (services-down =
    skip-with-named-target, never misreported as a scrub-wiring defect).

Run: python3 -m pytest tests/test_68_evidence_scrub.py -v
"""
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.request

import pytest

# ── sys.path: ensure repo root is importable from any cwd ────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Avoid daemon module-level side effects during any incidental import.
os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
os.environ.setdefault("PYTEST_CURRENT_TEST", "1")

from services import evidence_scrub
from services.evidence_scrub import scrub_text

_FIXTURES_PATH = os.path.join(_HERE, "fixtures", "68-build-log-fixtures.json")
_DAEMON_PATH = os.path.join(_ROOT, "services", "amauta-daemon.py")
# Plan 88-08-03: the two "live" tests below used to read GSD_AMAUTA_PORT (default
# 18799 = the operator's live daemon) and skip when nothing answered. They now run
# against the hermetic ``fixture_daemon`` (tests/conftest.py), which runs THIS
# tree's code on an ephemeral port with a private SQLite data dir, so the
# "stale in-memory process" and "degraded PG pool" skips no longer apply.


def _load_fixtures():
    with open(_FIXTURES_PATH) as f:
        return json.load(f)["fixtures"]


_DAEMON_MODULE = None


def _load_daemon_module():
    """Load services/amauta-daemon.py via importlib WITHOUT running main().

    The hyphenated filename isn't a valid module name for `import`, and the
    real daemon-startup side effects (thread starts, socket bind) all live
    behind `if __name__ == "__main__":` at the bottom of the file -- loading
    it under a distinct module name (never "__main__") never crosses that
    guard. Cached at module scope so repeated calls across tests in this
    file don't re-run the guarded top-level imports.
    """
    global _DAEMON_MODULE
    if _DAEMON_MODULE is not None:
        return _DAEMON_MODULE
    # When amauta-daemon.py runs normally (`python3 services/amauta-daemon.py`),
    # sys.path[0] is services/, which is why its own bare `from evidence_scrub
    # import scrub_text` resolves. Loading it here via importlib does NOT set
    # that up automatically, so the services/ dir must be added explicitly.
    services_dir = os.path.dirname(_DAEMON_PATH)
    if services_dir not in sys.path:
        sys.path.insert(0, services_dir)
    spec = importlib.util.spec_from_file_location("amauta_daemon_under_test", _DAEMON_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _DAEMON_MODULE = module
    return module


@pytest.fixture(autouse=True)
def _reset_scrub_cache():
    """Ensure module-level pattern cache/warn-once flags don't leak across tests."""
    yield
    os.environ.pop("GSD_EVIDENCE_SCRUB_PATTERNS_PATH", None)
    os.environ.pop("GSD_EVIDENCE_SCRUB", None)
    evidence_scrub._PATTERNS_CACHE = None
    evidence_scrub._LOAD_WARNED = False


# ─── Fixture-driven scrub correctness ─────────────────────────────────────────

@pytest.mark.parametrize("fixture", _load_fixtures(), ids=lambda fx: fx["name"])
def test_shared_fixture_scrubs_to_expected(fixture):
    out, hits = scrub_text(fixture["input"])
    assert out == fixture["expected"], (
        f"{fixture['name']}: scrubbed output mismatch\n  got: {out!r}\n  exp: {fixture['expected']!r}"
    )
    assert hits == fixture["expected_hits"], (
        f"{fixture['name']}: hit list mismatch\n  got: {hits!r}\n  exp: {fixture['expected_hits']!r}"
    )


def test_fixture_file_has_no_raw_secrets_in_expected_column():
    """Sanity floor: every fixture with expected_hits must have removed the
    raw secret substrings from its `expected` field (marker present, no
    residual raw material)."""
    raw_secret_needles = [
        "hunter2", "swordfish123", "s3cr3t", "ABCDE12345",
        "12345678-1234-1234-1234-123456789012",
        "ghp_0123456789abcdef0123456789abcdef0123",
        "github_pat_11ABCDEFG0123456789",
        "xoxb-1234567890-abcdefghijklmno",
        "AKIAABCDEFGHIJKLMNOP",
        "supersecretpass",
    ]
    for fixture in _load_fixtures():
        for needle in raw_secret_needles:
            assert needle not in fixture["expected"], (
                f"{fixture['name']}: raw secret {needle!r} leaked into expected output"
            )


# ─── Kill switch ───────────────────────────────────────────────────────────────

def test_kill_switch_off_roundtrips_unchanged():
    os.environ["GSD_EVIDENCE_SCRUB"] = "off"
    text = "iPhone Distribution: Acme Corp (ABCDE12345) storePassword=hunter2"
    out, hits = scrub_text(text)
    assert out == text
    assert hits == []


def test_kill_switch_default_on_scrubs():
    os.environ.pop("GSD_EVIDENCE_SCRUB", None)
    out, hits = scrub_text("storePassword=hunter2")
    assert out == "[scrubbed:keystore-password]"
    assert hits == ["keystore-password"]


# ─── Fail-open ─────────────────────────────────────────────────────────────────

def test_fail_open_on_missing_patterns_file(tmp_path):
    missing_path = tmp_path / "does-not-exist-evidence-scrub-patterns.json"
    os.environ["GSD_EVIDENCE_SCRUB_PATTERNS_PATH"] = str(missing_path)
    evidence_scrub._PATTERNS_CACHE = None
    text = "storePassword=hunter2"
    out, hits = scrub_text(text)
    assert out == text
    assert hits == []


def test_fail_open_on_corrupt_patterns_file(tmp_path):
    corrupt_path = tmp_path / "corrupt-evidence-scrub-patterns.json"
    corrupt_path.write_text("{not valid json")
    os.environ["GSD_EVIDENCE_SCRUB_PATTERNS_PATH"] = str(corrupt_path)
    evidence_scrub._PATTERNS_CACHE = None
    text = "storePassword=hunter2"
    out, hits = scrub_text(text)
    assert out == text
    assert hits == []


def test_fail_open_never_raises_and_caches_failure_sentinel(tmp_path):
    missing_path = tmp_path / "nope.json"
    os.environ["GSD_EVIDENCE_SCRUB_PATTERNS_PATH"] = str(missing_path)
    evidence_scrub._PATTERNS_CACHE = None
    # First call triggers the warning + caches the failure sentinel.
    evidence_scrub.load_patterns()
    assert evidence_scrub._PATTERNS_CACHE is evidence_scrub._FAILURE_SENTINEL
    # Second call must short-circuit to [] without re-reading the (still
    # missing) file or raising.
    assert evidence_scrub.load_patterns() == []


# ─── Daemon wiring smoke (-k daemon) ──────────────────────────────────────────

def test_daemon_evidence_scrub_available_flag():
    daemon = _load_daemon_module()
    assert daemon._EVIDENCE_SCRUB_AVAILABLE is True
    # daemon.scrub_text is loaded via a bare `from evidence_scrub import
    # scrub_text` (services/ prepended to sys.path, mirroring how the
    # daemon resolves it when run normally) -- a DIFFERENT module identity
    # than services.evidence_scrub.scrub_text imported here, but the same
    # source file, so behavior must be identical.
    out, hits = daemon.scrub_text("storePassword=hunter2")
    assert (out, hits) == scrub_text("storePassword=hunter2")


def test_daemon_memory_store_choke_point_scrubs_before_store():
    """Proves the /api/memory/store handler's scrub call (identical logic
    to the handler body: `if _EVIDENCE_SCRUB_AVAILABLE: text, hits =
    scrub_text(text)`) removes the secret BEFORE any store() call would see
    it -- import-level proof, no live PG/SQLite store required."""
    daemon = _load_daemon_module()
    assert daemon._EVIDENCE_SCRUB_AVAILABLE
    raw_text = "Gradle build log: storePassword=hunter2 ghp_0123456789abcdef0123456789abcdef0123"
    scrubbed_text, hits = daemon.scrub_text(raw_text)
    assert "hunter2" not in scrubbed_text
    assert "ghp_" not in scrubbed_text
    assert "[scrubbed:keystore-password]" in scrubbed_text
    assert "[scrubbed:github-token]" in scrubbed_text
    assert set(hits) == {"keystore-password", "github-token"}


def test_daemon_memory_store_live_smoke_or_skip(fixture_daemon):
    """Daemon smoke against the hermetic fixture daemon: POST /api/memory/store
    with a secret in ``text`` must report the scrub.

    (The function name keeps its historical ``_or_skip`` suffix; the live-daemon
    skip branches were removed in 88-08-03 because the fixture daemon always runs
    current code on SQLite.)"""
    base = f"http://127.0.0.1:{fixture_daemon.port}"
    body = json.dumps({
        "text": "live-smoke storePassword=hunter2",
        "source": "agent",
        "tags": ["68-02-04-live-smoke"],
        "embed": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/api/memory/store", data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read())

    assert "error" not in data, f"fixture daemon store failed: {data!r}"
    assert data.get("stored") is True
    if data.get("scrubbed"):
        assert "keystore-password" in data["scrubbed"]


# ─── MCP-transport case (-k mcp_transport) ───────────────────────────────────

def test_mcp_transport_scrub_evidence_args_scrubs_rpetd_content():
    """Exercises the exact args shape the daemon builds for the
    bin/mcp-server.cjs rpetd-log transport's {id, phase, content} body
    (POSTed straight to /api/rpetd -- no Node CLI in that path, so only
    the Python-side choke point can cover it)."""
    daemon = _load_daemon_module()
    secret = "iPhone Distribution: Acme Corp (ABCDE12345) storePassword=hunter2"
    args = ["rpetd", "TK-x", "--phase", "T", "--content", secret]
    scrubbed_args = daemon._scrub_evidence_args(args)
    assert scrubbed_args[0:4] == ["rpetd", "TK-x", "--phase", "T"]
    content_arg = scrubbed_args[scrubbed_args.index("--content") + 1]
    assert "hunter2" not in content_arg
    assert "ABCDE12345" not in content_arg
    assert "[scrubbed:apple-signing-identity]" in content_arg
    assert "[scrubbed:keystore-password]" in content_arg


def test_mcp_transport_scrub_evidence_args_covers_note_text_backcompat():
    daemon = _load_daemon_module()
    args = ["note", "TK-x", "--text", "AKIAABCDEFGHIJKLMNOP"]
    scrubbed_args = daemon._scrub_evidence_args(args)
    content_arg = scrubbed_args[scrubbed_args.index("--text") + 1]
    assert "AKIAABCDEFGHIJKLMNOP" not in content_arg
    assert content_arg == "[scrubbed:aws-access-key]"


def test_mcp_transport_non_evidence_command_passthrough_unchanged():
    daemon = _load_daemon_module()
    args = ["search", "storePassword=hunter2"]
    scrubbed_args = daemon._scrub_evidence_args(args)
    assert scrubbed_args == args


def _urlopen_json(url, body=None, method="GET", timeout=5):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def test_mcp_transport_live_post_rpetd_or_skip(fixture_daemon):
    """An MCP-style POST /api/rpetd with a fixture secret in `content` lands
    scrubbed on a REAL task record (read back via /api/exec show, not just the
    POST's own ack message), against the hermetic fixture daemon.

    (Name kept for continuity. The three live-daemon outcomes this test used to
    distinguish -- unreachable, reachable-and-current, reachable-but-stale -- are
    gone: the fixture daemon is started from this tree for this test, so it is
    always reachable and always current, and a failure at any step is a real
    failure, not a skip.)
    """
    base = f"http://127.0.0.1:{fixture_daemon.port}"
    add_resp = _urlopen_json(
        f"{base}/api/add",
        {"type": "task", "title": "68-02-04 scrub smoke probe (throwaway)"},
        method="POST", timeout=10,
    )
    import re as _re
    m = _re.search(r"(TK|EP|ST|BG)-\d+", add_resp.get("output", ""))
    assert m, f"could not parse a task id from /api/add response: {add_resp!r}"
    probe_id = m.group(0)

    secret_marker = "storePassword=hunter2"
    rpetd_resp = _urlopen_json(
        f"{base}/api/rpetd",
        {"id": probe_id, "phase": "T", "content": f"mcp-transport probe {secret_marker}"},
        method="POST", timeout=10,
    )
    assert rpetd_resp.get("exit_code") == 0, f"daemon rpetd command errored: {rpetd_resp!r}"

    show_resp = _urlopen_json(f"{base}/api/exec", {"args": ["show", probe_id, "--json"]}, method="POST", timeout=10)
    show_item = json.loads(show_resp.get("output", "{}"))
    stored_content = str(show_item.get("rpetd_phases", {}).get("T", ""))

    assert secret_marker not in stored_content, "raw secret survived into the stored T-phase content"
    assert "[scrubbed:keystore-password]" in stored_content

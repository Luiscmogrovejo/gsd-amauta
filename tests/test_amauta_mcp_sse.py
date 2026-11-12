"""
tests/test_amauta_mcp_sse.py — SSE transport integration test (Phase 46-02-05).

Spawns `python3 services/amauta-mcp.py --sse` and verifies the SSE transport
on the frozen port 18800.

Frozen port: 18800 (MCP-01 verbatim). Daemon stays on 18799. No collision possible.
The port is a constant of `services/amauta-mcp.py`, a canary-pinned file, so this
test cannot move it to an ephemeral one without changing a pinned path.

Phase 88 plan 88-16-02 removed three mid-test `pytest.skip` calls here:

  * the startup wait was 3 seconds, which the macOS runner misses because
    `HTTPServer.server_bind` calls `socket.getfqdn()` and the reverse lookup is
    slow there (plan 88-18 fixed the same stall in `services/amauta-daemon.py`
    and plan 88-15 in `services/rlm-service.py`; `amauta-mcp.py` is canary-pinned
    and its SSE path is SEC-06/Phase 90 work, so the budget is raised here
    instead of the product being changed). Three tests skipped on macOS for this
    and now run.
  * `GET /sse` is a REAL, reproducible product defect, measured identically on
    ubuntu CI, Windows CI and the operator's macOS: `_run_sse` hands
    `SseServerTransport.handle_sse` a raw `rfile`/`wfile` pair where the SDK
    expects an ASGI `(scope, receive, send)` triple, so the handler raises and
    `BaseHTTPRequestHandler` closes the socket with no response. That is a
    `strict` xfail with an owner, not a skip: it turns red the moment Phase 90
    makes it work, which is exactly when the marker must be removed.
  * a module-load failure now fails the test instead of skipping it.
"""

import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

# ── Skip gate 1: mcp package required ─────────────────────────────────────────

_MCP_AVAILABLE = False
try:
    import mcp  # noqa: F401
    _MCP_AVAILABLE = True
except ImportError:
    pass

# ── Precondition: port 18800 must be free ─────────────────────────────────────

def _port_in_use(port: int) -> bool:
    """Return True if port is already bound by another process."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1)
    try:
        result = s.connect_ex(("127.0.0.1", port))
        return result == 0  # 0 = connection succeeded → port already in use
    except OSError:
        return False
    finally:
        s.close()


# `mcp` is a hard requirement (`requirements.txt`: mcp>=1.0,<2) and is importable
# on all three Python cells, so this gate never fires in CI. It is kept because a
# broken install should name itself rather than produce a wall of import errors.
pytestmark = pytest.mark.skipif(
    not _MCP_AVAILABLE,
    reason="mcp Python package not installed — it is a hard requirement (requirements.txt)",
)

# ── Constants ──────────────────────────────────────────────────────────────────

_SERVICES_DIR = os.path.join(os.path.dirname(__file__), "..", "services")
_SERVER_PATH = os.path.join(_SERVICES_DIR, "amauta-mcp.py")
MCP_SSE_PORT = 18800  # frozen (MCP-01 verbatim)


# How long to wait for the bind. `HTTPServer.server_bind` resolves the host name,
# which costs seconds on the macOS runner. Overridable so a slow runner can be
# given more without another code change; never below the old 3 s.
_BIND_TIMEOUT = max(3.0, float(os.environ.get("GSD_MCP_SSE_BIND_TIMEOUT", "60")))


# ── Wait helper ────────────────────────────────────────────────────────────────

def _wait_for_port(port: int, timeout: float = 3.0) -> bool:
    """Poll until the port accepts connections. Returns True when reachable."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.2)
        try:
            result = s.connect_ex(("127.0.0.1", port))
            if result == 0:
                return True
        except OSError:
            pass
        finally:
            s.close()
        time.sleep(0.1)
    return False


# ── Subprocess fixture ─────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def sse_server():
    """Spawn SSE server subprocess. Yields Popen or skips if server fails to bind."""
    env = os.environ.copy()
    env["GSD_POSTGRES_URL"] = "postgresql://invalid:1/none"  # PG deliberately down

    if _port_in_use(MCP_SSE_PORT):
        pytest.fail(
            "port %d is already bound; the SSE transport's port is a constant of "
            "services/amauta-mcp.py and cannot be moved from a test" % MCP_SSE_PORT
        )

    proc = subprocess.Popen(
        [sys.executable, _SERVER_PATH, "--sse"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    if not _wait_for_port(MCP_SSE_PORT, timeout=_BIND_TIMEOUT):
        proc.terminate()
        try:
            out, err = proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
        pytest.fail(
            "SSE server did not bind port %d within %.0f s.\n--- stdout ---\n%s\n--- stderr ---\n%s"
            % (
                MCP_SSE_PORT,
                _BIND_TIMEOUT,
                (out or b"").decode("utf-8", "replace")[-2000:],
                (err or b"").decode("utf-8", "replace")[-4000:],
            )
        )

    yield proc

    # Teardown
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    except Exception:
        pass


# ── Tests ──────────────────────────────────────────────────────────────────────

class TestSSETransport:

    def test_sse_port_18800_accepts_connections(self, sse_server):
        """Port 18800 is reachable after server starts."""
        result = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        result.settimeout(2)
        try:
            rc = result.connect_ex(("127.0.0.1", 18800))
            assert rc == 0, f"Port 18800 not reachable (connect_ex returned {rc})"
        finally:
            result.close()

    @pytest.mark.xfail(
        strict=True,
        reason=(
            "services/amauta-mcp.py `_run_sse` calls SseServerTransport.handle_sse("
            "rfile, wfile, server) where the mcp SDK expects an ASGI (scope, receive, "
            "send) triple, so the handler raises and the socket closes with no "
            "response. Measured identically on ubuntu CI, Windows CI and macOS. The "
            "file is canary-pinned and the 0.0.0.0 SSE path is SEC-06 / Phase 90 "
            "work, so plan 88-16 may not fix it. EXIT CRITERION: remove this marker "
            "when Phase 90's console/SSE rewrite lands and GET /sse answers 200 "
            "text/event-stream."
        ),
    )
    def test_sse_get_sse_path_returns_event_stream(self, sse_server):
        """GET http://127.0.0.1:18800/sse returns 200 with Content-Type: text/event-stream."""
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:18800/sse",
                headers={"Accept": "text/event-stream"},
            )
            # Use a raw HTTP connection to avoid urlopen blocking on SSE stream
            import http.client
            conn = http.client.HTTPConnection("127.0.0.1", 18800, timeout=3)
            conn.request("GET", "/sse", headers={"Accept": "text/event-stream"})
            resp = conn.getresponse()

            assert resp.status == 200, f"Expected HTTP 200, got {resp.status}"
            content_type = resp.getheader("Content-Type", "")
            assert content_type.startswith("text/event-stream"), (
                f"Expected Content-Type: text/event-stream, got: {content_type!r}"
            )

            # Read first chunk without blocking indefinitely
            chunk = resp.read(256)
            # SSE stream may be empty initially (waiting for events) or have a data: line
            # The contract is that the stream OPENS; we don't require data in first 256 bytes
            # but the connection must succeed with correct content-type (already asserted above)
            _ = chunk  # chunk may be empty; connection opened is the guarantee

        finally:
            try:
                conn.close()
            except Exception:
                pass

    def test_sse_port_constant_frozen_at_18800(self):
        """MCP_SSE_PORT module constant is frozen at 18800 (guards against drift)."""
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "amauta_mcp", _SERVER_PATH,
        )
        m = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(m)
        except Exception as e:  # a module that will not load is a failure, not a skip
            pytest.fail(f"services/amauta-mcp.py failed to import: {e!r}")
        assert m.MCP_SSE_PORT == 18800, (
            f"MCP_SSE_PORT drift: expected 18800, got {m.MCP_SSE_PORT}"
        )

    def test_sse_process_terminates_on_sigterm(self, sse_server):
        """SIGTERM causes the SSE server process to terminate within 5 seconds."""
        proc = sse_server
        try:
            proc.send_signal(signal.SIGTERM)
        except (ProcessLookupError, OSError):
            pass  # Already dead — counts as terminated
        try:
            exit_code = proc.wait(timeout=5)
            # Any exit (including signal exit) is acceptable; just must not hang
            assert exit_code is not None, "proc.wait() returned None unexpectedly"
        except subprocess.TimeoutExpired:
            pytest.fail("SSE server did not terminate within 5 seconds after SIGTERM")

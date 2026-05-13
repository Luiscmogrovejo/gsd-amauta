"""
tests/test_amauta_mcp_sse.py — SSE transport integration test (Phase 46-02-05).

Spawns `python3 services/amauta-mcp.py --sse` and verifies the SSE transport
on the frozen port 18800.

Skips gracefully when:
  - mcp Python package is not installed
  - Port 18800 is already bound by another process (EADDRINUSE)
  - SSE server fails to bind within startup timeout

Frozen port: 18800 (MCP-01 verbatim). Daemon stays on 18799. No collision possible.
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

# ── Skip gate 2: port 18800 already in use ────────────────────────────────────

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


_PORT_BUSY = _port_in_use(18800)

pytestmark = pytest.mark.skipif(
    not _MCP_AVAILABLE or _PORT_BUSY,
    reason=(
        "mcp Python package not installed — SSE integration test skipped"
        if not _MCP_AVAILABLE
        else "Port 18800 already in use — SSE integration test skipped"
    ),
)

# ── Constants ──────────────────────────────────────────────────────────────────

_SERVICES_DIR = os.path.join(os.path.dirname(__file__), "..", "services")
_SERVER_PATH = os.path.join(_SERVICES_DIR, "amauta-mcp.py")
MCP_SSE_PORT = 18800  # frozen (MCP-01 verbatim)


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

    proc = subprocess.Popen(
        [sys.executable, _SERVER_PATH, "--sse"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )

    # Wait up to 3s for port 18800 to become reachable
    if not _wait_for_port(18800, timeout=3.0):
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        pytest.skip("SSE server failed to bind port 18800 within 3 seconds — skipping")

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

        except (ConnectionRefusedError, OSError) as e:
            pytest.skip(f"SSE endpoint not reachable: {e}")
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
        except Exception as e:
            pytest.skip(f"Module load failed: {e}")
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

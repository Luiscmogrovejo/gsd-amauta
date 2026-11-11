"""pytest configuration: hermetic environment for every Python test (plan 88-01).

The session fixture below runs before any test and applies the same scrub as
scripts/run-tests.cjs: SQLite forced, test mode on, temporary data and config
directories, ports moved off the operator's live services, and the socket guard
installed. HOME is not modified (replacing it hides user-site packages).
"""
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
_REPO = _TESTS_DIR.parent
_SUPPORT = _TESTS_DIR / "support"
if str(_SUPPORT) not in sys.path:
    sys.path.insert(0, str(_SUPPORT))

import hermetic_guard  # noqa: E402

_DELETED_KEYS = (
    "GSD_POSTGRES_URL",
    "DATABASE_URL",
    "AMAUTA_MEMORY_DATABASE_URL",
    "VALKEY_URL",
    "REDIS_URL",
    "GSD_PG_PORT",
)
_LIVE_PORTS = {18799, 18798, 6379, 5433}

# Install the socket guard at conftest import, which is BEFORE pytest collects
# any test module. A module-level probe (``_daemon_ready()`` in
# tests/test_capability_e2e.py used to GET the live daemon at import) runs during
# collection, i.e. before the session fixture below; with the guard installed
# only there, collection itself reached the operator's live daemon (88-08-03).
# install() is idempotent, so the session fixture's later call is a no-op.
hermetic_guard.install()


def _free_port(avoid=()):
    """Bind port 0 on 127.0.0.1 and return the port the OS chose.

    Args:
        avoid: ports that must not be returned.

    Returns:
        A free port that is not one of the live service ports.
    """
    for _ in range(10):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port not in _LIVE_PORTS and port not in avoid:
            return port
    raise RuntimeError("could not obtain a free port")


@pytest.fixture(autouse=True, scope="session")
def _gsd_hermetic_env(tmp_path_factory):
    """Scrub the environment and install the socket guard before any test runs."""
    for key in _DELETED_KEYS:
        os.environ.pop(key, None)
    os.environ.update(
        {
            "GSD_FORCE_SQLITE": "1",
            "GSD_BACKEND": "sqlite",
            "GSD_TEST_MODE": "1",
            "GSD_REDIS_ENABLED": "false",
            "GSD_RLM_ENABLED": "false",
            "GSD_AMAUTA_NO_AUTO_START": "1",
            "GSD_INSTALL_FILES_ONLY": "1",
            "AMAUTA_AUTO_BACKUP": "off",
        }
    )
    root = tmp_path_factory.mktemp("gsd-hermetic")
    data_dir = root / "data"
    config_dir = root / ".claude"
    data_dir.mkdir()
    config_dir.mkdir()
    os.environ["AMAUTA_DATA_DIR"] = str(data_dir)
    os.environ["CLAUDE_CONFIG_DIR"] = str(config_dir)

    daemon_port = _free_port()
    rlm_port = _free_port(avoid=(daemon_port,))
    os.environ["GSD_AMAUTA_PORT"] = str(daemon_port)
    os.environ["GSD_DAEMON_PORT"] = str(daemon_port)
    os.environ["GSD_RLM_PORT"] = str(rlm_port)
    redis_port = _free_port(avoid=(daemon_port, rlm_port))
    os.environ["AMAUTA_PORT"] = str(daemon_port)
    os.environ["GSD_REDIS_PORT"] = str(redis_port)
    os.environ["GSD_REDIS_URL"] = "redis://127.0.0.1:%d/0" % redis_port

    pypath = str(_SUPPORT / "pythonpath")
    existing = os.environ.get("PYTHONPATH", "")
    os.environ["PYTHONPATH"] = pypath + (os.pathsep + existing if existing else "")

    hermetic_guard.install()
    yield


class FixtureDaemon:
    """Handle for a daemon started by the ``fixture_daemon`` fixture."""

    def __init__(self, port, data_dir, env, proc):
        self.port = port
        self.data_dir = data_dir
        self.env = env
        self.proc = proc


@pytest.fixture
def fixture_daemon(tmp_path):
    """Start services/amauta-daemon.py on an ephemeral port with the SQLite backend.

    Same contract as tests/support/fixture-daemon.cjs: GSD_AMAUTA_PORT=0 makes the
    daemon bind an ephemeral port and print ``DAEMON_PORT=<n>``; readiness is polled
    on /health (never a fixed sleep). Yields an object with ``.port``, ``.data_dir``
    and ``.env``; terminates the process on teardown (terminate, then kill).

    Raises:
        RuntimeError: when the daemon does not become ready within 20 s; the
            message ends with the last 2000 characters of its stderr.
    """
    data_dir = tmp_path / "fixture-data"
    data_dir.mkdir()
    env = dict(os.environ)
    for key in ("GSD_POSTGRES_URL", "DATABASE_URL", "REDIS_URL", "GSD_SQLITE_PATH", "GSD_DATA_DIR"):
        env.pop(key, None)
    env.update(
        {
            "GSD_TEST_MODE": "1",
            "GSD_AMAUTA_PORT": "0",
            "GSD_DAEMON_PORT": "0",
            "GSD_FORCE_SQLITE": "1",
            "GSD_BACKEND": "sqlite",
            "AMAUTA_DATA_DIR": str(data_dir),
            "AMAUTA_AUTO_BACKUP": "off",
            "GSD_REDIS_ENABLED": "false",
            "GSD_RLM_ENABLED": "false",
        }
    )
    out_path = tmp_path / "fixture-daemon.out"
    err_path = tmp_path / "fixture-daemon.err"
    out_f = open(out_path, "w")
    err_f = open(err_path, "w")
    proc = subprocess.Popen(
        [sys.executable, str(_REPO / "services" / "amauta-daemon.py"), "run"],
        stdout=out_f,
        stderr=err_f,
        env=env,
    )
    try:
        port = None
        deadline = time.time() + 20
        ready = False
        while time.time() < deadline and proc.poll() is None:
            if port is None:
                for line in out_path.read_text().splitlines():
                    if line.startswith("DAEMON_PORT="):
                        port = int(line.split("=", 1)[1])
                        break
            if port is not None:
                try:
                    with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=2) as r:
                        if r.status == 200:
                            ready = True
                            break
                except Exception:
                    pass
            time.sleep(0.1)
        if not ready:
            raise RuntimeError("fixture daemon did not become ready: " + err_path.read_text()[-2000:])
        yield FixtureDaemon(
            port,
            data_dir,
            {
                "GSD_AMAUTA_PORT": str(port),
                "GSD_DAEMON_PORT": str(port),
                "AMAUTA_DATA_DIR": str(data_dir),
                "GSD_TEST_MODE": "1",
                "GSD_FORCE_SQLITE": "1",
            },
            proc,
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        out_f.close()
        err_f.close()


# ---------------------------------------------------------------------------
# Plan 88-08 shared helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def backend_selection_env(monkeypatch):
    """Clear the variables the hermetic scrub exports so a test can exercise backend selection.

    The session scrub sets ``GSD_FORCE_SQLITE=1``, ``GSD_BACKEND=sqlite`` and
    ``GSD_TEST_MODE=1``. The daemon's ``_force_sqlite()`` answers True for any of
    them, so a test that asks "does an unset or later-written variable count as an
    operator choice?" cannot see its own inputs. This fixture removes exactly those
    three names for one test (monkeypatch restores them afterwards). It does not
    touch the socket guard, the port scrub or the data-dir isolation, so the test
    still cannot reach a live service.

    Yields:
        None.
    """
    for key in ("GSD_FORCE_SQLITE", "GSD_BACKEND", "GSD_TEST_MODE"):
        monkeypatch.delenv(key, raising=False)
    yield


def _postgres_dsn_or_skip():
    """Return ``GSD_TEST_POSTGRES_URL`` or skip the calling test with a named reason.

    Kept as a plain function so a test can exercise the skip contract directly.

    Returns:
        The DSN string.

    Raises:
        pytest.skip.Exception: when ``GSD_TEST_POSTGRES_URL`` is unset or empty.
    """
    dsn = os.environ.get("GSD_TEST_POSTGRES_URL")
    if not dsn:
        pytest.skip(
            "no disposable Postgres: set GSD_TEST_POSTGRES_URL to run this test "
            "(Phase 89 adds the CI service)"
        )
    return dsn


@pytest.fixture(scope="session")
def postgres_dsn():
    """DSN of a disposable Postgres, or skip when none was provided.

    The opt-in variable is ``GSD_TEST_POSTGRES_URL``, deliberately not
    ``GSD_POSTGRES_URL``: the session scrub deletes the latter so that no test can
    inherit the operator's live DSN, and this helper must not reintroduce it.
    Never starts a container; Phase 89 brings the CI service.

    Returns:
        The DSN string from ``GSD_TEST_POSTGRES_URL``.
    """
    return _postgres_dsn_or_skip()

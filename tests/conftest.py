"""pytest configuration: hermetic environment for every Python test (plan 88-01).

The session fixture below runs before any test and applies the same scrub as
scripts/run-tests.cjs: SQLite forced, test mode on, temporary data and config
directories, ports moved off the operator's live services, and the socket guard
installed. HOME is not modified (replacing it hides user-site packages).
"""
import os
import socket
import sys
import tempfile
from pathlib import Path

import pytest

_TESTS_DIR = Path(__file__).resolve().parent
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

    pypath = str(_SUPPORT / "pythonpath")
    existing = os.environ.get("PYTHONPATH", "")
    os.environ["PYTHONPATH"] = pypath + (os.pathsep + existing if existing else "")

    hermetic_guard.install()
    yield

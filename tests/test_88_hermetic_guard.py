"""Phase 88 plan 88-01: the Python hermetic guard and the conftest scrub."""
import os
import socket

import pytest


@pytest.mark.parametrize("port", [18799, 18798, 6379, 5433])
def test_connect_to_live_daemon_port_raises(port):
    with socket.socket() as s:
        with pytest.raises(RuntimeError) as exc:
            s.connect(("127.0.0.1", port))
    assert str(exc.value).startswith("HERMETIC GUARD")
    assert "live service port %d" % port in str(exc.value)


@pytest.mark.parametrize("port", [18799, 5433])
def test_connect_ex_to_live_port_raises(port):
    with socket.socket() as s:
        with pytest.raises(RuntimeError):
            s.connect_ex(("127.0.0.1", port))


def test_free_port_is_not_blocked():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    # Nothing listens on the port any more: the OS refusal is the correct outcome.
    with socket.socket() as s:
        with pytest.raises(OSError) as exc:
            s.connect(("127.0.0.1", port))
    assert not isinstance(exc.value, RuntimeError)


def test_install_is_idempotent():
    import hermetic_guard

    first = socket.socket.connect
    assert hermetic_guard.install() is True
    assert socket.socket.connect is first


def test_conftest_scrubbed_environment():
    assert os.environ.get("GSD_POSTGRES_URL") is None
    assert os.environ.get("DATABASE_URL") is None
    assert os.environ.get("REDIS_URL") is None
    assert os.environ["GSD_FORCE_SQLITE"] == "1"
    assert os.environ["GSD_TEST_MODE"] == "1"
    assert os.environ["GSD_AMAUTA_PORT"] == os.environ["GSD_DAEMON_PORT"]
    assert os.environ["GSD_AMAUTA_PORT"] != "18799"
    assert os.environ["GSD_RLM_PORT"] != "18798"
    assert os.environ["AMAUTA_DATA_DIR"] != os.path.expanduser("~/.amauta")


def test_fixture_daemon_fixture_is_sqlite_on_an_ephemeral_port(fixture_daemon):
    import json
    import urllib.request

    assert fixture_daemon.port not in (18799, 18798, 6379, 5433)
    with urllib.request.urlopen("http://127.0.0.1:%d/health" % fixture_daemon.port, timeout=5) as r:
        body = json.loads(r.read().decode())
    assert body["backend"] == "sqlite"
    assert (fixture_daemon.data_dir / "amauta-daemon.pid").exists()

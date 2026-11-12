"""Phase 88 plan 88-01: the Python hermetic guard and the conftest scrub."""
import os
import socket

import pytest

# Plan 88-16-03: these assertions are ABOUT the refusal, so they pin the guard
# to enforce rather than inheriting the rollout's log-only mode.
pytestmark = pytest.mark.usefixtures("enforcing_guard")


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
    # Plan 88-16-09 sharpened this one property and left the rest alone: a DSN
    # may be present ONLY if tests/conftest.py validated it against the live
    # service ports at import. "absent" became "absent or validated, never
    # inherited", which is strictly stronger than what was asserted before —
    # the old form would have passed with a live DSN that conftest merely
    # forgot to delete.
    import conftest as _c

    for key in ("GSD_POSTGRES_URL", "DATABASE_URL"):
        value = os.environ.get(key)
        if value is None:
            assert _c.postgres_dsn_or_none() is None, (
                "%s is absent but a disposable database is configured" % key
            )
            continue
        assert value == _c.postgres_dsn_or_none(), (
            "%s holds something other than the validated disposable DSN" % key
        )
        assert _c._port_of_dsn(value) not in _c._LIVE_PORTS, (
            "%s names a live service port" % key
        )
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

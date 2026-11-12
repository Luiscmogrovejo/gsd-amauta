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


# ── GSD_HERMETIC_GUARD_BLOCK_PORTS (plan 88-17 defect 2, closed by 88-11) ─────
#
# The Node guard has had this variable since 88-16; the Python one had not, so
# plan 88-17's "the API host was never dialled" alarm had to install its own
# socket recorder on the Python side. These three pin the parity: the variable
# blocks, an allowance lifts it, and an allowance can never lift a LIVE port.


def test_block_ports_blocks_a_port_that_is_otherwise_free():
    import hermetic_guard

    env = {"GSD_HERMETIC_GUARD_BLOCK_PORTS": "443,8443"}
    for port in (443, 8443):
        allowed, reason = hermetic_guard.decide("127.0.0.1", port, env=env)
        assert allowed is False, "port %d must be blocked by the variable" % port
        assert reason == "live-port"
    # A port the variable did not name is untouched: the rule is not "block all".
    assert hermetic_guard.decide("127.0.0.1", 8444, env=env) == (True, "loopback")
    # And without the variable the same port is free, so the block is the cause.
    assert hermetic_guard.decide("127.0.0.1", 443, env={}) == (True, "loopback")


def test_block_ports_is_lifted_by_allow_ports():
    import hermetic_guard

    env = {
        "GSD_HERMETIC_GUARD_BLOCK_PORTS": "443",
        "GSD_HERMETIC_GUARD_ALLOW_PORTS": "443",
    }
    assert hermetic_guard.decide("127.0.0.1", 443, env=env) == (True, "loopback")


def test_block_ports_cannot_be_used_to_lift_a_live_port():
    import hermetic_guard

    env = {
        "GSD_HERMETIC_GUARD_BLOCK_PORTS": "443",
        "GSD_HERMETIC_GUARD_ALLOW_PORTS": "6379",
    }
    # arm_refusal is the loud half: the guard refuses to arm at all.
    assert "6379" in (hermetic_guard.arm_refusal(env) or "")
    # And decide() still refuses the live port even if armed anyway.
    allowed, reason = hermetic_guard.decide("127.0.0.1", 6379, env=env)
    assert (allowed, reason) == (False, "live-port")


#: The variables that change a GUARD DECISION. Both guards must read all four.
#: ``GSD_HERMETIC_GUARD_NO_AUTOINSTALL`` is deliberately NOT here: it is a
#: Node-only import hook (the Python guard is installed from conftest), so
#: requiring it would be parity for its own sake.
_DECISION_VARIABLES = (
    "GSD_HERMETIC_GUARD_MODE",
    "GSD_HERMETIC_GUARD_BLOCK_PORTS",
    "GSD_HERMETIC_GUARD_ALLOW_PORTS",
    "GSD_HERMETIC_GUARD_ALLOW_HOSTS",
    "GSD_HERMETIC_GUARD_LOG",
)


@pytest.mark.parametrize("name", _DECISION_VARIABLES)
def test_both_guards_read_the_same_decision_variables(name):
    from pathlib import Path

    root = Path(__file__).resolve().parent.parent
    for rel in ("tests/support/hermetic-guard.cjs", "tests/support/hermetic_guard.py"):
        text = (root / rel).read_text(encoding="utf-8")
        assert name in text, "%s does not read %s" % (rel, name)


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

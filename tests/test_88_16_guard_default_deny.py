"""88-16-03: the Python hermetic guard is default-deny for non-loopback destinations.

SAFETY, and it is why this file is shaped the way it is: a mutation test of a
guard must never prove itself by DIALLING the thing the guard protects. With the
guard off, "connect and expect a refusal" would be a real request to the
operator's live daemon, RLM, Redis or PostgreSQL. Every case below either

  * asserts on the pure decision function ``hermetic_guard.decide`` and on the
    ``_gsd_hermetic`` marker, opening no socket at all, or
  * uses a listener this test opened itself on a free loopback port.

The live-port literals appear below only inside refuse-to-arm assertions and
inside ``GSD_HERMETIC_GUARD_ALLOW_PORTS`` values, where the point is precisely
that asking for them stops the run.
"""
import os
import socket
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "support"))

import hermetic_guard as hg  # noqa: E402


@pytest.fixture
def log_file(tmp_path):
    """A fresh refusal-log path for one case."""
    return str(tmp_path / "refusals.tsv")


# ── The loopback definition, written down and pinned ─────────────────────────

def test_loopback_definition_is_exactly_what_the_plan_states():
    for host in (None, "", "localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1"):
        assert hg.is_loopback_host(host) is True, "%r must count as loopback" % (host,)
    for host in ("api.voyageai.com", "203.0.113.9", "0.0.0.0", "10.0.0.1", "::2"):
        assert hg.is_loopback_host(host) is False, "%r must NOT count as loopback" % (host,)
    # AF_UNIX is permitted: the address is a path, not a (host, port) tuple.
    assert hg.decide(None, None, is_unix=True) == (True, "af-unix")


# ── Mutation 1: a non-loopback HOST is refused and the refusal is logged ─────

def test_m1_non_loopback_host_refused_and_logged(log_file):
    env = {"GSD_HERMETIC_GUARD_LOG": log_file}
    allowed, reason = hg.decide("api.voyageai.com", 443, env=env)
    assert allowed is False
    assert reason == "non-loopback-host"

    hg.log_refusal("api.voyageai.com", 443, reason, env=env)
    with open(log_file, encoding="utf-8") as fh:
        lines = fh.read().strip().split("\n")
    assert len(lines) == 1, lines
    fields = lines[0].split("\t")
    assert fields[2] == "enforce"
    assert fields[3] == "python"
    assert fields[4] == "api.voyageai.com"
    assert fields[5] == "443"
    assert fields[6] == "non-loopback-host"
    assert "HERMETIC GUARD" in hg._message("api.voyageai.com", 443, reason)


# ── Mutation 2: the allow-list is read at CHECK time ─────────────────────────

def test_m2_allow_host_is_read_at_check_time_not_install_time():
    # The guard is already armed in this interpreter (conftest installs it at
    # import). If it had snapshotted the allow-list then — which it did before
    # this plan — setting the variable now would change nothing.
    assert getattr(socket.socket.connect, "_gsd_hermetic", False) is True
    env = {}
    assert hg.decide("api.voyageai.com", 443, env=env)[0] is False
    env["GSD_HERMETIC_GUARD_ALLOW_HOSTS"] = "api.voyageai.com"
    assert hg.decide("api.voyageai.com", 443, env=env) == (True, "allow-host")


def test_m2b_allow_host_fixture_permits_one_host_for_one_test(allow_host):
    allow_host("api.voyageai.com")
    assert hg.decide("api.voyageai.com", 443) == (True, "allow-host")
    # ...and it refuses to be used as a back door.
    with pytest.raises(RuntimeError, match="back door"):
        allow_host("localhost")


# ── Mutation 3: the allowance does not leak into the next test ───────────────

def test_m3_allowance_from_the_previous_test_did_not_leak():
    # This test deliberately runs AFTER test_m2b and takes no allow_host
    # fixture. monkeypatch restored the variable when that test ended.
    assert "api.voyageai.com" not in os.environ.get("GSD_HERMETIC_GUARD_ALLOW_HOSTS", "")
    assert hg.decide("api.voyageai.com", 443)[0] is False


# ── Mutation 4: a RAW non-loopback IP is refused inside connect itself ───────

def test_m4_raw_non_loopback_ip_refused_and_the_mutant_lets_it_through():
    # 203.0.113.0/24 is TEST-NET-3 (RFC 5737): documentation-only, never routed.
    allowed, reason = hg.decide("203.0.113.9", 443)
    assert allowed is False
    assert reason == "non-loopback-ip"

    # THE MUTATION: a guard that only wraps name resolution — getaddrinfo and
    # nothing else — never sees a literal address, so the same connect goes
    # straight through. That is the one-line bypass the in-connect check closes.
    def name_only_decide(host, port):
        if hg.is_ip_literal(host):
            return True, "mutant"
        return hg.decide(host, port)

    assert name_only_decide("203.0.113.9", 443)[0] is True, (
        "the mutant must demonstrate the bypass, otherwise this case proves nothing"
    )
    assert hg.decide("203.0.113.9", 443)[0] is False

    # And the installed wrapper really does refuse before any syscall: a socket
    # object is created but `connect` raises before libc is reached.
    with socket.socket() as s:
        with pytest.raises(RuntimeError, match="HERMETIC GUARD"):
            s.connect(("203.0.113.9", 443))


# ── Mutation 5: the guard refuses to ARM for a live port or for loopback ─────

def test_m5_guard_refuses_to_arm_for_a_live_port_or_loopback_by_name():
    refusal = hg.arm_refusal({"GSD_HERMETIC_GUARD_ALLOW_PORTS": "18799"})
    assert refusal is not None and "REFUSES TO ARM" in refusal
    assert "18799" in refusal, "the refusal must name the port it refused"

    refusal = hg.arm_refusal({"GSD_HERMETIC_GUARD_ALLOW_HOSTS": "localhost"})
    assert refusal is not None and "REFUSES TO ARM" in refusal

    assert hg.arm_refusal({}) is None

    # install() raises rather than arming with a hole in it.
    saved = os.environ.get("GSD_HERMETIC_GUARD_ALLOW_PORTS")
    os.environ["GSD_HERMETIC_GUARD_ALLOW_PORTS"] = "6379"  # a live port, refused
    try:
        with pytest.raises(hg.GuardArmRefused):
            hg.install()
    finally:
        if saved is None:
            os.environ.pop("GSD_HERMETIC_GUARD_ALLOW_PORTS", None)
        else:
            os.environ["GSD_HERMETIC_GUARD_ALLOW_PORTS"] = saved

    # An allowance can never lift a live-port block even if arm_refusal is bypassed.
    assert hg.decide("127.0.0.1", 5433, env={"GSD_HERMETIC_GUARD_ALLOW_PORTS": "5433"}) == (
        False,
        "live-port",
    )


# ── Mutation 6: loopback on an ephemeral port still works ────────────────────

def test_m6_real_loopback_connection_to_an_ephemeral_port_still_succeeds():
    # The case that breaks the harness if the loopback definition is wrong: the
    # fixture daemon and the fixture RLM bind exactly like this.
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
            conn, _ = server.accept()
            conn.close()
            assert client.fileno() != -1
    finally:
        server.close()


# ── The host is resolved BEFORE the connection ───────────────────────────────

def test_outbound_name_resolution_is_refused_before_any_connection():
    with pytest.raises(RuntimeError, match="HERMETIC GUARD"):
        socket.getaddrinfo("api.voyageai.com", 443)
    # A bare lookup with no port is left alone on purpose: socket.getfqdn()
    # during a server bind must keep working.
    assert socket.getaddrinfo("127.0.0.1", 0)


def test_create_connection_is_guarded_too():
    with pytest.raises(RuntimeError, match="HERMETIC GUARD"):
        socket.create_connection(("203.0.113.9", 443), timeout=1)


# ── Log-only mode records without stopping the run ───────────────────────────

def test_log_only_mode_records_the_refusal_and_lets_the_call_through(log_file, monkeypatch):
    monkeypatch.setenv("GSD_HERMETIC_GUARD_MODE", "log")
    monkeypatch.setenv("GSD_HERMETIC_GUARD_LOG", log_file)
    # _enforce records and returns instead of raising.
    hg._enforce("203.0.113.9", 443, False, ())
    with open(log_file, encoding="utf-8") as fh:
        fields = fh.read().strip().split("\t")
    assert fields[2] == "log"
    assert fields[6] == "non-loopback-ip"


# ── The DSN check libpq DOES obey ────────────────────────────────────────────

def test_conftest_refuses_a_test_dsn_on_a_live_port():
    from conftest import assert_test_dsn_is_not_live

    assert assert_test_dsn_is_not_live("postgresql://u:p@127.0.0.1:5434/db").endswith("/db")
    for live_port in (18799, 18798, 6379, 5433):  # each must be refused
        with pytest.raises(RuntimeError, match="live service port"):
            assert_test_dsn_is_not_live("postgresql://u:p@127.0.0.1:%d/db" % live_port)

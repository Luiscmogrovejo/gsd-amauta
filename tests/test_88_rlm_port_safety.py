"""Plan 88-12 task 01: a daemon never claims a port that is not its own, and never
kills a port holder it did not start.

The incident (2026-11-11): an installer run started a daemon on a non-default port
that still managed RLM on the DEFAULT RLM port, found the operator's live RLM there
and killed it, over and over. These tests drive the real daemon module in-process.
Every port is obtained by binding port 0; every child is reaped by pid in a finally.
Only ``test_default_pair_unchanged`` names the default numbers, and it binds nothing.
"""
import importlib.util
import logging
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

_REPO = Path(__file__).resolve().parent.parent
_DAEMON = _REPO / "services" / "amauta-daemon.py"

# 88-18: there used to be a module-level skipif on the lsof tool being absent here. On Windows it
# silently skipped all seven tests, so plan 88-15-01's pin on tests 4 and 7 would have been a no-op on
# that cell. The tests now always run: where the product's port-holder lookup still needs ``lsof``
# (plan 88-15 replaces it with a portable one) they FAIL and are listed as handed to 88-15, not skipped.

_LISTENER = (
    "import socket,sys,time\n"
    "s=socket.socket()\n"
    "s.bind(('127.0.0.1',int(sys.argv[1])))\n"
    "s.listen(5)\n"
    "print('ready',flush=True)\n"
    "time.sleep(120)\n"
)

_loads = [0]


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _load_daemon(monkeypatch, tmp_path, env):
    """Import a fresh copy of the daemon module under the given environment."""
    for key in ("GSD_RLM_PORT", "GSD_AMAUTA_PORT", "GSD_TEST_MODE", "GSD_RLM_ENABLED"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("AMAUTA_LOG_FILE", "off")
    monkeypatch.setenv("GSD_AMAUTA_NO_AUTO_START", "1")
    monkeypatch.setenv("GSD_FORCE_SQLITE", "1")
    (tmp_path / "data").mkdir(exist_ok=True)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    _loads[0] += 1
    spec = importlib.util.spec_from_file_location("amauta_daemon_88_12_%d" % _loads[0], str(_DAEMON))
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(_REPO / "services"))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.remove(str(_REPO / "services"))
    return mod


# Phase 88 plan 88-15: POSIX encodes the killing signal in the exit status.
# Windows has neither SIGTERM nor SIGKILL -- `signal.SIGKILL` does not even
# exist there, so naming it raises AttributeError before any assertion runs --
# and TerminateProcess sets an exit CODE instead. The contract these two tests
# check is "the daemon stopped this child", so the portable half is asserted
# everywhere and the POSIX signal encoding on POSIX.
_IS_WINDOWS = sys.platform.startswith("win")
_STOPPED_BY_SIGNAL = () if _IS_WINDOWS else (-signal.SIGTERM, -signal.SIGKILL)


def _assert_stopped(child, timeout=5):
    """The child was stopped by the daemon, whatever the platform encodes."""
    status = child.wait(timeout=timeout)
    assert status is not None, "the child is still running"
    if _STOPPED_BY_SIGNAL:
        assert status in _STOPPED_BY_SIGNAL, status


def _spawn_listener(port, script=None):
    """Start a child that listens on `port`; returns the Popen once it is ready."""
    if script is None:
        cmd = [sys.executable, "-c", _LISTENER, str(port)]
    else:
        cmd = [sys.executable, str(script), str(port)]
    child = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, encoding="utf-8")
    line = child.stdout.readline()
    assert line.strip() == "ready", "listener child did not start: %r" % line
    return child


def _reap(child):
    if child is None:
        return
    try:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
    finally:
        if child.stdout:
            child.stdout.close()


def test_default_pair_unchanged(monkeypatch, tmp_path):
    mod = _load_daemon(monkeypatch, tmp_path, {"GSD_AMAUTA_PORT": "18799"})
    assert mod._resolve_rlm_port(18799, {}) == (18798, "default_pair")
    assert mod.RLM_PORT == 18798
    assert mod._rlm_enabled is True


def test_non_default_daemon_port_disowns_rlm(monkeypatch, tmp_path, caplog):
    port = _free_port()
    with caplog.at_level(logging.INFO, logger="amauta.daemon"):
        mod = _load_daemon(monkeypatch, tmp_path, {"GSD_AMAUTA_PORT": str(port)})
    assert mod._resolve_rlm_port(port, {}) == (None, "non_default_daemon_port")
    assert mod._resolve_rlm_port(0, {}) == (None, "non_default_daemon_port")
    assert mod.RLM_PORT is None
    assert mod._rlm_enabled is False
    assert "rlm_unmanaged reason=non_default_daemon_port daemon_port=%d" % port in caplog.text
    # Disowned means _start_rlm does nothing at all, not even a port probe.
    assert mod._start_rlm() is False


def test_explicit_rlm_port_is_honoured(monkeypatch, tmp_path):
    port_a = _free_port()
    port_b = _free_port()
    mod = _load_daemon(
        monkeypatch, tmp_path, {"GSD_AMAUTA_PORT": str(port_a), "GSD_RLM_PORT": str(port_b)}
    )
    assert mod._resolve_rlm_port(port_a, {"GSD_RLM_PORT": str(port_b)}) == (port_b, "explicit")
    assert mod.RLM_PORT == port_b
    assert mod._rlm_enabled is True


def test_foreign_port_holder_is_not_killed(monkeypatch, tmp_path, caplog):
    port = _free_port()
    mod = _load_daemon(monkeypatch, tmp_path, {"GSD_AMAUTA_PORT": str(_free_port())})
    listener = socket.socket()
    try:
        listener.bind(("127.0.0.1", port))
        listener.listen(5)
        mod.RLM_PORT = port
        mod._rlm_enabled = True
        killed = []
        real_kill = os.kill

        def spy_kill(pid, sig):
            if sig != 0:
                killed.append((pid, sig))
            return real_kill(pid, sig)

        monkeypatch.setattr(mod.os, "kill", spy_kill)
        with caplog.at_level(logging.INFO, logger="amauta.daemon"):
            assert mod._start_rlm() is False
        assert killed == [], "a foreign port holder was signalled: %r" % (killed,)
        assert "rlm_port_holder_foreign port=%d pid=%d" % (port, os.getpid()) in caplog.text
        probe = socket.create_connection(("127.0.0.1", port), timeout=2)
        probe.close()
    finally:
        listener.close()


def test_own_child_is_killed(monkeypatch, tmp_path):
    port = _free_port()
    mod = _load_daemon(monkeypatch, tmp_path, {"GSD_AMAUTA_PORT": str(_free_port())})
    child = _spawn_listener(port)
    try:
        monkeypatch.setattr(mod, "_rlm_process", SimpleNamespace(pid=child.pid))
        assert mod._rlm_allowed_pids() >= {child.pid}
        assert mod._kill_port_holder(port, {child.pid}) is True
        _assert_stopped(child)
    finally:
        _reap(child)


def test_kill_port_holder_refuses_empty_allowlist(monkeypatch, tmp_path, caplog):
    port = _free_port()
    mod = _load_daemon(monkeypatch, tmp_path, {"GSD_AMAUTA_PORT": str(_free_port())})
    child = _spawn_listener(port)
    try:
        with caplog.at_level(logging.INFO, logger="amauta.daemon"):
            assert mod._kill_port_holder(port, set()) is False
        assert child.poll() is None
        assert "rlm_port_holder_foreign port=%d pid=%d" % (port, child.pid) in caplog.text
    finally:
        _reap(child)


def _stub_rlm_script(directory):
    script = directory / "rlm-service.py"
    script.write_text(_LISTENER, encoding="utf-8")
    return script


def test_restarted_daemon_reclaims_its_own_orphaned_rlm(monkeypatch, tmp_path, caplog):
    """The restarted live daemon has _rlm_process None; the pid file beside the
    service script is its only handle. GSD_TEST_MODE is unset so the non-test
    branch of the path rule is the one exercised."""
    script_dir = tmp_path / "scripts"
    script_dir.mkdir()
    mod = _load_daemon(monkeypatch, tmp_path, {"GSD_AMAUTA_PORT": str(_free_port())})
    # The helper must resolve beside the (stand-in) service script, not DATA_DIR.
    monkeypatch.setattr(mod, "RLM_SERVICE_PY", str(script_dir / "rlm-service.py"))
    monkeypatch.setattr(mod, "_rlm_process", None)
    assert mod._rlm_pid_file_path() == script_dir.resolve() / "rlm-service.pid"
    assert not str(mod._rlm_pid_file_path()).startswith(str((tmp_path / "data").resolve()))

    # Case A: a real rlm-service.py process recorded in the pid file is ours.
    port_a = _free_port()
    own = None
    stranger = None
    try:
        own = _spawn_listener(port_a, script=_stub_rlm_script(script_dir))
        (script_dir / "rlm-service.pid").write_text(str(own.pid), encoding="utf-8")
        allowed = mod._rlm_allowed_pids()
        assert own.pid in allowed, "pid file %r -> command line seen: %r" % (
            (script_dir / "rlm-service.pid").read_text(encoding="utf-8"), mod._pid_command_line(own.pid))
        assert mod._kill_port_holder(port_a, allowed) is True
        _assert_stopped(own)

        # Case B: a pid in the pid file whose command line is not an RLM service.
        port_b = _free_port()
        stranger = _spawn_listener(port_b)
        (script_dir / "rlm-service.pid").write_text(str(stranger.pid), encoding="utf-8")
        allowed = mod._rlm_allowed_pids()
        assert stranger.pid not in allowed
        with caplog.at_level(logging.INFO, logger="amauta.daemon"):
            assert mod._kill_port_holder(port_b, allowed) is False
        assert stranger.poll() is None
        assert "rlm_port_holder_foreign port=%d pid=%d" % (port_b, stranger.pid) in caplog.text
    finally:
        _reap(own)
        _reap(stranger)

    # The test-mode branch mirrors services/rlm-service.py: data dir when both are set.
    monkeypatch.setenv("GSD_TEST_MODE", "1")
    assert mod._rlm_pid_file_path() == (tmp_path / "data").resolve() / "rlm-service.pid"

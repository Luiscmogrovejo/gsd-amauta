"""Golden POSIX pins for the daemon's and the RLM service's process control.

Phase 88, plan 88-15 task 01: written and green BEFORE a single Windows branch
was added, against the unmodified code at origin/master ``f114bf0``.

Why this file exists
--------------------
Plan 88-15 replaces every ``os.kill``, ``fork``, ``setsid``, ``ps`` and ``lsof``
site in ``services/amauta-daemon.py`` and ``services/rlm-service.py`` with
helpers in ``services/_platform.py``.  That is the code the operator's LIVE
LaunchAgent daemon runs.  88-CONTEXT.md requires every Windows branch to be
additive and the POSIX path to stay behaviourally byte-for-byte identical, so
this file pins -- against today's code -- the argv, the call shape, the
``PermissionError`` behaviour per site and the daemonise parent/child split.
After task 88-15-02 every expectation here must still hold **unedited**.

Hermetic by construction
------------------------
Nothing here binds, connects to or signals anything.  ``os.kill``,
``subprocess.run`` and ``subprocess.Popen`` are replaced by recorders, so the
assertions are about the call the product *would* make.  No live port of the
operator's daemon, RLM, Postgres or Redis appears anywhere in this file, every
port is obtained by binding ('127.0.0.1', 0), and no process is started.
"""

import ast
import importlib.util
import os
import signal
import socket
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

_REPO = Path(__file__).resolve().parents[1]
_DAEMON = _REPO / "services" / "amauta-daemon.py"
_RLM = _REPO / "services" / "rlm-service.py"

_loads = [0]


def _free_port():
    """An ephemeral loopback port the test owns; the socket is closed at once."""
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _load(monkeypatch, tmp_path, module_path, env):
    """Import a service module under the pinned hermetic environment.

    Plan 88-12 verified that importing the daemon with GSD_AMAUTA_NO_AUTO_START=1
    starts no server.
    """
    for key in ("GSD_POSTGRES_URL", "AMAUTA_MEMORY_DATABASE_URL", "DATABASE_URL"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("AMAUTA_LOG_FILE", "off")
    monkeypatch.setenv("GSD_AMAUTA_NO_AUTO_START", "1")
    monkeypatch.setenv("GSD_TEST_MODE", "1")
    monkeypatch.setenv("GSD_FORCE_SQLITE", "1")
    monkeypatch.setenv("AMAUTA_AUTO_BACKUP", "off")
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)
    _loads[0] += 1
    name = "gsd_88_15_%s_%d" % (module_path.stem.replace("-", "_"), _loads[0])
    spec = importlib.util.spec_from_file_location(name, str(module_path))
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(_REPO / "services"))
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.path.remove(str(_REPO / "services"))
    return mod


def _daemon(monkeypatch, tmp_path, env=None):
    base = {"GSD_AMAUTA_PORT": str(_free_port())}
    base.update(env or {})
    return _load(monkeypatch, tmp_path, _DAEMON, base)


def _rlm(monkeypatch, tmp_path, env=None):
    base = {"GSD_RLM_PORT": str(_free_port())}
    base.update(env or {})
    return _load(monkeypatch, tmp_path, _RLM, base)


class _Recorder:
    """Records every call; returns a canned value."""

    def __init__(self, result=None, raises=None, side_effect=None):
        self.calls = []
        self._result = result
        self._raises = raises
        self._side_effect = side_effect

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self._side_effect is not None:
            return self._side_effect(len(self.calls), args, kwargs)
        if self._raises is not None:
            raise self._raises
        return self._result


# ══════════════════════════════════════════════════════════════════════════
# 1. The process command lookup: `ps -ww -o command= -p <pid>` + /proc
# ══════════════════════════════════════════════════════════════════════════

PINNED_PS_ARGV = ["ps", "-ww", "-o", "command=", "-p", "4242"]
PINNED_PS_KWARGS = {"capture_output": True, "text": True, "timeout": 5}


def test_golden_process_command_posix_argv(monkeypatch, tmp_path):
    """_pid_command_line runs exactly `ps -ww -o command= -p <pid>` on POSIX."""
    mod = _daemon(monkeypatch, tmp_path)
    rec = _Recorder(result=SimpleNamespace(returncode=0, stdout="python3 rlm-service.py run\n"))
    monkeypatch.setattr(subprocess, "run", rec)
    out = mod._pid_command_line(4242)
    assert len(rec.calls) == 1, rec.calls
    args, kwargs = rec.calls[0]
    assert list(args[0]) == PINNED_PS_ARGV
    assert kwargs == PINNED_PS_KWARGS
    assert "rlm-service.py" in out


def test_golden_process_command_non_zero_returncode_is_dropped(monkeypatch, tmp_path):
    """A non-zero `ps` exit contributes nothing; the result stays falsy on macOS."""
    mod = _daemon(monkeypatch, tmp_path)
    monkeypatch.setattr(
        subprocess, "run", _Recorder(result=SimpleNamespace(returncode=1, stdout="ignored"))
    )
    assert "ignored" not in mod._pid_command_line(4242)


def test_golden_pid_is_rlm_service_contract(monkeypatch, tmp_path):
    """The identity check is a substring test on the command line, nothing else."""
    mod = _daemon(monkeypatch, tmp_path)
    monkeypatch.setattr(
        subprocess, "run",
        _Recorder(result=SimpleNamespace(returncode=0, stdout="/usr/bin/python3 /x/rlm-service.py run")),
    )
    assert mod._pid_is_rlm_service(4242) is True
    monkeypatch.setattr(
        subprocess, "run", _Recorder(result=SimpleNamespace(returncode=0, stdout="/bin/sleep 900"))
    )
    assert mod._pid_is_rlm_service(4242) is False


def test_golden_process_command_unreadable_is_foreign(monkeypatch, tmp_path):
    """A lookup that fails must widen "foreign", never narrow it."""
    mod = _daemon(monkeypatch, tmp_path)
    monkeypatch.setattr(subprocess, "run", _Recorder(raises=OSError("no ps")))
    assert mod._pid_is_rlm_service(4242) is False


# ══════════════════════════════════════════════════════════════════════════
# 2. The port-holder lookup: port -> pids, `lsof -t -iTCP:<port> -sTCP:LISTEN`
# ══════════════════════════════════════════════════════════════════════════

PINNED_LSOF_KWARGS = {"capture_output": True, "text": True, "timeout": 5}


def test_golden_port_holders_posix_argv(monkeypatch, tmp_path):
    """_port_holder_pids maps PORT -> PIDS with a byte-identical lsof argv."""
    mod = _daemon(monkeypatch, tmp_path)
    port = _free_port()
    rec = _Recorder(result=SimpleNamespace(returncode=0, stdout="111\n222\n"))
    monkeypatch.setattr(subprocess, "run", rec)
    pids = mod._port_holder_pids(port)
    assert pids == [111, 222]
    args, kwargs = rec.calls[0]
    assert list(args[0]) == ["lsof", "-t", "-iTCP:%d" % port, "-sTCP:LISTEN"]
    assert kwargs == PINNED_LSOF_KWARGS


def test_golden_port_holders_failure_is_empty(monkeypatch, tmp_path):
    mod = _daemon(monkeypatch, tmp_path)
    monkeypatch.setattr(subprocess, "run", _Recorder(raises=OSError("no lsof")))
    assert mod._port_holder_pids(_free_port()) == []
    monkeypatch.setattr(
        subprocess, "run", _Recorder(result=SimpleNamespace(returncode=1, stdout=""))
    )
    assert mod._port_holder_pids(_free_port()) == []


# ══════════════════════════════════════════════════════════════════════════
# 3. The liveness probe: os.kill(pid, 0), and the PermissionError edge PER SITE
#
#    Measured on f114bf0: amauta-daemon.py:5359 (start_server) and :5814
#    (check_status), rlm-service.py:1291 (start_server) and :1377
#    (check_status) all catch (ProcessLookupError, ValueError) only, so a
#    PermissionError PROPAGATES today.  _kill_port_holder (:669) catches it and
#    logs rlm_port_kill_permission.  Task 88-15-02 keeps every one of these.
# ══════════════════════════════════════════════════════════════════════════


def test_golden_check_status_probes_with_signal_zero(monkeypatch, tmp_path, capsys):
    mod = _daemon(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    rec = _Recorder(result=None)
    monkeypatch.setattr(os, "kill", rec)
    assert mod.check_status() is True
    assert rec.calls == [((4242, 0), {})]
    assert "Daemon running (PID 4242)" in capsys.readouterr().out


def test_golden_check_status_process_lookup_error_is_stale(monkeypatch, tmp_path, capsys):
    mod = _daemon(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    monkeypatch.setattr(os, "kill", _Recorder(raises=ProcessLookupError()))
    assert mod.check_status() is False
    assert not mod.PID_FILE.exists()
    assert "stale PID file" in capsys.readouterr().out


def test_golden_check_status_permission_error_propagates(monkeypatch, tmp_path):
    """PINNED SITE amauta-daemon.py:5814 -- PermissionError is NOT caught today."""
    mod = _daemon(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    monkeypatch.setattr(os, "kill", _Recorder(raises=PermissionError()))
    with pytest.raises(PermissionError):
        mod.check_status()
    assert mod.PID_FILE.exists(), "the pid file must survive a PermissionError"


def test_golden_start_server_already_running_probe(monkeypatch, tmp_path, capsys):
    """PINNED SITE amauta-daemon.py:5359 -- the probe returns before any bind."""
    mod = _daemon(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    rec = _Recorder(result=None)
    monkeypatch.setattr(os, "kill", rec)
    mod.start_server(foreground=False)
    assert rec.calls == [((4242, 0), {})]
    assert "Daemon already running (PID 4242)" in capsys.readouterr().out


def test_golden_start_server_permission_error_propagates(monkeypatch, tmp_path):
    """PINNED SITE amauta-daemon.py:5359 -- PermissionError is NOT caught today."""
    mod = _daemon(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    monkeypatch.setattr(os, "kill", _Recorder(raises=PermissionError()))
    with pytest.raises(PermissionError):
        mod.start_server(foreground=False)


def test_golden_rlm_check_status_probe_and_permission_edge(monkeypatch, tmp_path, capsys):
    """PINNED SITE rlm-service.py:1377 -- probe with 0; PermissionError propagates."""
    mod = _rlm(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    rec = _Recorder(result=None)
    monkeypatch.setattr(os, "kill", rec)
    assert mod.check_status() is True
    assert rec.calls == [((4242, 0), {})]
    assert "RLM service running (PID 4242)" in capsys.readouterr().out

    monkeypatch.setattr(os, "kill", _Recorder(raises=PermissionError()))
    with pytest.raises(PermissionError):
        mod.check_status()


def test_golden_rlm_start_server_already_running_probe(monkeypatch, tmp_path, capsys):
    """PINNED SITE rlm-service.py:1291 -- probe with 0 before any bind."""
    mod = _rlm(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    rec = _Recorder(result=None)
    monkeypatch.setattr(os, "kill", rec)
    mod.start_server(foreground=False)
    assert rec.calls == [((4242, 0), {})]
    assert "RLM service already running (PID 4242)" in capsys.readouterr().out

    monkeypatch.setattr(os, "kill", _Recorder(raises=PermissionError()))
    with pytest.raises(PermissionError):
        mod.start_server(foreground=False)


# ══════════════════════════════════════════════════════════════════════════
# 4. terminate: SIGTERM, then the SIGKILL escalation with its probe cadence
# ══════════════════════════════════════════════════════════════════════════


def test_golden_stop_server_sigterm_then_one_probe(monkeypatch, tmp_path, capsys):
    mod = _daemon(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    monkeypatch.setattr(mod.time, "sleep", lambda _s: None)

    def effect(n, args, _kwargs):
        if n == 1:
            return None            # the SIGTERM lands
        raise ProcessLookupError()  # the first probe says it is gone

    rec = _Recorder(side_effect=effect)
    monkeypatch.setattr(os, "kill", rec)
    mod.stop_server()
    assert rec.calls == [((4242, signal.SIGTERM), {}), ((4242, 0), {})]
    out = capsys.readouterr().out
    assert "Sent SIGTERM to PID 4242" in out
    assert "Daemon stopped" in out
    assert not mod.PID_FILE.exists()


def test_golden_stop_server_escalates_to_sigkill(monkeypatch, tmp_path, capsys):
    """The pinned cadence: SIGTERM, 20 probes, SIGKILL, 10 probes, then a warning."""
    mod = _daemon(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    monkeypatch.setattr(mod.time, "sleep", lambda _s: None)
    rec = _Recorder(result=None)  # nothing ever dies
    monkeypatch.setattr(os, "kill", rec)
    mod.stop_server()
    signals = [c[0][1] for c in rec.calls]
    assert signals[0] == signal.SIGTERM
    assert signals[1:21] == [0] * 20
    assert signals[21] == signal.SIGKILL
    assert signals[22:] == [0] * 10
    out = capsys.readouterr().out
    assert "did not exit on SIGTERM" in out
    assert "may still be running" in out


def test_golden_rlm_stop_server_sends_sigterm_only(monkeypatch, tmp_path, capsys):
    """PINNED SITE rlm-service.py:1360 -- one SIGTERM, no escalation, no probe."""
    mod = _rlm(monkeypatch, tmp_path)
    mod.PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    mod.PID_FILE.write_text("4242", encoding="utf-8")
    rec = _Recorder(result=None)
    monkeypatch.setattr(os, "kill", rec)
    mod.stop_server()
    assert rec.calls == [((4242, signal.SIGTERM), {})]
    assert "Sent SIGTERM to PID 4242" in capsys.readouterr().out
    assert not mod.PID_FILE.exists()


def test_golden_kill_port_holder_sequence_and_permission_edge(monkeypatch, tmp_path, caplog):
    """PINNED SITE amauta-daemon.py:666/669/670 -- SIGTERM, probe, SIGKILL; a
    PermissionError from either is caught and logged as rlm_port_kill_permission."""
    import logging

    mod = _daemon(monkeypatch, tmp_path)
    port = _free_port()
    monkeypatch.setattr(mod.time, "sleep", lambda _s: None)
    monkeypatch.setattr(
        mod, "_port_holder_pids", lambda _p: [4242]
    )
    rec = _Recorder(result=None)
    monkeypatch.setattr(os, "kill", rec)
    assert mod._kill_port_holder(port, {4242}) is True
    assert [c[0][1] for c in rec.calls] == [signal.SIGTERM, 0, signal.SIGKILL]

    # PermissionError on the SIGTERM: logged, never raised, nothing signalled.
    caplog.clear()
    monkeypatch.setattr(os, "kill", _Recorder(raises=PermissionError()))
    with caplog.at_level(logging.INFO, logger="amauta.daemon"):
        assert mod._kill_port_holder(port, {4242}) is False
    assert "rlm_port_kill_permission pid=4242" in caplog.text


# ══════════════════════════════════════════════════════════════════════════
# 5. The detached start: start_new_session=True on the RLM child
# ══════════════════════════════════════════════════════════════════════════


def test_golden_rlm_child_is_started_detached(monkeypatch, tmp_path):
    """amauta-daemon.py:800 -- the RLM child is spawned with start_new_session=True
    so it survives a daemon restart (the premise of _rlm_allowed_pids)."""
    import urllib.request

    port = _free_port()
    mod = _daemon(
        monkeypatch, tmp_path,
        {"GSD_AMAUTA_PORT": str(_free_port()), "GSD_RLM_PORT": str(port)},
    )
    assert mod.RLM_PORT == port, "an explicit GSD_RLM_PORT wins (88-12 contract)"
    Path(mod.DATA_DIR).mkdir(parents=True, exist_ok=True)
    mod._rlm_enabled = True
    mod._rlm_process = None
    monkeypatch.setattr(mod, "_port_is_free", lambda _p: True)
    monkeypatch.setattr(mod.time, "sleep", lambda _s: None)
    monkeypatch.setattr(
        urllib.request, "urlopen", lambda *a, **k: SimpleNamespace(status=200)
    )
    rec = _Recorder(result=SimpleNamespace(pid=4242))
    monkeypatch.setattr(subprocess, "Popen", rec)
    try:
        assert mod._start_rlm() is True
    finally:
        mod._rlm_process = None
    args, kwargs = rec.calls[0]
    assert list(args[0])[1:] == [mod.RLM_SERVICE_PY, "run"], args[0]
    assert kwargs.get("start_new_session") is True, kwargs
    assert kwargs["env"]["GSD_RLM_PORT"] == str(port)


# ══════════════════════════════════════════════════════════════════════════
# 6. The daemonise parent/child split.
#
#    `daemonize() -> None` could not express what the code does: the PARENT
#    prints "starting in background" and returns, while the CHILD goes on to
#    run start_server.  The pin executes the real `if __name__ == "__main__":`
#    dispatch with os.fork / os.setsid / start_server replaced by recorders --
#    no process is forked and no server is started.  Task 88-15-02's
#    `daemonize() -> 'parent' | 'child'` must reproduce it exactly.
# ══════════════════════════════════════════════════════════════════════════


def _main_block_source(module_path):
    """Source of the `if __name__ == "__main__":` body, dedented."""
    src = module_path.read_text(encoding="utf-8")
    lines = src.splitlines()
    tree = ast.parse(src)
    for node in tree.body:
        if isinstance(node, ast.If) and "__main__" in ast.dump(node.test):
            first = node.body[0].lineno - 1
            last = max(getattr(s, "end_lineno", s.lineno) for s in node.body)
            return textwrap.dedent("\n".join(lines[first:last])) + "\n"
    raise AssertionError("no __main__ block in %s" % module_path)


def _run_start_dispatch(mod, module_path, monkeypatch, fork_result):
    """Execute the real `start` dispatch with fork/setsid/start_server recorded."""
    setsid = _Recorder(result=None)
    started = _Recorder(result=None)
    printed = []
    monkeypatch.setattr(os, "fork", _Recorder(result=fork_result))
    monkeypatch.setattr(os, "setsid", setsid)
    ns = dict(mod.__dict__)
    ns["start_server"] = started
    ns["print"] = lambda *a, **k: printed.append(" ".join(str(x) for x in a))
    ns["sys"] = SimpleNamespace(
        argv=[str(module_path), "start"],
        exit=lambda code=0: (_ for _ in ()).throw(AssertionError("sys.exit(%r)" % code)),
        path=list(sys.path),
        stdout=sys.stdout,
        stderr=sys.stderr,
    )
    exec(compile(_main_block_source(module_path), str(module_path), "exec"), ns)  # noqa: S102
    return setsid, started, printed


def test_golden_daemonize_child_branch_runs_the_server(monkeypatch, tmp_path):
    mod = _daemon(monkeypatch, tmp_path)
    setsid, started, printed = _run_start_dispatch(mod, _DAEMON, monkeypatch, 0)
    assert len(setsid.calls) == 1, "the CHILD detaches with setsid"
    assert started.calls == [((), {"foreground": False})], "the CHILD runs start_server"
    assert printed == [], "the CHILD prints nothing"


def test_golden_daemonize_parent_branch_prints_and_returns(monkeypatch, tmp_path):
    mod = _daemon(monkeypatch, tmp_path)
    setsid, started, printed = _run_start_dispatch(mod, _DAEMON, monkeypatch, 4242)
    assert setsid.calls == [], "the PARENT does not detach"
    assert started.calls == [], "the PARENT does not run start_server"
    assert printed == ["Daemon starting in background..."]


def test_golden_rlm_daemonize_child_and_parent(monkeypatch, tmp_path):
    mod = _rlm(monkeypatch, tmp_path)
    setsid, started, printed = _run_start_dispatch(mod, _RLM, monkeypatch, 0)
    assert len(setsid.calls) == 1
    assert started.calls == [((), {"foreground": False})]
    assert printed == []

    setsid, started, printed = _run_start_dispatch(mod, _RLM, monkeypatch, 4242)
    assert setsid.calls == []
    assert started.calls == []
    assert printed == ["RLM service starting in background..."]

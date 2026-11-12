"""Plan 88-18 task 02: the portable fake executable and the fail-loud Python guard.

Two things every later task of the plan relies on:

* ``tests/support/fake_exe.py`` writes a fake tool that really shadows a PATH-resolved
  one, and joins PATH with ``os.pathsep``.
* The Python socket guard cannot fail open silently in the children the Node runner
  spawns through ``PYTHONPATH``. The detector asserts on the marker the guard leaves on
  ``socket.socket.connect`` (``_gsd_hermetic``); it never dials a service. The refusal
  path is exercised by stubbing the underlying connect before the guard wraps it, so no
  connection leaves the process, guard on or guard off.

Children run with the pinned hermetic environment (built from the parent environment).
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

# Plan 88-16-03: these assertions are ABOUT the refusal, so they pin the guard
# to enforce rather than inheriting the rollout's log-only mode.
pytestmark = pytest.mark.usefixtures("enforcing_guard")

import fake_exe
import hermetic_guard

ROOT = Path(__file__).resolve().parent.parent
SUPPORT = ROOT / "tests" / "support"
PYTHONPATH_DIR = SUPPORT / "pythonpath"
MARKER_PROBE = "import socket; print(getattr(socket.socket.connect, '_gsd_hermetic', False))"


def pinned_env(tmp_path, **extra):
    """Environment for a child: the parent's, with every local service pinned off the live ports.

    Args:
        tmp_path: directory used as the child's data dir.
        **extra: variables added on top.

    Returns:
        dict: a new environment mapping.
    """
    data_dir = Path(tmp_path) / "child-data"
    data_dir.mkdir(exist_ok=True)
    env = {
        **os.environ,
        "GSD_TEST_MODE": "1",
        "AMAUTA_DATA_DIR": str(data_dir),
        "GSD_FORCE_SQLITE": "1",
        "GSD_AMAUTA_PORT": "0",
        "GSD_DAEMON_PORT": "0",
        "GSD_RLM_PORT": "0",
        "AMAUTA_MEMORY_DATABASE_URL": "",
        "GSD_POSTGRES_URL": "",
        "AMAUTA_AUTO_BACKUP": "off",
    }
    env.update(extra)
    return env


def run_child(args, env, **kw):
    """Run ``[sys.executable, *args]`` with captured UTF-8 output.

    Args:
        args: interpreter arguments.
        env: the child environment.
        **kw: forwarded to ``subprocess.run``.

    Returns:
        subprocess.CompletedProcess
    """
    return subprocess.run(
        [sys.executable, *args], env=env, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=60, **kw
    )


# --- fake_exe -----------------------------------------------------------------------------


def test_write_fake_exe_shadows_a_path_resolved_tool(tmp_path):
    name = "gsd-fake-tool-8818"
    real_dir = tmp_path / "real"
    fake_dir = tmp_path / "fake"
    real = fake_exe.write_fake_exe(real_dir, name, "print('REAL')")
    fake = fake_exe.write_fake_exe(fake_dir, name, "import sys; print('FAKE', *sys.argv[1:])")

    # Resolution: the fake directory first wins, on every platform (shutil.which applies PATHEXT).
    search = fake_exe.prepend_path([fake_dir, real_dir], base="")
    resolved = shutil.which(name, path=search)
    assert resolved is not None
    assert Path(resolved).resolve() == Path(fake).resolve()
    assert Path(resolved).resolve() != Path(real).resolve()

    # Execution by the resolved path works on every platform and passes the arguments through.
    out = subprocess.run([resolved, "a", "b"], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert out.returncode == 0, out.stderr
    assert out.stdout.split() == ["FAKE", "a", "b"]

    # A bare-name spawn is shadowed by the PATH on POSIX; on Windows a .cmd cannot do that
    # (subprocess does not apply PATHEXT), which fake_exe documents. Assert each side exactly.
    if sys.platform == "win32":
        assert fake.endswith(".cmd")
        with pytest.raises(FileNotFoundError):
            subprocess.run([name], env={**os.environ, "PATH": search}, capture_output=True, timeout=60)
    else:
        assert os.access(fake, os.X_OK)
        assert (os.stat(fake).st_mode & 0o777) == 0o755
        bare = subprocess.run(
            [name, "x"], env={**os.environ, "PATH": search}, capture_output=True, text=True, encoding="utf-8", timeout=60
        )
        assert bare.returncode == 0, bare.stderr
        assert bare.stdout.split() == ["FAKE", "x"]


def test_write_fake_exe_launcher_shape(tmp_path):
    path = Path(fake_exe.write_fake_exe(tmp_path, "shape", "print(1)"))
    assert (tmp_path / "shape.py").read_text(encoding="utf-8") == "print(1)\n"
    if sys.platform == "win32":
        assert path.name == "shape.cmd"
        assert path.read_bytes().startswith(b"@echo off\r\n")
    else:
        assert path.name == "shape"
        assert path.read_text(encoding="utf-8").startswith("#!/bin/sh\n")


def test_prepend_path_uses_the_platform_separator():
    assert fake_exe.prepend_path(["a", "b"], base="c") == os.pathsep.join(["a", "b", "c"])
    assert fake_exe.prepend_path(["a"], base="") == "a"
    assert fake_exe.prepend_path([], base="c") == "c"
    assert fake_exe.prepend_path(["a"]) == os.pathsep.join(["a", os.environ.get("PATH", "")])
    assert os.pathsep in fake_exe.prepend_path(["x", "y"], base="")


def test_isolated_path_leads_with_the_fakes_and_keeps_only_system_dirs():
    parts = fake_exe.isolated_path("fakes-dir").split(os.pathsep)
    assert parts[0] == "fakes-dir"
    assert len(parts) >= 2
    if sys.platform == "win32":
        assert any(p.lower().endswith("system32") for p in parts[1:])
    else:
        assert parts[1:] == ["/usr/bin", "/bin"]


# --- the guard marker ---------------------------------------------------------------------


def test_the_guard_is_armed_in_this_session():
    """Asserts the marker; it never connects anywhere."""
    assert getattr(__import__("socket").socket.connect, "_gsd_hermetic", False) is True
    assert getattr(__import__("socket").socket.connect_ex, "_gsd_hermetic", False) is True


def test_refusal_path_runs_over_a_stubbed_connect(monkeypatch):
    """Install the guard over a stub connect; a blocked address is refused, an open one reaches the stub.

    The stub records instead of dialling, so no connection leaves the process whichever
    way the guard behaves.
    """
    import socket

    calls = []

    def stub_connect(self, address):
        calls.append(address)

    def stub_connect_ex(self, address):
        calls.append(address)
        return 0

    stub_connect.__name__ = "stub_connect"
    monkeypatch.setattr(socket.socket, "connect", stub_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", stub_connect_ex)
    assert getattr(socket.socket.connect, "_gsd_hermetic", False) is False

    blocked = (hermetic_guard.DEFAULT_BLOCKED[0],)
    assert hermetic_guard.install(blocked=blocked) is True
    assert getattr(socket.socket.connect, "_gsd_hermetic", False) is True

    s = socket.socket()
    try:
        with pytest.raises(RuntimeError, match="HERMETIC GUARD"):
            s.connect(("127.0.0.1", blocked[0]))
        assert calls == []  # refused before the underlying connect was reached
        s.connect(("127.0.0.1", 9))  # an unblocked port reaches the stub, not the network
        assert calls == [("127.0.0.1", 9)]
    finally:
        s.close()


# --- the child-process path (the point of this task) ---------------------------------------


def test_child_spawned_with_pythonpath_arms_the_guard(tmp_path):
    env = pinned_env(tmp_path, PYTHONPATH=str(PYTHONPATH_DIR), GSD_HERMETIC_GUARD_REQUIRED="1")
    env.pop("GSD_HERMETIC_GUARD", None)
    r = run_child(["-c", MARKER_PROBE], env)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "True"


def test_child_without_the_pythonpath_is_not_guarded(tmp_path):
    """The marker test can fail: without sitecustomize on the path the child is unguarded."""
    env = pinned_env(tmp_path)
    env.pop("PYTHONPATH", None)
    env.pop("GSD_HERMETIC_GUARD_REQUIRED", None)
    r = run_child(["-c", MARKER_PROBE], env)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "False"


def _copy_sitecustomize_without_the_guard(tmp_path):
    """A copy of the chaining sitecustomize whose ``../hermetic_guard.py`` does not exist."""
    pydir = Path(tmp_path) / "broken-support" / "pythonpath"
    pydir.mkdir(parents=True)
    shutil.copy(PYTHONPATH_DIR / "sitecustomize.py", pydir / "sitecustomize.py")
    return pydir


def test_required_guard_that_cannot_arm_exits_nonzero_with_a_message(tmp_path):
    pydir = _copy_sitecustomize_without_the_guard(tmp_path)
    env = pinned_env(tmp_path, PYTHONPATH=str(pydir), GSD_HERMETIC_GUARD_REQUIRED="1")
    env.pop("GSD_HERMETIC_GUARD", None)
    r = run_child(["-c", "print('child body ran')"], env)
    assert r.returncode == 70, (r.returncode, r.stdout, r.stderr)
    assert "HERMETIC GUARD NOT ARMED" in r.stderr
    assert "child body ran" not in r.stdout


def test_unrequired_guard_that_cannot_arm_keeps_the_old_chaining_behaviour(tmp_path):
    pydir = _copy_sitecustomize_without_the_guard(tmp_path)
    env = pinned_env(tmp_path, PYTHONPATH=str(pydir))
    env.pop("GSD_HERMETIC_GUARD_REQUIRED", None)
    env.pop("GSD_HERMETIC_GUARD", None)
    r = run_child(["-c", MARKER_PROBE], env)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "False"
    assert "NOT ARMED" not in r.stderr


def test_explicit_opt_out_wins_over_required(tmp_path):
    env = pinned_env(
        tmp_path, PYTHONPATH=str(PYTHONPATH_DIR), GSD_HERMETIC_GUARD_REQUIRED="1", GSD_HERMETIC_GUARD="off"
    )
    r = run_child(["-c", MARKER_PROBE], env)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "False"


def test_the_runner_sets_the_required_variable_for_node_spawned_children():
    src = (ROOT / "scripts" / "run-tests.cjs").read_text(encoding="utf-8")
    assert "GSD_HERMETIC_GUARD_REQUIRED: '1'" in src

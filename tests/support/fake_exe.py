"""Portable fake executables for Python tests (plan 88-18, mirror of ``fake-exe.cjs``).

A test that needs "a tool on PATH that behaves like X" writes a small Python program as
the tool, and puts its directory in front of ``PATH``. Two functions, the same contract as
the Node helper plan 88-14 adds in ``tests/support/fake-exe.cjs``:

``write_fake_exe(dir, name, body)``
    ``body`` is Python source (never shell: a Python body behaves the same on every
    platform, a shell body does not). It is written to ``<dir>/<name>.py`` and a launcher
    is written beside it: on POSIX an executable (mode ``0o755``) ``#!/bin/sh`` script
    named ``<name>`` that ``exec``s ``sys.executable`` on the body; on Windows a
    ``<name>.cmd`` batch shim that does the same. The launcher's path is returned.

``prepend_path(dirs, base=None)``
    Joins ``dirs`` in front of ``base`` (default: the current ``PATH``) with
    ``os.pathsep``, so the same call is right on ``:`` and ``;`` platforms.

Limitation, carried forward from plan 88-14 and the reason a naive fake is useless on
Windows: **a ``.cmd`` shim cannot shadow a bare-name spawn.** Python's ``subprocess``
resolves a bare name on Windows only against ``.exe`` and ``.com``; it does not apply
``PATHEXT``. ``shutil.which`` does apply ``PATHEXT`` (so a ``.cmd`` shim IS found by it),
and a spawn by the launcher's full path works everywhere. A product that spawns a bare
name (``subprocess.run(["docker", ...])``) cannot be shadowed on Windows by this helper.
Where a test needs that, the answer is an environment variable the product reads to pick
the executable. ``GSD_PYTHON`` is introduced by plan 88-15 (wave 9, after this plan) and
is the route that opens later; until then use ``sys.executable`` directly or hand the row
to 88-15. No test written under 88-18 depends on ``GSD_PYTHON``.

Example:
    >>> import tempfile, shutil
    >>> d = tempfile.mkdtemp()
    >>> exe = write_fake_exe(d, "fake-tool", "print('hello from the fake')")
    >>> shutil.which("fake-tool", path=prepend_path([d], base="")) is not None
    True
"""
import os
import shlex
import stat
import sys
from pathlib import Path


def _is_windows():
    """True when the interpreter runs on Windows."""
    return sys.platform == "win32"


def write_fake_exe(directory, name, body):
    """Write a fake executable called ``name`` into ``directory``.

    Args:
        directory: directory that receives the launcher and the body (created if absent).
        name: the tool name without extension, for example ``"lsof"``.
        body: Python source the fake runs; it sees the caller's arguments in ``sys.argv``.

    Returns:
        str: the path of the launcher (``<directory>/<name>`` on POSIX,
        ``<directory>/<name>.cmd`` on Windows).

    Raises:
        OSError: when a file cannot be written.

    Example:
        >>> import tempfile
        >>> p = write_fake_exe(tempfile.mkdtemp(), "t", "print(1)")
        >>> os.path.basename(p) in ("t", "t.cmd")
        True
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    script = directory / (name + ".py")
    script.write_text(body if body.endswith("\n") else body + "\n", encoding="utf-8")
    if _is_windows():
        launcher = directory / (name + ".cmd")
        text = '@echo off\r\n"%s" "%s" %%*\r\n' % (sys.executable, script)
        launcher.write_bytes(text.encode("utf-8"))
        return str(launcher)
    launcher = directory / name
    text = "#!/bin/sh\nexec %s %s \"$@\"\n" % (shlex.quote(sys.executable), shlex.quote(str(script)))
    launcher.write_text(text, encoding="utf-8")
    launcher.chmod(launcher.stat().st_mode | stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
    return str(launcher)


def prepend_path(dirs, base=None):
    """Return a ``PATH`` value with ``dirs`` in front of ``base``.

    Args:
        dirs: iterable of directories, searched in the order given.
        base: the path to extend; ``None`` means the current ``PATH`` (empty if unset).
            An empty string yields only ``dirs``.

    Returns:
        str: the entries joined with ``os.pathsep``.

    Example:
        >>> prepend_path(["a", "b"], base="c") == os.pathsep.join(["a", "b", "c"])
        True
    """
    if base is None:
        base = os.environ.get("PATH", "")
    parts = [str(d) for d in dirs]
    if base:
        parts.append(base)
    return os.pathsep.join(parts)

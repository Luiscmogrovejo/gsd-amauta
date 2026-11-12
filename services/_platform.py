"""Platform differences in one place (Phase 88, plans 88-13 and 88-15).

Nothing here may change POSIX behaviour. Every function is a no-op on a platform that
already behaves correctly, and the Windows branch is strictly additive.

Importable both as ``from _platform import setup_stdio`` (when ``services/`` is on
``sys.path``, which every entry point arranges first) and as
``from services._platform import setup_stdio``.
"""
import io
import os
import signal
import subprocess
import sys
import time

__all__ = [
    "setup_stdio",
    "DaemonizeUnsupported",
    "pid_alive",
    "terminate",
    "daemonize",
    "process_command",
    "port_holders",
    "detached_popen_kwargs",
    "file_lock",
]

# ── Windows plumbing, configurable per ENG-04 (never a hard-coded literal) ────
POWERSHELL_EXE = os.environ.get("GSD_POWERSHELL_EXE") or "powershell.exe"
POWERSHELL_TIMEOUT_S = max(1.0, int(os.environ.get("GSD_POWERSHELL_TIMEOUT_MS") or "20000") / 1000.0)
PS_TIMEOUT_S = 5  # the POSIX `ps` / `lsof` timeout, byte-identical to the pre-88-15 code


def _is_windows(platform=None) -> bool:
    """True when the (optionally injected) platform string is Windows.

    Args:
        platform: ``sys.platform`` override. Tests inject ``"win32"`` or
            ``"darwin"`` so both branches are covered on one machine.

    Returns:
        bool: True for ``win32``.
    """
    return str(platform if platform is not None else sys.platform).startswith("win")


def _is_utf8(stream) -> bool:
    """Report whether a stream already encodes as UTF-8.

    The encoding name is lower-cased and every ``-`` and ``_`` is removed; after that
    reduction the only string that counts as UTF-8 is ``utf8``. That covers ``utf-8``,
    ``UTF-8``, ``utf_8`` and ``UTF8`` with one comparison.

    Args:
        stream: Any text stream; an object without an ``encoding`` attribute is not UTF-8.

    Returns:
        bool: True when the stream's encoding normalises to ``utf8``.
    """
    name = getattr(stream, "encoding", "") or ""
    return str(name).lower().replace("-", "").replace("_", "") == "utf8"


def _reconfigure(stream, replace_name=None) -> bool:
    """Make one stream UTF-8, never raising.

    Args:
        stream: The stream to convert.
        replace_name: ``"stdout"`` or ``"stderr"`` when the stream is the live ``sys``
            attribute, so the fallback path can rebind it; None otherwise.

    Returns:
        bool: True when the stream was reconfigured or replaced.
    """
    try:
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")
            return True
        buffer = getattr(stream, "buffer", None)
        if buffer is not None and replace_name:
            wrapper = io.TextIOWrapper(
                buffer,
                encoding="utf-8",
                errors="backslashreplace",
                line_buffering=bool(getattr(stream, "line_buffering", False)),
            )
            setattr(sys, replace_name, wrapper)
            return True
    except Exception:  # closed stream, detached buffer, a test double: leave it alone
        return False
    return False


def setup_stdio(streams=None) -> bool:
    """Make stdout and stderr UTF-8 when they are not already.

    Windows uses the ANSI code page (cp1252) for a piped stdout, so printing U+25CB
    raises UnicodeEncodeError. Reconfigure only when the stream's encoding is not
    already a UTF-8 alias: on Linux and macOS it is, so this returns False and not one
    byte of output changes. A character that still cannot be encoded degrades to a
    visible backslash escape instead of killing the process. stdin is never touched.

    Args:
        streams: Iterable of streams to convert. None means ``sys.stdout`` and
            ``sys.stderr``. Tests pass their own wrappers.

    Returns:
        bool: True when at least one stream was reconfigured.

    Example:
        if __name__ == "__main__":
            setup_stdio()
            main()
    """
    changed = False
    try:
        if streams is None:
            targets = [(sys.stdout, "stdout"), (sys.stderr, "stderr")]
        else:
            targets = [(s, None) for s in streams]
        for stream, name in targets:
            if stream is None or _is_utf8(stream):
                continue
            if _reconfigure(stream, name):
                changed = True
    except Exception:
        return changed
    return changed


# ═══════════════════════════════════════════════════════════════════════════
# Process control (Phase 88, plan 88-15 task 02)
#
# Python's documentation is explicit: on Windows ``os.kill`` with any signal
# other than CTRL_C_EVENT / CTRL_BREAK_EVENT calls ``TerminateProcess``.  The
# harness used ``os.kill(pid, 0)`` as an "is it alive?" probe at seven sites, so
# on Windows every health check KILLED the daemon it was checking.  Nothing in
# this module may use ``os.kill`` on Windows.
#
# Every POSIX branch below is the pre-88-15 code, unchanged, and is pinned
# byte-for-byte by tests/test_88_15_process_control.py.
# ═══════════════════════════════════════════════════════════════════════════


class DaemonizeUnsupported(RuntimeError):
    """`daemonize()` cannot detach on this platform; re-spawn detached instead.

    Raised on Windows, which has no ``fork``.  The caller must start a fresh
    child with ``detached_popen_kwargs()`` and return.  A typed, catchable error
    is the point: the alternative is an ``AttributeError: module 'os' has no
    attribute 'fork'`` deep inside the start verb.
    """


def _assert_pid(pid) -> int:
    """Validate and normalise a process id.

    A pid reaches a PowerShell ``-Command`` string on Windows, so it is checked
    before it is ever interpolated: only a positive integer gets through.

    Args:
        pid: Candidate process id.

    Returns:
        int: the validated pid.

    Raises:
        TypeError: when `pid` is not an integer (a bool, a string, a float).
        ValueError: when `pid` is not strictly positive.
    """
    if isinstance(pid, bool) or not isinstance(pid, int):
        raise TypeError("pid must be an int, got %r" % (pid,))
    if pid <= 0:
        raise ValueError("pid must be positive, got %r" % (pid,))
    return pid


def _assert_port(port) -> int:
    """Validate a TCP port before it is interpolated into a PowerShell command.

    Args:
        port: Candidate port.

    Returns:
        int: the validated port.

    Raises:
        TypeError: when `port` is not an integer.
        ValueError: when `port` is outside 1..65535.
    """
    if isinstance(port, bool) or not isinstance(port, int):
        raise TypeError("port must be an int, got %r" % (port,))
    if not 1 <= port <= 65535:
        raise ValueError("port must be in 1..65535, got %r" % (port,))
    return port


def _powershell(script, timeout=None):
    """Run a PowerShell script through execFile-style argv (never a shell string).

    Args:
        script: The PowerShell source to run. Callers build it only from values
            already validated by `_assert_pid` / `_assert_port`.
        timeout: Seconds; defaults to GSD_POWERSHELL_TIMEOUT_MS / 1000.

    Returns:
        str | None: stdout on success, None when PowerShell is absent, fails or
        times out. None always means "could not be determined".
    """
    try:
        out = subprocess.run(
            [POWERSHELL_EXE, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout if timeout is not None else POWERSHELL_TIMEOUT_S,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    return out.stdout


# Win32 constants, named rather than inlined so the branch reads as documentation.
SYNCHRONIZE = 0x00100000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_TERMINATE = 0x0001
WAIT_TIMEOUT = 0x00000102
ERROR_ACCESS_DENIED = 5
ERROR_INVALID_PARAMETER = 87


def _load_kernel32():
    """Return ``(kernel32, get_last_error)`` for the Windows branches.

    A seam, not an abstraction: the Windows API cannot be reached from the
    operator's macOS, so the injected-platform tests replace this function with
    a fake and assert on the calls the helper makes. On Windows it is the real
    ``kernel32`` with ``use_last_error`` armed.

    Returns:
        tuple: the kernel32 handle object and a zero-argument last-error getter.
    """
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    return kernel32, ctypes.get_last_error


def _win_pid_alive(pid: int, strict: bool):
    """Windows liveness without signalling: OpenProcess + WaitForSingleObject(0).

    ``os.kill`` is forbidden here -- Python maps it to ``TerminateProcess``, so
    it would kill the very process this function only means to observe.
    """
    kernel32, get_last_error = _load_kernel32()
    handle = kernel32.OpenProcess(
        SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, pid
    )
    if not handle:
        err = get_last_error()
        if err == ERROR_ACCESS_DENIED:
            # The process exists, this token may not look at it -- the same
            # situation POSIX reports as PermissionError.
            if strict:
                raise PermissionError(err, "OpenProcess access denied for pid %d" % pid)
            return True
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)


def pid_alive(pid, *, strict: bool = False, platform=None) -> bool:
    """True when the process exists. MUST NOT signal it.

    POSIX: ``os.kill(pid, 0)``, exactly today's probe. ``ProcessLookupError``
    means the process is gone and returns False.  ``PermissionError`` means the
    process EXISTS but belongs to another user: with ``strict=False`` (the
    default) that returns True; with ``strict=True`` it propagates, which is
    what every pre-88-15 call site did, so those sites pass ``strict=True`` and
    their behaviour is unchanged.

    Windows: ``OpenProcess`` plus ``WaitForSingleObject`` with a zero timeout.
    NEVER ``os.kill``: Python maps every signal but the console-control events
    to ``TerminateProcess``, so the probe would kill its target.

    Args:
        pid: Process id to observe.
        strict: Re-raise ``PermissionError`` instead of answering True.
        platform: ``sys.platform`` override for tests.

    Returns:
        bool: True when the process exists.

    Raises:
        TypeError, ValueError: an invalid pid.
        PermissionError: only when ``strict=True``.

    Example:
        if pid_alive(pid, strict=True):
            print("still running")
    """
    pid = _assert_pid(pid)
    if _is_windows(platform):
        return _win_pid_alive(pid, strict)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        if strict:
            raise
        return True


def _win_terminate(pid: int) -> bool:
    """TerminateProcess(pid). Windows has no graceful signal for another process."""
    kernel32, get_last_error = _load_kernel32()
    handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
    if not handle:
        err = get_last_error()
        if err == ERROR_ACCESS_DENIED:
            raise PermissionError(err, "OpenProcess(PROCESS_TERMINATE) denied for pid %d" % pid)
        if err == ERROR_INVALID_PARAMETER:
            raise ProcessLookupError(err, "no such process: %d" % pid)
        raise OSError(err, "OpenProcess failed for pid %d" % pid)
    try:
        if not kernel32.TerminateProcess(handle, 1):
            raise OSError(get_last_error(), "TerminateProcess failed for pid %d" % pid)
        return True
    finally:
        kernel32.CloseHandle(handle)


def terminate(pid, *, force: bool = False, graceful: bool = True,
              grace_s: float = 0.5, settle_s: float = 0.3, platform=None) -> bool:
    """Ask the process to stop; with force=True, make it stop.

    POSIX, byte-for-byte the pre-88-15 sequence:
      * ``graceful`` (the default) sends SIGTERM;
      * ``force`` then waits ``grace_s``, probes, and sends SIGKILL if the
        process is still there;
      * ``graceful=False, force=True`` sends SIGKILL alone (the escalation half
        of ``stop_server``, whose own retry loop stays in the caller).
    ``ProcessLookupError`` from the first signal and ``PermissionError`` from
    anywhere propagate to the caller, which is what every pre-88-15 call site
    expects.

    Windows: there is no SIGTERM and no SIGKILL. Both phases become
    ``TerminateProcess``; the graceful phase HAS NO WINDOWS EQUIVALENT and the
    process gets no chance to clean up. Documented, not emulated.

    Args:
        pid: Process id to stop.
        force: Escalate to SIGKILL / TerminateProcess.
        graceful: Send the polite signal first.
        grace_s: Seconds between SIGTERM and the escalation probe.
        settle_s: Seconds to wait after SIGKILL for the kernel to reap.
        platform: ``sys.platform`` override for tests.

    Returns:
        bool: True when a signal was delivered.

    Raises:
        ProcessLookupError: the process is already gone.
        PermissionError: the caller may not signal it.
    """
    pid = _assert_pid(pid)
    if not graceful and not force:
        raise ValueError("terminate(graceful=False, force=False) would do nothing")
    if _is_windows(platform):
        return _win_terminate(pid)
    if graceful:
        os.kill(pid, signal.SIGTERM)
        if not force:
            return True
        time.sleep(grace_s)
        try:
            if pid_alive(pid, strict=True, platform=platform):
                os.kill(pid, signal.SIGKILL)
                time.sleep(settle_s)
        except ProcessLookupError:
            pass
        return True
    os.kill(pid, signal.SIGKILL)
    return True


def daemonize(platform=None) -> str:
    """Detach from the controlling terminal. Returns 'parent' or 'child'.

    The return value is not decoration. Today's POSIX code forks, and the
    PARENT prints "starting in background" and returns while the CHILD goes on
    to run ``start_server``; a ``-> None`` signature could not tell the caller
    which side it is on.

    POSIX: ``os.fork()`` + ``os.setsid()``, unchanged.
    Windows: there is no fork. Raises `DaemonizeUnsupported`; the caller
    re-spawns itself with ``detached_popen_kwargs()``.

    Args:
        platform: ``sys.platform`` override for tests.

    Returns:
        str: ``'child'`` in the forked process, ``'parent'`` in the forking one.

    Raises:
        DaemonizeUnsupported: on Windows.
    """
    if _is_windows(platform):
        raise DaemonizeUnsupported(
            "fork() does not exist on Windows; re-spawn with detached_popen_kwargs()"
        )
    if os.fork() == 0:
        os.setsid()
        return "child"
    return "parent"


def detached_popen_kwargs(platform=None) -> dict:
    """The subprocess.Popen keywords that detach a child from this process.

    POSIX: ``start_new_session=True`` -- a new session, so the child survives
    the parent and does not take the parent's terminal signals.
    Windows: ``creationflags=CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS``.
    ``start_new_session`` is silently ignored on Windows, and libuv-style job
    objects kill a non-detached child with its parent, so the two must be
    chosen in one place -- this one.

    Args:
        platform: ``sys.platform`` override for tests.

    Returns:
        dict: keyword arguments for ``subprocess.Popen``.
    """
    if _is_windows(platform):
        create_new_process_group = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        detached_process = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        return {"creationflags": create_new_process_group | detached_process}
    return {"start_new_session": True}


def process_command(pid, *, on_error=None, platform=None):
    """The process's full command line, or None when it cannot be determined.

    POSIX: ``ps -ww -o command= -p <pid>`` (``-ww`` lifts any column cap) joined
    with ``/proc/<pid>/cmdline`` where that exists -- the pre-88-15 body,
    unchanged and argv-pinned.
    Windows: ``Get-CimInstance Win32_Process`` through
    ``powershell.exe -NoProfile -NonInteractive``, execFile-style argv, never a
    shell string; the pid is validated as a positive integer first.

    Returning None MUST make the caller treat the process as FOREIGN, never as
    its own.

    Args:
        pid: Process id to inspect.
        on_error: Optional callable invoked with the exception when the lookup
            fails, so the caller can keep its own log line.
        platform: ``sys.platform`` override for tests.

    Returns:
        str | None: the command line(s), or None when nothing could be read.
    """
    pid = _assert_pid(pid)
    if _is_windows(platform):
        out = _powershell(
            "(Get-CimInstance Win32_Process -Filter 'ProcessId=%d')"
            ".CommandLine" % pid
        )
        if out is None:
            if on_error is not None:
                on_error(OSError("Get-CimInstance Win32_Process failed for pid %d" % pid))
            return None
        out = out.strip()
        return out or None
    parts = []
    try:
        out = subprocess.run(
            ["ps", "-ww", "-o", "command=", "-p", str(int(pid))],
            capture_output=True, text=True, timeout=PS_TIMEOUT_S,
        )
        if out.returncode == 0:
            parts.append(out.stdout)
    except Exception as exc:
        if on_error is not None:
            on_error(exc)
    try:
        with open("/proc/%d/cmdline" % int(pid), "rb") as fh:
            parts.append(fh.read().replace(b"\0", b" ").decode("utf-8", "replace"))
    except (OSError, ValueError):
        pass  # no /proc (macOS) or the process is gone
    joined = " ".join(parts)
    return joined or None


def port_holders(port, *, on_error=None, platform=None):
    """The pids with a LISTEN socket on `port`.

    Note the direction: PORT -> PIDS. A ``listening_ports(pid)`` helper maps the
    other way and could not replace this call.

    POSIX: ``lsof -t -iTCP:<port> -sTCP:LISTEN`` -- byte-identical to the
    pre-88-15 argv, pinned by tests/test_88_15_process_control.py.
    Windows: ``Get-NetTCPConnection -LocalPort <port> -State Listen`` reading
    ``OwningProcess``, through ``powershell.exe -NoProfile -NonInteractive``
    execFile-style; the port is validated as a positive integer first.

    Any failure returns an EMPTY list, which is the safe direction: the caller
    then signals nothing.

    Args:
        port: TCP port to inspect.
        on_error: Optional callable invoked with the exception on failure.
        platform: ``sys.platform`` override for tests.

    Returns:
        list[int]: pids listening on `port`.
    """
    port = _assert_port(port)
    if _is_windows(platform):
        out = _powershell(
            "Get-NetTCPConnection -LocalPort %d -State Listen "
            "-ErrorAction SilentlyContinue | "
            "Select-Object -ExpandProperty OwningProcess" % port
        )
        if out is None:
            if on_error is not None:
                on_error(OSError("Get-NetTCPConnection failed for port %d" % port))
            return []
        raw = out
    else:
        try:
            result = subprocess.run(
                ["lsof", "-t", "-iTCP:%d" % port, "-sTCP:LISTEN"],
                capture_output=True, text=True, timeout=PS_TIMEOUT_S,
            )
        except Exception as exc:
            if on_error is not None:
                on_error(exc)
            return []
        if result.returncode != 0 or not result.stdout.strip():
            return []
        raw = result.stdout
    pids = []
    for line in raw.split():
        try:
            pids.append(int(line))
        except ValueError:
            continue
    return pids


# ═══════════════════════════════════════════════════════════════════════════
# Cross-process file locking (Phase 88, plan 88-15 task 03)
#
# amauta.py used to import fcntl in a try, set it to None on Windows, and then
# guard every lock call with `if fcntl:`.  Its own comment said it: "file
# locking will be skipped".  The in-process reentrancy flag made a single run
# look correct, so nothing failed -- two concurrent `amauta` invocations simply
# lost an update to tasks.json.  A silent no-op is the defect; an explicit
# failure is correctable.
# ═══════════════════════════════════════════════════════════════════════════

# How long file_lock waits for a holder before giving up (ENG-04: a knob with a
# default, never a hard-coded literal). msvcrt.LK_LOCK itself blocks for about
# ten seconds per attempt and then raises; the retry below turns that into one
# bounded wait instead of a spurious failure.
FILE_LOCK_TIMEOUT_S = max(1.0, float(os.environ.get("GSD_FILE_LOCK_TIMEOUT_S") or "120"))
_MSVCRT_LOCK_BYTES = 1  # msvcrt locks a byte range from the current position


def _load_fcntl():
    """The POSIX locking primitive, or None where it does not exist."""
    try:
        import fcntl as _fcntl
        return _fcntl
    except ImportError:
        return None


def _load_msvcrt():
    """The Windows locking primitive, or None where it does not exist."""
    try:
        import msvcrt as _msvcrt
        return _msvcrt
    except ImportError:
        return None


def file_lock(target, *, platform=None, timeout_s=None):
    """Exclusive, cross-process advisory lock on `target`.

    POSIX: ``fcntl.flock(fd, LOCK_EX)`` -- identical to the pre-88-15
    behaviour, including the blocking wait and the ``LOCK_UN`` on exit.

    Windows: ``msvcrt.locking(fd.fileno(), msvcrt.LK_LOCK, 1)``. ``msvcrt``
    locks a byte RANGE from the current file position, so the position is set
    to 0 and exactly one byte is locked; the same range is unlocked on exit
    (locking a region past EOF is legal on Windows and is what makes a
    zero-length lock file work). ``LK_LOCK`` blocks for about ten seconds and
    then raises, so it is retried until ``timeout_s`` is spent -- a long but
    legitimate hold must not read as a failure.

    NEITHER PLATFORM MAY SILENTLY DO NOTHING. With no locking primitive at all
    this raises ``RuntimeError`` naming the platform.

    Args:
        target: A path to open (``"w"``, ``encoding="utf-8"``) and lock, or an
            already-open file object the caller owns and will close itself.
        platform: ``sys.platform`` override for tests.
        timeout_s: Windows retry budget; defaults to GSD_FILE_LOCK_TIMEOUT_S.

    Yields:
        The open file object holding the lock.

    Raises:
        RuntimeError: no locking primitive is available on this platform.
        OSError: the lock could not be taken within the budget.

    Example:
        with file_lock(data_dir / ".amauta.lock"):
            rewrite(tasks_json)
    """
    return _FileLock(target, platform=platform, timeout_s=timeout_s)


class _FileLock:
    """The context manager `file_lock` returns (a class, so it is re-enterable).

    Kept separate from the function so `file_lock(...)` can be stored and
    entered later, which `amauta.py._file_lock` does.
    """

    def __init__(self, target, *, platform=None, timeout_s=None):
        self._target = target
        self._platform = platform
        self._timeout_s = FILE_LOCK_TIMEOUT_S if timeout_s is None else timeout_s
        self._handle = None
        self._owns_handle = False

    def __enter__(self):
        if hasattr(self._target, "fileno"):
            self._handle = self._target
            self._owns_handle = False
        else:
            self._handle = open(self._target, "w", encoding="utf-8")
            self._owns_handle = True
        try:
            self._acquire()
        except BaseException:
            if self._owns_handle:
                self._handle.close()
            self._handle = None
            raise
        return self._handle

    def __exit__(self, *exc):
        handle, self._handle = self._handle, None
        if handle is None:
            return False
        try:
            self._release(handle)
        finally:
            if self._owns_handle:
                handle.close()
        return False

    def _acquire(self):
        if _is_windows(self._platform):
            msvcrt = _load_msvcrt()
            if msvcrt is None:
                raise RuntimeError(
                    "no cross-process file lock on this platform (%s): msvcrt is not "
                    "importable. Refusing to run unlocked -- a silent no-op loses "
                    "updates." % (self._platform or sys.platform)
                )
            deadline = time.monotonic() + self._timeout_s
            while True:
                self._handle.seek(0)
                try:
                    msvcrt.locking(self._handle.fileno(), msvcrt.LK_LOCK, _MSVCRT_LOCK_BYTES)
                    return
                except OSError:
                    # LK_LOCK gives up after ~10s; a legitimate long hold is not
                    # a failure, so retry until the budget is spent.
                    if time.monotonic() >= deadline:
                        raise
        fcntl = _load_fcntl()
        if fcntl is None:
            raise RuntimeError(
                "no cross-process file lock on this platform (%s): neither fcntl nor "
                "msvcrt is importable. Refusing to run unlocked -- a silent no-op "
                "loses updates." % (self._platform or sys.platform)
            )
        fcntl.flock(self._handle, fcntl.LOCK_EX)

    def _release(self, handle):
        if _is_windows(self._platform):
            msvcrt = _load_msvcrt()
            if msvcrt is None:
                return
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, _MSVCRT_LOCK_BYTES)
            except OSError:
                pass  # the handle is about to close, which releases it anyway
            return
        fcntl = _load_fcntl()
        if fcntl is None:
            return
        fcntl.flock(handle, fcntl.LOCK_UN)

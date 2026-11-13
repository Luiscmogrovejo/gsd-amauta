#!/usr/bin/env python3
"""The ONE ``.env`` loader the entry points run at import time (plans 89-09, 89-10).

Until plan 89-09 the loader was four byte-identical copies — ``amauta.py``,
``services/amauta-daemon.py``, ``services/rlm-service.py`` and
``services/amauta-mcp.py`` — kept in step by
``tests/test_88_11_dotenv_loader.py``. They are one module now, so a change here
costs no canary re-baseline.

WHAT IS READ, AND IN WHAT ORDER (plan 89-10, decision 11 of 89-CONTEXT.md)
──────────────────────────────────────────────────────────────────────────
1. **The managed keys file** — ``~/.amauta/env`` (``<home>/.amauta/env``, resolved
   with ``pathlib.Path.home()``), or the ONE file ``GSD_DOTENV_PATH`` names when
   that variable is set. It is the owner-only file the daemon and the CLIs both
   load. It is read FIRST, so its values win over every later file.
2. **The legacy files, exactly as before**: ``<root>/.env`` then
   ``/srv/amauta/.env``; the first of the two that EXISTS is the only one of the
   two that is read.

A variable that is already set in the process environment always wins over every
file. Because of that rule the managed file is a LAYER in front of the legacy
files, not a replacement for them: a name the managed file does not define still
comes from the legacy file, so creating the managed file never switches off
anything an existing ``.env`` supplies.

THE MANAGED FILE MUST BE OWNER-ONLY
───────────────────────────────────
On POSIX a managed file with any group or other permission bit (anything but
``0600`` / ``0400``) is REFUSED: nothing is read from it and
:class:`ManagedEnvPermissionError` is raised, naming the file and the exact
``chmod 600 <path>`` that fixes it. The check is made on the OPEN file
descriptor, so the file that is checked is the file that is read.

On Windows there are no POSIX mode bits and the access-control list is NOT
inspected. The file is read as it is; :func:`permission_state` answers
``"not_checked_windows"`` and ``doctor`` prints that. The file lives under the
user profile, whose default ACL is the user, SYSTEM and Administrators.

The legacy ``.env`` files are not checked: their handling is unchanged.

THE TEST-MODE GUARD (plan 88-11, PR #37) IS INTACT
──────────────────────────────────────────────────
Under :func:`dotenv_suppressed` — ``GSD_TEST_MODE`` in ``{1, true, yes, on}``,
``PYTEST_CURRENT_TEST``, or any name in ``extra_skip`` — NOTHING ambient is
read: not the managed file under the home directory, not a legacy file. The only
file a suppressed process reads is the one ``GSD_DOTENV_PATH`` names, and no
test sets that except deliberately.

NOTHING HERE EVER EMITS A VALUE
───────────────────────────────
No value, prefix, suffix or length of a value is logged, printed, returned by a
reporting function or put into an exception message. Error messages carry a
path and a mode. :func:`key_presence` answers presence and source only.

The loader creates nothing: a missing file is simply not read.

WHY THE ENTRY POINTS LOAD THIS FILE BY PATH
───────────────────────────────────────────
Three of the four run the loader BEFORE their own imports are resolved, and
``amauta.py`` is at the repository root while this module is in ``services/``. A
path load through ``importlib.util.spec_from_file_location`` needs no ``sys.path``
manipulation and behaves identically from either directory. The prelude that does
it is itself byte-identical in all four entry points, and
``tests/test_88_11_dotenv_loader.py`` pins that.

Example:
    >>> import os
    >>> os.environ["GSD_TEST_MODE"] = "1"
    >>> dotenv_suppressed()
    True
    >>> load_dotenv("/nonexistent")          # suppressed: reads nothing
"""
import os
import pathlib
import stat

#: Deployment location the installed daemon has always read second.
DEPLOY_ENV_PATH = "/srv/amauta/.env"

#: The managed keys file, relative to the home directory: ``~/.amauta/env``.
MANAGED_ENV_PARTS = (".amauta", "env")

#: The variable that names the managed keys file explicitly. Honoured in BOTH
#: branches (suppressed and not) since plan 89-10; it replaces the default
#: ``~/.amauta/env``, it does not add a second managed file.
EXPLICIT_PATH_VAR = "GSD_DOTENV_PATH"

#: Permission bits a managed file may not carry on POSIX: anything for the group
#: or for others.
FORBIDDEN_MODE_BITS = 0o077

#: The ``source`` vocabulary of :func:`key_presence`.
SOURCE_MANAGED = "managed_env_file"
SOURCE_PROCESS = "process_env"
SOURCE_REPO = "repo_dotenv"
SOURCE_DEPLOY = "deploy_dotenv"
SOURCE_ABSENT = "absent"

#: The answers of :func:`permission_state`.
PERMISSION_OWNER_ONLY = "owner_only"
PERMISSION_REFUSED = "refused_group_or_world_accessible"
PERMISSION_NOT_CHECKED_WINDOWS = "not_checked_windows"
PERMISSION_FILE_ABSENT = "file_absent"


class ManagedEnvPermissionError(PermissionError):
    """The managed keys file is readable or writable by someone but its owner.

    The message names the file, its mode and the fix. It never contains anything
    read from the file.

    Attributes:
        path: the refused file.
        mode: its permission bits, as an int.
        code: the stable error code, ``"MANAGED_ENV_TOO_OPEN"``.
    """

    code = "MANAGED_ENV_TOO_OPEN"

    def __init__(self, path, mode):
        self.path = str(path)
        self.mode = mode
        super().__init__(
            "refusing to read the keys file %s: its mode is %04o, so it is "
            "accessible by the group or by other users. It must be owner-only. "
            "Fix: chmod 600 %s" % (self.path, mode, self.path)
        )

    def as_dict(self):
        """The structured form: ``{code, message, details}``.

        Returns:
            dict: no key of it holds anything read from the file.
        """
        return {
            "code": self.code,
            "message": str(self),
            "details": {"path": self.path, "mode": "%04o" % self.mode,
                        "fix": "chmod 600 %s" % self.path},
        }


def _env(env=None):
    """``os.environ`` unless a mapping was passed."""
    return os.environ if env is None else env


def dotenv_suppressed(extra_skip=(), env=None):
    """True when this process must not read an ambient ``.env`` file.

    Plan 88-11 task 04: this loader runs at import time in four entry points, so a
    test that imported any of them used to re-inject the operator's live DSN, live
    ports and API keys into an environment ``tests/conftest.py`` had just scrubbed.
    Inside a test session the answer is always True.

    Args:
        extra_skip: extra variable names that switch the loader off when set.
            ``amauta.py`` passes ``("GSD_AMAUTA_NO_AUTO_START",)``; the three
            services pass ``()``.
        env: an extra mapping to consult. It can only ADD a reason to suppress;
            the process environment is always consulted too.

    Returns:
        bool: True when any name in ``extra_skip`` is set, when ``GSD_TEST_MODE`` is
        1/true/yes/on, or when pytest is running (``PYTEST_CURRENT_TEST``, which
        tests/test_88_rlm_port_safety.py needs because it deletes ``GSD_TEST_MODE``
        before importing the daemon). False in every other case, including
        ``GSD_TEST_MODE=0``.

    Example:
        >>> dotenv_suppressed(("A_NAME_NOTHING_SETS",))        # doctest: +SKIP
        False
    """
    # The PROCESS environment is always consulted, and a passed mapping can only
    # ADD a reason to suppress. The guard is about the process: a reporter that
    # is handed a bare mapping inside a test session must not start reading the
    # home directory because the mapping does not mention pytest.
    sources = [os.environ] if env is None or env is os.environ else [os.environ, env]
    for source in sources:
        for name in extra_skip:
            if source.get(name):
                return True
        if (source.get("GSD_TEST_MODE") or "").strip().lower() in ("1", "true", "yes", "on"):
            return True
        if source.get("PYTEST_CURRENT_TEST"):
            return True
    return False


def default_managed_env_path():
    """``<home>/.amauta/env``, or None when the home directory cannot be resolved.

    Returns:
        str or None: the default managed keys file. Nothing is created.

    Example:
        >>> default_managed_env_path().endswith("env")       # doctest: +SKIP
        True
    """
    try:
        return str(pathlib.Path.home().joinpath(*MANAGED_ENV_PARTS))
    except (RuntimeError, KeyError, OSError):
        return None


def managed_env_path(extra_skip=(), env=None):
    """The managed keys file THIS process would read, and whether it was named.

    Args:
        extra_skip: see :func:`dotenv_suppressed`.
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        tuple: ``(path or None, explicit)``. ``GSD_DOTENV_PATH`` wins in both
        branches. Without it the answer is ``~/.amauta/env`` outside a test
        session and None inside one — the test-mode guard.

    Example:
        >>> managed_env_path(env={"GSD_DOTENV_PATH": "/x/env"})
        ('/x/env', True)
    """
    explicit = (_env(env).get(EXPLICIT_PATH_VAR) or "").strip()
    if explicit:
        return os.path.expanduser(explicit), True
    if dotenv_suppressed(extra_skip, env):
        return None, False
    return default_managed_env_path(), False


def _legacy_candidates(root):
    """The two legacy files, in order, each with its ``source`` name."""
    return [(os.path.join(root, ".env"), SOURCE_REPO), (DEPLOY_ENV_PATH, SOURCE_DEPLOY)]


def planned_files(root, extra_skip=(), env=None):
    """Every file this process would read, in precedence order.

    Args:
        root: directory the repository-root ``.env`` is resolved from.
        extra_skip: see :func:`dotenv_suppressed`.
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        list: ``(path, source, managed)`` triples for files that EXIST: the
        managed file first, then the first existing legacy file. Inside a test
        session there is no legacy entry and the managed entry exists only when
        ``GSD_DOTENV_PATH`` names it.

    Example:
        >>> planned_files("/nonexistent", env={"GSD_TEST_MODE": "1"})
        []
    """
    plan = []
    managed, _explicit = managed_env_path(extra_skip, env)
    if managed and os.path.isfile(managed):
        plan.append((managed, SOURCE_MANAGED, True))
    if not dotenv_suppressed(extra_skip, env):
        for candidate, source in _legacy_candidates(root):
            if os.path.isfile(candidate):
                plan.append((candidate, source, False))
                break
    return plan


def _parse(handle):
    """Parse an open ``.env`` file with the rules the daemon has always used.

    Args:
        handle: an open text file.

    Returns:
        list: ``(key, value)`` pairs in file order. Comments, blank lines and
        lines without ``=`` are skipped; one layer of quotes comes off.
    """
    pairs = []
    for line in handle:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip("'\"")
        if key:
            pairs.append((key, val))
    return pairs


def posix_modes_apply():
    """True where a file mode means something (POSIX), False on Windows.

    Returns:
        bool: ``os.name == "posix"``.
    """
    return os.name == "posix"


def read_env_file(path, managed=False):
    """Read one ``.env`` file. Changes nothing in the environment.

    Args:
        path: the file.
        managed: when True the file is the managed keys file and must be
            owner-only on POSIX.

    Returns:
        list: ``(key, value)`` pairs in file order.

    Raises:
        ManagedEnvPermissionError: ``managed`` is True, the platform is POSIX and
            the file has a group or other permission bit. Nothing was read.
        OSError: the file cannot be opened.

    Example:
        >>> read_env_file("/nonexistent")                    # doctest: +SKIP
        Traceback (most recent call last):
        FileNotFoundError: ...
    """
    with open(path, encoding="utf-8") as handle:
        if managed and posix_modes_apply():
            # fstat on the OPEN descriptor: the file checked is the file read,
            # and a symlink is judged by what it points at.
            mode = stat.S_IMODE(os.fstat(handle.fileno()).st_mode)
            if mode & FORBIDDEN_MODE_BITS:
                raise ManagedEnvPermissionError(path, mode)
        return _parse(handle)


def permission_state(path):
    """How the managed file's permissions stand, without reading its content.

    Args:
        path: the managed keys file, or None.

    Returns:
        str: ``"file_absent"``, ``"owner_only"``,
        ``"refused_group_or_world_accessible"``, or ``"not_checked_windows"``
        where there are no POSIX mode bits and the ACL is not inspected.

    Example:
        >>> permission_state(None)
        'file_absent'
    """
    if not path or not os.path.isfile(path):
        return PERMISSION_FILE_ABSENT
    if not posix_modes_apply():
        return PERMISSION_NOT_CHECKED_WINDOWS
    try:
        mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        return PERMISSION_FILE_ABSENT
    return PERMISSION_REFUSED if mode & FORBIDDEN_MODE_BITS else PERMISSION_OWNER_ONLY


def load_dotenv(root, extra_skip=()):
    """Load the managed keys file and the legacy ``.env`` into ``os.environ``.

    A variable that is already set always wins. The managed file
    (``GSD_DOTENV_PATH``, else ``~/.amauta/env``) is read first, then the first
    existing legacy file (``<root>/.env``, else ``/srv/amauta/.env``). Under
    :func:`dotenv_suppressed` only the file ``GSD_DOTENV_PATH`` names is read, and
    nothing at all when it is unset. No file is ever created.

    Args:
        root: directory the repository-root ``.env`` is resolved from.
        extra_skip: see :func:`dotenv_suppressed`.

    Returns:
        str or None: the first file that was read, or None when nothing was.

    Raises:
        ManagedEnvPermissionError: the managed file exists and is accessible by
            the group or by other users (POSIX). Nothing was loaded from it.

    Example:
        >>> load_dotenv("/nonexistent") is None
        True
    """
    first = None
    for candidate, _source, managed in planned_files(root, extra_skip):
        for key, val in read_env_file(candidate, managed=managed):
            if key not in os.environ:  # Don't override existing env
                os.environ[key] = val
        if first is None:
            first = candidate
    return first


def key_presence(names, root, extra_skip=(), env=None):
    """Presence and source of each name — never a value, a prefix or a length.

    The answer describes what an entry point of this install holds after its
    loader has run. It is computed from the environment and the files rather
    than remembered, so it is the same in a process that ran the loader (the
    daemon) and in one that did not (``doctor``).

    Args:
        names: variable names to report.
        root: directory the repository-root ``.env`` is resolved from.
        extra_skip: see :func:`dotenv_suppressed`.
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        dict: ``{name: {"present": bool, "source": str}}`` where ``source`` is
        ``"managed_env_file"``, ``"repo_dotenv"``, ``"deploy_dotenv"``,
        ``"process_env"`` or ``"absent"``. A managed file that is refused for
        its permissions supplies nothing.

    Example:
        >>> key_presence(["A_KEY"], "/nonexistent", env={"GSD_TEST_MODE": "1", "A_KEY": "x"})
        {'A_KEY': {'present': True, 'source': 'process_env'}}
    """
    source_env = _env(env)
    layers = []
    for candidate, source, managed in planned_files(root, extra_skip, env):
        try:
            pairs = read_env_file(candidate, managed=managed)
        except (OSError, UnicodeDecodeError):
            # ManagedEnvPermissionError is an OSError: a refused or unreadable
            # file supplies nothing. permission_state() says why.
            continue
        first_wins = {}
        for key, val in pairs:
            first_wins.setdefault(key, val)
        layers.append((source, first_wins))

    report = {}
    for name in names:
        file_source, file_value = None, None
        for source, pairs in layers:
            if name in pairs:
                file_source, file_value = source, pairs[name]
                break
        if name in source_env:
            current = source_env.get(name) or ""
            if not current:
                # Set but empty: "already set wins", so no file fills it in.
                report[name] = {"present": False, "source": SOURCE_ABSENT}
            elif file_source is not None and file_value == current:
                report[name] = {"present": True, "source": file_source}
            else:
                report[name] = {"present": True, "source": SOURCE_PROCESS}
        elif file_source is not None and file_value:
            report[name] = {"present": True, "source": file_source}
        else:
            report[name] = {"present": False, "source": SOURCE_ABSENT}
    return report

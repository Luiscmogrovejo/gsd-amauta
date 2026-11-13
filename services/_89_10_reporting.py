#!/usr/bin/env python3
"""services/_89_10_reporting.py — which API keys are PRESENT, and from where (plan 89-10).

Decision 11 of 89-CONTEXT.md: the daemon gets its keys through one owner-only
file, ``~/.amauta/env``, that the daemon and the CLIs both load
(``services/_dotenv.py``), and everything that reports on a key reports
**presence only**. This module is that report, contributed through plan 89-09's
hooks (``services/report_hooks.py`` ``PROVIDER_MODULES``), so neither
``services/amauta-daemon.py`` nor the row renderer of ``services/doctor.py`` is
edited for it.

THE CONTRACT
────────────
For each name in :data:`REPORTED_KEYS`::

    {"VOYAGE_API_KEY": {"present": true, "source": "managed_env_file"}}

``source`` is ``managed_env_file``, ``repo_dotenv``, ``deploy_dotenv``,
``process_env`` or ``absent``. **Never a value, never a prefix, never a length**:
a length plus a prefix is a fingerprint. Nothing in this module logs.

``/health`` publishes the fragment as ``extra.keys``; ``doctor`` prints one
``keys`` row. The same resolver answers both.

Example:
    >>> health_fragment({"GSD_TEST_MODE": "1"})["VOYAGE_API_KEY"]
    {'present': False, 'source': 'absent'}
"""
import os

try:
    from services import _dotenv
except ImportError:  # pragma: no cover - script-launched from services/
    import _dotenv

#: The name this provider's ``/health`` fragment is published under
#: (``extra.keys``), instead of the module name with its plan number.
HEALTH_KEY = "keys"

#: The ``doctor`` category of the row.
DOCTOR_CATEGORY = "keys"

#: The keys reported. No Anthropic key: model calls go through the host runtime
#: (decision 8), so the product neither reads nor reports one.
REPORTED_KEYS = ("VOYAGE_API_KEY", "PERPLEXITY_API_KEY", "OPENAI_API_KEY")

#: The fragment key that describes the managed file itself.
FILE_KEY = "_managed_env_file"

#: ``doctor``'s status strings (services/report_hooks.py carries the same three).
STATUS_OK = "OK  "
STATUS_WARN = "WARN"

#: The repository root every entry point resolves ``<root>/.env`` from.
_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def presence(env=None):
    """Presence and source of every reported key.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        dict: ``{name: {"present": bool, "source": str}}`` — see
        ``services/_dotenv.py`` ``key_presence``. No value, prefix or length.

    Example:
        >>> presence({"GSD_TEST_MODE": "1", "VOYAGE_API_KEY": "x"})["VOYAGE_API_KEY"]
        {'present': True, 'source': 'process_env'}
    """
    return _dotenv.key_presence(REPORTED_KEYS, _ROOT, env=env)


def is_present(name, env=None):
    """True when ``name`` is present for this install's entry points.

    Args:
        name: a variable name.
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        bool: presence only.

    Example:
        >>> is_present("VOYAGE_API_KEY", {"GSD_TEST_MODE": "1"})
        False
    """
    return _dotenv.key_presence((name,), _ROOT, env=env)[name]["present"]


def managed_file_state(env=None):
    """Where the managed keys file is and how its permissions stand.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        dict: ``path`` (None inside a test session with no ``GSD_DOTENV_PATH``),
        ``explicit`` (True when ``GSD_DOTENV_PATH`` named it), ``exists`` and
        ``permissions`` — ``owner_only``, ``refused_group_or_world_accessible``,
        ``not_checked_windows`` or ``file_absent``. Nothing read from the file.

    Example:
        >>> managed_file_state({"GSD_TEST_MODE": "1"})["exists"]
        False
    """
    path, explicit = _dotenv.managed_env_path(env=env)
    return {
        "path": path,
        "explicit": explicit,
        "exists": bool(path) and os.path.isfile(path),
        "permissions": _dotenv.permission_state(path),
    }


def health_fragment(env=None):
    """The ``/health`` fragment, published as ``extra.keys``.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        dict: one ``{"present", "source"}`` entry per reported key, plus
        ``"_managed_env_file"`` describing the file.

    Example:
        >>> sorted(health_fragment({"GSD_TEST_MODE": "1"}))[0]
        'OPENAI_API_KEY'
    """
    fragment = dict(presence(env))
    fragment[FILE_KEY] = managed_file_state(env)
    return fragment


def doctor_rows(env=None):
    """The ``doctor`` row: presence and source per key, and the file's state.

    WARN only when the managed file is REFUSED for its permissions — that is a
    misconfiguration with a one-line fix. An absent key is not a warning (the
    keys are optional features, and ``--strict`` promotes a warning to a
    failure), and neither is Windows, where the mode cannot be checked.

    Args:
        env: mapping to read; ``os.environ`` when omitted.

    Returns:
        list: one ``(status, category, detail, data)`` tuple.

    Example:
        >>> doctor_rows({"GSD_TEST_MODE": "1"})[0][1]
        'keys'
    """
    keys = presence(env)
    state = managed_file_state(env)
    parts = [
        "%s %s" % (name, "present (%s)" % keys[name]["source"] if keys[name]["present"] else "absent")
        for name in REPORTED_KEYS
    ]
    status = STATUS_OK
    permissions = state["permissions"]
    if state["path"] is None:
        file_text = "keys file not read in a test session (set GSD_DOTENV_PATH to name one)"
    elif permissions == _dotenv.PERMISSION_FILE_ABSENT:
        file_text = "keys file %s does not exist" % state["path"]
    elif permissions == _dotenv.PERMISSION_REFUSED:
        status = STATUS_WARN
        file_text = ("keys file %s is REFUSED: it is accessible by the group or by other "
                     "users. Fix: chmod 600 %s" % (state["path"], state["path"]))
    elif permissions == _dotenv.PERMISSION_NOT_CHECKED_WINDOWS:
        file_text = ("keys file %s is read; its permissions are NOT checked on Windows "
                     "(no POSIX mode, the ACL is not inspected)" % state["path"])
    else:
        file_text = "keys file %s is owner-only" % state["path"]
    data = dict(keys)
    data[FILE_KEY] = state
    return [(status, DOCTOR_CATEGORY, "%s; %s" % ("; ".join(parts), file_text), data)]

#!/usr/bin/env python3
"""The ONE ``.env`` loader the entry points run at import time (plan 89-09 task 03).

Until this module existed the loader was four byte-identical copies — ``amauta.py``,
``services/amauta-daemon.py``, ``services/rlm-service.py`` and
``services/amauta-mcp.py`` — kept in step by
``tests/test_88_11_dotenv_loader.py``. Two of the four
(``services/amauta-mcp.py`` by all four canaries, and the daemon by none) are
byte-pinned, so a one-line change to the loader cost up to four canary
re-baselines. The drift the old test DETECTED is now impossible by construction,
and a change here costs no re-baseline at all.

**This module changes no behaviour.** It is the four copies, verbatim, with the two
per-file names turned into arguments:

* candidates: ``<root>/.env`` then ``/srv/amauta/.env``, first that EXISTS wins and
  the loop stops there;
* a variable that is already set always wins;
* comments, blank lines and lines without ``=`` are skipped; one layer of quotes
  comes off;
* nothing at all is read when :func:`dotenv_suppressed` is true — under
  ``GSD_TEST_MODE`` in ``{1, true, yes, on}``, under ``PYTEST_CURRENT_TEST``, or when
  any name in ``extra_skip`` is set;
* ``GSD_DOTENV_PATH`` is honoured **only when suppressed**: it is the single opt-in
  that exists so the loader's own tests can drive the parser without an ambient file.

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

#: Deployment location the installed daemon has always read second.
DEPLOY_ENV_PATH = "/srv/amauta/.env"


def dotenv_suppressed(extra_skip=()):
    """True when this process must not read an ambient ``.env`` file.

    Plan 88-11 task 04: this loader runs at import time in four entry points, so a
    test that imported any of them used to re-inject the operator's live DSN, live
    ports and API keys into an environment ``tests/conftest.py`` had just scrubbed.
    Inside a test session the answer is always True.

    Args:
        extra_skip: extra variable names that switch the loader off when set.
            ``amauta.py`` passes ``("GSD_AMAUTA_NO_AUTO_START",)``; the three
            services pass ``()``.

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
    for name in extra_skip:
        if os.environ.get(name):
            return True
    if os.environ.get("GSD_TEST_MODE", "").strip().lower() in ("1", "true", "yes", "on"):
        return True
    return bool(os.environ.get("PYTEST_CURRENT_TEST"))


def load_dotenv(root, extra_skip=()):
    """Load a ``.env`` file into ``os.environ`` (simple parser, no dependency).

    A variable that is already set always wins; comments, blank lines and lines
    without ``=`` are skipped; one layer of quotes comes off; the first candidate
    that exists is the only one read. Outside test mode the candidates are
    ``<root>/.env`` then ``/srv/amauta/.env``, exactly as the installed daemon has
    always read them. Under :func:`dotenv_suppressed` nothing is read at all, unless
    ``GSD_DOTENV_PATH`` names one file — the single opt-in, which exists so the
    loader's own tests can drive the parser without an ambient file.

    Args:
        root: directory the repository-root ``.env`` is resolved from.
        extra_skip: see :func:`dotenv_suppressed`.

    Returns:
        str or None: the candidate that was read, or None when nothing was.

    Example:
        >>> load_dotenv("/nonexistent") is None
        True
    """
    if dotenv_suppressed(extra_skip):
        explicit = os.environ.get("GSD_DOTENV_PATH", "")
        if not explicit:
            return None
        candidates = [explicit]
    else:
        candidates = [os.path.join(root, ".env"), DEPLOY_ENV_PATH]
    for candidate in candidates:
        if os.path.isfile(candidate):
            with open(candidate, encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip("'\"")
                    if key and key not in os.environ:  # Don't override existing env
                        os.environ[key] = val
            return candidate
    return None

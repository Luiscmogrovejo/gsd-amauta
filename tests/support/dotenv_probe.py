"""Probe for the import-time ``.env`` loaders (Phase 88, plan 88-11 task 04).

Four entry points — ``amauta.py``, ``services/amauta-daemon.py``,
``services/rlm-service.py`` and ``services/amauta-mcp.py`` — each run the loader
at IMPORT time, before their own imports are resolved. Exercising that loader
therefore means importing one of those files, and each file decides which ``.env``
to read from its own ``__file__``. So the probe copies one entry point into a
temporary tree, gives THAT tree a ``.env`` holding sentinel values, and imports the
copy in a child interpreter.

Plan 89-09 task 03 replaced the four copies of the loader by ONE module,
``services/_dotenv.py``, which each entry point loads FROM ITS PATH
(``<root>/services/_dotenv.py``, where ``<root>`` is the repository root for all
four). :func:`build_tree` therefore copies that module into the temporary tree
beside the entry point — without it the prelude would raise and the probe would
report a module that died before the loader. The path load goes through
``importlib.util.spec_from_file_location``, which does NOT consult
``sys.meta_path``, so :class:`_StopAtFirstForeignImport` below does not see it and
the loader still runs to completion.

The repository's own ``.env`` is never read, written, moved or copied. On the
operator's machine it holds live credentials and the live service ports — which
is exactly the hermeticity defect this probe exists to pin — and a test that
needed it would be a test nobody else could run.

The child stops the module at its first non-stdlib import. Every one of the four
loaders sits at the top of its file with nothing but stdlib imports above it, so
the prologue is all that has to execute, and stopping there keeps the probe from
opening a connection pool, binding a port or spawning a service. The stop is a
``BaseException`` subclass on purpose: the product wraps optional imports in
``except ImportError`` / ``except Exception``, and a stop those could swallow
would let the module run on and report a clean environment for the wrong reason.

Example:
    >>> import dotenv_probe                                  # doctest: +SKIP
    >>> target = dotenv_probe.build_tree(tmp, "amauta.py")    # doctest: +SKIP
    >>> dotenv_probe.probe(target)["GSD_DOTENV_SENTINEL"]     # doctest: +SKIP
    'leaked-from-dotenv'
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

#: Repository root — ``tests/support/dotenv_probe.py`` is two directories down.
REPO = Path(__file__).resolve().parent.parent.parent

#: The four entry points that carry the loader, as repository-relative POSIX paths.
ENTRY_POINTS = (
    "amauta.py",
    "services/amauta-daemon.py",
    "services/rlm-service.py",
    "services/amauta-mcp.py",
)

#: Marker the child prints its JSON report behind, so product chatter on stdout
#: (``services/amauta-mcp.py`` writes a warning line) cannot be mistaken for it.
MARKER = "GSD_PROBE_JSON "

#: Sentinel names the probe asks the child about. ``GSD_POSTGRES_URL`` and the
#: API key are the names that actually leaked on the operator's machine; the
#: DSN names port 1, which is nothing, because a sentinel that named a live port
#: would be the defect rather than a test for it.
SENTINEL_KEYS = (
    "GSD_DOTENV_SENTINEL",
    "GSD_POSTGRES_URL",
    "VOYAGE_API_KEY",
)

#: The sentinel ``.env`` body. One key per name above.
SENTINEL_ENV = (
    "GSD_DOTENV_SENTINEL=leaked-from-dotenv\n"
    "GSD_POSTGRES_URL=postgresql://sentinel@127.0.0.1:1/none\n"
    "VOYAGE_API_KEY=sentinel-not-a-real-key\n"
)

#: The ONE loader module every entry point loads by path (plan 89-09 task 03).
#: Copied into every probe tree, because without it the prelude raises.
LOADER_REL = "services/_dotenv.py"

#: Names whose presence changes what the loader does. The probe removes all of
#: them from the child's environment and the caller puts back only what the
#: case under test is about.
MARKER_KEYS = (
    "GSD_TEST_MODE",
    "GSD_DOTENV_PATH",
    "PYTEST_CURRENT_TEST",
    "GSD_AMAUTA_NO_AUTO_START",
)


def build_tree(root, rel, env_text=SENTINEL_ENV, env_name=".env", loader=True):
    """Copy one entry point into ``root`` and give the tree its own ``.env``.

    The loader module :data:`LOADER_REL` is copied too, because every entry point
    loads it from ``<root>/services/_dotenv.py`` (plan 89-09 task 03).

    Args:
        root: directory to build the tree in (a pytest ``tmp_path``).
        rel: one of :data:`ENTRY_POINTS`.
        env_text: body of the ``.env`` file; None writes no file at all.
        env_name: file name to write ``env_text`` to, relative to ``root``.
        loader: whether to copy the loader module; False builds a DELIBERATELY
            broken tree, which is how a case proves the prelude is load-bearing.

    Returns:
        pathlib.Path: the copied entry point, ready to hand to :func:`probe`.

    Raises:
        FileNotFoundError: when ``rel`` does not name a file in the repository.
    """
    root = Path(root)
    parts = rel.split("/")
    dest = root.joinpath(*parts)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REPO.joinpath(*parts), dest)
    if loader:
        loader_parts = LOADER_REL.split("/")
        loader_dest = root.joinpath(*loader_parts)
        loader_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO.joinpath(*loader_parts), loader_dest)
    if env_text is not None:
        (root / env_name).write_text(env_text, encoding="utf-8")
    return dest


def child_env(**overrides):
    """The child's environment: this process's, minus every name under test.

    Both the sentinel names and the loader's marker names are removed, so a
    value the child reports can only have come from a ``.env`` the probe wrote
    or from ``overrides``.

    Args:
        **overrides: names to put back (``GSD_TEST_MODE="1"`` and friends).

    Returns:
        dict: an environment mapping for :func:`subprocess.run`.
    """
    env = dict(os.environ)
    for key in tuple(SENTINEL_KEYS) + tuple(MARKER_KEYS):
        env.pop(key, None)
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = str(value)
    return env


def probe(target, keys=SENTINEL_KEYS, env=None, timeout=120):
    """Import ``target`` in a child interpreter and report what it injected.

    Args:
        target: the copied entry point returned by :func:`build_tree`.
        keys: environment names to report.
        env: the child's environment; :func:`child_env` when omitted.
        timeout: seconds to wait for the child.

    Returns:
        dict: ``{name: value or None}`` as the child's ``os.environ`` held it
        after the module's prologue ran.

    Raises:
        AssertionError: when the child printed no report, which means it died
            before the loader rather than deciding not to read anything.
    """
    target = Path(target)
    keys = tuple(keys)
    proc = subprocess.run(
        [sys.executable, "-I", str(Path(__file__).resolve()), str(target), ",".join(keys)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=child_env() if env is None else env,
        cwd=str(target.parent),
    )
    report = None
    for line in (proc.stdout or "").splitlines():
        if line.startswith(MARKER):
            report = json.loads(line[len(MARKER):])
    assert report is not None, (
        "the probe child printed no report for %s\n--- stdout ---\n%s\n--- stderr ---\n%s"
        % (target, proc.stdout, proc.stderr)
    )
    return report


# ─── Child side ───────────────────────────────────────────────────────────────


class _ProbeStop(BaseException):
    """Ends the module under probe at its first non-stdlib import.

    Derived from ``BaseException`` rather than ``Exception`` so the product's
    own ``except ImportError`` / ``except Exception`` guards around optional
    imports cannot swallow it and let the module run on.
    """


class _StopAtFirstForeignImport:
    """A meta-path finder that answers every non-stdlib name with a stop."""

    def find_spec(self, fullname, path=None, target=None):
        """Let stdlib through; stop the module on anything else.

        Args:
            fullname: the module name being imported.
            path: unused, part of the finder protocol.
            target: unused, part of the finder protocol.

        Returns:
            None: always, for stdlib names, so the normal finders answer.

        Raises:
            _ProbeStop: for any module outside the standard library.
        """
        if fullname.partition(".")[0] in sys.stdlib_module_names:
            return None
        raise _ProbeStop(fullname)


def _main(argv):
    """Run one probe: import the target, then print the requested names.

    Args:
        argv: ``[target, "KEY1,KEY2"]``.

    Returns:
        int: 0 — the report is the result; a module that stopped early is
        normal and is recorded on stderr for the host to show on failure.
    """
    import runpy

    target, keys = argv[0], [k for k in argv[1].split(",") if k]
    sys.meta_path.insert(0, _StopAtFirstForeignImport())
    try:
        runpy.run_path(target, run_name="_gsd_dotenv_probe")
    except _ProbeStop as stop:
        sys.stderr.write("probe: stopped at the first foreign import: %s\n" % stop)
    except BaseException as exc:  # noqa: BLE001 - reported, never hidden
        sys.stderr.write("probe: module ended with %s: %s\n" % (type(exc).__name__, exc))
    sys.stdout.write(MARKER + json.dumps({k: os.environ.get(k) for k in keys}) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))

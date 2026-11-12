#!/usr/bin/env python3
"""Verified backup snapshots for GSD-Amauta — create, verify, restore, prune.

WHY THIS MODULE EXISTS
──────────────────────
On 2026-11-12 an installer run changed the operator's PostgreSQL with no backup
in place.  The three things that were supposed to cover that case did not:

* ``services/backup.py`` ``BackupManager`` is a **partial logical export**.  It
  strips every embedding (``services/pg_store.py:456``, ``:2982``, ``:3281`` —
  three sites) and covers 6 of about 22 tables.  A restore from it is not a
  restore.
* ``scripts/backup.sh`` hard-coded a credentialed DSN and ended its dump line
  with ``&& echo ok || echo skipped``, so a FAILED dump exited 0 and the script
  carried on.  No checksum, no manifest, no verification, no restore test.
* ``scripts/restore.sh`` piped a dump into ``psql`` with no ``ON_ERROR_STOP``
  and with stderr discarded, so a partial restore printed "restored".

This module is the replacement, and its central property is that **verification
is part of taking a backup, not a later option**: :func:`create` runs
:func:`verify` on its own output and writes ``verified_at`` / ``verify_result``
only when every check passes.  A snapshot whose manifest lacks ``verified_at``
is treated as ABSENT by ``services/backup_guard.py``.  That is what makes
"verified backups" mechanical rather than aspirational.

CONTAINMENT
───────────
No DSN literal appears in this file and none is ever written to disk.  The
manifest records ``dsn_fingerprint = sha256("host:port/database")[:16]`` and
nothing else about the connection; a password is never read into a manifest, a
log line or an argv (``PGPASSWORD`` carries it to the child process instead, so
it does not appear in a process listing).  ``services/pg_dsn.py`` resolves every
DSN; this module never invents one.

WINDOWS AND macOS ARE FIRST-CLASS
─────────────────────────────────
* The SQLite leg uses Python's online-backup API,
  ``sqlite3.Connection.backup()``, followed by ``PRAGMA integrity_check`` on the
  copy.  There is no `sqlite3` binary on Windows at all, and a plain file copy
  of a WAL database is not a backup.
* ``tasks.json`` is copied under the SAME cross-process lock ``amauta.py`` takes
  (``amauta.py:511`` ``_LOCK_FILE = DATA_DIR / ".amauta.lock"``, ``:514-557``
  ``_file_lock`` over ``services/_platform.file_lock``), not an invented one.
* Every external tool is resolved through ``services/_platform.which`` and
  spawned as an argv list.  No shell string, ever.

THE ``pg_dump`` RESOLUTION ORDER (measured in task 89-04-01, not assumed)
────────────────────────────────────────────────────────────────────────
1. ``GSD_PG_DUMP_BIN`` / ``GSD_PG_RESTORE_BIN`` when set — an absolute path,
   validated to exist;
2. a host ``pg_dump`` whose MAJOR version is >= the server's;
3. ``docker exec <container> pg_dump`` **only** when
   ``GSD_BACKUP_ALLOW_DOCKER=1`` is set explicitly, so neither a default path
   nor any test can invoke Docker;
4. otherwise the typed error ``pg_dump_unavailable``, naming both environment
   variables and the measured client and server versions.

Usage::

    python3 services/backup_snapshot.py create --reason manual --scope all
    python3 services/backup_snapshot.py verify --latest --reason pre-migration
    python3 services/backup_snapshot.py restore <dir> --mode replace --confirm
    python3 services/backup_snapshot.py for migrations
    python3 services/backup_snapshot.py prune --dry-run
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from services import _platform
    from services.pg_dsn import (UnconfiguredPostgresDSN, dsn_parts,
                                 local_docker_dsn, mask_dsn, require_dsn,
                                 resolve_dsn)
except ImportError:  # pragma: no cover - script-launched from services/
    import _platform
    from pg_dsn import (UnconfiguredPostgresDSN, dsn_parts, local_docker_dsn,
                        mask_dsn, require_dsn, resolve_dsn)

__all__ = [
    "REASONS",
    "GUARD_ACCEPTED_REASONS",
    "SUBCOMMANDS",
    "SCOPES",
    "MANIFEST_SCHEMA",
    "STEP_SNAPSHOTS",
    "BackupError",
    "create",
    "verify",
    "restore",
    "prune",
    "list_snapshots",
    "latest_snapshot",
    "read_manifest",
    "for_step",
    "find_tool",
    "resolve_pg_tool",
    "server_major_version",
    "describe_resolution_order",
    "dsn_fingerprint",
    "main",
]

#: The manifest schema version this module writes and reads.
MANIFEST_SCHEMA = 1

#: The CLOSED `--reason` enum.  Every caller in Phase 89 must be in it, and a
#: later plan needing a value that is absent means THE ENUM IS WRONG, not the
#: caller: an ``argparse`` ``choices=`` rejection of a value the live cutover
#: types is exactly the class of defect that produced the 2026-11-12 incident.
#:
#: Who uses each:
#:   pre-migration           plan 89-11 installer (`migrations`,
#:                           `apply_upgrade_migrations`), migrate_runner,
#:                           migrate_sqlite_to_pg
#:   pre-upgrade             plan 89-11 installer (`detect_infra`,
#:                           `restart_daemon`, container start)
#:   pre-rebuild             plan 89-14 cutover, the drop-and-recreate step
#:   pre-reingest            plan 89-14 cutover step 13.  It exists SO THAT
#:                           step 5 and step 13 do not share `pre-rebuild`:
#:                           they would, and `verify --latest --reason
#:                           pre-rebuild` would then resolve to the later one,
#:                           pointing step 6's and step 7's rollbacks at the
#:                           wrong snapshot.
#:   pre-restore             taken by `restore` for itself, before it writes
#:   post-load               plan 89-14, after the SQLite load
#:   pre-cutover             plan 89-14 step 0
#:   pre-embedding-cutover   plan 89-14, before the blue/green vector switch
#:   post-cutover            plan 89-14, the final snapshot
#:   manual                  an operator, never pruned automatically
#:   auto                    the daemon's daily snapshot, keep the last 7
REASONS = (
    "pre-migration",
    "pre-upgrade",
    "pre-rebuild",
    "pre-reingest",
    "pre-restore",
    "post-load",
    "pre-cutover",
    "pre-embedding-cutover",
    "post-cutover",
    "manual",
    "auto",
)

#: The reasons the guard accepts as evidence of a deliberate pre-step snapshot:
#: every data-touching reason, plus ``manual``.  ``auto`` is excluded on purpose
#: — a daily background snapshot is not evidence that anybody thought about THIS
#: step, which is the whole point of the guard.
GUARD_ACCEPTED_REASONS = frozenset(r for r in REASONS if r != "auto")

#: What a snapshot may cover.
SCOPES = ("all", "postgres", "sqlite", "tasks")

#: The six subcommands, exported as a VALUE SET so a caller (and plan 89-11's
#: ``gsd-tools backup`` dispatch) can compare rather than grep.  Every
#: ``add_parser`` call in this module also passes ``help=``, as every
#: ``add_parser`` in this repository's ``services/`` does, so a text match of
#: the shape ``add_parser('create')`` cannot see them; the parser itself is the
#: authority and :data:`SUBCOMMANDS` is asserted against it by test.
SUBCOMMANDS = ("create", "list", "verify", "restore", "prune", "for")

#: Retention by reason (decision in 89-04-PLAN.md).  ``auto`` keeps the last 7,
#: matching today's ``services/backup.py`` ``auto_backup``; ``manual`` is never
#: pruned automatically; every other reason is kept 30 days and never fewer than
#: the last 3.  Any reason added to :data:`REASONS` later falls into the
#: 30-day class by construction, which is the safe direction.
AUTO_KEEP = 7
REASON_KEEP_DAYS = 30
REASON_KEEP_MIN = 3

#: ``backup for <step>`` — the convenience a refused step names as its remedy.
#: The keys are the step names plan 89-11 wires into ``bin/init.cjs`` and the
#: ones plan 89-14's cutover uses.
STEP_SNAPSHOTS = {
    "detect_infra": ("pre-upgrade", "all"),
    "migrations": ("pre-migration", "all"),
    "apply_upgrade_migrations": ("pre-migration", "all"),
    "restart_daemon": ("pre-upgrade", "all"),
    "container_start": ("pre-upgrade", "all"),
    "install": ("pre-upgrade", "all"),
    "upgrade": ("pre-upgrade", "all"),
    "sqlite-to-pg": ("pre-migration", "all"),
    "rebuild": ("pre-rebuild", "all"),
    "reingest": ("pre-reingest", "all"),
    "cutover": ("pre-cutover", "all"),
    "embedding-cutover": ("pre-embedding-cutover", "all"),
}

#: The three files the 2026-11-12 incident proved matter, plus the task store.
TASK_SCOPE_FILES = (
    "tasks.json",
    "tasks.json.bak",
    "install_record.json",
    "last_backend",
    "pg_retry_queue.json",
)

#: The SQLite copy's name inside a snapshot.
SQLITE_ARTEFACT = "gsd_amauta.db"
DUMP_ARTEFACT = "postgres.dump"
TAR_ARTEFACT = "postgres-volume.tar.gz"
MANIFEST_NAME = "manifest.json"

_TOOL_TIMEOUT_S = int(os.environ.get("GSD_BACKUP_TOOL_TIMEOUT_S") or "1800")


# ══════════════════════════════════════════════════════════════════
# Errors
# ══════════════════════════════════════════════════════════════════

class BackupError(RuntimeError):
    """A typed backup failure carrying a machine-readable payload.

    Every refusal in this module is one of these, so a caller can branch on
    ``payload["error"]`` rather than on a message.

    Args:
        code: the stable error code, for example ``"pg_dump_unavailable"``.
        message: the human sentence.
        **extra: further payload fields.

    Example:
        >>> err = BackupError("verify_failed", "one file changed", file="x")
        >>> err.payload["error"], err.payload["file"]
        ('verify_failed', 'x')
    """

    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code = code
        self.payload = {"error": code, "message": message}
        self.payload.update(extra)


# ══════════════════════════════════════════════════════════════════
# Paths, time and hashing
# ══════════════════════════════════════════════════════════════════

def _truthy(value):
    """Whether an environment string means yes.

    Args:
        value: the raw string, or None.

    Returns:
        bool
    """
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _home():
    """The user's home directory, correct on every platform.

    Returns:
        str: an absolute path, from ``services/_platform.home_dir``.
    """
    return _platform.home_dir()


def default_backups_dir(env=None):
    """Where snapshots live when ``--backups-dir`` is not given.

    The precedence mirrors ``services/backup.py._default_backup_dir`` so the two
    agree about what "the backups directory" means on the operator's machine:

    1. ``AMAUTA_DATA_DIR`` wins — snapshots live beside the data they cover;
    2. otherwise, under ``GSD_TEST_MODE``, a temp directory, never a real home;
    3. otherwise ``<home>/.amauta/backups``.

    Args:
        env: the environment to read; ``None`` means the process environment.

    Returns:
        str: an absolute directory path (not created).
    """
    env = os.environ if env is None else env
    data_dir = (env.get("AMAUTA_DATA_DIR") or "").strip()
    if data_dir:
        return os.path.join(data_dir, "backups")
    if _truthy(env.get("GSD_TEST_MODE")):
        return os.path.join(tempfile.gettempdir(), "gsd-test-snapshots")
    return os.path.join(_home(), ".amauta", "backups")


def default_data_dir(env=None):
    """The data directory holding ``tasks.json`` and the three incident files.

    ``amauta.py:282`` resolves it as ``AMAUTA_DATA_DIR`` or ``<home>/.amauta``;
    this is the same rule, so the copy covers the file the product actually
    writes.

    Args:
        env: the environment to read.

    Returns:
        str: an absolute directory path.
    """
    env = os.environ if env is None else env
    data_dir = (env.get("AMAUTA_DATA_DIR") or "").strip()
    if data_dir:
        return data_dir
    return os.path.join(_home(), ".amauta")


def default_sqlite_path(env=None):
    """The SQLite database the product reads.

    ``services/sqlite_store.py:163-169``: ``GSD_SQLITE_PATH``, else
    ``GSD_DATA_DIR``/``gsd_amauta.db``, else ``<home>/.amauta/data``.

    Args:
        env: the environment to read.

    Returns:
        str: an absolute file path (which may not exist).
    """
    env = os.environ if env is None else env
    explicit = (env.get("GSD_SQLITE_PATH") or "").strip()
    if explicit:
        return explicit
    data_dir = (env.get("GSD_DATA_DIR") or "").strip()
    if not data_dir:
        amauta_data = (env.get("AMAUTA_DATA_DIR") or "").strip()
        data_dir = amauta_data or os.path.join(_home(), ".amauta", "data")
    return os.path.join(data_dir, SQLITE_ARTEFACT)


def utc_now():
    """The current UTC time, timezone-aware.

    Returns:
        datetime.datetime
    """
    return datetime.datetime.now(datetime.timezone.utc)


def iso(moment):
    """A UTC ISO-8601 string with a ``Z`` suffix.

    Args:
        moment: a timezone-aware datetime.

    Returns:
        str
    """
    return moment.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text):
    """Parse the ISO string :func:`iso` writes.

    Args:
        text: an ISO-8601 string, with or without a ``Z``.

    Returns:
        datetime.datetime | None: timezone-aware, or None when unparseable.
    """
    if not text:
        return None
    raw = str(text).strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed


def snapshot_name(reason, moment=None):
    """The directory name of a snapshot: ``<UTC-ISO-compact>-<reason>``.

    Args:
        reason: a member of :data:`REASONS`.
        moment: the creation time; ``None`` means now.

    Returns:
        str

    Example:
        >>> import datetime as dt
        >>> snapshot_name("manual", dt.datetime(2026, 11, 12, 9, 7, 0,
        ...     tzinfo=dt.timezone.utc))
        '20261112T090700Z-manual'
    """
    moment = utc_now() if moment is None else moment
    stamp = moment.astimezone(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return "%s-%s" % (stamp, reason)


def sha256_file(path, chunk=1024 * 1024):
    """SHA-256 of a file's bytes.

    Args:
        path: the file to hash.
        chunk: read size in bytes.

    Returns:
        str: lowercase hex digest.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def dsn_fingerprint(dsn):
    """``sha256("host:port/database")[:16]`` — never the DSN, never a password.

    Args:
        dsn: a PostgreSQL DSN, or None.

    Returns:
        str | None: the 16-character fingerprint, or None for no DSN.

    Example:
        >>> a = dsn_fingerprint("postgres" + "ql://u:secret@h:5432/d")
        >>> b = dsn_fingerprint("postgres" + "ql://other:pw@h:5432/d")
        >>> a == b   # the user and password are not part of the identity
        True
    """
    if not dsn:
        return None
    parts = dsn_parts(dsn)
    material = "%s:%s/%s" % (parts["host"], parts["port"], parts["database"])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


# ══════════════════════════════════════════════════════════════════
# Tool resolution
# ══════════════════════════════════════════════════════════════════

def find_tool(name, env=None):
    """Locate an executable, PATHEXT-aware, through the platform helper.

    Args:
        name: the tool name as it would be typed.
        env: the environment whose PATH is searched.

    Returns:
        str | None: the resolved path, or None.
    """
    env = os.environ if env is None else env
    found = _platform.which(name, env=env)
    if found:
        return found
    # The Windows runner carries PostgreSQL 17 under PGBIN but NOT on PATH
    # (measured in 88-16-RECORD.md). An operator-set PGBIN is explicit
    # configuration, so honouring it is not a guess.
    pgbin = (env.get("PGBIN") or "").strip()
    if pgbin:
        for suffix in ("", ".exe"):
            candidate = os.path.join(pgbin, name + suffix)
            if os.path.isfile(candidate):
                return candidate
    return None


def _tool_major(path):
    """The major version a PostgreSQL client tool reports.

    Args:
        path: the executable.

    Returns:
        int | None
    """
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True,
                             timeout=60)
    except Exception:  # noqa: BLE001 - an unversionable tool is simply unusable
        return None
    text = (out.stdout or "") + (out.stderr or "")
    for token in text.replace(",", " ").split():
        head = token.split(".")[0]
        if head.isdigit():
            return int(head)
    return None


def server_major_version(dsn, connect=None):
    """The server's major version, read over a real connection.

    Args:
        dsn: the DSN to ask.
        connect: an injected connect callable, for tests.

    Returns:
        int | None: the major version, or None when the server is unreachable.
    """
    if not dsn:
        return None
    try:
        if connect is None:
            import psycopg2

            connect = psycopg2.connect
        conn = connect(dsn, connect_timeout=10)
    except Exception:  # noqa: BLE001 - unreachable is a reportable state
        return None
    try:
        with conn.cursor() as cur:
            cur.execute("SHOW server_version_num")
            num = int(str(cur.fetchone()[0]).strip())
        return num // 10000
    except Exception:  # noqa: BLE001
        return None
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def describe_resolution_order():
    """The resolution order, as data, for the record and for ``--help``.

    Returns:
        list[dict]: one entry per step, each with ``step`` and ``what``.
    """
    return [
        {"step": 1, "what": "GSD_PG_DUMP_BIN / GSD_PG_RESTORE_BIN, validated as an existing file"},
        {"step": 2, "what": "a host tool whose major version is >= the server's"},
        {"step": 3, "what": "docker exec <container> — ONLY with GSD_BACKUP_ALLOW_DOCKER=1"},
        {"step": 4, "what": "the typed error pg_dump_unavailable, naming both variables and both versions"},
    ]


def resolve_pg_tool(tool, dsn=None, env=None, server_major=None):
    """Resolve ``pg_dump`` or ``pg_restore`` by this module's stated order.

    Args:
        tool: ``"pg_dump"`` or ``"pg_restore"``.
        dsn: the target DSN, used to learn the server's major version.
        env: the environment to read.
        server_major: an already-measured server major, to avoid a second
            connection.

    Returns:
        dict: ``{"argv_prefix": [...], "source": "...", "client_major": N|None,
        "server_major": N|None, "docker": bool}``.

    Raises:
        BackupError: ``pg_dump_unavailable`` when no usable tool exists.
    """
    env = os.environ if env is None else env
    var = "GSD_PG_DUMP_BIN" if tool == "pg_dump" else "GSD_PG_RESTORE_BIN"

    explicit = (env.get(var) or "").strip()
    if explicit:
        if not os.path.isfile(explicit):
            raise BackupError(
                "pg_dump_unavailable",
                "%s is set to %r, which is not a file. Point it at an absolute "
                "path to a %s binary, or unset it." % (var, explicit, tool),
                variable=var, value=explicit, tool=tool,
            )
        return {"argv_prefix": [explicit], "source": var,
                "client_major": _tool_major(explicit),
                "server_major": server_major, "docker": False}

    if server_major is None:
        server_major = server_major_version(dsn)

    host_tool = find_tool(tool, env=env)
    client_major = _tool_major(host_tool) if host_tool else None
    if host_tool and (server_major is None or
                      (client_major is not None and client_major >= server_major)):
        return {"argv_prefix": [host_tool], "source": "PATH",
                "client_major": client_major, "server_major": server_major,
                "docker": False}

    if _truthy(env.get("GSD_BACKUP_ALLOW_DOCKER")):
        container = (env.get("GSD_BACKUP_DOCKER_CONTAINER") or "gsd-postgres").strip()
        docker = find_tool("docker", env=env)
        if docker:
            return {"argv_prefix": [docker, "exec", "-i", container, tool],
                    "source": "docker exec %s" % container,
                    "client_major": None, "server_major": server_major,
                    "docker": True}

    raise BackupError(
        "pg_dump_unavailable",
        "no usable %s. Resolution order: (1) %s (unset); (2) a host %s whose "
        "major version is >= the server's — found %s (client major %s, server "
        "major %s); (3) docker exec, which needs GSD_BACKUP_ALLOW_DOCKER=1 "
        "(not set, and no test sets it); (4) this error. Set %s to a %s of "
        "major %s or newer, or set GSD_BACKUP_ALLOW_DOCKER=1 to use the "
        "container's own client." % (
            tool, var, tool, host_tool or "none", client_major, server_major,
            var, tool, server_major if server_major is not None else "the server's",
        ),
        tool=tool, variable=var, host_tool=host_tool,
        client_major=client_major, server_major=server_major,
        allow_docker_variable="GSD_BACKUP_ALLOW_DOCKER",
    )


def default_runner(argv, *, env=None, stdout_path=None, timeout=None):
    """Spawn an argv list.  The injectable seam every tool call goes through.

    There is no shell anywhere in this module: a tool is an argv LIST, so no
    quoting bug can turn a path into a command.

    Args:
        argv: the command, as a list.
        env: environment for the child; ``None`` means inherit.
        stdout_path: when given, the child's stdout is written to this file.
        timeout: seconds; ``None`` means the module default.

    Returns:
        dict: ``{"argv", "returncode", "stdout", "stderr"}``.
    """
    timeout = _TOOL_TIMEOUT_S if timeout is None else timeout
    if stdout_path:
        with open(stdout_path, "wb") as sink:
            completed = subprocess.run(argv, stdout=sink, stderr=subprocess.PIPE,
                                       env=env, timeout=timeout)
        return {"argv": list(argv), "returncode": completed.returncode,
                "stdout": b"", "stderr": (completed.stderr or b"").decode("utf-8", "replace")}
    completed = subprocess.run(argv, capture_output=True, env=env, timeout=timeout)
    return {"argv": list(argv), "returncode": completed.returncode,
            "stdout": completed.stdout or b"",
            "stderr": (completed.stderr or b"").decode("utf-8", "replace")}


def _pg_env(dsn, env=None):
    """A child environment carrying the DSN's password out of argv.

    Args:
        dsn: the DSN whose parts are used.
        env: the parent environment.

    Returns:
        dict: the child environment.
    """
    env = dict(os.environ if env is None else env)
    parts = dsn_parts(dsn)
    if parts["password"]:
        env["PGPASSWORD"] = parts["password"]
    return env


def _pg_conn_args(dsn):
    """``-h -p -U -d`` for a DSN, so no password reaches a process listing.

    Args:
        dsn: the DSN.

    Returns:
        list[str]
    """
    parts = dsn_parts(dsn)
    return ["-h", parts["host"], "-p", str(parts["port"]),
            "-U", parts["user"], "-d", parts["database"]]


# ══════════════════════════════════════════════════════════════════
# The PostgreSQL census
# ══════════════════════════════════════════════════════════════════

def pg_census(dsn, connect=None):
    """Read-only measurement of the database a snapshot covers.

    Per table: row count, the count of non-null vector values and the declared
    vector dimension.  This is also the read-only census ROADMAP Phase 89 asks
    the merge plan to start from, which is why it lives in the manifest rather
    than in a throwaway script.

    Args:
        dsn: the DSN to measure.
        connect: an injected connect callable, for tests.

    Returns:
        dict: the manifest's ``pg`` block.

    Raises:
        BackupError: ``census_failed`` when the server cannot be read.
    """
    if connect is None:
        import psycopg2

        connect = psycopg2.connect
    try:
        conn = connect(dsn, connect_timeout=15)
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
        raise BackupError("census_failed",
                          "cannot connect to the database to measure it: %s" % exc,
                          dsn=mask_dsn(dsn)) from exc
    try:
        out = {"server_version": None, "applied_migrations": [],
               "extensions": {}, "tables": {}}
        with conn.cursor() as cur:
            cur.execute("SHOW server_version")
            out["server_version"] = str(cur.fetchone()[0]).strip()

            cur.execute("SELECT extname, extversion FROM pg_extension ORDER BY extname")
            out["extensions"] = {name: version for name, version in cur.fetchall()}

            cur.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                "ORDER BY table_name"
            )
            tables = [row[0] for row in cur.fetchall()]

            cur.execute(
                "SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) "
                "FROM pg_attribute a "
                "JOIN pg_class c ON c.oid = a.attrelid "
                "JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'public' AND a.attnum > 0 "
                "AND NOT a.attisdropped "
                "AND format_type(a.atttypid, a.atttypmod) LIKE 'vector%'"
            )
            vector_columns = {}
            for relname, attname, formatted in cur.fetchall():
                dims = None
                if "(" in formatted and formatted.endswith(")"):
                    inner = formatted[formatted.index("(") + 1:-1]
                    if inner.isdigit():
                        dims = int(inner)
                vector_columns.setdefault(relname, []).append((attname, dims))

            if "schema_migrations" in tables:
                cur.execute("SELECT filename FROM schema_migrations ORDER BY filename")
                out["applied_migrations"] = [row[0] for row in cur.fetchall()]

            for table in tables:
                cur.execute('SELECT COUNT(*) FROM "%s"' % table)
                entry = {"rows": int(cur.fetchone()[0])}
                columns = vector_columns.get(table) or []
                if columns:
                    attname, dims = columns[0]
                    cur.execute('SELECT COUNT("%s") FROM "%s"' % (attname, table))
                    entry["with_embedding"] = int(cur.fetchone()[0])
                    entry["vector_dims"] = dims
                    entry["vector_column"] = attname
                out["tables"][table] = entry
        return out
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def _audit_restore(dsn, payload, connect=None):
    """Append one ``gsd_audit_log`` row describing a restore.

    Append-only by the table's own contract (``migrations/006-audit-log.sql``).
    A failure here is reported, never swallowed into silence, but it does not
    undo a restore that already succeeded — the caller decides.

    Args:
        dsn: the restored database.
        payload: the JSON metadata to record.
        connect: an injected connect callable, for tests.

    Returns:
        int | None: the new row id, or None when the row could not be written.
    """
    try:
        if connect is None:
            import psycopg2

            connect = psycopg2.connect
        conn = connect(dsn, connect_timeout=15)
    except Exception:  # noqa: BLE001 - reported by the caller's result dict
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO gsd_audit_log "
                "(task_id, event_type, agent_id, actor, content, metadata) "
                "VALUES (%s, %s, %s, %s, %s, %s::jsonb) RETURNING id",
                ("backup-restore", "backup_restore", "backup_snapshot",
                 "backup_snapshot.restore",
                 "restore from %s" % payload.get("snapshot"),
                 json.dumps(payload)),
            )
            row_id = cur.fetchone()[0]
        conn.commit()
        return int(row_id)
    except Exception:  # noqa: BLE001
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        return None
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


# ══════════════════════════════════════════════════════════════════
# The legs
# ══════════════════════════════════════════════════════════════════

def _copy_sqlite(src, dest):
    """Copy a SQLite database through the ONLINE-BACKUP API, then check it.

    ``Connection.backup()`` is correct with a live writer; a plain file copy of a
    WAL database is not a backup.  There is also no `sqlite3` binary on Windows,
    so a binary invocation would not be portable even if it were correct.

    Args:
        src: the live database file.
        dest: where the copy is written.

    Returns:
        dict: ``{"page_count", "integrity_check", "tables"}``.

    Raises:
        BackupError: ``sqlite_integrity_failed`` when the COPY does not pass
            ``PRAGMA integrity_check``.
    """
    source = sqlite3.connect(src)
    try:
        target = sqlite3.connect(dest)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()

    checked = sqlite3.connect(dest)
    try:
        cur = checked.cursor()
        cur.execute("PRAGMA integrity_check")
        verdict = str(cur.fetchone()[0]).strip()
        cur.execute("PRAGMA page_count")
        pages = int(cur.fetchone()[0])
        cur.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        names = [row[0] for row in cur.fetchall()]
        counts = {}
        for name in names:
            if name.startswith("sqlite_"):
                continue
            try:
                cur.execute('SELECT COUNT(*) FROM "%s"' % name)
                counts[name] = int(cur.fetchone()[0])
            except sqlite3.Error:
                counts[name] = None
    finally:
        checked.close()
    if verdict.lower() != "ok":
        raise BackupError("sqlite_integrity_failed",
                          "the SQLite copy failed PRAGMA integrity_check: %s" % verdict,
                          integrity_check=verdict, path=dest)
    return {"page_count": pages, "integrity_check": verdict, "tables": counts}


def _copy_task_files(data_dir, snapshot_dir):
    """Copy ``tasks.json`` and the three incident files under the PRODUCT's lock.

    The lock is ``amauta.py``'s own: ``<data dir>/.amauta.lock`` held through
    ``services/_platform.file_lock`` (``amauta.py:511``, ``:538-549``).  Taking a
    different lock would be taking no lock at all.

    Args:
        data_dir: the directory holding the files.
        snapshot_dir: the snapshot being written.

    Returns:
        dict: ``{"items": N|None, "copied": [...], "absent": [...]}``.
    """
    lock_path = os.path.join(data_dir, ".amauta.lock")
    copied, absent = [], []
    items = None
    os.makedirs(data_dir, exist_ok=True)
    with _platform.file_lock(lock_path):
        for name in TASK_SCOPE_FILES:
            src = os.path.join(data_dir, name)
            if not os.path.isfile(src):
                absent.append(name)
                continue
            shutil.copy2(src, os.path.join(snapshot_dir, name))
            copied.append(name)
        tasks = os.path.join(snapshot_dir, "tasks.json")
        if os.path.isfile(tasks):
            with open(tasks, "r", encoding="utf-8") as handle:
                document = json.load(handle)
            items = len(document.get("items") or [])
    return {"items": items, "copied": copied, "absent": absent}


def _dump_postgres(dsn, dest, env=None, runner=None, server_major=None):
    """``pg_dump -Fc --no-owner --no-privileges`` into ``dest``.

    Custom format, so ``pg_restore --list`` can parse the artefact without a
    database (which is how :func:`verify` checks it) and ``pg_restore -j`` works.

    Args:
        dsn: the database to dump.
        dest: the output file.
        env: the parent environment.
        runner: an injected command runner.
        server_major: an already-measured server major.

    Returns:
        dict: the resolution used, plus ``{"bytes": N}``.

    Raises:
        BackupError: ``pg_dump_failed`` on a non-zero exit or an empty artefact.
    """
    runner = default_runner if runner is None else runner
    resolved = resolve_pg_tool("pg_dump", dsn=dsn, env=env, server_major=server_major)
    argv = list(resolved["argv_prefix"]) + [
        "-Fc", "--no-owner", "--no-privileges",
    ] + _pg_conn_args(dsn)
    if resolved["docker"]:
        # The container's own client writes to ITS stdout; the host captures it.
        result = runner(argv, env=_pg_env(dsn, env), stdout_path=dest)
    else:
        argv = argv + ["-f", dest]
        result = runner(argv, env=_pg_env(dsn, env))
    if result["returncode"] != 0:
        raise BackupError(
            "pg_dump_failed",
            "pg_dump exited %s. A failed dump is a FAILED BACKUP: this is the "
            "defect scripts/backup.sh carried, where `&& echo ok || echo "
            "skipped` turned a failed dump into exit 0. stderr: %s"
            % (result["returncode"], (result["stderr"] or "").strip()[:2000]),
            returncode=result["returncode"], source=resolved["source"],
        )
    size = os.path.getsize(dest) if os.path.exists(dest) else 0
    if size <= 0:
        raise BackupError("pg_dump_failed",
                          "pg_dump exited 0 but wrote %d bytes" % size,
                          returncode=0, source=resolved["source"])
    out = dict(resolved)
    out["bytes"] = size
    return out


def _tar_volume(volume_path, dest, dsn=None, env=None, runner=None,
                port_probe=None):
    """Cold ``tar`` of the PostgreSQL data volume.

    The atomic undo, and the only artefact that also preserves cluster-era state
    such as ``shared_preload_libraries``.  It is COLD by contract: the caller
    stops the container, and this function REFUSES while anything is still
    listening on the DSN's port, because a tar of a running cluster's data
    directory is a torn copy that looks like a backup.

    It is implemented and unit-tested with an injected runner.  Its first real
    execution against a Docker volume is plan 89-14, on the operator's machine.

    Args:
        volume_path: the directory to archive.
        dest: the ``.tar.gz`` to write.
        dsn: the DSN whose port must be idle.
        env: the parent environment.
        runner: an injected command runner.
        port_probe: an injected port -> pids callable.

    Returns:
        dict: ``{"argv": [...], "bytes": N}``.

    Raises:
        BackupError: ``volume_hot`` when the port is in use, ``tar_unavailable``
            when no ``tar`` exists, ``tar_failed`` on a non-zero exit.
    """
    runner = default_runner if runner is None else runner
    probe = _platform.port_holders if port_probe is None else port_probe
    if dsn:
        port = int(dsn_parts(dsn)["port"])
        holders = probe(port) or []
        if holders:
            raise BackupError(
                "volume_hot",
                "refusing a volume tar while %d process(es) still LISTEN on "
                "port %d. A cold copy is the contract: stop the container "
                "first. Holders: %s" % (len(holders), port, holders),
                port=port, holders=list(holders),
            )
    tar = find_tool("tar", env=env)
    if not tar:
        raise BackupError("tar_unavailable",
                          "no tar on PATH; set it on PATH or omit "
                          "--include-volume-tar", tool="tar")
    argv = [tar, "-czf", dest, "-C", volume_path, "."]
    result = runner(argv, env=None)
    if result["returncode"] != 0:
        raise BackupError("tar_failed",
                          "tar exited %s: %s" % (result["returncode"],
                                                 (result["stderr"] or "").strip()[:2000]),
                          returncode=result["returncode"], argv=argv)
    return {"argv": argv, "bytes": os.path.getsize(dest) if os.path.exists(dest) else 0}


def _git_sha():
    """The repository HEAD, as ``bin/init.cjs`` ``packageCommit`` records it.

    Returns:
        str | None: a 40-character sha, or None.
    """
    git = find_tool("git")
    if not git:
        return None
    try:
        out = subprocess.run([git, "-C", _REPO_ROOT, "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=30)
    except Exception:  # noqa: BLE001
        return None
    sha = (out.stdout or "").strip()
    if out.returncode == 0 and len(sha) == 40 and all(
            ch in "0123456789abcdef" for ch in sha):
        return sha
    return None


# ══════════════════════════════════════════════════════════════════
# create
# ══════════════════════════════════════════════════════════════════

def read_manifest(snapshot_dir):
    """Load a snapshot's manifest.

    Args:
        snapshot_dir: the snapshot directory.

    Returns:
        dict: the manifest.

    Raises:
        BackupError: ``manifest_missing`` or ``manifest_unreadable``.
    """
    path = os.path.join(snapshot_dir, MANIFEST_NAME)
    if not os.path.isfile(path):
        raise BackupError("manifest_missing",
                          "no %s in %s, so this directory is not a snapshot"
                          % (MANIFEST_NAME, snapshot_dir), snapshot=snapshot_dir)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:  # noqa: BLE001 - re-raised as a typed error
        raise BackupError("manifest_unreadable",
                          "%s is not readable JSON: %s" % (path, exc),
                          snapshot=snapshot_dir) from exc


def _write_manifest(snapshot_dir, manifest):
    """Write a manifest atomically.

    Args:
        snapshot_dir: the snapshot directory.
        manifest: the document to write.

    Returns:
        str: the manifest path.
    """
    path = os.path.join(snapshot_dir, MANIFEST_NAME)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    return path


def create(reason, scope="all", dsn=None, sqlite_path=None, backups_dir=None,
           data_dir=None, include_volume_tar=False, volume_path=None,
           env=None, runner=None, connect=None, port_probe=None, moment=None,
           log=None):
    """Take one snapshot, verify it, and write ``verified_at`` only if it passes.

    The order is the point.  Artefacts first, then the manifest WITHOUT
    ``verified_at``, then a full :func:`verify` of what is on disk, and only then
    the ``verified_at`` / ``verify_result`` fields.  A snapshot that fails
    verification therefore has **no ``verified_at`` key at all** — not
    ``verified_at: null`` — and ``services/backup_guard.py`` treats it as absent.

    Args:
        reason: a member of :data:`REASONS`.
        scope: a member of :data:`SCOPES`.
        dsn: the PostgreSQL DSN, for the ``postgres`` legs.
        sqlite_path: the SQLite database to copy.
        backups_dir: where the snapshot directory is created.
        data_dir: where ``tasks.json`` and the three incident files live.
        include_volume_tar: also take a cold volume tar.
        volume_path: the directory the tar covers.
        env: the environment to read.
        runner: an injected command runner.
        connect: an injected psycopg2-style connect callable.
        port_probe: an injected port -> pids callable.
        moment: the creation time, for deterministic names in tests.
        log: a line sink; ``None`` means silence.

    Returns:
        dict: ``{"snapshot", "manifest", "verify"}``.

    Raises:
        BackupError: on an unknown reason or scope, a failed leg, or a snapshot
            that does not verify.
    """
    env = os.environ if env is None else env
    log = (lambda _message: None) if log is None else log
    if reason not in REASONS:
        raise BackupError("unknown_reason",
                          "%r is not one of %s" % (reason, ", ".join(sorted(REASONS))),
                          reason=reason, allowed=sorted(REASONS))
    if scope not in SCOPES:
        raise BackupError("unknown_scope",
                          "%r is not one of %s" % (scope, ", ".join(SCOPES)),
                          scope=scope, allowed=list(SCOPES))

    wants_pg = scope in ("all", "postgres")
    wants_sqlite = scope in ("all", "sqlite")
    wants_tasks = scope in ("all", "tasks")

    backups_dir = backups_dir or default_backups_dir(env)
    data_dir = data_dir or default_data_dir(env)
    sqlite_path = sqlite_path or default_sqlite_path(env)

    if wants_pg:
        dsn = require_dsn(dsn, component="backup_snapshot create --scope %s" % scope)

    os.makedirs(backups_dir, exist_ok=True)
    created_at = utc_now() if moment is None else moment
    snapshot_dir = os.path.join(backups_dir, snapshot_name(reason, created_at))
    suffix = 1
    while os.path.exists(snapshot_dir):
        suffix += 1
        snapshot_dir = os.path.join(
            backups_dir, "%s-%d" % (snapshot_name(reason, created_at), suffix))
    os.makedirs(snapshot_dir)

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "created_at": iso(created_at),
        "reason": reason,
        "scope": scope,
        "host": _hostname(),
        "git_sha": _git_sha(),
        "backend": "postgresql" if wants_pg else "sqlite",
        "dsn_fingerprint": dsn_fingerprint(dsn) if wants_pg else None,
        "pg": None,
        "sqlite": None,
        "tasks": None,
        "files": [],
    }

    server_major = None
    if wants_pg:
        server_major = server_major_version(dsn, connect=connect)
        log("  measuring the database (read-only census)")
        manifest["pg"] = pg_census(dsn, connect=connect)
        log("  pg_dump -Fc --no-owner --no-privileges")
        dumped = _dump_postgres(dsn, os.path.join(snapshot_dir, DUMP_ARTEFACT),
                                env=env, runner=runner, server_major=server_major)
        manifest["pg"]["dump_source"] = dumped["source"]
        manifest["pg"]["dump_client_major"] = dumped["client_major"]
        if include_volume_tar:
            if not volume_path:
                raise BackupError("volume_path_required",
                                  "--include-volume-tar needs --volume-path",
                                  flag="--include-volume-tar")
            log("  cold tar of the data volume")
            tarred = _tar_volume(volume_path, os.path.join(snapshot_dir, TAR_ARTEFACT),
                                 dsn=dsn, env=env, runner=runner,
                                 port_probe=port_probe)
            manifest["pg"]["volume_tar_argv"] = tarred["argv"]

    if wants_sqlite:
        if os.path.isfile(sqlite_path):
            log("  sqlite online backup + integrity check")
            manifest["sqlite"] = _copy_sqlite(
                sqlite_path, os.path.join(snapshot_dir, SQLITE_ARTEFACT))
        else:
            manifest["sqlite"] = {"page_count": 0, "integrity_check": "absent",
                                  "tables": {}, "source": sqlite_path}

    if wants_tasks:
        log("  tasks.json and the three incident files, under the product lock")
        manifest["tasks"] = _copy_task_files(data_dir, snapshot_dir)

    manifest["files"] = _file_census(snapshot_dir)
    _write_manifest(snapshot_dir, manifest)

    # `create` ALWAYS verifies. `--verify` is accepted for clarity and is a
    # no-op; there is no code path that writes an unverified snapshot's
    # verified_at, because there is no code path that skips this call.
    result = verify(snapshot_dir, env=env, runner=runner)
    if not result["ok"]:
        raise BackupError(
            "create_verify_failed",
            "the snapshot was written but FAILED its own verification, so no "
            "verified_at was written and the guard will treat it as absent. "
            "Failures: %s" % "; ".join(result["failures"]),
            snapshot=snapshot_dir, failures=result["failures"],
        )
    manifest["verified_at"] = iso(utc_now())
    manifest["verify_result"] = "ok"
    _write_manifest(snapshot_dir, manifest)
    log("  verified: %s" % snapshot_dir)
    return {"snapshot": snapshot_dir, "manifest": manifest, "verify": result}


def _hostname():
    """The host name recorded in a manifest.

    Returns:
        str
    """
    import socket

    try:
        return socket.gethostname()
    except Exception:  # noqa: BLE001
        return "unknown"


def _file_census(snapshot_dir):
    """Per-file ``{path, bytes, sha256}`` for every artefact but the manifest.

    The manifest is excluded because it carries the census: a document cannot
    hash itself.

    Args:
        snapshot_dir: the snapshot directory.

    Returns:
        list[dict]: sorted by path.
    """
    out = []
    for name in sorted(os.listdir(snapshot_dir)):
        if name in (MANIFEST_NAME, MANIFEST_NAME + ".tmp"):
            continue
        path = os.path.join(snapshot_dir, name)
        if not os.path.isfile(path):
            continue
        out.append({"path": name, "bytes": os.path.getsize(path),
                    "sha256": sha256_file(path)})
    return out


# ══════════════════════════════════════════════════════════════════
# verify
# ══════════════════════════════════════════════════════════════════

def verify(snapshot_dir, env=None, runner=None):
    """Check a snapshot against its manifest.  Fails CLOSED.

    Every check is an error, never a warning: a corrupt or partial artefact is
    not a backup, and reporting it as a warning is how a backup set rots
    unnoticed.  The checks are:

    * every file named in ``files`` exists, with the recorded size and SHA-256;
    * no unexpected extra artefact is present;
    * ``postgres.dump`` parses under ``pg_restore --list`` (a STRUCTURAL parse;
      no database is touched);
    * any ``*.tar.gz`` parses under ``tar -tzf``;
    * the SQLite copy passes ``PRAGMA integrity_check``;
    * ``tasks.json`` parses as JSON and its item count equals the manifest's.

    Args:
        snapshot_dir: the snapshot directory.
        env: the environment to read.
        runner: an injected command runner.

    Returns:
        dict: ``{"ok", "snapshot", "checks", "failures", "manifest"}``.

    Raises:
        BackupError: ``manifest_missing`` / ``manifest_unreadable`` when there is
            nothing to verify against.
    """
    env = os.environ if env is None else env
    runner = default_runner if runner is None else runner
    manifest = read_manifest(snapshot_dir)
    checks, failures = [], []

    if manifest.get("schema") != MANIFEST_SCHEMA:
        failures.append("manifest schema is %r, expected %d"
                        % (manifest.get("schema"), MANIFEST_SCHEMA))
    else:
        checks.append("manifest schema %d" % MANIFEST_SCHEMA)

    for value in _manifest_strings(manifest):
        if "://" in value and "@" in value:
            failures.append("a manifest value looks like a DSN: %r" % value[:40])

    recorded = {entry["path"]: entry for entry in manifest.get("files") or []}
    for name, entry in sorted(recorded.items()):
        path = os.path.join(snapshot_dir, name)
        if not os.path.isfile(path):
            failures.append("%s: named in the manifest but missing" % name)
            continue
        size = os.path.getsize(path)
        if size != entry["bytes"]:
            failures.append("%s: %d bytes on disk, manifest says %d"
                            % (name, size, entry["bytes"]))
        actual = sha256_file(path)
        if actual != entry["sha256"]:
            failures.append(
                "%s: SHA-256 mismatch — expected %s, actual %s"
                % (name, entry["sha256"], actual))
        else:
            checks.append("%s: sha256 ok (%d bytes)" % (name, size))

    on_disk = {n for n in os.listdir(snapshot_dir)
               if os.path.isfile(os.path.join(snapshot_dir, n))
               and n not in (MANIFEST_NAME, MANIFEST_NAME + ".tmp")}
    for extra in sorted(on_disk - set(recorded)):
        failures.append("%s: present on disk but absent from the manifest" % extra)

    dump = os.path.join(snapshot_dir, DUMP_ARTEFACT)
    if DUMP_ARTEFACT in recorded and os.path.isfile(dump):
        failures.extend(_verify_dump_structure(dump, env=env, runner=runner,
                                               checks=checks))

    for name in sorted(recorded):
        if not name.endswith(".tar.gz"):
            continue
        tar = find_tool("tar", env=env)
        path = os.path.join(snapshot_dir, name)
        if not tar:
            failures.append("%s: cannot be checked, no tar on PATH" % name)
            continue
        result = runner([tar, "-tzf", path], env=None)
        if result["returncode"] != 0:
            failures.append("%s: tar -tzf exited %s: %s"
                            % (name, result["returncode"],
                               (result["stderr"] or "").strip()[:400]))
        else:
            checks.append("%s: tar -tzf ok" % name)

    sqlite_copy = os.path.join(snapshot_dir, SQLITE_ARTEFACT)
    if SQLITE_ARTEFACT in recorded and os.path.isfile(sqlite_copy):
        try:
            conn = sqlite3.connect(sqlite_copy)
            try:
                cur = conn.cursor()
                cur.execute("PRAGMA integrity_check")
                verdict = str(cur.fetchone()[0]).strip()
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001 - a corrupt copy is a failure
            verdict = "unreadable: %s" % exc
        if verdict.lower() != "ok":
            failures.append("%s: PRAGMA integrity_check says %s"
                            % (SQLITE_ARTEFACT, verdict))
        else:
            checks.append("%s: integrity_check ok" % SQLITE_ARTEFACT)

    tasks = os.path.join(snapshot_dir, "tasks.json")
    if "tasks.json" in recorded and os.path.isfile(tasks):
        try:
            with open(tasks, "r", encoding="utf-8") as handle:
                document = json.load(handle)
            items = len(document.get("items") or [])
        except Exception as exc:  # noqa: BLE001
            items = None
            failures.append("tasks.json: not readable JSON: %s" % exc)
        expected = (manifest.get("tasks") or {}).get("items")
        if items is not None and expected is not None and items != expected:
            failures.append("tasks.json: %d items on disk, manifest says %d"
                            % (items, expected))
        elif items is not None:
            checks.append("tasks.json: %d items, matching the manifest" % items)

    return {"ok": not failures, "snapshot": snapshot_dir, "checks": checks,
            "failures": failures, "manifest": manifest}


def _manifest_strings(document):
    """Every string value anywhere in a manifest, for the containment check.

    Args:
        document: the manifest (or any nested value).

    Returns:
        list[str]
    """
    out = []
    stack = [document]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            stack.extend(node.values())
        elif isinstance(node, (list, tuple)):
            stack.extend(node)
        elif isinstance(node, str):
            out.append(node)
    return out


def _verify_dump_structure(dump, env, runner, checks):
    """``pg_restore --list`` as a structural parse of a custom-format dump.

    No database is touched: ``--list`` reads the archive's table of contents, so
    a truncated or corrupted artefact is caught before anybody tries to restore
    it.

    Args:
        dump: the dump file.
        env: the environment to read.
        runner: an injected command runner.
        checks: the list to append a passing note to.

    Returns:
        list[str]: failures (empty when the dump parses).
    """
    try:
        resolved = resolve_pg_tool("pg_restore", dsn=None, env=env,
                                   server_major=None)
    except BackupError as exc:
        return ["%s: cannot be structurally checked — %s"
                % (DUMP_ARTEFACT, exc.payload["message"])]
    if resolved["docker"]:
        return ["%s: refusing to shell into a container to verify a dump; set "
                "GSD_PG_RESTORE_BIN to a host pg_restore" % DUMP_ARTEFACT]
    result = runner(list(resolved["argv_prefix"]) + ["--list", dump], env=None)
    if result["returncode"] != 0:
        return ["%s: pg_restore --list exited %s: %s"
                % (DUMP_ARTEFACT, result["returncode"],
                   (result["stderr"] or "").strip()[:400])]
    checks.append("%s: pg_restore --list parsed the archive" % DUMP_ARTEFACT)
    return []


# ══════════════════════════════════════════════════════════════════
# list / latest / prune
# ══════════════════════════════════════════════════════════════════

def list_snapshots(backups_dir=None, reason=None, env=None):
    """Every snapshot directory under ``backups_dir``, newest last.

    Args:
        backups_dir: where to look.
        reason: filter to one reason.
        env: the environment to read.

    Returns:
        list[dict]: ``{"snapshot", "reason", "created_at", "verified_at",
        "verify_result", "bytes", "manifest"}``, sorted by ``created_at``.
    """
    env = os.environ if env is None else env
    backups_dir = backups_dir or default_backups_dir(env)
    out = []
    if not os.path.isdir(backups_dir):
        return out
    for name in sorted(os.listdir(backups_dir)):
        path = os.path.join(backups_dir, name)
        if not os.path.isdir(path):
            continue
        try:
            manifest = read_manifest(path)
        except BackupError:
            continue
        if reason and manifest.get("reason") != reason:
            continue
        total = sum(entry.get("bytes") or 0 for entry in manifest.get("files") or [])
        out.append({
            "snapshot": path,
            "name": name,
            "reason": manifest.get("reason"),
            "scope": manifest.get("scope"),
            "created_at": manifest.get("created_at"),
            "verified_at": manifest.get("verified_at"),
            "verify_result": manifest.get("verify_result"),
            "dsn_fingerprint": manifest.get("dsn_fingerprint"),
            "bytes": total,
            "manifest": manifest,
        })
    out.sort(key=lambda row: (row["created_at"] or "", row["name"]))
    return out


def latest_snapshot(backups_dir=None, reason=None, env=None, verified_only=True):
    """The newest snapshot, optionally of one reason.

    Args:
        backups_dir: where to look.
        reason: filter to one reason.
        env: the environment to read.
        verified_only: only consider snapshots carrying ``verified_at``.

    Returns:
        dict | None
    """
    rows = list_snapshots(backups_dir, reason=reason, env=env)
    if verified_only:
        rows = [r for r in rows if r.get("verified_at")]
    return rows[-1] if rows else None


def prune(backups_dir=None, dry_run=False, env=None, now=None):
    """Apply the retention rule.  Never deletes the newest verified snapshot.

    ``auto`` keeps the last 7.  ``manual`` is never pruned automatically.  Every
    other reason is kept for 30 days and never fewer than the last 3.  On top of
    all three rules, the newest VERIFIED snapshot of every reason is protected
    unconditionally — a retention rule that can delete the only restorable
    artefact of a class is not a retention rule.

    Args:
        backups_dir: where to look.
        dry_run: report without deleting.
        env: the environment to read.
        now: the reference time, for tests.

    Returns:
        dict: ``{"kept", "removed", "protected", "dry_run"}``.
    """
    env = os.environ if env is None else env
    now = utc_now() if now is None else now
    rows = list_snapshots(backups_dir, env=env)
    by_reason = {}
    for row in rows:
        by_reason.setdefault(row["reason"], []).append(row)

    removed, kept, protected = [], [], []
    for reason, group in sorted(by_reason.items()):
        group = sorted(group, key=lambda r: (r["created_at"] or "", r["name"]))
        newest_verified = None
        for row in reversed(group):
            if row.get("verified_at"):
                newest_verified = row["snapshot"]
                break
        if newest_verified:
            protected.append({"snapshot": newest_verified, "reason": reason,
                              "why": "newest verified snapshot of this reason"})
        if reason == "manual":
            kept.extend(r["snapshot"] for r in group)
            continue
        if reason == "auto":
            doomed = group[:-AUTO_KEEP] if len(group) > AUTO_KEEP else []
        else:
            doomed = []
            if len(group) > REASON_KEEP_MIN:
                cutoff = now - datetime.timedelta(days=REASON_KEEP_DAYS)
                candidates = group[:-REASON_KEEP_MIN]
                for row in candidates:
                    created = parse_iso(row["created_at"])
                    if created is not None and created < cutoff:
                        doomed.append(row)
        doomed = [r for r in doomed if r["snapshot"] != newest_verified]
        doomed_paths = {r["snapshot"] for r in doomed}
        for row in group:
            if row["snapshot"] in doomed_paths:
                removed.append({"snapshot": row["snapshot"], "reason": reason,
                                "created_at": row["created_at"]})
            else:
                kept.append(row["snapshot"])

    if not dry_run:
        for row in removed:
            shutil.rmtree(row["snapshot"], ignore_errors=True)
    return {"kept": sorted(kept), "removed": removed, "protected": protected,
            "dry_run": dry_run}


# ══════════════════════════════════════════════════════════════════
# restore
# ══════════════════════════════════════════════════════════════════

def restore(snapshot_dir, dsn=None, mode="replace", scope="all", confirm=False,
            pre_restore_snapshot=True, data_dir=None, sqlite_path=None,
            backups_dir=None, env=None, runner=None, connect=None, log=None):
    """Restore a snapshot.  Refuses an unverified or now-failing one.

    What this does that ``scripts/restore.sh`` did not:

    * it **refuses** unless the manifest carries ``verified_at`` AND a fresh
      :func:`verify` passes right now — a snapshot can rot on disk after it was
      written, so the stored verdict alone is not enough;
    * ``--mode replace`` on PostgreSQL requires ``--confirm`` and runs
      ``pg_restore --clean --if-exists --exit-on-error``, which is the
      ``ON_ERROR_STOP`` semantics ``scripts/restore.sh`` lacked: a PARTIAL
      restore is a FAILURE, never a "restored" message;
    * it takes a ``reason=pre-restore`` snapshot of the target first, unless
      ``pre_restore_snapshot`` is explicitly false (which is then recorded);
    * the SQLite and ``tasks.json`` legs fail loudly instead of ``|| true``.

    Args:
        snapshot_dir: the snapshot to restore from.
        dsn: the target DSN.
        mode: ``replace`` or ``merge``.
        scope: which legs to restore.
        confirm: required for ``--mode replace`` on PostgreSQL.
        pre_restore_snapshot: take a ``pre-restore`` snapshot first.
        data_dir: where ``tasks.json`` is written.
        sqlite_path: where the SQLite copy is written.
        backups_dir: where the pre-restore snapshot is written.
        env: the environment to read.
        runner: an injected command runner.
        connect: an injected psycopg2-style connect callable.
        log: a line sink.

    Returns:
        dict: ``{"snapshot", "mode", "scope", "restored", "pre_restore",
        "audit_row", "overrides"}``.

    Raises:
        BackupError: on any refusal or any failed leg.
    """
    env = os.environ if env is None else env
    log = (lambda _message: None) if log is None else log
    if mode not in ("replace", "merge"):
        raise BackupError("unknown_mode", "%r is not replace or merge" % mode,
                          mode=mode)
    if scope not in SCOPES:
        raise BackupError("unknown_scope", "%r is not one of %s"
                          % (scope, ", ".join(SCOPES)), scope=scope)

    manifest = read_manifest(snapshot_dir)
    if not manifest.get("verified_at"):
        raise BackupError(
            "snapshot_unverified",
            "%s carries no verified_at, so it is not a verified snapshot and "
            "will not be restored. Re-create it: `create` always verifies."
            % snapshot_dir, snapshot=snapshot_dir)

    fresh = verify(snapshot_dir, env=env, runner=runner)
    if not fresh["ok"]:
        raise BackupError(
            "snapshot_failed_verification",
            "%s was verified when it was written but FAILS verification now, "
            "so nothing was restored and the target is untouched. Failures: %s"
            % (snapshot_dir, "; ".join(fresh["failures"])),
            snapshot=snapshot_dir, failures=fresh["failures"])

    wants_pg = scope in ("all", "postgres") and DUMP_ARTEFACT in {
        entry["path"] for entry in manifest.get("files") or []}
    wants_sqlite = scope in ("all", "sqlite") and os.path.isfile(
        os.path.join(snapshot_dir, SQLITE_ARTEFACT))
    wants_tasks = scope in ("all", "tasks") and os.path.isfile(
        os.path.join(snapshot_dir, "tasks.json"))

    if wants_pg:
        dsn = require_dsn(dsn, component="backup_snapshot restore")
        if mode == "replace" and not confirm:
            raise BackupError(
                "confirmation_required",
                "--mode replace DROPS and reloads every object in the target "
                "database. Pass --confirm if that is really what you want.",
                mode=mode, flag="--confirm")

    overrides = {}
    pre = None
    if pre_restore_snapshot:
        log("  taking a pre-restore snapshot of the target first")
        pre = create("pre-restore", scope=scope, dsn=dsn, sqlite_path=sqlite_path,
                     backups_dir=backups_dir, data_dir=data_dir, env=env,
                     runner=runner, connect=connect, log=log)
    else:
        overrides["no_pre_restore_snapshot"] = True

    restored = []
    if wants_pg:
        log("  pg_restore --clean --if-exists --exit-on-error")
        resolved = resolve_pg_tool("pg_restore", dsn=dsn, env=env)
        argv = list(resolved["argv_prefix"]) + [
            "--no-owner", "--no-privileges", "--exit-on-error",
        ]
        if mode == "replace":
            argv += ["--clean", "--if-exists"]
        argv += _pg_conn_args(dsn) + [os.path.join(snapshot_dir, DUMP_ARTEFACT)]
        result = (default_runner if runner is None else runner)(
            argv, env=_pg_env(dsn, env))
        if result["returncode"] != 0:
            raise BackupError(
                "restore_failed",
                "pg_restore exited %s. A PARTIAL restore is a failure, not a "
                "'restored' message — that was the defect in "
                "scripts/restore.sh, which piped into psql with no "
                "ON_ERROR_STOP and stderr discarded. stderr: %s"
                % (result["returncode"], (result["stderr"] or "").strip()[:2000]),
                returncode=result["returncode"])
        restored.append("postgres")

    if wants_sqlite:
        target = sqlite_path or default_sqlite_path(env)
        os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
        shutil.copy2(os.path.join(snapshot_dir, SQLITE_ARTEFACT), target)
        conn = sqlite3.connect(target)
        try:
            cur = conn.cursor()
            cur.execute("PRAGMA integrity_check")
            verdict = str(cur.fetchone()[0]).strip()
        finally:
            conn.close()
        if verdict.lower() != "ok":
            raise BackupError("restore_failed",
                              "the restored SQLite database fails "
                              "integrity_check: %s" % verdict, leg="sqlite")
        restored.append("sqlite")

    if wants_tasks:
        target_dir = data_dir or default_data_dir(env)
        os.makedirs(target_dir, exist_ok=True)
        with _platform.file_lock(os.path.join(target_dir, ".amauta.lock")):
            for name in TASK_SCOPE_FILES:
                src = os.path.join(snapshot_dir, name)
                if not os.path.isfile(src):
                    continue
                shutil.copy2(src, os.path.join(target_dir, name))
        restored.append("tasks")

    audit_row = None
    if wants_pg:
        audit_row = _audit_restore(dsn, {
            "snapshot": os.path.basename(snapshot_dir),
            "snapshot_path": snapshot_dir,
            "mode": mode,
            "scope": scope,
            "reason": manifest.get("reason"),
            "created_at": manifest.get("created_at"),
            "verified_at": manifest.get("verified_at"),
            "pre_restore_snapshot": pre["snapshot"] if pre else None,
            "overrides": overrides,
        }, connect=connect)

    return {"snapshot": snapshot_dir, "mode": mode, "scope": scope,
            "restored": restored,
            "pre_restore": pre["snapshot"] if pre else None,
            "audit_row": audit_row, "overrides": overrides}


# ══════════════════════════════════════════════════════════════════
# for <step>
# ══════════════════════════════════════════════════════════════════

def for_step(step, **kwargs):
    """Take the snapshot a named step needs.  The remedy a refusal names.

    Args:
        step: a key of :data:`STEP_SNAPSHOTS`.
        **kwargs: passed to :func:`create`.

    Returns:
        dict: :func:`create`'s result.

    Raises:
        BackupError: ``unknown_step`` for a step with no mapping.
    """
    if step not in STEP_SNAPSHOTS:
        raise BackupError("unknown_step",
                          "%r is not a known step. Known: %s"
                          % (step, ", ".join(sorted(STEP_SNAPSHOTS))),
                          step=step, allowed=sorted(STEP_SNAPSHOTS))
    reason, scope = STEP_SNAPSHOTS[step]
    kwargs.setdefault("scope", scope)
    return create(reason, **kwargs)


# ══════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════

def _add_target_args(parser):
    """The DSN / path flags every subcommand that touches data shares.

    Args:
        parser: the subparser to extend.

    Returns:
        None
    """
    parser.add_argument("--dsn", default=None,
                        help="PostgreSQL DSN. Default: GSD_POSTGRES_URL, "
                             "DATABASE_URL or AMAUTA_MEMORY_DATABASE_URL. With "
                             "none set the command refuses to guess a database "
                             "(see services/pg_dsn.py).")
    parser.add_argument("--local-docker", action="store_true",
                        help="Target this project's own Docker PostgreSQL "
                             "explicitly (built from parts; never a literal).")
    parser.add_argument("--sqlite", default=None,
                        help="SQLite database file. Default: GSD_SQLITE_PATH, "
                             "else <data dir>/gsd_amauta.db.")
    parser.add_argument("--data-dir", default=None,
                        help="Directory holding tasks.json, install_record.json, "
                             "last_backend and pg_retry_queue.json.")


def build_parser():
    """The argparse parser, in the house shape.

    Returns:
        argparse.ArgumentParser
    """
    parser = argparse.ArgumentParser(
        prog="backup_snapshot",
        description="Verified backup snapshots for GSD-Amauta. A snapshot is "
                    "one directory carrying a pg_dump -Fc dump, the SQLite "
                    "database copied through the online-backup API, tasks.json "
                    "under the product's own lock, the three incident files, "
                    "and a manifest.json with per-file SHA-256 and a per-table "
                    "census. `create` ALWAYS verifies its own output.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    create_p = sub.add_parser("create", help="Take and verify one snapshot.")
    create_p.add_argument("--reason", choices=REASONS, required=True,
                          help="Why this snapshot exists. A CLOSED enum: a "
                               "later caller needing a value that is absent "
                               "means the enum is wrong, not the caller.")
    create_p.add_argument("--scope", choices=SCOPES, default="all")
    _add_target_args(create_p)
    create_p.add_argument("--backups-dir", default=None,
                          help="Where the snapshot directory is created.")
    create_p.add_argument("--include-volume-tar", action="store_true",
                          help="Also take a COLD tar of the data volume (the "
                               "caller stops the container; the command "
                               "refuses while the port is still in use).")
    create_p.add_argument("--volume-path", default=None,
                          help="The directory --include-volume-tar archives.")
    create_p.add_argument("--verify", action="store_true",
                          help="Accepted for clarity; verification is "
                               "unconditional, so this flag is a no-op.")
    create_p.add_argument("--json", action="store_true")

    list_p = sub.add_parser("list", help="List snapshots.")
    list_p.add_argument("--backups-dir", default=None)
    list_p.add_argument("--reason", choices=REASONS, default=None)
    list_p.add_argument("--json", action="store_true")

    verify_p = sub.add_parser("verify", help="Verify a snapshot. Fails closed.")
    verify_p.add_argument("snapshot", nargs="?", default=None)
    verify_p.add_argument("--latest", action="store_true",
                          help="Verify the newest snapshot instead of a named one.")
    verify_p.add_argument("--reason", choices=REASONS, default=None)
    verify_p.add_argument("--backups-dir", default=None)
    verify_p.add_argument("--json", action="store_true")

    restore_p = sub.add_parser("restore", help="Restore a verified snapshot.")
    restore_p.add_argument("snapshot")
    _add_target_args(restore_p)
    restore_p.add_argument("--backups-dir", default=None)
    restore_p.add_argument("--mode", choices=("replace", "merge"), default="replace")
    restore_p.add_argument("--scope", choices=SCOPES, default="all")
    restore_p.add_argument("--confirm", action="store_true",
                           help="Required for --mode replace on PostgreSQL.")
    restore_p.add_argument("--no-pre-restore-snapshot", action="store_true",
                           help="Do NOT snapshot the target first. Recorded in "
                                "the audit log when used.")
    restore_p.add_argument("--json", action="store_true")

    prune_p = sub.add_parser("prune", help="Apply the retention rule.")
    prune_p.add_argument("--backups-dir", default=None)
    prune_p.add_argument("--dry-run", action="store_true")
    prune_p.add_argument("--json", action="store_true")

    for_p = sub.add_parser("for", help="Take the snapshot a named step needs.")
    for_p.add_argument("step", choices=sorted(STEP_SNAPSHOTS))
    _add_target_args(for_p)
    for_p.add_argument("--backups-dir", default=None)
    for_p.add_argument("--scope", choices=SCOPES, default=None,
                       help="Override the step's own scope. The guard puts this "
                            "flag into its remedy string when it asked for a "
                            "narrower scope, so the remedy it prints is runnable "
                            "exactly as printed.")
    for_p.add_argument("--include-volume-tar", action="store_true",
                       help="Also take a COLD tar of the data volume.")
    for_p.add_argument("--volume-path", default=None,
                       help="The directory --include-volume-tar archives.")
    for_p.add_argument("--json", action="store_true")

    return parser


def _resolved_dsn(args):
    """The DSN a subcommand should use, with ``--local-docker`` honoured.

    Args:
        args: parsed arguments.

    Returns:
        str | None
    """
    dsn = getattr(args, "dsn", None)
    if not dsn and getattr(args, "local_docker", False):
        return local_docker_dsn()
    return dsn or resolve_dsn(None)


def main(argv=None):
    """CLI entry point.

    Args:
        argv: argument list; ``None`` means ``sys.argv[1:]``.

    Returns:
        int: 0 on success, 1 on a typed backup failure, 2 on anything else.
    """
    parser = build_parser()
    args = parser.parse_args(argv)
    as_json = getattr(args, "json", False)

    def log(message):
        print(message, file=sys.stderr if as_json else sys.stdout)

    def emit(payload):
        if as_json:
            print(json.dumps(payload, indent=2, default=str))

    try:
        if args.command == "create":
            result = create(
                args.reason, scope=args.scope, dsn=_resolved_dsn(args),
                sqlite_path=args.sqlite, backups_dir=args.backups_dir,
                data_dir=args.data_dir,
                include_volume_tar=args.include_volume_tar,
                volume_path=args.volume_path, log=log)
            emit({"snapshot": result["snapshot"], "manifest": result["manifest"]})
            if not as_json:
                print("snapshot: %s (verified %s)"
                      % (result["snapshot"], result["manifest"]["verified_at"]))
            return 0

        if args.command == "list":
            rows = list_snapshots(args.backups_dir, reason=args.reason)
            emit([{k: v for k, v in row.items() if k != "manifest"} for row in rows])
            if not as_json:
                for row in rows:
                    print("%-44s %-22s %-8s %s"
                          % (row["name"], row["reason"], row["scope"],
                             row["verified_at"] or "UNVERIFIED"))
                print("%d snapshot(s)" % len(rows))
            return 0

        if args.command == "verify":
            target = args.snapshot
            if args.latest or not target:
                newest = latest_snapshot(args.backups_dir, reason=args.reason,
                                         verified_only=False)
                if newest is None:
                    raise BackupError("no_snapshot",
                                      "no snapshot to verify in %s"
                                      % (args.backups_dir or default_backups_dir()),
                                      reason=args.reason)
                target = newest["snapshot"]
            result = verify(target)
            emit({"snapshot": result["snapshot"], "ok": result["ok"],
                  "checks": result["checks"], "failures": result["failures"]})
            if not as_json:
                for line in result["checks"]:
                    print("  ok    %s" % line)
                for line in result["failures"]:
                    print("  FAIL  %s" % line)
                print("verify: %s" % ("ok" if result["ok"] else "FAILED"))
            return 0 if result["ok"] else 1

        if args.command == "restore":
            result = restore(
                args.snapshot, dsn=_resolved_dsn(args), mode=args.mode,
                scope=args.scope, confirm=args.confirm,
                pre_restore_snapshot=not args.no_pre_restore_snapshot,
                data_dir=args.data_dir, sqlite_path=args.sqlite,
                backups_dir=args.backups_dir, log=log)
            emit(result)
            if not as_json:
                print("restored %s from %s (mode %s)"
                      % (", ".join(result["restored"]) or "nothing",
                         result["snapshot"], result["mode"]))
            return 0

        if args.command == "prune":
            result = prune(args.backups_dir, dry_run=args.dry_run)
            emit(result)
            if not as_json:
                for row in result["removed"]:
                    print("%s %s" % ("would remove" if args.dry_run else "removed",
                                     row["snapshot"]))
                print("%d kept, %d %s, %d protected"
                      % (len(result["kept"]), len(result["removed"]),
                         "would be removed" if args.dry_run else "removed",
                         len(result["protected"])))
            return 0

        if args.command == "for":
            overrides = {}
            if args.scope:
                overrides["scope"] = args.scope
            result = for_step(args.step, dsn=_resolved_dsn(args),
                              sqlite_path=args.sqlite,
                              backups_dir=args.backups_dir,
                              data_dir=args.data_dir,
                              include_volume_tar=args.include_volume_tar,
                              volume_path=args.volume_path, log=log,
                              **overrides)
            emit({"snapshot": result["snapshot"], "manifest": result["manifest"]})
            if not as_json:
                print("snapshot for step %s: %s" % (args.step, result["snapshot"]))
            return 0

        parser.error("unknown command %r" % args.command)
        return 2
    except BackupError as exc:
        if as_json:
            print(json.dumps(exc.payload, indent=2, default=str))
        print("ERROR: %s" % exc, file=sys.stderr)
        return 1
    except UnconfiguredPostgresDSN as exc:
        # A typed refusal, not an "unexpected" exit 2: an absent DSN is a
        # configuration state the operator can fix, and the message from
        # services/pg_dsn.py already says how.
        if as_json:
            print(json.dumps({"error": "dsn_unconfigured", "message": str(exc)},
                             indent=2, default=str))
        print("ERROR: %s" % exc, file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - top-level CLI guard
        if as_json:
            print(json.dumps({"error": "unexpected", "message": str(exc)},
                             indent=2, default=str))
        print("ERROR: backup_snapshot failed: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    # Phase 88-13: UTF-8 stdio when the console code page is not (Windows cp1252); a no-op otherwise.
    import os as _os, sys as _sys
    _sys.path.append(_os.path.dirname(_os.path.abspath(__file__)))
    try:
        from _platform import setup_stdio
    except ImportError:  # pragma: no cover - a tree without services/ on sys.path
        def setup_stdio():  # type: ignore[misc]
            return False
    setup_stdio()
    sys.exit(main())

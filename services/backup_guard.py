#!/usr/bin/env python3
"""The guard that refuses a data-touching step without a verified backup.

WHY THIS MODULE EXISTS
──────────────────────
On 2026-11-12 an installer run changed the operator's PostgreSQL with no backup
in place.  The operator's standing rule since is that verified backups are taken
**before** any installer, upgrade, migration, container or backend step — and
that **the product enforces that rule itself** rather than relying on a plan's
promise (89-CONTEXT.md decisions 2 and 3).

ONE PREDICATE, IMPLEMENTED ONCE
───────────────────────────────
::

    recent_verified_backup(max_age_hours=24, scope="all", backups_dir=None,
                           dsn_fingerprint=None) -> (ok, manifest_or_None, reason)
    require_recent_backup(step=..., ...)   # raises BackupRequired with a remedy

A snapshot counts only when **all** of these hold:

* its manifest carries ``verified_at`` — an unverified snapshot is ABSENT, which
  is what makes "verified backups" mechanical rather than aspirational;
* its ``reason`` is a data-touching one or ``manual``
  (``services/backup_snapshot.GUARD_ACCEPTED_REASONS``).  ``auto`` does not
  count: a daily background snapshot is not evidence that anybody thought about
  THIS step;
* its ``scope`` covers the scope asked for;
* its ``created_at`` is within ``max_age_hours`` (**24 hours**, decision D7);
* when a ``dsn_fingerprint`` is given, the snapshot's matches — a backup of a
  different database is not a backup of this one.

KILL-SWITCH-FIRST (the Phase 67 enforcement-hook discipline)
────────────────────────────────────────────────────────────
The guard is **armed unless ``GSD_BACKUP_GUARD=off``**, and it is **not armed**
when ``GSD_TEST_MODE`` is truthy or ``CI`` is set, so the test suite is
unaffected.  ``GSD_BACKUP_GUARD=on`` forces it on regardless, which is how CI
tests that it FIRES — a guard CI never sees fire is a guard nobody has tested.
``tests/test_89_04_backup_guard.py`` asserts both arms.

OVERRIDES ARE EXPLICIT AND RECORDED, NEVER SILENT
─────────────────────────────────────────────────
``--allow-stale-backup`` accepts an older snapshot; ``--no-backup-check``
disables the check entirely and prints the full consequence sentence.  Both are
written to ``gsd_audit_log`` where a database is reachable and to the install
record's ``last_override`` where one is.

``--dry-run`` and ``--status`` paths are **never** gated, which is what keeps
the cutover's read-only census read-only.

This module ships the predicate and nothing else.  The six installer call sites
in ``bin/init.cjs`` are plan 89-11's (decision D8: all of the phase's edits to
that canary-pinned file land in one plan).
"""

from __future__ import annotations

import datetime
import json
import os
import shlex
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from services import backup_snapshot as snapshots
    from services import _platform
except ImportError:  # pragma: no cover - script-launched from services/
    import backup_snapshot as snapshots
    import _platform

__all__ = [
    "MAX_AGE_HOURS",
    "GUARD_ENV",
    "BackupRequired",
    "guard_armed",
    "recent_verified_backup",
    "require_recent_backup",
    "remedy_argv",
    "remedy_command",
    "record_override",
    "NO_BACKUP_CHECK_CONSEQUENCE",
]

#: Decision D7. Twenty-four hours, and the override is explicit and logged.
MAX_AGE_HOURS = 24

#: The kill switch's name, in one place.
GUARD_ENV = "GSD_BACKUP_GUARD"

#: What ``--no-backup-check`` prints. It is long on purpose: the point of the
#: flag is that nobody passes it by accident.
NO_BACKUP_CHECK_CONSEQUENCE = (
    "--no-backup-check disables the backup guard entirely for this run. "
    "Nothing will check that a verified snapshot of this database exists before "
    "the schema is changed. On 2026-11-12 an installer run changed the "
    "operator's PostgreSQL with no backup in place and the September content "
    "survived only in hand-made copies; this flag reproduces exactly that "
    "situation on purpose. If you want to proceed with an OLDER snapshot rather "
    "than none, use --allow-stale-backup instead."
)

#: The reason strings the predicate returns, so a caller can branch on them.
REASON_OK = "ok"
REASON_NO_SNAPSHOT = "no_snapshot"
REASON_UNVERIFIED_ONLY = "unverified_only"
REASON_STALE = "stale"
REASON_FINGERPRINT_MISMATCH = "fingerprint_mismatch"
REASON_SCOPE_MISMATCH = "scope_mismatch"
REASON_DISARMED = "disarmed"


class BackupRequired(RuntimeError):
    """Raised when a data-touching step has no verified recent backup.

    Args:
        payload: the typed refusal, including the ``remedy`` command.

    Example:
        >>> err = BackupRequired({"error": "backup_required", "remedy": "x"})
        >>> err.payload["remedy"]
        'x'
    """

    def __init__(self, payload):
        super().__init__(payload.get("message") or payload.get("error"))
        self.payload = payload


def _truthy(value):
    """Whether an environment string means yes.

    Args:
        value: the raw string, or None.

    Returns:
        bool
    """
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def guard_armed(env=None):
    """Whether the guard is armed for this process.

    Kill-switch-first: armed by default, ``off`` disarms it, and the suite is
    exempt (``GSD_TEST_MODE`` or ``CI``) so that adding the guard cannot turn
    every other Postgres test red.  ``on`` forces it, which is the ONLY way CI
    ever sees it fire.

    Args:
        env: the environment to read; ``None`` means the process environment.

    Returns:
        bool

    Example:
        >>> guard_armed({"GSD_BACKUP_GUARD": "off"})
        False
        >>> guard_armed({"CI": "true"})
        False
        >>> guard_armed({"CI": "true", "GSD_BACKUP_GUARD": "on"})
        True
        >>> guard_armed({})
        True
    """
    env = os.environ if env is None else env
    forced = str(env.get(GUARD_ENV) or "").strip().lower()
    if forced in ("off", "0", "false", "no"):
        return False
    if forced in ("on", "1", "true", "yes"):
        return True
    if _truthy(env.get("GSD_TEST_MODE")):
        return False
    if str(env.get("CI") or "").strip():
        return False
    return True


def _scope_covers(snapshot_scope, wanted):
    """Whether a snapshot's scope covers the scope a step asks for.

    Args:
        snapshot_scope: the snapshot's ``scope`` field.
        wanted: the scope the step needs.

    Returns:
        bool
    """
    if snapshot_scope == "all":
        return True
    return snapshot_scope == wanted


def recent_verified_backup(max_age_hours=MAX_AGE_HOURS, scope="all",
                           backups_dir=None, dsn_fingerprint=None, env=None,
                           now=None):
    """Whether a verified snapshot newer than ``max_age_hours`` exists.

    Args:
        max_age_hours: the age ceiling; 24 by decision D7.
        scope: the scope the step needs (``all``/``postgres``/``sqlite``/``tasks``).
        backups_dir: where to look; ``None`` means the module default.
        dsn_fingerprint: when given, the snapshot must name the same database.
        env: the environment to read.
        now: the reference time, for tests.

    Returns:
        tuple: ``(ok, manifest_or_None, reason)``.  ``manifest_or_None`` is the
        newest ACCEPTABLE snapshot's row when ``ok``, and otherwise the newest
        candidate that was rejected (so a caller can report its age).

    Example:
        >>> ok, newest, reason = recent_verified_backup(backups_dir="nowhere")
        >>> (ok, newest, reason)
        (False, None, 'no_snapshot')
    """
    env = os.environ if env is None else env
    now = snapshots.utc_now() if now is None else now
    rows = snapshots.list_snapshots(backups_dir, env=env)
    if not rows:
        return (False, None, REASON_NO_SNAPSHOT)

    candidates = [r for r in rows
                  if r.get("reason") in snapshots.GUARD_ACCEPTED_REASONS]
    if not candidates:
        return (False, rows[-1], REASON_NO_SNAPSHOT)

    verified = [r for r in candidates if r.get("verified_at")]
    if not verified:
        return (False, candidates[-1], REASON_UNVERIFIED_ONLY)

    in_scope = [r for r in verified if _scope_covers(r.get("scope"), scope)]
    if not in_scope:
        return (False, verified[-1], REASON_SCOPE_MISMATCH)

    if dsn_fingerprint:
        matching = [r for r in in_scope
                    if r.get("dsn_fingerprint") == dsn_fingerprint]
        if not matching:
            return (False, in_scope[-1], REASON_FINGERPRINT_MISMATCH)
        in_scope = matching

    ceiling = now - datetime.timedelta(hours=max_age_hours)
    fresh = []
    for row in in_scope:
        created = snapshots.parse_iso(row.get("created_at"))
        if created is not None and created >= ceiling:
            fresh.append(row)
    if not fresh:
        return (False, in_scope[-1], REASON_STALE)
    return (True, fresh[-1], REASON_OK)


def age_hours(row, now=None):
    """How many hours ago a snapshot was created.

    Args:
        row: a row from ``backup_snapshot.list_snapshots``, or None.
        now: the reference time.

    Returns:
        float | None
    """
    if not row:
        return None
    created = snapshots.parse_iso(row.get("created_at"))
    if created is None:
        return None
    now = snapshots.utc_now() if now is None else now
    return round((now - created).total_seconds() / 3600.0, 2)


def remedy_argv(step="migrations", backups_dir=None, scope=None, dsn=None):
    """The exact ARGV that fixes a refusal, as a list.

    A list, not a string, because a string has to be re-parsed and the parsing
    is platform-specific: ``shlex.split`` runs in POSIX mode, where a Windows
    path's backslashes are escape characters, so splitting the rendered command
    on the Windows cell produced
    ``C:hostedtoolcachewindowsPython3.12.10x64python3.exe`` and
    ``FileNotFoundError`` (run 43319162316). A caller that wants to RUN the
    remedy uses this; :func:`remedy_command` renders the same list for a human.

    ``--backups-dir`` and ``--scope`` are carried because a remedy that needs
    the reader to add flags is not a remedy.

    Args:
        step: a key of ``backup_snapshot.STEP_SNAPSHOTS``.
        backups_dir: appended as ``--backups-dir`` when given.
        scope: appended as ``--scope`` when it differs from the step's own.
        dsn: appended as ``--dsn`` when given.  Pass it only where the caller
            already knows the DSN is safe to print; the guard never adds it
            itself, so no password can reach a log line through this list.

    Returns:
        list[str]
    """
    script = os.path.join(_REPO_ROOT, "services", "backup_snapshot.py")
    parts = [sys.executable, script, "for", str(step)]
    if backups_dir:
        parts += ["--backups-dir", str(backups_dir)]
    step_scope = (snapshots.STEP_SNAPSHOTS.get(step) or (None, None))[1]
    if scope and scope != step_scope:
        parts += ["--scope", str(scope)]
    if dsn:
        parts += ["--dsn", str(dsn)]
    return parts


def remedy_command(step="migrations", backups_dir=None, scope=None, dsn=None):
    """The same remedy, rendered as one line for a human to paste.

    Rendered with the quoting the LOCAL shell uses: ``subprocess.list2cmdline``
    on Windows, ``shlex.join`` elsewhere. ``tests/test_89_04_backup_guard.py``
    runs :func:`remedy_argv` unchanged and asserts the guard then passes —
    because a remedy nobody has run is a guess.

    Args:
        step: a key of ``backup_snapshot.STEP_SNAPSHOTS``.
        backups_dir: appended as ``--backups-dir`` when given.
        scope: appended as ``--scope`` when it differs from the step's own.
        dsn: appended as ``--dsn`` when given.

    Returns:
        str: a command line, correctly quoted for this platform's shell.
    """
    parts = remedy_argv(step=step, backups_dir=backups_dir, scope=scope, dsn=dsn)
    if sys.platform == "win32":
        import subprocess

        return subprocess.list2cmdline(parts)
    return shlex.join(parts)


def require_recent_backup(step="migrations", max_age_hours=MAX_AGE_HOURS,
                          scope="all", backups_dir=None, dsn_fingerprint=None,
                          env=None, now=None, allow_stale_backup=False,
                          no_backup_check=False, dsn=None, log=None):
    """Refuse a data-touching step without a verified recent backup.

    Args:
        step: the step being guarded; names the remedy.
        max_age_hours: the age ceiling.
        scope: the scope the step needs.
        backups_dir: where to look.
        dsn_fingerprint: the database the snapshot must name.
        env: the environment to read.
        now: the reference time, for tests.
        allow_stale_backup: accept an older snapshot, and RECORD that.
        no_backup_check: skip the check entirely, print the consequence, RECORD.
        dsn: the target DSN, used only to write the audit row for an override.
        log: a line sink; ``None`` means ``print``.

    Returns:
        dict: ``{"checked", "ok", "reason", "newest", "override"}``.

    Raises:
        BackupRequired: when the guard is armed and no acceptable snapshot
            exists, with a typed payload naming the one command that fixes it.
    """
    env = os.environ if env is None else env
    log = print if log is None else log

    if no_backup_check:
        log(NO_BACKUP_CHECK_CONSEQUENCE)
        record_override("no-backup-check", step=step, dsn=dsn, env=env,
                        detail={"max_age_hours": max_age_hours, "scope": scope})
        return {"checked": False, "ok": True, "reason": "no_backup_check",
                "newest": None, "override": "no-backup-check"}

    if not guard_armed(env):
        return {"checked": False, "ok": True, "reason": REASON_DISARMED,
                "newest": None, "override": None}

    ok, newest, reason = recent_verified_backup(
        max_age_hours=max_age_hours, scope=scope, backups_dir=backups_dir,
        dsn_fingerprint=dsn_fingerprint, env=env, now=now)

    if ok:
        return {"checked": True, "ok": True, "reason": reason,
                "newest": _row_summary(newest), "override": None}

    if allow_stale_backup:
        log("WARNING: proceeding with --allow-stale-backup. The newest "
            "acceptable snapshot is %s (%s hours old); the guard wanted one "
            "newer than %d hours. This override is recorded."
            % ((newest or {}).get("name"), age_hours(newest, now),
               max_age_hours))
        record_override("allow-stale-backup", step=step, dsn=dsn, env=env,
                        detail={"reason": reason, "max_age_hours": max_age_hours,
                                "newest": _row_summary(newest),
                                "newest_age_hours": age_hours(newest, now)})
        return {"checked": True, "ok": True, "reason": reason,
                "newest": _row_summary(newest), "override": "allow-stale-backup"}

    payload = {
        "error": "backup_required",
        "step": step,
        "scope": scope,
        "max_age_hours": max_age_hours,
        "guard_reason": reason,
        "newest": (newest or {}).get("name"),
        "newest_age_hours": age_hours(newest, now),
        "remedy": remedy_command(step=step, backups_dir=backups_dir,
                                 scope=scope),
        # The same remedy as a LIST, so a caller never has to re-parse the
        # string. Splitting it is platform-specific and `shlex.split` mangles a
        # Windows path; plan 89-11's installer spawns this directly.
        "remedy_argv": remedy_argv(step=step, backups_dir=backups_dir,
                                   scope=scope),
        "override_flags": ["--allow-stale-backup", "--no-backup-check"],
        "kill_switch": "%s=off" % GUARD_ENV,
    }
    payload["message"] = (
        "refusing to touch data for step %r: no verified backup newer than %d "
        "hours (%s). Take one with:\n  %s\nOr proceed deliberately with "
        "--allow-stale-backup (recorded) or --no-backup-check (recorded, and it "
        "prints what it gives up)." % (step, max_age_hours, reason,
                                       payload["remedy"]))
    raise BackupRequired(payload)


def _row_summary(row):
    """The reportable fields of a snapshot row, with no path and no DSN.

    Args:
        row: a snapshot row, or None.

    Returns:
        dict | None
    """
    if not row:
        return None
    return {k: row.get(k) for k in
            ("name", "reason", "scope", "created_at", "verified_at",
             "dsn_fingerprint")}


# ══════════════════════════════════════════════════════════════════
# Recording an override
# ══════════════════════════════════════════════════════════════════

def _install_record_path(env=None):
    """Where the installer's own record lives.

    ``bin/init.cjs:1791`` writes ``<home>/.amauta/data/install_record.json`` and
    ``services/doctor.py:525`` reads the same path.  Under ``AMAUTA_DATA_DIR``
    the record lives in that directory instead, so a test never reaches the
    operator's file.

    Args:
        env: the environment to read.

    Returns:
        str
    """
    env = os.environ if env is None else env
    data_dir = (env.get("AMAUTA_DATA_DIR") or "").strip()
    if data_dir:
        return os.path.join(data_dir, "install_record.json")
    return os.path.join(_platform.home_dir(), ".amauta", "data",
                        "install_record.json")


def record_override(flag, step=None, dsn=None, env=None, detail=None):
    """Record an override in the audit log and in the install record.

    An override that leaves no trace is indistinguishable from the guard not
    existing.  Both destinations are best-effort and INDEPENDENT: a missing
    database must not stop the install record being written, and an absent
    install record must not stop the audit row.

    Args:
        flag: ``"allow-stale-backup"`` or ``"no-backup-check"``.
        step: the step that was overridden.
        dsn: the database to write the audit row to; ``None`` skips that half.
        env: the environment to read.
        detail: extra JSON metadata.

    Returns:
        dict: ``{"audit_row": id|None, "install_record": path|None}``.
    """
    env = os.environ if env is None else env
    payload = {"flag": flag, "step": step,
               "at": snapshots.iso(snapshots.utc_now())}
    payload.update(detail or {})

    audit_row = None
    if dsn:
        audit_row = _write_audit_row(dsn, flag, payload)

    record_path = _install_record_path(env)
    written = None
    if os.path.isfile(record_path):
        try:
            with open(record_path, "r", encoding="utf-8") as handle:
                document = json.load(handle)
            if isinstance(document, dict):
                document["last_override"] = payload
                tmp = record_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as handle:
                    json.dump(document, handle, indent=2)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(tmp, record_path)
                written = record_path
        except Exception:  # noqa: BLE001 - best effort, reported in the result
            written = None
    return {"audit_row": audit_row, "install_record": written}


def _write_audit_row(dsn, flag, payload):
    """Append one ``gsd_audit_log`` row for an override.

    Args:
        dsn: the database.
        flag: the override flag.
        payload: the JSON metadata.

    Returns:
        int | None: the new row id, or None when it could not be written (a
        fresh database has no ``gsd_audit_log`` until migration 006 runs, which
        is exactly the situation the guard fires in).
    """
    try:
        import psycopg2

        conn = psycopg2.connect(dsn, connect_timeout=15)
    except Exception:  # noqa: BLE001 - an unreachable database is reportable
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO gsd_audit_log "
                "(task_id, event_type, agent_id, actor, content, metadata) "
                "VALUES (%s, %s, %s, %s, %s, %s::jsonb) RETURNING id",
                ("backup-guard", "backup_guard_override", "backup_guard",
                 flag, "override %s for step %s" % (flag, payload.get("step")),
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

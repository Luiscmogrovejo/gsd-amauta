#!/usr/bin/env python3
"""Plan 89-04: the backup guard — its truth table, and proof that it FIRES.

The predicate's six-cell truth table, the arming rules and the remedy's
executability need no database and run on every cell with no skip.  The two arms
that matter most — ``migrate_runner.apply_migrations`` REFUSING with
``backup_required`` and then proceeding under ``--allow-stale-backup`` — run on
the disposable PostgreSQL, because a guard CI never sees fire is a guard nobody
has tested.

Run: /opt/homebrew/bin/python3 -m pytest tests/test_89_04_backup_guard.py -q -rs -p no:cacheprovider
"""

import datetime
import json
import os
import pathlib
import shlex
import subprocess
import sys
import uuid

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
SUPPORT = REPO_ROOT / "tests" / "support"
if str(SUPPORT) not in sys.path:
    sys.path.insert(0, str(SUPPORT))

from conftest import PG_SKIP_REASON, postgres_dsn_or_none  # noqa: E402
from services import backup_guard as guard  # noqa: E402
from services import backup_snapshot as bs  # noqa: E402
from services import migrate_runner, migrate_sqlite_to_pg, pg_dsn  # noqa: E402

TEST_DSN = postgres_dsn_or_none()
requires_pg = pytest.mark.skipif(TEST_DSN is None, reason=PG_SKIP_REASON)


# ══════════════════════════════════════════════════════════════════
# The pinned environment
# ══════════════════════════════════════════════════════════════════

def pinned_env(home, **extra):
    """The plan's pinned environment, built from the parent one.

    HOME, USERPROFILE, HOMEDRIVE and HOMEPATH are set TOGETHER, as the Windows
    cell needs and as the 88-14 lint's POSIX_HOME_ONLY rule requires.

    Args:
        home: the directory every home variable points at.
        **extra: further variables, or ``None`` to delete one.

    Returns:
        dict
    """
    home = str(home)
    drive, tail = os.path.splitdrive(home)
    env = dict(os.environ)
    env.update({
        "HOME": home,
        "USERPROFILE": home,
        "HOMEDRIVE": drive or "",
        "HOMEPATH": tail or home,
        "AMAUTA_DATA_DIR": str(pathlib.Path(home) / "data"),
        "AMAUTA_AUTO_BACKUP": "off",
        "GSD_AMAUTA_PORT": "0",
        "GSD_DAEMON_PORT": "0",
        "GSD_RLM_PORT": "0",
    })
    env.pop("GSD_TEST_MODE", None)
    env.pop("CI", None)
    env.pop("GSD_BACKUP_GUARD", None)
    for key, value in extra.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = str(value)
    return env


@pytest.fixture
def home(tmp_path):
    """A temp home carrying the data dir the pinned environment names."""
    h = tmp_path / "home"
    (h / "data").mkdir(parents=True)
    return h


@pytest.fixture
def backups(tmp_path):
    """An empty, explicit backups directory."""
    d = tmp_path / "backups"
    d.mkdir()
    return d


def plant(backups_dir, reason="pre-migration", hours_old=1, verified=True,
          scope="all", fingerprint=None, now=None):
    """Write a minimal snapshot directory with a chosen age and shape.

    Args:
        backups_dir: where to plant it.
        reason: the snapshot's reason.
        hours_old: its age in hours.
        verified: whether it carries ``verified_at``.
        scope: its scope.
        fingerprint: its ``dsn_fingerprint``.
        now: the reference time.

    Returns:
        str: the snapshot directory.
    """
    now = now or bs.utc_now()
    created = now - datetime.timedelta(hours=hours_old)
    path = os.path.join(str(backups_dir), bs.snapshot_name(reason, created))
    suffix = 1
    while os.path.exists(path):
        suffix += 1
        path = os.path.join(str(backups_dir),
                            "%s-%d" % (bs.snapshot_name(reason, created), suffix))
    os.makedirs(path)
    manifest = {"schema": 1, "created_at": bs.iso(created), "reason": reason,
                "scope": scope, "dsn_fingerprint": fingerprint, "files": []}
    if verified:
        manifest["verified_at"] = bs.iso(created)
        manifest["verify_result"] = "ok"
    with open(os.path.join(path, bs.MANIFEST_NAME), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle)
    return path


# ══════════════════════════════════════════════════════════════════
# The six-cell truth table
# ══════════════════════════════════════════════════════════════════

def test_cell_1_no_snapshot(backups):
    """An empty backups directory: ``no_snapshot``."""
    ok, newest, reason = guard.recent_verified_backup(backups_dir=str(backups))
    assert (ok, newest, reason) == (False, None, "no_snapshot")


def test_cell_2_an_unverified_snapshot_is_absent(backups):
    """No ``verified_at`` means ABSENT, not "present but unchecked"."""
    planted = plant(backups, hours_old=1, verified=False)
    ok, newest, reason = guard.recent_verified_backup(backups_dir=str(backups))
    assert ok is False
    assert reason == "unverified_only"
    assert newest["snapshot"] == planted


def test_cell_3_a_twenty_five_hour_old_snapshot_is_stale(backups):
    """25 hours > the 24-hour ceiling: ``stale``."""
    planted = plant(backups, hours_old=25)
    ok, newest, reason = guard.recent_verified_backup(backups_dir=str(backups))
    assert ok is False
    assert reason == "stale"
    assert newest["snapshot"] == planted
    assert guard.age_hours(newest) >= 24.9


def test_cell_4_a_twenty_three_hour_old_snapshot_passes(backups):
    """23 hours < the ceiling: ``ok``.  The boundary is load-bearing."""
    planted = plant(backups, hours_old=23)
    ok, newest, reason = guard.recent_verified_backup(backups_dir=str(backups))
    assert (ok, reason) == (True, "ok")
    assert newest["snapshot"] == planted


def test_cell_5_a_wrong_fingerprint_does_not_count(backups):
    """A verified, fresh backup OF ANOTHER DATABASE is not a backup of this one."""
    wanted = bs.dsn_fingerprint("postgres" + "ql://u:p@host-a:5432/db")
    other = bs.dsn_fingerprint("postgres" + "ql://u:p@host-b:5432/db")
    assert wanted != other
    plant(backups, hours_old=1, fingerprint=other)
    ok, newest, reason = guard.recent_verified_backup(
        backups_dir=str(backups), dsn_fingerprint=wanted)
    assert ok is False
    assert reason == "fingerprint_mismatch"
    assert newest["dsn_fingerprint"] == other


def test_cell_6_the_right_fingerprint_passes(backups):
    """The matching fingerprint is accepted."""
    wanted = bs.dsn_fingerprint("postgres" + "ql://u:p@host-a:5432/db")
    planted = plant(backups, hours_old=2, fingerprint=wanted)
    ok, newest, reason = guard.recent_verified_backup(
        backups_dir=str(backups), dsn_fingerprint=wanted)
    assert (ok, reason) == (True, "ok")
    assert newest["snapshot"] == planted


def test_an_auto_snapshot_alone_does_not_satisfy_the_guard(backups):
    """``auto`` is excluded: a daily background copy is not a decision.

    This is the cell that stops the guard from being satisfied by the very
    ``gsd-auto-*`` mechanism decision D9 declares is not a backup.
    """
    plant(backups, reason="auto", hours_old=1)
    ok, _newest, reason = guard.recent_verified_backup(backups_dir=str(backups))
    assert ok is False
    assert reason == "no_snapshot"
    assert "auto" not in bs.GUARD_ACCEPTED_REASONS


def test_a_narrower_scope_does_not_satisfy_a_wider_step(backups):
    """A ``tasks`` snapshot is not a backup for an ``all`` step; ``all`` is."""
    plant(backups, hours_old=1, scope="tasks")
    ok, _newest, reason = guard.recent_verified_backup(
        backups_dir=str(backups), scope="all")
    assert (ok, reason) == (False, "scope_mismatch")
    ok, _newest, reason = guard.recent_verified_backup(
        backups_dir=str(backups), scope="tasks")
    assert (ok, reason) == (True, "ok")
    plant(backups, hours_old=1, scope="all")
    ok, _newest, reason = guard.recent_verified_backup(
        backups_dir=str(backups), scope="postgres")
    assert (ok, reason) == (True, "ok")


# ══════════════════════════════════════════════════════════════════
# Arming: kill-switch-first, and silent for the suite by default
# ══════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("env,expected", [
    ({}, True),
    ({"GSD_BACKUP_GUARD": "off"}, False),
    ({"GSD_BACKUP_GUARD": "on"}, True),
    ({"GSD_TEST_MODE": "1"}, False),
    ({"CI": "true"}, False),
    ({"CI": "true", "GSD_TEST_MODE": "1"}, False),
    ({"CI": "true", "GSD_BACKUP_GUARD": "on"}, True),
    ({"GSD_TEST_MODE": "1", "GSD_BACKUP_GUARD": "on"}, True),
    ({"GSD_BACKUP_GUARD": "off", "CI": "true"}, False),
])
def test_the_arming_table(env, expected):
    """Every arming combination, stated rather than inferred."""
    assert guard.guard_armed(env) is expected


def test_the_suite_is_unaffected_by_default(home, backups):
    """With ``CI`` set and no ``GSD_BACKUP_GUARD``, the guard does not fire.

    If it did, every other Postgres test in this repository would break — which
    is why this is asserted directly rather than assumed from the arming table.
    """
    env = pinned_env(home, CI="true")
    result = guard.require_recent_backup(step="migrations",
                                         backups_dir=str(backups), env=env)
    assert result == {"checked": False, "ok": True, "reason": "disarmed",
                      "newest": None, "override": None}
    assert os.listdir(str(backups)) == [], "and it created nothing"


def test_the_kill_switch_disarms_it_even_outside_ci(home, backups):
    """``GSD_BACKUP_GUARD=off`` is the documented escape hatch."""
    env = pinned_env(home, GSD_BACKUP_GUARD="off")
    assert guard.guard_armed(env) is False
    result = guard.require_recent_backup(step="migrations",
                                         backups_dir=str(backups), env=env)
    assert result["reason"] == "disarmed"


def test_the_guard_fires_when_armed_with_an_empty_backups_directory(home, backups):
    """The positive arm, in process: armed + nothing present = refusal."""
    env = pinned_env(home, GSD_BACKUP_GUARD="on", CI="true")
    with pytest.raises(guard.BackupRequired) as caught:
        guard.require_recent_backup(step="migrations", backups_dir=str(backups),
                                    env=env, log=lambda *_a: None)
    payload = caught.value.payload
    assert payload["error"] == "backup_required"
    assert payload["max_age_hours"] == 24
    assert payload["newest"] is None
    assert payload["newest_age_hours"] is None
    assert payload["guard_reason"] == "no_snapshot"
    assert payload["step"] == "migrations"
    assert payload["kill_switch"] == "GSD_BACKUP_GUARD=off"
    assert payload["override_flags"] == ["--allow-stale-backup",
                                         "--no-backup-check"]
    assert "backup_snapshot.py" in payload["remedy"]
    assert "for migrations" in payload["remedy"]


def test_the_refusal_names_the_age_of_the_snapshot_it_rejected(home, backups):
    """A stale refusal reports HOW stale, so the operator can judge."""
    env = pinned_env(home, GSD_BACKUP_GUARD="on")
    plant(backups, hours_old=72)
    with pytest.raises(guard.BackupRequired) as caught:
        guard.require_recent_backup(step="migrations", backups_dir=str(backups),
                                    env=env, log=lambda *_a: None)
    payload = caught.value.payload
    assert payload["guard_reason"] == "stale"
    assert payload["newest"] is not None
    assert 71 <= payload["newest_age_hours"] <= 73


# ══════════════════════════════════════════════════════════════════
# The remedy command is EXECUTED, not merely printed
# ══════════════════════════════════════════════════════════════════

def test_the_remedy_command_runs_and_makes_the_guard_pass(home, backups):
    """Extract the remedy from the payload, run it, assert the guard passes.

    A remedy nobody has run is a guess.  The command is run in the pinned
    environment with a temp HOME and a temp ``--backups-dir``, so nothing can
    reach the operator's own ``~/.amauta/backups``.
    """
    # `scope=tasks` is the shape that needs no database, so the remedy is
    # runnable on every cell with no disposable Postgres.
    env = pinned_env(home, GSD_BACKUP_GUARD="on")
    (pathlib.Path(home) / "data" / "tasks.json").write_text(
        json.dumps({"items": [{"id": "TK-1"}], "metadata": {}}),
        encoding="utf-8")

    with pytest.raises(guard.BackupRequired) as caught:
        guard.require_recent_backup(step="migrations", scope="tasks",
                                    backups_dir=str(backups), env=env,
                                    log=lambda *_a: None)
    remedy = caught.value.payload["remedy"]
    argv = caught.value.payload["remedy_argv"]
    assert "--backups-dir" in remedy
    assert str(backups) in remedy
    assert "--scope tasks" in remedy, (
        "the remedy must carry the scope the guard asked for, or it is not "
        "runnable as printed")
    assert argv[-4:] == ["--backups-dir", str(backups), "--scope", "tasks"], argv

    # RUN IT UNCHANGED, from the ARGV the payload carries. Not from the rendered
    # string: `shlex.split` runs in POSIX mode, so on the Windows cell it ate
    # the backslashes of every path and the spawn failed with WinError 2
    # (run 43319162316). A machine reads `remedy_argv`; a human reads `remedy`.
    run = subprocess.run(argv, capture_output=True, text=True,
                         encoding="utf-8", errors="replace", env=env,
                         cwd=str(REPO_ROOT), timeout=300)
    assert run.returncode == 0, run.stdout + run.stderr
    # And the rendered string is the same command, re-parsed with the parser
    # this platform's shell would use.
    if sys.platform != "win32":
        assert shlex.split(remedy) == argv

    after = guard.require_recent_backup(step="migrations", scope="tasks",
                                        backups_dir=str(backups), env=env,
                                        log=lambda *_a: None)
    assert after["ok"] is True
    assert after["reason"] == "ok"
    assert after["newest"]["reason"] == "pre-migration"
    assert after["newest"]["verified_at"]


def test_the_remedy_names_a_step_that_exists():
    """Every step the guard can name is a key of ``STEP_SNAPSHOTS``."""
    for step in sorted(bs.STEP_SNAPSHOTS):
        assert step in guard.remedy_command(step=step)
        assert guard.remedy_argv(step=step)[-1] == step
    assert "migrations" in bs.STEP_SNAPSHOTS
    assert "sqlite-to-pg" in bs.STEP_SNAPSHOTS


def test_the_remedy_is_carried_as_both_a_string_and_an_argv(tmp_path):
    """One remedy, two shapes, and the list is the authoritative one.

    The rendered string exists for a human to paste and is quoted the way THIS
    platform's shell expects; the list exists so no caller re-parses it. A
    directory with a space in it is the case that separates them.
    """
    spaced = tmp_path / "back ups"
    spaced.mkdir()
    argv = guard.remedy_argv(step="migrations", backups_dir=str(spaced),
                             scope="tasks")
    line = guard.remedy_command(step="migrations", backups_dir=str(spaced),
                                scope="tasks")
    assert argv[2] == "for" and argv[3] == "migrations"
    assert str(spaced) in argv
    assert "back ups" in line
    assert '"' in line or "'" in line, "a path with a space must be quoted"
    if sys.platform != "win32":
        assert shlex.split(line) == argv


def test_the_remedy_never_carries_a_password(home, backups):
    """The guard never puts a DSN in the remedy by itself."""
    secret = "sekrit-guard-pw"
    dsn = "postgres" + "ql://u:%s@127.0.0.1:65432/db" % secret
    env = pinned_env(home, GSD_BACKUP_GUARD="on")
    with pytest.raises(guard.BackupRequired) as caught:
        guard.require_recent_backup(step="migrations", backups_dir=str(backups),
                                    dsn_fingerprint=bs.dsn_fingerprint(dsn),
                                    dsn=dsn, env=env, log=lambda *_a: None)
    payload = caught.value.payload
    assert secret not in json.dumps(payload)
    assert secret not in payload["remedy"]


# ══════════════════════════════════════════════════════════════════
# The overrides are recorded, not silent
# ══════════════════════════════════════════════════════════════════

def test_allow_stale_backup_is_recorded_in_the_install_record(home, backups):
    """The override lands in ``install_record.json`` as ``last_override``."""
    record = pathlib.Path(home) / "data" / "install_record.json"
    record.write_text(json.dumps({"version": "3.3.0"}), encoding="utf-8")
    env = pinned_env(home, GSD_BACKUP_GUARD="on")
    plant(backups, hours_old=100)
    lines = []
    result = guard.require_recent_backup(
        step="migrations", backups_dir=str(backups), env=env,
        allow_stale_backup=True, log=lines.append)
    assert result["ok"] is True
    assert result["override"] == "allow-stale-backup"
    assert any("--allow-stale-backup" in line for line in lines), lines
    document = json.loads(record.read_text(encoding="utf-8"))
    assert document["version"] == "3.3.0", "the record was not clobbered"
    assert document["last_override"]["flag"] == "allow-stale-backup"
    assert document["last_override"]["step"] == "migrations"
    assert document["last_override"]["reason"] == "stale"
    assert document["last_override"]["newest_age_hours"] >= 99


def test_no_backup_check_prints_the_full_consequence_and_is_recorded(home, backups):
    """The escape hatch says what it gives up, in full, and is recorded."""
    record = pathlib.Path(home) / "data" / "install_record.json"
    record.write_text(json.dumps({"version": "3.3.0"}), encoding="utf-8")
    env = pinned_env(home, GSD_BACKUP_GUARD="on")
    lines = []
    result = guard.require_recent_backup(
        step="migrations", backups_dir=str(backups), env=env,
        no_backup_check=True, log=lines.append)
    assert result == {"checked": False, "ok": True, "reason": "no_backup_check",
                      "newest": None, "override": "no-backup-check"}
    assert lines == [guard.NO_BACKUP_CHECK_CONSEQUENCE]
    assert "2026-11-12" in guard.NO_BACKUP_CHECK_CONSEQUENCE
    assert "--allow-stale-backup" in guard.NO_BACKUP_CHECK_CONSEQUENCE
    document = json.loads(record.read_text(encoding="utf-8"))
    assert document["last_override"]["flag"] == "no-backup-check"


def test_an_absent_install_record_is_not_created_by_an_override(home, backups):
    """Recording is best-effort and never invents an install record."""
    record = pathlib.Path(home) / "data" / "install_record.json"
    assert not record.exists()
    env = pinned_env(home, GSD_BACKUP_GUARD="on")
    out = guard.record_override("allow-stale-backup", step="migrations", env=env)
    assert out == {"audit_row": None, "install_record": None}
    assert not record.exists()


def test_the_install_record_path_never_escapes_the_data_dir(home):
    """Containment of the record path itself.

    With ``AMAUTA_DATA_DIR`` set the record is inside it, so no test can reach
    the operator's ``~/.amauta/data/install_record.json``.
    """
    env = pinned_env(home)
    path = guard._install_record_path(env)
    assert path == str(pathlib.Path(home) / "data" / "install_record.json")
    assert str(pathlib.Path.home()) not in path or str(home).startswith(
        str(pathlib.Path.home()))


# ══════════════════════════════════════════════════════════════════
# The call sites: migrate_runner and migrate_sqlite_to_pg
# ══════════════════════════════════════════════════════════════════

def test_the_predicate_is_called_from_exactly_two_product_modules():
    """One predicate, two Python call sites — plus its own definition.

    ``bin/init.cjs``'s six installer call sites are plan 89-11's (decision D8),
    so they are deliberately absent here.
    """
    hits = []
    for path in sorted((REPO_ROOT / "services").glob("*.py")):
        text = path.read_text(encoding="utf-8")
        if "recent_verified_backup" in text or "require_recent_backup" in text:
            hits.append(path.name)
    assert hits == ["backup_guard.py", "migrate_runner.py",
                    "migrate_sqlite_to_pg.py"], hits


def test_the_guard_runs_before_the_first_begin_in_apply_migrations():
    """Source order: the guard call precedes ``_connect`` and the DDL.

    A guard that ran after the connection and after ``ensure_tracking_table``
    would already have opened a transaction on the database it is protecting.
    """
    source = (REPO_ROOT / "services" / "migrate_runner.py").read_text(
        encoding="utf-8")
    body = source.split("def apply_migrations", 1)[1].split("\ndef ", 1)[0]
    guard_at = body.index("require_recent_backup")
    connect_at = body.index("conn = _connect(dsn)")
    tracking_at = body.index("ensure_tracking_table(conn)")
    assert guard_at < connect_at < tracking_at
    assert "if not dry_run:" in body[:guard_at]


def test_both_call_sites_expose_the_two_override_flags():
    """``--allow-stale-backup`` and ``--no-backup-check`` on both CLIs."""
    for module in (migrate_runner, migrate_sqlite_to_pg):
        parser_source = (REPO_ROOT / "services" /
                         (module.__name__.split(".")[-1] + ".py")).read_text(
                             encoding="utf-8")
        assert '"--allow-stale-backup"' in parser_source, module.__name__
        assert '"--no-backup-check"' in parser_source, module.__name__


# ══════════════════════════════════════════════════════════════════
# The arms that need a database: the guard FIRES, and the override passes
# ══════════════════════════════════════════════════════════════════

def _admin_dsn():
    """The DSN pointed at ``postgres``, for CREATE/DROP DATABASE.

    Returns:
        str
    """
    return pg_dsn.dsn_with_database(TEST_DSN, "postgres")


def _autocommit(dsn):
    """An autocommit connection.

    Args:
        dsn: the DSN.

    Returns:
        psycopg2 connection
    """
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    conn = psycopg2.connect(dsn, connect_timeout=15)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    return conn


@pytest.fixture
def scratch():
    """An isolated, EMPTY database; dropped afterwards.

    Yields:
        dict: ``{"dsn", "name"}``.
    """
    name = "gsd_8904g_" + uuid.uuid4().hex[:12]
    conn = _autocommit(_admin_dsn())
    try:
        with conn.cursor() as cur:
            cur.execute('CREATE DATABASE "%s"' % name)
    finally:
        conn.close()
    try:
        yield {"dsn": pg_dsn.dsn_with_database(TEST_DSN, name), "name": name}
    finally:
        conn = _autocommit(_admin_dsn())
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = %s AND pid <> pg_backend_pid()", (name,))
                cur.execute('DROP DATABASE IF EXISTS "%s"' % name)
        finally:
            conn.close()


def _has_gsd_schema(dsn):
    """Whether the database carries this repository's own schema.

    The precise question the guard tests ask. A raw table COUNT cannot answer
    it: measured on the ParadeDB image, a freshly created database already has
    one public table inherited from the template.

    Args:
        dsn: the database.

    Returns:
        bool
    """
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=15)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                "AND table_name IN ('gsd_memory', 'gsd_tasks', 'gsd_shared_kb', "
                "'schema_migrations')")
            return int(cur.fetchone()[0]) > 0
    finally:
        conn.close()


def _table_count(dsn):
    """How many public base tables the database holds.

    Args:
        dsn: the database.

    Returns:
        int
    """
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=15)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
            return int(cur.fetchone()[0])
    finally:
        conn.close()


@requires_pg
def test_apply_migrations_refuses_when_armed_with_no_snapshot(scratch, home,
                                                              backups):
    """THE ARM THAT MAKES THE GUARD REAL.

    With ``GSD_BACKUP_GUARD=on`` and an empty backups directory,
    ``apply_migrations`` against a real, empty disposable database raises
    ``backup_required`` and the database is STILL EMPTY afterwards — the guard
    refused before the first BEGIN, so nothing was created.
    """
    env = pinned_env(home, GSD_BACKUP_GUARD="on", CI="true")
    # NOT `== 0`: measured on the ParadeDB image, a freshly created database
    # inherits a public table from the template. The claim is that the guard
    # changed NOTHING, so the baseline is captured and compared.
    baseline = _table_count(scratch["dsn"])
    assert not _has_gsd_schema(scratch["dsn"]), "the target must start un-migrated"
    with pytest.raises(guard.BackupRequired) as caught:
        migrate_runner.apply_migrations(dsn=scratch["dsn"],
                                        backups_dir=str(backups), env=env,
                                        log=lambda *_a: None)
    payload = caught.value.payload
    assert payload["error"] == "backup_required"
    assert payload["guard_reason"] == "no_snapshot"
    assert payload["max_age_hours"] == 24
    assert "for migrations" in payload["remedy"]
    assert _table_count(scratch["dsn"]) == baseline, "the guard fired before any DDL"
    assert not _has_gsd_schema(scratch["dsn"])


@requires_pg
def test_apply_migrations_proceeds_with_allow_stale_backup_and_records_it(
        scratch, home, backups):
    """The override lets it through, and the override is RECORDED."""
    env = pinned_env(home, GSD_BACKUP_GUARD="on", CI="true")
    record = pathlib.Path(home) / "data" / "install_record.json"
    record.write_text(json.dumps({"version": "3.3.0"}), encoding="utf-8")
    plant(backups, hours_old=200,
          fingerprint=bs.dsn_fingerprint(scratch["dsn"]))
    lines = []
    result = migrate_runner.apply_migrations(
        dsn=scratch["dsn"], backups_dir=str(backups), env=env,
        allow_stale_backup=True, log=lines.append)
    assert result["applied"], "migrations really ran"
    assert _table_count(scratch["dsn"]) > 10
    assert any("--allow-stale-backup" in line for line in lines), lines
    document = json.loads(record.read_text(encoding="utf-8"))
    assert document["last_override"]["flag"] == "allow-stale-backup"
    assert document["last_override"]["step"] == "migrations"


@requires_pg
def test_apply_migrations_proceeds_with_a_fresh_verified_snapshot(scratch, home,
                                                                  backups):
    """No override needed when the guard's condition is actually met."""
    env = pinned_env(home, GSD_BACKUP_GUARD="on", CI="true")
    plant(backups, hours_old=2,
          fingerprint=bs.dsn_fingerprint(scratch["dsn"]))
    result = migrate_runner.apply_migrations(
        dsn=scratch["dsn"], backups_dir=str(backups), env=env,
        log=lambda *_a: None)
    assert result["applied"]
    assert _table_count(scratch["dsn"]) > 10


@requires_pg
def test_dry_run_and_status_are_never_gated(scratch, home, backups):
    """Both proceed with the guard ARMED and an empty backups directory.

    This is what keeps the cutover's read-only census read-only: a census that
    needed a backup first could never be the thing that decides whether to take
    one.
    """
    env = pinned_env(home, GSD_BACKUP_GUARD="on", CI="true")
    assert os.listdir(str(backups)) == []
    baseline = _table_count(scratch["dsn"])
    dry = migrate_runner.apply_migrations(
        dsn=scratch["dsn"], dry_run=True, backups_dir=str(backups), env=env,
        log=lambda *_a: None)
    assert dry["dry_run"] is True
    assert dry["pending"], "the dry run really classified the pending files"
    assert _table_count(scratch["dsn"]) == baseline
    assert not _has_gsd_schema(scratch["dsn"])

    payload = migrate_runner.status(dsn=scratch["dsn"])
    assert payload["tracking_table"] is False
    assert payload["pending"]
    assert _table_count(scratch["dsn"]) == baseline


@requires_pg
def test_the_status_cli_is_never_gated(scratch, home, backups):
    """``--status`` exits 0 with the guard armed and nothing backed up."""
    env = pinned_env(home, GSD_BACKUP_GUARD="on", CI="true")
    run = subprocess.run(
        [sys.executable, str(REPO_ROOT / "services" / "migrate_runner.py"),
         "--status", "--dsn", scratch["dsn"], "--backups-dir", str(backups),
         "--json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(REPO_ROOT), timeout=300)
    assert run.returncode == 0, run.stdout + run.stderr
    assert json.loads(run.stdout)["tracking_table"] is False


@requires_pg
def test_the_migrate_cli_refuses_with_a_typed_payload_and_exit_one(scratch, home,
                                                                   backups):
    """The CLI's own arm: exit 1 and ``backup_required`` on stdout as JSON."""
    env = pinned_env(home, GSD_BACKUP_GUARD="on", CI="true")
    baseline = _table_count(scratch["dsn"])
    run = subprocess.run(
        [sys.executable, str(REPO_ROOT / "services" / "migrate_runner.py"),
         "--dsn", scratch["dsn"], "--backups-dir", str(backups), "--json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=env, cwd=str(REPO_ROOT), timeout=300)
    assert run.returncode == 1, run.stdout + run.stderr
    assert _table_count(scratch["dsn"]) == baseline
    payload = json.loads(run.stdout)
    assert payload["error"] == "backup_required"
    assert payload["max_age_hours"] == 24
    assert not _has_gsd_schema(scratch["dsn"]), "the CLI created no GSD table"


@requires_pg
def test_migrate_sqlite_to_pg_refuses_in_write_mode_but_not_in_dry_run(
        scratch, home, backups, tmp_path):
    """The second call site: write mode is gated, ``--dry-run`` is not."""
    import sqlite3

    env = pinned_env(home, GSD_BACKUP_GUARD="on", CI="true")
    # The target needs the schema for a dry run to classify anything.
    plant(backups, hours_old=2, fingerprint=bs.dsn_fingerprint(scratch["dsn"]))
    migrate_runner.apply_migrations(dsn=scratch["dsn"],
                                    backups_dir=str(backups), env=env,
                                    log=lambda *_a: None)
    for name in os.listdir(str(backups)):
        import shutil

        shutil.rmtree(os.path.join(str(backups), name))
    assert os.listdir(str(backups)) == []

    source = tmp_path / "source.db"
    conn = sqlite3.connect(str(source))
    try:
        conn.execute("CREATE TABLE gsd_memory (id TEXT PRIMARY KEY, text TEXT, "
                     "agent_id TEXT, source TEXT, tags TEXT, metadata TEXT, "
                     "project_id TEXT, created_at TEXT, updated_at TEXT)")
        conn.executemany(
            "INSERT INTO gsd_memory (id, text, source) VALUES (?, ?, ?)",
            [("mem-g%d" % i, "text %d" % i, "agent") for i in range(3)])
        conn.commit()
    finally:
        conn.close()

    # Write mode: refused.
    with pytest.raises(guard.BackupRequired) as caught:
        migrate_sqlite_to_pg.migrate(sqlite_path=str(source), dsn=scratch["dsn"],
                                     dry_run=False, backups_dir=str(backups),
                                     env=env, log=lambda *_a: None)
    assert caught.value.payload["error"] == "backup_required"
    assert caught.value.payload["step"] == "sqlite-to-pg"

    # Dry run: never gated, and it really classified rows.
    ok, report = migrate_sqlite_to_pg.migrate(
        sqlite_path=str(source), dsn=scratch["dsn"], dry_run=True,
        backups_dir=str(backups), env=env, log=lambda *_a: None)
    assert report["dry_run"] is True
    memory = [t for t in report["tables"] if t["table"] == "gsd_memory"][0]
    # The printed COLUMN is headed `sqlite`; the report KEY is `source`
    # (services/migrate_sqlite_to_pg.py `_print_report`). Reading the header as
    # the key is how a report assertion goes vacuous.
    assert memory["source"] == 3, memory
    assert memory["insert"] == 3, memory


@requires_pg
def test_migrate_sqlite_to_pg_proceeds_with_the_override_and_records_it(
        scratch, home, backups, tmp_path):
    """And the override arm for the second call site."""
    import sqlite3

    env = pinned_env(home, GSD_BACKUP_GUARD="on", CI="true")
    record = pathlib.Path(home) / "data" / "install_record.json"
    record.write_text(json.dumps({"version": "3.3.0"}), encoding="utf-8")
    plant(backups, hours_old=2, fingerprint=bs.dsn_fingerprint(scratch["dsn"]))
    migrate_runner.apply_migrations(dsn=scratch["dsn"],
                                    backups_dir=str(backups), env=env,
                                    log=lambda *_a: None)
    for name in os.listdir(str(backups)):
        import shutil

        shutil.rmtree(os.path.join(str(backups), name))
    plant(backups, hours_old=500, fingerprint=bs.dsn_fingerprint(scratch["dsn"]))

    source = tmp_path / "source.db"
    conn = sqlite3.connect(str(source))
    try:
        conn.execute("CREATE TABLE gsd_memory (id TEXT PRIMARY KEY, text TEXT, "
                     "agent_id TEXT, source TEXT, tags TEXT, metadata TEXT, "
                     "project_id TEXT, created_at TEXT, updated_at TEXT)")
        conn.executemany(
            "INSERT INTO gsd_memory (id, text, source) VALUES (?, ?, ?)",
            [("mem-h%d" % i, "text %d" % i, "agent") for i in range(2)])
        conn.commit()
    finally:
        conn.close()

    lines = []
    ok, report = migrate_sqlite_to_pg.migrate(
        sqlite_path=str(source), dsn=scratch["dsn"], dry_run=False,
        backups_dir=str(backups), env=env, allow_stale_backup=True,
        log=lines.append)
    assert ok is True, report
    assert any("--allow-stale-backup" in line for line in lines), lines
    document = json.loads(record.read_text(encoding="utf-8"))
    assert document["last_override"]["flag"] == "allow-stale-backup"
    assert document["last_override"]["step"] == "sqlite-to-pg"

    # And the audit row, in the database the override touched.
    import psycopg2

    conn = psycopg2.connect(scratch["dsn"], connect_timeout=15)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT actor, metadata FROM gsd_audit_log "
                        "WHERE event_type = 'backup_guard_override' "
                        "ORDER BY id DESC LIMIT 1")
            row = cur.fetchone()
    finally:
        conn.close()
    assert row is not None, "the override left no audit row"
    assert row[0] == "allow-stale-backup"
    assert row[1]["step"] == "sqlite-to-pg"
    assert "://" not in json.dumps(row[1])

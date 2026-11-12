#!/usr/bin/env python3
"""Plan 89-04: `services/backup_snapshot.py` — create, the manifest, verification.

Every test here runs with a temp HOME and an explicit ``backups_dir`` under
``tmp_path``.  **None of them needs a database**, so none of them may skip on any
cell — the plan's acceptance criteria say so, and the skip gate would otherwise
demand a ledger entry for a test that reached for Postgres it does not need.  The
PostgreSQL legs are exercised through an injected ``connect`` and an injected
command ``runner``, which is also the only way the cold-volume-tar path is ever
run in this plan: its argv is asserted, and ``tar`` is never spawned.

The one test that measures rather than asserts is
:func:`test_pg_dump_capability_probe`.  Plan 89-04 task 01 needs the ``pg_dump`` /
``pg_restore`` / server versions of every CI cell, and the honest place for that
measurement is the suite: a temporary ``continue-on-error`` workflow step would
have given ``.github/workflows/test.yml`` a third owner this wave and would be
deleted again before anybody could re-read it.  The probe emits a ``UserWarning``
so the numbers land in the warnings summary of a ``-q`` run, which is where a
reader of the job log already is.

Run: /opt/homebrew/bin/python3 -m pytest tests/test_89_04_backup_snapshot.py -q -rs -p no:cacheprovider
"""

import argparse
import copy
import datetime
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import warnings

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
SUPPORT = REPO_ROOT / "tests" / "support"
if str(SUPPORT) not in sys.path:
    sys.path.insert(0, str(SUPPORT))

from fake_exe import isolated_path, write_fake_exe  # noqa: E402
from services import _platform  # noqa: E402
from services import backup_snapshot as bs  # noqa: E402

#: The eleven `--reason` values, reproduced here and in the record's `## Handoff`
#: so plan 89-14's step-0a check is a string comparison and not a judgement.
EXPECTED_REASONS = [
    "auto",
    "manual",
    "post-cutover",
    "post-load",
    "pre-cutover",
    "pre-embedding-cutover",
    "pre-migration",
    "pre-rebuild",
    "pre-reingest",
    "pre-restore",
    "pre-upgrade",
]

#: A password that appears nowhere else in the tree, so a leak is unambiguous.
SECRET = "sekrit-pw-89-04"
#: A DSN built from parts, never written as one literal, on a port that is not a
#: live service port and where nothing is listening.
FAKE_DSN = "postgres" + "ql://gsd:%s@127.0.0.1:65432/gsd_snapshot_test" % SECRET


# ══════════════════════════════════════════════════════════════════
# The pinned environment
# ══════════════════════════════════════════════════════════════════

def pinned_env(home, **extra):
    """The plan's pinned environment, built from the parent one.

    HOME, USERPROFILE, HOMEDRIVE and HOMEPATH are set TOGETHER (the Windows cell
    resolves ``~`` from the last three), which is also what the 88-14 lint's
    POSIX_HOME_ONLY rule requires of every test that redirects a home.

    Args:
        home: the directory every home variable points at.
        **extra: further variables, or ``None`` to delete one.

    Returns:
        dict: an environment mapping.
    """
    home = str(home)
    drive, tail = os.path.splitdrive(home)
    env = dict(os.environ)
    env.update({
        "HOME": home,
        "USERPROFILE": home,
        "HOMEDRIVE": drive or "",
        "HOMEPATH": tail or home,
        "GSD_TEST_MODE": "1",
        "AMAUTA_DATA_DIR": str(pathlib.Path(home) / "data"),
        "GSD_FORCE_SQLITE": "1",
        "GSD_AMAUTA_PORT": "0",
        "GSD_DAEMON_PORT": "0",
        "GSD_RLM_PORT": "0",
        "AMAUTA_MEMORY_DATABASE_URL": "",
        "GSD_POSTGRES_URL": "",
        "AMAUTA_AUTO_BACKUP": "off",
        "PYTHONPATH": str(REPO_ROOT),
    })
    for key in ("GSD_PG_DUMP_BIN", "GSD_PG_RESTORE_BIN",
                "GSD_BACKUP_ALLOW_DOCKER", "GSD_BACKUP_DOCKER_CONTAINER"):
        env.pop(key, None)
    for key, value in extra.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = str(value)
    return env


def run_cli(args, home, **extra):
    """Run ``services/backup_snapshot.py`` as a subprocess in the pinned env.

    Args:
        args: argv after the script path.
        home: the temp home every home variable points at.
        **extra: environment overrides.

    Returns:
        subprocess.CompletedProcess
    """
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "services" / "backup_snapshot.py")]
        + [str(a) for a in args],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
        env=pinned_env(home, **extra), timeout=300,
    )


@pytest.fixture
def home(tmp_path):
    """A temp home carrying the data dir the pinned environment names."""
    h = tmp_path / "home"
    (h / "data").mkdir(parents=True)
    return h


@pytest.fixture
def backups(tmp_path):
    """An explicit backups directory under tmp_path."""
    d = tmp_path / "backups"
    d.mkdir()
    return d


def write_tasks(home, count=3):
    """Write a tasks.json with ``count`` items into the home's data dir.

    Args:
        home: the temp home.
        count: how many items.

    Returns:
        pathlib.Path: the file written.
    """
    data_dir = pathlib.Path(home) / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / "tasks.json"
    path.write_text(json.dumps({
        "items": [{"id": "TK-%04d" % i, "title": "t%d" % i} for i in range(count)],
        "sprints": [],
        "metadata": {"version": "2.0"},
    }, indent=2), encoding="utf-8")
    (data_dir / "last_backend").write_text("sqlite", encoding="utf-8")
    (data_dir / "pg_retry_queue.json").write_text("[]", encoding="utf-8")
    (data_dir / "install_record.json").write_text(
        json.dumps({"version": "3.3.0"}), encoding="utf-8")
    return path


def write_sqlite(path, rows=4):
    """Build a tiny SQLite database at ``path``.

    Args:
        path: where to create it.
        rows: how many rows in the single table.

    Returns:
        str: the path, as a string.
    """
    conn = sqlite3.connect(str(path))
    try:
        conn.execute("CREATE TABLE gsd_memory (id INTEGER PRIMARY KEY, text TEXT)")
        conn.executemany("INSERT INTO gsd_memory (id, text) VALUES (?, ?)",
                         [(i, "row %d" % i) for i in range(rows)])
        conn.commit()
    finally:
        conn.close()
    return str(path)


# ══════════════════════════════════════════════════════════════════
# A fake PostgreSQL, so the manifest and the dump legs run with no database
# ══════════════════════════════════════════════════════════════════

FAKE_TABLES = {
    "gsd_memory": {"rows": 7, "vector": ("embedding", 1024), "with_embedding": 5},
    "rlm_chunks": {"rows": 3, "vector": ("embedding_code", 1024), "with_embedding": 3},
    "gsd_tasks": {"rows": 11},
    "schema_migrations": {"rows": 2},
}


class FakeCursor:
    """A cursor that answers exactly the census's queries and nothing else."""

    def __init__(self):
        self._rows = []
        self._one = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, sql, params=None):
        """Dispatch on the SQL text the census issues.

        Args:
            sql: the statement.
            params: ignored; the census binds nothing.

        Returns:
            None

        Raises:
            AssertionError: on a statement this fake does not model, so a new
                query in the product cannot pass unnoticed.
        """
        text = " ".join(str(sql).split())
        if text == "SHOW server_version_num":
            self._one = ("160004",)
        elif text == "SHOW server_version":
            self._one = ("16.4",)
        elif text.startswith("SELECT extname"):
            self._rows = [("vector", "0.8.1"), ("pg_search", "0.24.1")]
        elif "information_schema.tables" in text:
            self._rows = [(name,) for name in sorted(FAKE_TABLES)]
        elif "format_type(a.atttypid" in text:
            self._rows = [
                (name, spec["vector"][0],
                 "vector(%d)" % spec["vector"][1])
                for name, spec in sorted(FAKE_TABLES.items()) if "vector" in spec
            ]
        elif text.startswith("SELECT filename FROM schema_migrations"):
            self._rows = [("001-init.sql",), ("030-whatever.sql",)]
        elif text.startswith("SELECT COUNT(*) FROM"):
            table = text.split('"')[1]
            self._one = (FAKE_TABLES[table]["rows"],)
        elif text.startswith("SELECT COUNT("):
            table = text.split('FROM "')[1].split('"')[0]
            self._one = (FAKE_TABLES[table]["with_embedding"],)
        elif text.startswith("INSERT INTO gsd_audit_log"):
            self._one = (4242,)
        else:  # pragma: no cover - a new product query must be modelled
            raise AssertionError("FakeCursor does not model: %s" % text)

    def fetchone(self):
        """The single-row answer."""
        return self._one

    def fetchall(self):
        """The multi-row answer."""
        return list(self._rows)


class FakeConn:
    """A psycopg2-shaped connection over :class:`FakeCursor`."""

    def __init__(self):
        self.closed = False
        self.commits = 0

    def cursor(self):
        """A new cursor."""
        return FakeCursor()

    def commit(self):
        """Count commits so a test can assert the audit row was committed."""
        self.commits += 1

    def rollback(self):
        """No-op."""

    def close(self):
        """Mark closed."""
        self.closed = True


def fake_connect_factory(record=None):
    """A ``psycopg2.connect``-shaped callable over :class:`FakeConn`.

    Args:
        record: a list that receives each DSN the product connects with, so a
            test can assert the DSN never reached anywhere unexpected.

    Returns:
        callable
    """
    def connect(dsn, **_kwargs):
        if record is not None:
            record.append(dsn)
        return FakeConn()
    return connect


def fake_runner_factory(calls, dump_bytes=b"PGDMP-fake-custom-format-archive"):
    """A command runner that records argv and fabricates a dump file.

    It NEVER spawns anything.  ``pg_dump`` writes ``dump_bytes`` to the ``-f``
    path (or to ``stdout_path`` on the Docker branch); ``pg_restore --list`` and
    ``tar -tzf`` succeed; anything else fails loudly so an unmodelled tool call
    cannot pass unnoticed.

    Args:
        calls: a list that receives every argv.
        dump_bytes: the bytes the fake dump carries.

    Returns:
        callable: with :func:`services.backup_snapshot.default_runner`'s shape.
    """
    def runner(argv, *, env=None, stdout_path=None, timeout=None):
        calls.append(list(argv))
        name = os.path.basename(str(argv[0])).lower()
        joined = " ".join(str(a) for a in argv)
        if stdout_path:
            with open(stdout_path, "wb") as handle:
                handle.write(dump_bytes)
            return {"argv": list(argv), "returncode": 0, "stdout": b"", "stderr": ""}
        if "pg_dump" in joined and "-f" in argv:
            with open(argv[argv.index("-f") + 1], "wb") as handle:
                handle.write(dump_bytes)
            return {"argv": list(argv), "returncode": 0, "stdout": b"", "stderr": ""}
        if "--list" in argv:
            return {"argv": list(argv), "returncode": 0,
                    "stdout": b"; Archive created at 2026-11-12\n", "stderr": ""}
        if name.startswith("tar") or "tar" in name:
            return {"argv": list(argv), "returncode": 0, "stdout": b"./PG_VERSION\n",
                    "stderr": ""}
        if "pg_restore" in joined:
            return {"argv": list(argv), "returncode": 0, "stdout": b"", "stderr": ""}
        return {"argv": list(argv), "returncode": 97,
                "stdout": b"", "stderr": "the fake runner models no %r" % name}
    return runner


@pytest.fixture
def pg_fakes(tmp_path, home):
    """Fake ``pg_dump``/``pg_restore`` on a PATH plus the injected seams.

    Returns:
        dict: ``{"env", "runner", "connect", "calls", "dsns"}``.
    """
    fakes = tmp_path / "fakes"
    write_fake_exe(str(fakes), "pg_dump", "print('pg_dump (PostgreSQL) 16.4')")
    write_fake_exe(str(fakes), "pg_restore", "print('pg_restore (PostgreSQL) 16.4')")
    env = pinned_env(home, PATH=isolated_path(str(fakes)))
    calls, dsns = [], []
    return {"env": env, "runner": fake_runner_factory(calls),
            "connect": fake_connect_factory(dsns), "calls": calls, "dsns": dsns}


# ══════════════════════════════════════════════════════════════════
# Task 89-04-01: the capability probe (reports; never skips, never fails)
# ══════════════════════════════════════════════════════════════════

def _tool_version(name):
    """``<tool> --version`` for a tool resolved through the platform helper.

    Args:
        name: the executable name as it would be typed.

    Returns:
        str: the version line, or ``"(absent)"`` / ``"(error: …)"``.
    """
    resolved = bs.find_tool(name)
    if not resolved:
        return "(absent)"
    try:
        out = subprocess.run([resolved, "--version"], capture_output=True,
                             text=True, timeout=60)
    except Exception as exc:  # noqa: BLE001 - a probe reports, it does not raise
        return "(error: %s)" % exc
    return "%s -> %s" % (resolved, (out.stdout or out.stderr).strip())


def test_pg_dump_capability_probe():
    """Record pg_dump, pg_restore and the server version on THIS cell.

    A measurement, not an assertion: it must pass on every cell, including the
    ones with no PostgreSQL at all, because the plan forbids a skip here.
    """
    lines = [
        "=== 89-04 pg_dump capability probe",
        "platform               : %s" % sys.platform,
        "GSD_PG_DUMP_BIN        : %s" % (os.environ.get("GSD_PG_DUMP_BIN") or "<unset>"),
        "GSD_PG_RESTORE_BIN     : %s" % (os.environ.get("GSD_PG_RESTORE_BIN") or "<unset>"),
        "GSD_BACKUP_ALLOW_DOCKER: %s" % (os.environ.get("GSD_BACKUP_ALLOW_DOCKER") or "<unset>"),
        "PGBIN                  : %s" % (os.environ.get("PGBIN") or "<unset>"),
        "pg_dump --version      : %s" % _tool_version("pg_dump"),
        "pg_restore --version   : %s" % _tool_version("pg_restore"),
    ]
    dsn = (os.environ.get("GSD_TEST_POSTGRES_URL") or "").strip()
    if not dsn:
        lines.append("server_version         : (no disposable Postgres on this cell)")
    else:
        try:
            import psycopg2

            conn = psycopg2.connect(dsn, connect_timeout=10)
            try:
                with conn.cursor() as cur:
                    cur.execute("SHOW server_version")
                    version = cur.fetchone()[0]
                    cur.execute("SHOW server_version_num")
                    num = cur.fetchone()[0]
            finally:
                conn.close()
            lines.append("server_version         : %s (num %s)" % (version, num))
            lines.append("server major           : %s" % bs.server_major_version(dsn))
            try:
                resolved = bs.resolve_pg_tool("pg_dump", dsn=dsn)
                lines.append("resolved pg_dump       : %s via %s (client major %s)"
                             % (resolved["argv_prefix"], resolved["source"],
                                resolved["client_major"]))
            except bs.BackupError as exc:
                lines.append("resolved pg_dump       : REFUSED %s"
                             % json.dumps(exc.payload))
        except Exception as exc:  # noqa: BLE001 - a probe reports, it does not raise
            lines.append("server_version         : (error: %s)" % exc)
    lines.append("resolution order       : %s"
                 % json.dumps(bs.describe_resolution_order()))
    report = "\n".join(lines)
    print(report)
    warnings.warn(UserWarning(report), stacklevel=1)
    assert "=== 89-04 pg_dump capability probe" in report


def test_the_probe_never_reaches_a_live_port():
    """The probe's own containment: it only ever uses GSD_TEST_POSTGRES_URL.

    Pinned directly rather than assumed, because a probe that silently fell back
    to ``local_docker_dsn()`` would dial 127.0.0.1:5433 — the operator's own
    database, and the exact shape of the 2026-09-07 incident.
    """
    source = pathlib.Path(__file__).read_text(encoding="utf-8")
    body = source.split("def test_pg_dump_capability_probe", 1)[1].split("\ndef ", 1)[0]
    assert "local_docker_dsn" not in body
    assert "5433" not in body
    assert "GSD_TEST_POSTGRES_URL" in body


# ══════════════════════════════════════════════════════════════════
# The surface: the eleven reasons as a VALUE SET, and the six subcommands
# ══════════════════════════════════════════════════════════════════

def test_the_reason_enum_is_exactly_the_eleven_values():
    """``sorted(REASONS)`` is the enum, asserted as a value set.

    A single-line ``grep -E`` over the eleven values cannot stand in for this:
    the values plus quoting run to about 160 characters, ``grep -E`` matches
    within one line, and every multi-line ``choices=`` in this repository's own
    services wraps — so a text match would pass only by accident of formatting.
    """
    assert sorted(bs.REASONS) == EXPECTED_REASONS
    assert len(bs.REASONS) == 11


def test_the_reason_flag_is_built_from_the_constant():
    """``--reason`` takes its ``choices`` from :data:`REASONS` itself.

    Not an equal-looking copy: the parser's choices object must BE the module
    constant, so an edit to one cannot leave the other behind.
    """
    parser = bs.build_parser()
    action = _find_action(parser, "create", "--reason")
    assert action.choices is bs.REASONS
    assert action.required is True


def test_every_reason_is_accepted_by_the_parser():
    """No value in the enum meets an argparse rejection.

    This is the defect class that produced the 2026-11-12 incident: a command a
    later plan types, refused by a ``choices=`` the plan never read.
    """
    parser = bs.build_parser()
    for reason in bs.REASONS:
        args = parser.parse_args(["create", "--reason", reason])
        assert args.reason == reason
    with pytest.raises(SystemExit):
        parser.parse_args(["create", "--reason", "pre-nonsense"])


def test_the_six_subcommands_exist_as_a_value_set():
    """The parser carries exactly the six documented subcommands."""
    parser = bs.build_parser()
    action = [a for a in parser._actions
              if isinstance(a, argparse._SubParsersAction)][0]
    assert sorted(action.choices) == sorted(bs.SUBCOMMANDS)
    assert sorted(bs.SUBCOMMANDS) == ["create", "for", "list", "prune",
                                      "restore", "verify"]


def test_the_guard_accepted_reasons_exclude_auto_only():
    """Every reason but ``auto`` is evidence a human thought about a step."""
    assert sorted(bs.GUARD_ACCEPTED_REASONS) == [
        r for r in EXPECTED_REASONS if r != "auto"]
    assert "auto" not in bs.GUARD_ACCEPTED_REASONS


def _find_action(parser, subcommand, option):
    """The argparse action for one option of one subcommand.

    Args:
        parser: the top-level parser.
        subcommand: the subcommand name.
        option: the option string, for example ``"--reason"``.

    Returns:
        argparse.Action
    """
    sub = [a for a in parser._actions if isinstance(a, argparse._SubParsersAction)][0]
    target = sub.choices[subcommand]
    for action in target._actions:
        if option in (action.option_strings or []):
            return action
    raise AssertionError("%s has no %s" % (subcommand, option))


# ══════════════════════════════════════════════════════════════════
# --verify is accepted and is a documented no-op
# ══════════════════════════════════════════════════════════════════

def test_verify_flag_is_accepted_and_is_a_no_op(home, tmp_path):
    """``create --verify`` and ``create`` write identical manifests.

    Apart from the timestamps, which differ by construction.  The flag exists
    because the cutover's commands read better with it and because an operator
    who types it on a safety step must not meet an argparse error.
    """
    write_tasks(home, count=2)
    with_flag = tmp_path / "with"
    without = tmp_path / "without"
    a = run_cli(["create", "--reason", "manual", "--scope", "tasks",
                 "--backups-dir", with_flag, "--verify", "--json"], home)
    b = run_cli(["create", "--reason", "manual", "--scope", "tasks",
                 "--backups-dir", without, "--json"], home)
    assert a.returncode == 0, a.stderr
    assert b.returncode == 0, b.stderr
    one = _strip_volatile(json.loads(a.stdout)["manifest"])
    two = _strip_volatile(json.loads(b.stdout)["manifest"])
    assert one == two
    assert "accepted for clarity" in _help_text("create").lower()


def test_verify_flag_appears_in_help_as_a_no_op():
    """``--help`` says the flag is accepted and that verification is uncondi''l."""
    text = _help_text("create")
    assert "--verify" in text
    assert "unconditional" in text


def _help_text(subcommand):
    """The rendered help of one subcommand.

    Args:
        subcommand: the subcommand name.

    Returns:
        str
    """
    parser = bs.build_parser()
    sub = [a for a in parser._actions if isinstance(a, argparse._SubParsersAction)][0]
    return sub.choices[subcommand].format_help()


def _strip_volatile(manifest):
    """A manifest with the fields that differ between two runs removed.

    Args:
        manifest: the manifest document.

    Returns:
        dict: a copy without timestamps or absolute paths.
    """
    out = copy.deepcopy(manifest)
    for key in ("created_at", "verified_at"):
        out.pop(key, None)
    return out


# ══════════════════════════════════════════════════════════════════
# --scope sqlite and --scope tasks, end to end, on all three systems
# ══════════════════════════════════════════════════════════════════

def test_scope_sqlite_end_to_end(home, tmp_path, backups):
    """The SQLite leg: online backup, integrity check, census, verification."""
    db = write_sqlite(tmp_path / "live.db", rows=5)
    result = run_cli(["create", "--reason", "pre-migration", "--scope", "sqlite",
                      "--sqlite", db, "--backups-dir", backups, "--json"], home)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    manifest = payload["manifest"]
    assert manifest["sqlite"]["integrity_check"] == "ok"
    assert manifest["sqlite"]["tables"]["gsd_memory"] == 5
    assert manifest["sqlite"]["page_count"] >= 1
    assert manifest["verify_result"] == "ok"
    assert manifest["verified_at"]
    copy_path = pathlib.Path(payload["snapshot"]) / bs.SQLITE_ARTEFACT
    assert copy_path.is_file()
    conn = sqlite3.connect(str(copy_path))
    try:
        assert conn.execute("SELECT COUNT(*) FROM gsd_memory").fetchone()[0] == 5
    finally:
        conn.close()
    # The copy is a real database, not a byte copy of a WAL file: it opens and
    # answers a query above, which a torn `cp` of a live WAL database would not.
    verified = run_cli(["verify", payload["snapshot"], "--json"], home)
    assert verified.returncode == 0, verified.stderr
    assert json.loads(verified.stdout)["ok"] is True


def test_scope_tasks_end_to_end_with_the_item_count(home, backups):
    """The tasks leg: the four files that exist, the item count, verification."""
    write_tasks(home, count=6)
    result = run_cli(["create", "--reason", "pre-upgrade", "--scope", "tasks",
                      "--backups-dir", backups, "--json"], home)
    assert result.returncode == 0, result.stderr
    manifest = json.loads(result.stdout)["manifest"]
    assert manifest["tasks"]["items"] == 6
    assert set(manifest["tasks"]["copied"]) == {
        "tasks.json", "install_record.json", "last_backend", "pg_retry_queue.json"}
    assert manifest["tasks"]["absent"] == ["tasks.json.bak"]
    names = {entry["path"] for entry in manifest["files"]}
    assert names == set(manifest["tasks"]["copied"])
    assert manifest["verify_result"] == "ok"


def test_a_wrong_item_count_in_the_manifest_fails_verification(home, backups):
    """The item-count check is not decorative: a changed count is a failure."""
    write_tasks(home, count=4)
    result = run_cli(["create", "--reason", "manual", "--scope", "tasks",
                      "--backups-dir", backups, "--json"], home)
    snapshot = pathlib.Path(json.loads(result.stdout)["snapshot"])
    manifest_path = snapshot / bs.MANIFEST_NAME
    document = json.loads(manifest_path.read_text(encoding="utf-8"))
    document["tasks"]["items"] = 99
    manifest_path.write_text(json.dumps(document, indent=2), encoding="utf-8")
    out = run_cli(["verify", snapshot, "--json"], home)
    assert out.returncode == 1
    failures = json.loads(out.stdout)["failures"]
    assert any("4 items on disk, manifest says 99" in f for f in failures), failures


# ══════════════════════════════════════════════════════════════════
# tasks.json is copied under the PRODUCT's own lock
# ══════════════════════════════════════════════════════════════════

def test_tasks_json_is_copied_under_the_products_own_lock(home, backups, monkeypatch):
    """The lock is ``<data dir>/.amauta.lock`` through ``_platform.file_lock``.

    ``amauta.py:511`` defines the path and ``amauta.py:538-549`` takes it through
    ``services/_platform.file_lock``.  A different lock file, or a lock taken
    with a different primitive, would be no lock at all against the running
    daemon — so the assertion is on BOTH the primitive and the path, and the
    wrapper records that it actually fired.
    """
    write_tasks(home, count=2)
    seen = []
    real = _platform.file_lock

    def spy(target, **kwargs):
        seen.append(str(target))
        return real(target, **kwargs)

    monkeypatch.setattr(bs._platform, "file_lock", spy)
    result = bs.create("manual", scope="tasks", backups_dir=str(backups),
                       data_dir=str(pathlib.Path(home) / "data"),
                       env=pinned_env(home))
    assert seen, "the lock spy never fired, so this test proved nothing"
    assert seen == [str(pathlib.Path(home) / "data" / ".amauta.lock")]
    assert result["manifest"]["tasks"]["items"] == 2


# ══════════════════════════════════════════════════════════════════
# The manifest schema, field by field
# ══════════════════════════════════════════════════════════════════

def test_manifest_schema_field_by_field(home, backups, pg_fakes):
    """Every field the plan names is present, with the shape it names."""
    write_tasks(home, count=3)
    db = write_sqlite(pathlib.Path(home) / "data" / "gsd_amauta.db", rows=2)
    result = bs.create("pre-cutover", scope="all", dsn=FAKE_DSN, sqlite_path=db,
                       backups_dir=str(backups),
                       data_dir=str(pathlib.Path(home) / "data"),
                       env=pg_fakes["env"], runner=pg_fakes["runner"],
                       connect=pg_fakes["connect"])
    m = result["manifest"]
    assert m["schema"] == bs.MANIFEST_SCHEMA == 1
    assert m["reason"] == "pre-cutover"
    assert m["scope"] == "all"
    assert m["backend"] == "postgresql"
    assert m["created_at"].endswith("Z")
    assert m["verified_at"].endswith("Z")
    assert m["verify_result"] == "ok"
    assert isinstance(m["host"], str) and m["host"]
    assert m["git_sha"] is None or len(m["git_sha"]) == 40
    assert len(m["dsn_fingerprint"]) == 16
    assert m["pg"]["server_version"] == "16.4"
    assert m["pg"]["extensions"] == {"vector": "0.8.1", "pg_search": "0.24.1"}
    assert m["pg"]["applied_migrations"] == ["001-init.sql", "030-whatever.sql"]
    assert m["pg"]["tables"]["gsd_memory"] == {
        "rows": 7, "with_embedding": 5, "vector_dims": 1024,
        "vector_column": "embedding"}
    assert m["pg"]["tables"]["rlm_chunks"]["vector_dims"] == 1024
    assert m["pg"]["tables"]["gsd_tasks"] == {"rows": 11}
    assert m["sqlite"]["integrity_check"] == "ok"
    assert m["tasks"]["items"] == 3
    for entry in m["files"]:
        assert set(entry) == {"path", "bytes", "sha256"}
        assert len(entry["sha256"]) == 64
    assert bs.DUMP_ARTEFACT in {e["path"] for e in m["files"]}


def test_the_manifest_carries_no_dsn_and_no_password(home, backups, pg_fakes):
    """Containment, with its own mutation arm.

    The manifest records a fingerprint, never the DSN and never the password.
    The mutation — writing the DSN into the manifest on purpose — must make the
    SAME assertion fail, and must also make the product's own ``verify`` fail,
    which is what stops a future edit from quietly reintroducing the leak.
    """
    write_tasks(home, count=1)
    result = bs.create("pre-migration", scope="postgres", dsn=FAKE_DSN,
                       backups_dir=str(backups), env=pg_fakes["env"],
                       runner=pg_fakes["runner"], connect=pg_fakes["connect"])
    snapshot = pathlib.Path(result["snapshot"])
    text = (snapshot / bs.MANIFEST_NAME).read_text(encoding="utf-8")
    assert SECRET not in text
    assert "://" not in text
    assert result["manifest"]["dsn_fingerprint"] == bs.dsn_fingerprint(FAKE_DSN)

    # No log line carries it either.
    lines = []
    bs.create("pre-migration", scope="postgres", dsn=FAKE_DSN,
              backups_dir=str(backups), env=pg_fakes["env"],
              runner=pg_fakes["runner"], connect=pg_fakes["connect"],
              log=lines.append)
    assert lines, "the log sink never fired, so this test proved nothing"
    assert not any(SECRET in line for line in lines)

    # The MUTATION: the same assertion, against a manifest that does leak.
    document = json.loads(text)
    document["dsn_leaked_on_purpose"] = FAKE_DSN
    (snapshot / bs.MANIFEST_NAME).write_text(json.dumps(document, indent=2),
                                             encoding="utf-8")
    mutated = (snapshot / bs.MANIFEST_NAME).read_text(encoding="utf-8")
    assert SECRET in mutated, "the mutation did not take"
    with pytest.raises(AssertionError):
        assert SECRET not in mutated
    fresh = bs.verify(str(snapshot), env=pg_fakes["env"], runner=pg_fakes["runner"])
    assert fresh["ok"] is False
    assert any("looks like a DSN" in f for f in fresh["failures"]), fresh["failures"]


def test_the_password_never_reaches_an_argv(home, backups, pg_fakes):
    """``PGPASSWORD`` carries the secret, so no process listing can show it."""
    bs.create("pre-migration", scope="postgres", dsn=FAKE_DSN,
              backups_dir=str(backups), env=pg_fakes["env"],
              runner=pg_fakes["runner"], connect=pg_fakes["connect"])
    assert pg_fakes["calls"], "no tool call was recorded"
    for argv in pg_fakes["calls"]:
        assert not any(SECRET in str(part) for part in argv), argv
    dump = [c for c in pg_fakes["calls"] if "pg_dump" in " ".join(map(str, c))][0]
    assert "-Fc" in dump and "--no-owner" in dump and "--no-privileges" in dump


# ══════════════════════════════════════════════════════════════════
# create verifies itself
# ══════════════════════════════════════════════════════════════════

def test_a_snapshot_that_fails_verification_has_no_verified_at_key(
        home, backups, monkeypatch):
    """A failed verification leaves NO ``verified_at`` key, and create exits 1.

    The corruption is real, not a stubbed verdict: the first manifest write is
    wrapped so that it also appends a byte to ``tasks.json`` afterwards — which
    is exactly the "a snapshot rots between write and read" case — so the
    product's own SHA-256 check is what fails.
    """
    write_tasks(home, count=2)
    real_write = bs._write_manifest
    fired = []

    def corrupting_write(snapshot_dir, manifest):
        path = real_write(snapshot_dir, manifest)
        if "verified_at" not in manifest:
            fired.append(snapshot_dir)
            with open(os.path.join(snapshot_dir, "tasks.json"), "ab") as handle:
                handle.write(b" ")
        return path

    monkeypatch.setattr(bs, "_write_manifest", corrupting_write)
    with pytest.raises(bs.BackupError) as caught:
        bs.create("manual", scope="tasks", backups_dir=str(backups),
                  data_dir=str(pathlib.Path(home) / "data"), env=pinned_env(home))
    assert fired, "the corrupting wrapper never fired, so this test proved nothing"
    assert caught.value.payload["error"] == "create_verify_failed"
    snapshot = pathlib.Path(fired[0])
    document = json.loads((snapshot / bs.MANIFEST_NAME).read_text(encoding="utf-8"))
    assert "verified_at" not in document
    assert "verify_result" not in document
    assert document.get("verified_at", "ABSENT") == "ABSENT"


def test_create_exits_non_zero_when_its_own_verification_fails(
        home, tmp_path, monkeypatch, capsys):
    """The CLI reports exit 1 and a typed payload, not a cheerful message."""
    write_tasks(home, count=2)
    real_write = bs._write_manifest
    fired = []

    def corrupting_write(snapshot_dir, manifest):
        path = real_write(snapshot_dir, manifest)
        if "verified_at" not in manifest:
            fired.append(snapshot_dir)
            with open(os.path.join(snapshot_dir, "tasks.json"), "ab") as handle:
                handle.write(b" ")
        return path

    monkeypatch.setattr(bs, "_write_manifest", corrupting_write)
    monkeypatch.setenv("AMAUTA_DATA_DIR", str(pathlib.Path(home) / "data"))
    code = bs.main(["create", "--reason", "manual", "--scope", "tasks",
                    "--backups-dir", str(tmp_path / "b"),
                    "--data-dir", str(pathlib.Path(home) / "data"), "--json"])
    assert fired, "the corrupting wrapper never fired, so this test proved nothing"
    assert code == 1
    out = capsys.readouterr().out
    assert '"error": "create_verify_failed"' in out


# ══════════════════════════════════════════════════════════════════
# verify fails closed: corruption, truncation, an extra file
# ══════════════════════════════════════════════════════════════════

def test_one_corrupted_byte_fails_verify_naming_both_digests(home, backups):
    """A single flipped byte is an ERROR naming the expected and actual SHA-256."""
    write_tasks(home, count=3)
    created = run_cli(["create", "--reason", "manual", "--scope", "tasks",
                       "--backups-dir", backups, "--json"], home)
    snapshot = pathlib.Path(json.loads(created.stdout)["snapshot"])
    target = snapshot / "tasks.json"
    expected = json.loads((snapshot / bs.MANIFEST_NAME).read_text(
        encoding="utf-8"))
    recorded = [e for e in expected["files"] if e["path"] == "tasks.json"][0]
    blob = bytearray(target.read_bytes())
    blob[10] = blob[10] ^ 0x01
    target.write_bytes(bytes(blob))
    out = run_cli(["verify", snapshot, "--json"], home)
    assert out.returncode == 1
    failures = json.loads(out.stdout)["failures"]
    joined = " ".join(failures)
    assert "SHA-256 mismatch" in joined
    assert recorded["sha256"] in joined, joined
    assert bs.sha256_file(str(target)) in joined, joined


def test_a_missing_or_extra_artefact_fails_verify(home, backups):
    """Both directions: a named file gone, and a file nobody recorded."""
    write_tasks(home, count=2)
    created = run_cli(["create", "--reason", "manual", "--scope", "tasks",
                       "--backups-dir", backups, "--json"], home)
    snapshot = pathlib.Path(json.loads(created.stdout)["snapshot"])
    (snapshot / "last_backend").unlink()
    first = bs.verify(str(snapshot))
    assert first["ok"] is False
    assert any("missing" in f for f in first["failures"])

    (snapshot / "last_backend").write_text("sqlite", encoding="utf-8")
    (snapshot / "a-file-nobody-recorded").write_text("x", encoding="utf-8")
    second = bs.verify(str(snapshot))
    assert second["ok"] is False
    assert any("absent from the manifest" in f for f in second["failures"])


def test_verify_refuses_a_directory_that_is_not_a_snapshot(tmp_path):
    """No manifest means "not a snapshot", typed, not a silent pass."""
    with pytest.raises(bs.BackupError) as caught:
        bs.verify(str(tmp_path))
    assert caught.value.payload["error"] == "manifest_missing"


# ══════════════════════════════════════════════════════════════════
# The pg_dump resolution order, each step forced by environment
# ══════════════════════════════════════════════════════════════════

def test_resolution_step_1_explicit_binary_wins(tmp_path, home):
    """``GSD_PG_DUMP_BIN`` wins, and is validated as an existing file."""
    fake = write_fake_exe(str(tmp_path / "bin"), "pg_dump",
                          "print('pg_dump (PostgreSQL) 17.1')")
    env = pinned_env(home, GSD_PG_DUMP_BIN=fake, PATH="")
    resolved = bs.resolve_pg_tool("pg_dump", dsn=None, env=env, server_major=16)
    assert resolved["source"] == "GSD_PG_DUMP_BIN"
    assert resolved["argv_prefix"] == [fake]
    assert resolved["client_major"] == 17
    assert resolved["docker"] is False


def test_resolution_step_1_rejects_a_path_that_is_not_a_file(tmp_path, home):
    """A set-but-wrong variable is an error, never a silent fall-through."""
    env = pinned_env(home, GSD_PG_DUMP_BIN=str(tmp_path / "nope" / "pg_dump"))
    with pytest.raises(bs.BackupError) as caught:
        bs.resolve_pg_tool("pg_dump", dsn=None, env=env, server_major=16)
    assert caught.value.payload["error"] == "pg_dump_unavailable"
    assert caught.value.payload["variable"] == "GSD_PG_DUMP_BIN"


def test_resolution_step_2_host_tool_when_its_major_is_high_enough(tmp_path, home):
    """A host ``pg_dump`` of major >= the server's is used."""
    fakes = tmp_path / "fakes"
    write_fake_exe(str(fakes), "pg_dump", "print('pg_dump (PostgreSQL) 16.4')")
    env = pinned_env(home, PATH=isolated_path(str(fakes)))
    resolved = bs.resolve_pg_tool("pg_dump", dsn=None, env=env, server_major=16)
    assert resolved["source"] == "PATH"
    assert resolved["client_major"] == 16
    assert resolved["docker"] is False


def test_resolution_step_2_refuses_a_client_older_than_the_server(tmp_path, home):
    """An older client is NOT used — this is the operator's own machine.

    Measured in task 89-04-01: the operator's host carries ``pg_dump`` 14 while
    the container serves 16, so step 2 must reject it rather than produce a dump
    the server's own ``pg_restore`` would refuse.
    """
    fakes = tmp_path / "fakes"
    write_fake_exe(str(fakes), "pg_dump", "print('pg_dump (PostgreSQL) 14.22')")
    env = pinned_env(home, PATH=isolated_path(str(fakes)))
    with pytest.raises(bs.BackupError) as caught:
        bs.resolve_pg_tool("pg_dump", dsn=None, env=env, server_major=16)
    payload = caught.value.payload
    assert payload["error"] == "pg_dump_unavailable"
    assert payload["client_major"] == 14
    assert payload["server_major"] == 16
    assert "GSD_PG_DUMP_BIN" in payload["message"]
    assert "GSD_BACKUP_ALLOW_DOCKER" in payload["message"]


def test_resolution_step_3_needs_the_explicit_docker_opt_in(tmp_path, home):
    """Docker is reachable ONLY with ``GSD_BACKUP_ALLOW_DOCKER=1``.

    The argv is asserted; nothing is spawned.  No test in this plan sets the
    variable except this one, and this one only resolves — it never runs.
    """
    fakes = tmp_path / "fakes"
    write_fake_exe(str(fakes), "docker", "print('Docker version 99')")
    write_fake_exe(str(fakes), "pg_dump", "print('pg_dump (PostgreSQL) 14.0')")
    path = isolated_path(str(fakes))

    without = pinned_env(home, PATH=path)
    with pytest.raises(bs.BackupError):
        bs.resolve_pg_tool("pg_dump", dsn=None, env=without, server_major=16)

    with_optin = pinned_env(home, PATH=path, GSD_BACKUP_ALLOW_DOCKER="1",
                            GSD_BACKUP_DOCKER_CONTAINER="gsd-postgres")
    resolved = bs.resolve_pg_tool("pg_dump", dsn=None, env=with_optin,
                                  server_major=16)
    assert resolved["docker"] is True
    assert resolved["argv_prefix"][1:] == ["exec", "-i", "gsd-postgres", "pg_dump"]
    assert resolved["source"] == "docker exec gsd-postgres"


def test_resolution_step_4_is_a_typed_error_naming_both_variables(home):
    """With nothing available the answer is ``pg_dump_unavailable``."""
    env = pinned_env(home, PATH="", PGBIN=None)
    with pytest.raises(bs.BackupError) as caught:
        bs.resolve_pg_tool("pg_restore", dsn=None, env=env, server_major=16)
    payload = caught.value.payload
    assert payload["error"] == "pg_dump_unavailable"
    assert payload["variable"] == "GSD_PG_RESTORE_BIN"
    assert payload["allow_docker_variable"] == "GSD_BACKUP_ALLOW_DOCKER"
    assert payload["host_tool"] is None


def test_the_resolution_order_is_reportable_as_data():
    """``describe_resolution_order`` is what the record quotes."""
    order = bs.describe_resolution_order()
    assert [row["step"] for row in order] == [1, 2, 3, 4]
    assert "GSD_BACKUP_ALLOW_DOCKER=1" in order[2]["what"]
    assert "pg_dump_unavailable" in order[3]["what"]


def test_no_default_path_can_resolve_the_docker_executable():
    """No code path reaches Docker unless the variable is set.

    Pinned on the MECHANISM, not on the word: the only way this module can name
    the Docker executable is ``find_tool("docker"`` / ``find_tool('docker'``, and
    every such call must be dominated by the ``GSD_BACKUP_ALLOW_DOCKER`` test.
    A docstring that merely says ``"docker": bool`` resolves nothing and is not
    a call, which is why the search is for the call and not for the string.
    """
    source = (REPO_ROOT / "services" / "backup_snapshot.py").read_text(
        encoding="utf-8")
    lines = source.splitlines()
    resolving = [i for i, line in enumerate(lines)
                 if 'find_tool("docker"' in line or "find_tool('docker'" in line
                 or '"docker", "exec"' in line or "'docker', 'exec'" in line]
    assert resolving, "the module no longer resolves docker; update this test"
    for index in resolving:
        window = "\n".join(lines[max(0, index - 10):index + 1])
        assert "GSD_BACKUP_ALLOW_DOCKER" in window, lines[index]
    # And the mutation direction: a resolving line OUTSIDE such a window would
    # be caught, which this inverted check demonstrates on a synthetic line.
    synthetic = ['x = find_tool("docker")']
    assert "GSD_BACKUP_ALLOW_DOCKER" not in synthetic[0]


# ══════════════════════════════════════════════════════════════════
# The cold volume tar: argv asserted, tar never spawned
# ══════════════════════════════════════════════════════════════════

def test_volume_tar_argv_is_asserted_and_tar_is_never_spawned(
        tmp_path, home, backups, pg_fakes):
    """The tar leg is proven by its argv, through an injected runner."""
    volume = tmp_path / "volume"
    volume.mkdir()
    (volume / "PG_VERSION").write_text("16", encoding="utf-8")
    calls = []
    runner = fake_runner_factory(calls)
    result = bs.create("pre-cutover", scope="postgres", dsn=FAKE_DSN,
                       backups_dir=str(backups), include_volume_tar=True,
                       volume_path=str(volume), env=pg_fakes["env"],
                       runner=runner, connect=pg_fakes["connect"],
                       port_probe=lambda _port: [])
    tar_calls = [c for c in calls if "-czf" in c]
    assert len(tar_calls) == 1, calls
    argv = tar_calls[0]
    assert os.path.basename(argv[0]).startswith("tar")
    assert argv[1] == "-czf"
    assert argv[2].endswith(bs.TAR_ARTEFACT)
    assert argv[3] == "-C"
    assert argv[4] == str(volume)
    assert argv[5] == "."
    assert result["manifest"]["pg"]["volume_tar_argv"] == argv
    # The injected runner fabricated nothing for tar, so the artefact is absent
    # from disk and therefore absent from the manifest's file census: this plan
    # NEVER produces a real volume tar, by construction.
    assert bs.TAR_ARTEFACT not in {e["path"] for e in result["manifest"]["files"]}


def test_volume_tar_refuses_while_the_port_is_still_in_use(tmp_path, home, backups,
                                                           pg_fakes):
    """A HOT volume is refused: a tar of a running cluster is a torn copy.

    The port probe is injected, so no real ``lsof`` runs and nothing is dialled.
    """
    volume = tmp_path / "volume"
    volume.mkdir()
    probed = []

    def probe(port):
        probed.append(port)
        return [4321]

    with pytest.raises(bs.BackupError) as caught:
        bs.create("pre-cutover", scope="postgres", dsn=FAKE_DSN,
                  backups_dir=str(backups), include_volume_tar=True,
                  volume_path=str(volume), env=pg_fakes["env"],
                  runner=pg_fakes["runner"], connect=pg_fakes["connect"],
                  port_probe=probe)
    assert probed == [65432], probed
    assert caught.value.payload["error"] == "volume_hot"
    assert caught.value.payload["holders"] == [4321]


def test_volume_tar_needs_an_explicit_volume_path(home, backups, pg_fakes):
    """``--include-volume-tar`` without ``--volume-path`` is a typed refusal."""
    with pytest.raises(bs.BackupError) as caught:
        bs.create("pre-cutover", scope="postgres", dsn=FAKE_DSN,
                  backups_dir=str(backups), include_volume_tar=True,
                  env=pg_fakes["env"], runner=pg_fakes["runner"],
                  connect=pg_fakes["connect"])
    assert caught.value.payload["error"] == "volume_path_required"


# ══════════════════════════════════════════════════════════════════
# A failed dump is a failed backup
# ══════════════════════════════════════════════════════════════════

def test_a_failing_pg_dump_is_a_failure_not_a_skip(home, backups, pg_fakes):
    """The defect ``scripts/backup.sh`` carried, pinned in the new code.

    ``pg_dump … && echo ok || echo skipped`` made a FAILED dump exit 0.  Here a
    non-zero exit raises, and the message says so.
    """
    def failing(argv, *, env=None, stdout_path=None, timeout=None):
        if "pg_dump" in " ".join(str(a) for a in argv):
            return {"argv": list(argv), "returncode": 1, "stdout": b"",
                    "stderr": "could not connect to server"}
        return pg_fakes["runner"](argv, env=env, stdout_path=stdout_path,
                                  timeout=timeout)

    with pytest.raises(bs.BackupError) as caught:
        bs.create("pre-migration", scope="postgres", dsn=FAKE_DSN,
                  backups_dir=str(backups), env=pg_fakes["env"],
                  runner=failing, connect=pg_fakes["connect"])
    assert caught.value.payload["error"] == "pg_dump_failed"
    assert "echo skipped" in caught.value.payload["message"]


def test_a_dump_that_exits_zero_but_writes_nothing_is_a_failure(home, backups,
                                                                pg_fakes):
    """An empty artefact is not a backup, whatever the exit code says."""
    def empty(argv, *, env=None, stdout_path=None, timeout=None):
        joined = " ".join(str(a) for a in argv)
        if "pg_dump" in joined and "-f" in argv:
            open(argv[argv.index("-f") + 1], "wb").close()
            return {"argv": list(argv), "returncode": 0, "stdout": b"", "stderr": ""}
        return pg_fakes["runner"](argv, env=env, stdout_path=stdout_path,
                                  timeout=timeout)

    with pytest.raises(bs.BackupError) as caught:
        bs.create("pre-migration", scope="postgres", dsn=FAKE_DSN,
                  backups_dir=str(backups), env=pg_fakes["env"],
                  runner=empty, connect=pg_fakes["connect"])
    assert caught.value.payload["error"] == "pg_dump_failed"
    assert "wrote 0 bytes" in caught.value.payload["message"]


def test_a_dump_that_does_not_parse_fails_verification(home, backups, pg_fakes):
    """``pg_restore --list`` is a structural parse, and it is load-bearing."""
    created = bs.create("pre-migration", scope="postgres", dsn=FAKE_DSN,
                        backups_dir=str(backups), env=pg_fakes["env"],
                        runner=pg_fakes["runner"], connect=pg_fakes["connect"])

    def unparseable(argv, *, env=None, stdout_path=None, timeout=None):
        if "--list" in argv:
            return {"argv": list(argv), "returncode": 1, "stdout": b"",
                    "stderr": "did not find magic string in file header"}
        return pg_fakes["runner"](argv, env=env, stdout_path=stdout_path,
                                  timeout=timeout)

    result = bs.verify(created["snapshot"], env=pg_fakes["env"], runner=unparseable)
    assert result["ok"] is False
    assert any("pg_restore --list exited 1" in f for f in result["failures"])


# ══════════════════════════════════════════════════════════════════
# Retention
# ══════════════════════════════════════════════════════════════════

def _plant(backups_dir, reason, days_old, verified=True, now=None):
    """Write a minimal snapshot directory with a chosen age.

    Args:
        backups_dir: where to plant it.
        reason: the snapshot's reason.
        days_old: how many days before ``now`` it was created.
        verified: whether it carries ``verified_at``.
        now: the reference time.

    Returns:
        str: the snapshot directory.
    """
    now = now or bs.utc_now()
    created = now - datetime.timedelta(days=days_old)
    path = os.path.join(str(backups_dir), bs.snapshot_name(reason, created))
    suffix = 1
    while os.path.exists(path):
        suffix += 1
        path = os.path.join(str(backups_dir),
                            "%s-%d" % (bs.snapshot_name(reason, created), suffix))
    os.makedirs(path)
    manifest = {"schema": 1, "created_at": bs.iso(created), "reason": reason,
                "scope": "tasks", "files": []}
    if verified:
        manifest["verified_at"] = bs.iso(created)
        manifest["verify_result"] = "ok"
    with open(os.path.join(path, bs.MANIFEST_NAME), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle)
    return path


def test_auto_snapshots_keep_the_last_seven(backups):
    """``auto`` matches today's ``services/backup.py`` ``auto_backup``."""
    now = bs.utc_now()
    planted = [_plant(backups, "auto", days_old=n, now=now) for n in range(12, 0, -1)]
    result = bs.prune(str(backups), now=now)
    assert len(result["removed"]) == 5
    assert {row["snapshot"] for row in result["removed"]} == set(planted[:5])
    assert len(bs.list_snapshots(str(backups))) == 7


def test_manual_snapshots_are_never_pruned_automatically(backups):
    """An operator's own snapshot is never deleted by a background rule."""
    now = bs.utc_now()
    for n in (400, 300, 200, 100, 1):
        _plant(backups, "manual", days_old=n, now=now)
    result = bs.prune(str(backups), now=now)
    assert result["removed"] == []
    assert len(bs.list_snapshots(str(backups))) == 5


def test_reason_snapshots_keep_thirty_days_and_never_fewer_than_three(backups):
    """Both halves of the rule, and that they interact the stated way."""
    now = bs.utc_now()
    old = [_plant(backups, "pre-migration", days_old=n, now=now)
           for n in (120, 90, 60, 45)]
    recent = [_plant(backups, "pre-migration", days_old=n, now=now) for n in (5, 1)]
    result = bs.prune(str(backups), now=now)
    removed = {row["snapshot"] for row in result["removed"]}
    # Four are older than 30 days, but the last three of the reason are kept, so
    # only the oldest three can go — and of those, none is the newest verified.
    assert removed == set(old[:3]), (removed, old, recent)
    survivors = {row["snapshot"] for row in bs.list_snapshots(str(backups))}
    assert survivors == {old[3]} | set(recent)


def test_prune_refuses_to_delete_the_newest_verified_snapshot_of_any_reason(backups):
    """Protection that outranks every other rule.

    Eight ``auto`` snapshots where only the OLDEST is verified: the keep-7 rule
    would delete exactly that one, and the protection stops it.
    """
    now = bs.utc_now()
    oldest = _plant(backups, "auto", days_old=30, verified=True, now=now)
    for n in range(7, 0, -1):
        _plant(backups, "auto", days_old=n, verified=False, now=now)
    result = bs.prune(str(backups), now=now)
    assert result["removed"] == []
    assert any(row["snapshot"] == oldest for row in result["protected"])
    assert os.path.isdir(oldest)


def test_prune_dry_run_deletes_nothing(backups):
    """``--dry-run`` reports and leaves every directory in place."""
    now = bs.utc_now()
    planted = [_plant(backups, "auto", days_old=n, now=now) for n in range(10, 0, -1)]
    result = bs.prune(str(backups), dry_run=True, now=now)
    assert len(result["removed"]) == 3
    assert result["dry_run"] is True
    for path in planted:
        assert os.path.isdir(path)


# ══════════════════════════════════════════════════════════════════
# list, verify --latest, and `for <step>`
# ══════════════════════════════════════════════════════════════════

def test_list_and_verify_latest_resolve_by_reason(home, backups):
    """``--latest --reason R`` is why ``pre-reingest`` exists as its own value.

    Two snapshots of DIFFERENT reasons: ``--latest --reason`` must resolve
    within the reason, not across all of them.  Sharing one reason between the
    cutover's step 5 and step 13 would make exactly this resolution point the
    wrong snapshot — which is the rollback target.
    """
    write_tasks(home, count=2)
    first = json.loads(run_cli(["create", "--reason", "pre-rebuild", "--scope",
                                "tasks", "--backups-dir", backups, "--json"],
                               home).stdout)["snapshot"]
    second = json.loads(run_cli(["create", "--reason", "pre-reingest", "--scope",
                                 "tasks", "--backups-dir", backups, "--json"],
                                home).stdout)["snapshot"]
    assert first != second
    rows = bs.list_snapshots(str(backups))
    assert [row["reason"] for row in rows] == ["pre-rebuild", "pre-reingest"]
    assert bs.latest_snapshot(str(backups), reason="pre-rebuild")["snapshot"] == first
    assert bs.latest_snapshot(str(backups), reason="pre-reingest")["snapshot"] == second
    out = run_cli(["verify", "--latest", "--reason", "pre-rebuild",
                   "--backups-dir", backups, "--json"], home)
    assert out.returncode == 0
    assert json.loads(out.stdout)["snapshot"] == first


def test_for_step_maps_every_step_to_a_reason_in_the_enum(home, backups):
    """``backup for <step>`` is the remedy a refusal names, so it must work."""
    write_tasks(home, count=1)
    for step, (reason, scope) in sorted(bs.STEP_SNAPSHOTS.items()):
        assert reason in bs.REASONS, step
        assert scope in bs.SCOPES, step
    # The step's own scope is `all`, which needs a DSN; with none configured the
    # CLI refuses in a TYPED way rather than guessing a database — the whole
    # point of services/pg_dsn.py after the 2026-09-07 incident.
    out = run_cli(["for", "migrations", "--backups-dir", backups, "--json"], home)
    assert out.returncode == 1, out.stdout + out.stderr
    assert json.loads(out.stdout)["error"] == "dsn_unconfigured"
    # With the scope narrowed to what needs no database, the step works.
    result = bs.for_step("migrations", scope="tasks", backups_dir=str(backups),
                         data_dir=str(pathlib.Path(home) / "data"),
                         env=pinned_env(home))
    assert result["manifest"]["reason"] == "pre-migration"
    assert result["manifest"]["verify_result"] == "ok"


def test_for_an_unknown_step_is_a_typed_refusal():
    """A step nobody mapped is an error naming the known ones."""
    with pytest.raises(bs.BackupError) as caught:
        bs.for_step("not-a-step")
    assert caught.value.payload["error"] == "unknown_step"
    assert "migrations" in caught.value.payload["allowed"]


def test_an_unknown_reason_or_scope_is_refused_before_anything_is_written(backups):
    """Validation happens first, so no half-written directory is left behind."""
    with pytest.raises(bs.BackupError) as caught:
        bs.create("pre-nonsense", scope="tasks", backups_dir=str(backups))
    assert caught.value.payload["error"] == "unknown_reason"
    with pytest.raises(bs.BackupError) as caught:
        bs.create("manual", scope="everything", backups_dir=str(backups))
    assert caught.value.payload["error"] == "unknown_scope"
    assert os.listdir(str(backups)) == []


def test_the_default_backups_dir_never_resolves_a_real_home_under_test_mode(tmp_path):
    """Containment of the default path itself.

    ``AMAUTA_DATA_DIR`` wins; under ``GSD_TEST_MODE`` with no data dir the answer
    is a temp directory, never ``~/.amauta/backups`` — the directory holding the
    operator's own post-incident set.
    """
    with_data_dir = {"AMAUTA_DATA_DIR": str(tmp_path / "d")}
    assert bs.default_backups_dir(with_data_dir) == str(tmp_path / "d" / "backups")
    test_mode = {"GSD_TEST_MODE": "1"}
    answer = bs.default_backups_dir(test_mode)
    assert ".amauta" not in answer
    assert answer.endswith("gsd-test-snapshots")


def test_dsn_fingerprint_is_sixteen_hex_and_ignores_credentials():
    """The fingerprint identifies the DATABASE, never the credentials."""
    one = bs.dsn_fingerprint("postgres" + "ql://a:%s@h:5432/db" % SECRET)
    two = bs.dsn_fingerprint("postgres" + "ql://b:other@h:5432/db")
    three = bs.dsn_fingerprint("postgres" + "ql://a:%s@h:5432/other" % SECRET)
    assert len(one) == 16 and all(c in "0123456789abcdef" for c in one)
    assert one == two
    assert one != three
    assert bs.dsn_fingerprint(None) is None

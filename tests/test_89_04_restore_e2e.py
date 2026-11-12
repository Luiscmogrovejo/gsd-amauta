#!/usr/bin/env python3
"""Plan 89-04: restore proven end to end, including byte-identical vectors.

This is the file the must-have lives in.  On the disposable PostgreSQL it

1. creates an isolated database and applies every migration (the same shape
   ``tests/test_docker_pg_migration.py`` already uses — one mechanism, not two);
2. seeds a known fixture into the tables the snapshot's census covers, with a
   real ``vector(1024)`` in ``gsd_memory.embedding`` AND in
   ``rlm_chunks.embedding_code``, built with
   ``tests/support/stub_embeddings.deterministic_embedding`` so it is
   reproducible with no API key;
3. takes a snapshot with ``create --scope postgres``;
4. DROPS the database and creates it empty;
5. restores with ``--mode replace --confirm``;
6. asserts row-for-row equality **and that the vectors came back byte-identical**
   (``embedding::text`` equality, plus ``embedding <=> $fixture = 0``).

Step 6 is the assertion that FAILS against ``services/backup.py``, whose
``_rows_to_dicts`` drops every embedding — which is why that exporter is
labelled here and replaced rather than trusted.  The same file proves the
corruption arm (one flipped byte makes ``verify`` fail and ``restore`` refuse
**without touching the target**) and that a partial restore is a failure rather
than a cheerful "restored" message.

Run: /opt/homebrew/bin/python3 -m pytest tests/test_89_04_restore_e2e.py -q -rs -p no:cacheprovider
"""

import gzip
import json
import os
import pathlib
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
from services import backup_snapshot as bs  # noqa: E402
from services import migrate_runner, pg_dsn  # noqa: E402
from stub_embeddings import deterministic_embedding  # noqa: E402

TEST_DSN = postgres_dsn_or_none()
requires_pg = pytest.mark.skipif(TEST_DSN is None, reason=PG_SKIP_REASON)

#: How many rows each seeded table receives.
SEED_ROWS = 4

#: The two tables whose vectors the must-have is about.
VECTOR_TABLES = (
    ("gsd_memory", "embedding", "id"),
    ("rlm_chunks", "embedding_code", "id"),
)


# ══════════════════════════════════════════════════════════════════
# Fixtures — one isolated database per test, dropped afterwards
# ══════════════════════════════════════════════════════════════════

def _admin_dsn():
    """The DSN pointed at ``postgres``, for CREATE/DROP DATABASE.

    Returns:
        str
    """
    return pg_dsn.dsn_with_database(TEST_DSN, "postgres")


def _autocommit(dsn):
    """An autocommit connection, for statements that cannot run in a block.

    Args:
        dsn: the DSN to connect to.

    Returns:
        psycopg2 connection
    """
    import psycopg2
    from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT

    conn = psycopg2.connect(dsn, connect_timeout=15)
    conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
    return conn


def _drop_database(name):
    """Terminate every backend on ``name`` and drop it.

    Args:
        name: the database to drop.

    Returns:
        None
    """
    conn = _autocommit(_admin_dsn())
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()", (name,))
            cur.execute('DROP DATABASE IF EXISTS "%s"' % name)
    finally:
        conn.close()


def _create_database(name):
    """Create an empty database called ``name``.

    Args:
        name: the database to create.

    Returns:
        None
    """
    conn = _autocommit(_admin_dsn())
    try:
        with conn.cursor() as cur:
            cur.execute('CREATE DATABASE "%s"' % name)
    finally:
        conn.close()


@pytest.fixture
def isolated():
    """An isolated database with every migration applied.

    Yields:
        dict: ``{"dsn", "name"}``.
    """
    name = "gsd_8904_" + uuid.uuid4().hex[:12]
    _create_database(name)
    dsn = pg_dsn.dsn_with_database(TEST_DSN, name)
    try:
        migrate_runner.apply_migrations(dsn=dsn, log=lambda *_a: None)
        yield {"dsn": dsn, "name": name}
    finally:
        _drop_database(name)


@pytest.fixture
def pinned_home(tmp_path):
    """A temp HOME, USERPROFILE, HOMEDRIVE and HOMEPATH for the module's paths.

    Set together, which is what the Windows cell needs and what the 88-14 lint's
    POSIX_HOME_ONLY rule requires.

    Returns:
        dict: an environment mapping.
    """
    home = tmp_path / "home"
    (home / "data").mkdir(parents=True)
    drive, tail = os.path.splitdrive(str(home))
    env = dict(os.environ)
    env.update({
        "HOME": str(home),
        "USERPROFILE": str(home),
        "HOMEDRIVE": drive or "",
        "HOMEPATH": tail or str(home),
        "GSD_TEST_MODE": "1",
        "AMAUTA_DATA_DIR": str(home / "data"),
        "AMAUTA_AUTO_BACKUP": "off",
    })
    return env


# ══════════════════════════════════════════════════════════════════
# Seeding and census helpers
# ══════════════════════════════════════════════════════════════════

def _vector_literal(values):
    """A pgvector input literal for a list of floats.

    Args:
        values: the components.

    Returns:
        str: ``"[v1,v2,…]"``.
    """
    return "[" + ",".join(repr(float(v)) for v in values) + "]"


def seed(dsn):
    """Seed a known fixture, including real 1024-dimension vectors.

    Args:
        dsn: the database to seed.

    Returns:
        dict: ``{"gsd_memory": {id: vector_text}, "rlm_chunks": {...}}`` — the
        fixture the round trip is compared against.
    """
    import psycopg2

    fixtures = {"gsd_memory": {}, "rlm_chunks": {}}
    conn = psycopg2.connect(dsn, connect_timeout=15)
    try:
        with conn.cursor() as cur:
            for i in range(SEED_ROWS):
                vector = deterministic_embedding("memory fixture %d" % i)
                assert len(vector) == 1024
                mem_id = "mem-8904-%04d" % i
                cur.execute(
                    "INSERT INTO gsd_memory (id, text, agent_id, source, tags, "
                    "metadata, project_id, embedding) "
                    "VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s::vector)",
                    (mem_id, "memory fixture %d" % i, "executor-backend",
                     "lesson-learned", json.dumps(["t%d" % i]),
                     json.dumps({"n": i}), "gsd-amauta",
                     _vector_literal(vector)))
                fixtures["gsd_memory"][mem_id] = vector

            for i in range(SEED_ROWS):
                vector = deterministic_embedding("chunk fixture %d" % i)
                cur.execute(
                    "INSERT INTO rlm_chunks (file_path, symbol_name, symbol_type, "
                    "start_line, end_line, content, description, sha256, "
                    "dependencies, dependents, embedding_code) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::vector) "
                    "RETURNING id",
                    ("services/fixture_%d.py" % i, "fn_%d" % i, "function",
                     i * 10, i * 10 + 5, "def fn_%d(): pass" % i,
                     "fixture function %d" % i, "%064d" % i, ["dep"], ["caller"],
                     _vector_literal(vector)))
                fixtures["rlm_chunks"][int(cur.fetchone()[0])] = vector

            for i in range(SEED_ROWS):
                cur.execute(
                    "INSERT INTO gsd_tasks (id, project_id, type, title, status, "
                    "priority, tags) VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)",
                    ("TK-89%02d" % i, "gsd-amauta", "task", "fixture %d" % i,
                     "pending", "medium", json.dumps(["phase-89"])))
                cur.execute(
                    "INSERT INTO gsd_shared_kb (id, title, content, category, "
                    "agent_id, tags, importance) "
                    "VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)",
                    ("skb-8904-%04d" % i, "fixture %d" % i, "content %d" % i,
                     "pattern", "executor-backend", json.dumps(["t"]), 5))
                cur.execute(
                    "INSERT INTO gsd_audit_log (task_id, event_type, agent_id, "
                    "content) VALUES (%s, %s, %s, %s)",
                    ("TK-89%02d" % i, "claim", "executor-backend", "fixture"))
                cache_vector = deterministic_embedding("cache fixture %d" % i)
                cur.execute(
                    "INSERT INTO semantic_cache (query_text, query_embedding, "
                    "response) VALUES (%s, %s::vector, %s)",
                    ("query %d" % i, _vector_literal(cache_vector), "answer %d" % i))
        conn.commit()
    finally:
        conn.close()
    return fixtures


def census(dsn):
    """Row counts per public table, and the text form of every seeded vector.

    Args:
        dsn: the database to read.

    Returns:
        dict: ``{"rows": {table: n}, "vectors": {table: {pk: text}}}``.
    """
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=15)
    try:
        out = {"rows": {}, "vectors": {}}
        with conn.cursor() as cur:
            cur.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' "
                "ORDER BY table_name")
            for (table,) in list(cur.fetchall()):
                cur.execute('SELECT COUNT(*) FROM "%s"' % table)
                out["rows"][table] = int(cur.fetchone()[0])
            for table, column, pk in VECTOR_TABLES:
                cur.execute('SELECT "%s", "%s"::text FROM "%s" ORDER BY "%s"'
                            % (pk, column, table, pk))
                out["vectors"][table] = {row[0]: row[1] for row in cur.fetchall()}
        return out
    finally:
        conn.close()


def take_snapshot(dsn, backups_dir, env, reason="pre-rebuild"):
    """``create --scope postgres`` against ``dsn``.

    Args:
        dsn: the database to snapshot.
        backups_dir: where the snapshot goes.
        env: the pinned environment.
        reason: the snapshot's reason.

    Returns:
        dict: :func:`services.backup_snapshot.create`'s result.
    """
    return bs.create(reason, scope="postgres", dsn=dsn,
                     backups_dir=str(backups_dir), env=env)


# ══════════════════════════════════════════════════════════════════
# The must-have: a restore that brings the vectors back byte-identically
# ══════════════════════════════════════════════════════════════════

@requires_pg
def test_restore_round_trips_every_table_and_the_vectors_are_byte_identical(
        isolated, tmp_path, pinned_home):
    """Drop the database, restore the snapshot, compare row for row.

    The vector comparison is the point.  ``embedding::text`` equality is exact
    (pgvector prints every component), and ``embedding <=> $fixture = 0`` is the
    independent second form — a distance of exactly zero against the ORIGINAL
    fixture, not against whatever came back.
    """
    import psycopg2

    dsn, name = isolated["dsn"], isolated["name"]
    fixtures = seed(dsn)
    before = census(dsn)
    assert before["rows"]["gsd_memory"] == SEED_ROWS
    assert before["rows"]["rlm_chunks"] == SEED_ROWS
    assert len(before["vectors"]["gsd_memory"]) == SEED_ROWS
    assert all(text and text.startswith("[")
               for text in before["vectors"]["gsd_memory"].values())

    created = take_snapshot(dsn, tmp_path / "backups", pinned_home)
    assert created["manifest"]["verify_result"] == "ok"
    assert created["manifest"]["verified_at"]
    claimed = created["manifest"]["pg"]["tables"]
    assert claimed["gsd_memory"]["rows"] == SEED_ROWS
    assert claimed["gsd_memory"]["with_embedding"] == SEED_ROWS
    assert claimed["gsd_memory"]["vector_dims"] == 1024
    assert claimed["rlm_chunks"]["with_embedding"] == SEED_ROWS

    _drop_database(name)
    _create_database(name)
    assert census(dsn)["rows"] == {}, "the target must start empty"

    result = bs.restore(created["snapshot"], dsn=dsn, mode="replace",
                        scope="postgres", confirm=True,
                        backups_dir=str(tmp_path / "backups"), env=pinned_home)
    assert result["restored"] == ["postgres"]
    assert result["pre_restore"], "a pre-restore snapshot is the default"

    after = census(dsn)
    # Every table's count is restored. gsd_audit_log is +1 BY DESIGN: `restore`
    # writes its own audit row, and that row is the proof the audit leg fired.
    expected = dict(before["rows"])
    expected["gsd_audit_log"] = before["rows"]["gsd_audit_log"] + 1
    assert after["rows"] == expected
    assert result["audit_row"] is not None

    # The vectors, byte-identically, by text equality …
    assert after["vectors"]["gsd_memory"] == before["vectors"]["gsd_memory"]
    assert after["vectors"]["rlm_chunks"] == before["vectors"]["rlm_chunks"]
    # … and independently, by cosine distance to the ORIGINAL fixture being 0.
    conn = psycopg2.connect(dsn, connect_timeout=15)
    try:
        with conn.cursor() as cur:
            for mem_id, vector in fixtures["gsd_memory"].items():
                cur.execute("SELECT embedding <=> %s::vector FROM gsd_memory "
                            "WHERE id = %s", (_vector_literal(vector), mem_id))
                row = cur.fetchone()
                assert row is not None, mem_id
                assert float(row[0]) == 0.0, (mem_id, row[0])
            for chunk_id, vector in fixtures["rlm_chunks"].items():
                cur.execute("SELECT embedding_code <=> %s::vector FROM rlm_chunks "
                            "WHERE id = %s", (_vector_literal(vector), chunk_id))
                row = cur.fetchone()
                assert row is not None, chunk_id
                assert float(row[0]) == 0.0, (chunk_id, row[0])
    finally:
        conn.close()

    # And the manifest's own census matches what the database holds now.
    for table, claim in claimed.items():
        if table == "gsd_audit_log":
            continue
        assert after["rows"].get(table) == claim["rows"], table
        if "with_embedding" in claim:
            assert len(after["vectors"].get(table, {})) or claim["with_embedding"] == 0


@requires_pg
def test_the_same_assertion_fails_against_the_old_backup_manager(isolated, tmp_path):
    """The must-have, proven against ``services/backup.py``.

    The old exporter's output carries no ``embedding`` key at all, so the
    byte-identical-vector assertion cannot even be made against it — which is
    why this plan replaces it rather than extending it.
    """
    from services import backup as old_backup
    from services.pg_store import PGStore

    dsn = isolated["dsn"]
    seed(dsn)
    store = PGStore(dsn=dsn, min_conn=1, max_conn=2)
    try:
        rows = store.export_all_memory()
        assert len(rows) == SEED_ROWS
        assert all("embedding" not in row for row in rows), (
            "services/pg_store.py stopped stripping embeddings; "
            "services/backup.py's docstring label must be updated")
        out = tmp_path / "old.json.gz"
        manager = old_backup.BackupManager(store)
        path, counts, _checksum = manager.create(str(out))
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            document = json.load(handle)
    finally:
        store.close()

    whole = json.dumps(document)
    assert '"embedding"' not in whole, "the old export unexpectedly kept a vector"
    assert counts["gsd_memory"] == SEED_ROWS
    # Six logical table types out of the ~22 the database carries.
    assert len(document["tables"]) == 6
    live_tables = len(census(dsn)["rows"])
    assert live_tables > len(document["tables"]) + 10, live_tables
    # THE ASSERTION THE NEW VERB PASSES AND THIS ONE CANNOT: there is no vector
    # to compare, so the comparison itself raises.
    with pytest.raises((KeyError, AssertionError)):
        exported = {row["id"]: row["embedding"] for row in document["tables"]["gsd_memory"]}
        assert exported


def test_services_backup_py_carries_the_honest_label():
    """The old exporter says what it is, in its own module docstring.

    The label is not decoration: the next reader who reaches for
    ``BackupManager`` to "restore the database" must meet the sentence before
    they meet the method.
    """
    from services import backup as old_backup

    doc = old_backup.__doc__ or ""
    assert "not a restorable snapshot" in doc
    assert "backup_snapshot" in doc
    assert "6 of" in doc and "22" in doc
    for site in ("456", "2982", "3281"):
        assert site in doc, site


def test_the_embedding_stripping_is_pinned_at_all_three_sites():
    """The limitation is PINNED, not assumed, at each of the three sites.

    If a future change stops stripping, this fails — which forces the label in
    ``services/backup.py`` to be updated in the same commit rather than rotting
    into a false claim.  ``services/pg_store.py`` itself is NOT edited here: it
    belongs to plans 89-06 and 89-08.
    """
    from services import pg_store

    source = (REPO_ROOT / "services" / "pg_store.py").read_text(encoding="utf-8")
    lines = source.splitlines()
    sites = [i + 1 for i, line in enumerate(lines)
             if 'd.pop("embedding", None)' in line]
    assert sites == [456, 2982, 3281], sites

    # Site 1 is the module-level scorer, and it is exercised directly.
    scored = pg_store._score_core(
        {"id": "m1", "source": "agent", "embedding": [0.1] * 1024}, 5.0,
        __import__("datetime").datetime.now(__import__("datetime").timezone.utc))
    assert "embedding" not in scored, (
        "pg_store._score_core stopped stripping; update services/backup.py's label")

    # Site 3 is the export path BackupManager depends on, exercised without a
    # database by calling the unbound method with a stand-in `self`.
    converted = pg_store.PGStore._rows_to_dicts(
        object(), [{"id": "m1", "embedding": [0.2] * 1024, "text": "t"}])
    assert converted == [{"id": "m1", "text": "t"}], converted


# ══════════════════════════════════════════════════════════════════
# The corruption arm: verify fails, restore refuses, the target is untouched
# ══════════════════════════════════════════════════════════════════

@requires_pg
def test_one_corrupted_byte_fails_verify_and_restore_refuses(
        isolated, tmp_path, pinned_home):
    """Corrupt one byte: ``verify`` names both digests and ``restore`` refuses.

    And the target is PROVEN untouched: the row counts are identical across the
    refused call, which is what distinguishes "refused" from "half done".
    """
    dsn = isolated["dsn"]
    seed(dsn)
    created = take_snapshot(dsn, tmp_path / "backups", pinned_home)
    snapshot = pathlib.Path(created["snapshot"])
    recorded = [entry for entry in created["manifest"]["files"]
                if entry["path"] == bs.DUMP_ARTEFACT][0]

    dump = snapshot / bs.DUMP_ARTEFACT
    blob = bytearray(dump.read_bytes())
    midpoint = len(blob) // 2
    blob[midpoint] = blob[midpoint] ^ 0xFF
    dump.write_bytes(bytes(blob))
    actual = bs.sha256_file(str(dump))
    assert actual != recorded["sha256"], "the corruption did not take"

    result = bs.verify(str(snapshot), env=pinned_home)
    assert result["ok"] is False
    joined = " ".join(result["failures"])
    assert "SHA-256 mismatch" in joined
    assert recorded["sha256"] in joined, joined
    assert actual in joined, joined

    before = census(dsn)
    with pytest.raises(bs.BackupError) as caught:
        bs.restore(str(snapshot), dsn=dsn, mode="replace", scope="postgres",
                   confirm=True, pre_restore_snapshot=False,
                   backups_dir=str(tmp_path / "backups"), env=pinned_home)
    assert caught.value.payload["error"] == "snapshot_failed_verification"
    after = census(dsn)
    assert after["rows"] == before["rows"], (before["rows"], after["rows"])
    assert after["vectors"] == before["vectors"]


@requires_pg
def test_restore_refuses_a_snapshot_that_was_never_verified(
        isolated, tmp_path, pinned_home):
    """No ``verified_at`` means ABSENT, and absent cannot be restored."""
    dsn = isolated["dsn"]
    seed(dsn)
    created = take_snapshot(dsn, tmp_path / "backups", pinned_home)
    snapshot = pathlib.Path(created["snapshot"])
    manifest_path = snapshot / bs.MANIFEST_NAME
    document = json.loads(manifest_path.read_text(encoding="utf-8"))
    document.pop("verified_at")
    document.pop("verify_result")
    manifest_path.write_text(json.dumps(document, indent=2), encoding="utf-8")

    before = census(dsn)
    with pytest.raises(bs.BackupError) as caught:
        bs.restore(str(snapshot), dsn=dsn, mode="replace", scope="postgres",
                   confirm=True, backups_dir=str(tmp_path / "backups"),
                   env=pinned_home)
    assert caught.value.payload["error"] == "snapshot_unverified"
    assert census(dsn)["rows"] == before["rows"]


@requires_pg
def test_replace_mode_requires_confirm(isolated, tmp_path, pinned_home):
    """A destructive mode needs a word from the caller."""
    dsn = isolated["dsn"]
    seed(dsn)
    created = take_snapshot(dsn, tmp_path / "backups", pinned_home)
    before = census(dsn)
    with pytest.raises(bs.BackupError) as caught:
        bs.restore(created["snapshot"], dsn=dsn, mode="replace",
                   scope="postgres", confirm=False,
                   backups_dir=str(tmp_path / "backups"), env=pinned_home)
    assert caught.value.payload["error"] == "confirmation_required"
    assert census(dsn)["rows"] == before["rows"]


@requires_pg
def test_a_partial_restore_is_a_failure_not_a_restored_message(
        isolated, tmp_path, pinned_home, capsys):
    """The exact defect in ``scripts/restore.sh``, pinned in the new code.

    ``psql < dump`` with no ``ON_ERROR_STOP`` and ``2>/dev/null`` printed
    "restored" after a partial load.  Here a non-zero ``pg_restore`` exit raises,
    and no output says "restored".
    """
    dsn = isolated["dsn"]
    seed(dsn)
    created = take_snapshot(dsn, tmp_path / "backups", pinned_home)

    seen = []

    def failing(argv, *, env=None, stdout_path=None, timeout=None):
        joined = " ".join(str(a) for a in argv)
        seen.append(joined)
        if "pg_restore" in joined and "--list" not in argv:
            return {"argv": list(argv), "returncode": 1, "stdout": b"",
                    "stderr": "ERROR:  relation \"gsd_memory\" already exists"}
        return bs.default_runner(argv, env=env, stdout_path=stdout_path,
                                 timeout=timeout)

    capsys.readouterr()
    with pytest.raises(bs.BackupError) as caught:
        bs.restore(created["snapshot"], dsn=dsn, mode="replace",
                   scope="postgres", confirm=True, pre_restore_snapshot=False,
                   backups_dir=str(tmp_path / "backups"), env=pinned_home,
                   runner=failing, log=print)
    assert any("pg_restore" in line and "--list" not in line for line in seen), seen
    payload = caught.value.payload
    assert payload["error"] == "restore_failed"
    assert payload["returncode"] == 1
    assert "ON_ERROR_STOP" in payload["message"]
    assert "restored" not in capsys.readouterr().out.lower().replace(
        "pre-restore", "")


@requires_pg
def test_the_restore_argv_carries_clean_if_exists_and_exit_on_error(
        isolated, tmp_path, pinned_home):
    """``--clean --if-exists --exit-on-error`` is the ON_ERROR_STOP semantics."""
    dsn = isolated["dsn"]
    seed(dsn)
    created = take_snapshot(dsn, tmp_path / "backups", pinned_home)
    calls = []

    def recording(argv, *, env=None, stdout_path=None, timeout=None):
        calls.append(list(argv))
        return bs.default_runner(argv, env=env, stdout_path=stdout_path,
                                 timeout=timeout)

    bs.restore(created["snapshot"], dsn=dsn, mode="replace", scope="postgres",
               confirm=True, pre_restore_snapshot=False,
               backups_dir=str(tmp_path / "backups"), env=pinned_home,
               runner=recording)
    restores = [c for c in calls
                if "pg_restore" in " ".join(map(str, c)) and "--list" not in c]
    assert len(restores) == 1, calls
    argv = restores[0]
    for flag in ("--clean", "--if-exists", "--exit-on-error",
                 "--no-owner", "--no-privileges"):
        assert flag in argv, (flag, argv)
    assert not any("sekrit" in str(part) or "@" in str(part) for part in argv), argv


# ══════════════════════════════════════════════════════════════════
# The pre-restore snapshot, and the record of its absence
# ══════════════════════════════════════════════════════════════════

@requires_pg
def test_restore_takes_a_pre_restore_snapshot_by_default(
        isolated, tmp_path, pinned_home):
    """A ``reason=pre-restore`` snapshot exists afterwards, and it is verified."""
    dsn = isolated["dsn"]
    seed(dsn)
    backups = tmp_path / "backups"
    created = take_snapshot(dsn, backups, pinned_home)
    result = bs.restore(created["snapshot"], dsn=dsn, mode="replace",
                        scope="postgres", confirm=True,
                        backups_dir=str(backups), env=pinned_home)
    pre = bs.list_snapshots(str(backups), reason="pre-restore")
    assert len(pre) == 1, [row["name"] for row in bs.list_snapshots(str(backups))]
    assert pre[0]["snapshot"] == result["pre_restore"]
    assert pre[0]["verified_at"]
    assert pre[0]["verify_result"] == "ok"
    assert result["overrides"] == {}


@requires_pg
def test_skipping_the_pre_restore_snapshot_is_recorded_in_the_audit_log(
        isolated, tmp_path, pinned_home):
    """``--no-pre-restore-snapshot`` is explicit AND recorded, never silent."""
    import psycopg2

    dsn = isolated["dsn"]
    seed(dsn)
    backups = tmp_path / "backups"
    created = take_snapshot(dsn, backups, pinned_home)
    result = bs.restore(created["snapshot"], dsn=dsn, mode="replace",
                        scope="postgres", confirm=True,
                        pre_restore_snapshot=False, backups_dir=str(backups),
                        env=pinned_home)
    assert result["pre_restore"] is None
    assert result["overrides"] == {"no_pre_restore_snapshot": True}
    assert bs.list_snapshots(str(backups), reason="pre-restore") == []
    assert result["audit_row"] is not None

    conn = psycopg2.connect(dsn, connect_timeout=15)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT event_type, metadata FROM gsd_audit_log "
                        "WHERE id = %s", (result["audit_row"],))
            event_type, metadata = cur.fetchone()
    finally:
        conn.close()
    assert event_type == "backup_restore"
    assert metadata["mode"] == "replace"
    assert metadata["overrides"] == {"no_pre_restore_snapshot": True}
    assert metadata["snapshot"] == os.path.basename(created["snapshot"])
    assert "://" not in json.dumps(metadata)


# ══════════════════════════════════════════════════════════════════
# The census the manifest records is the one the database holds
# ══════════════════════════════════════════════════════════════════

@requires_pg
def test_the_manifest_census_matches_the_database(isolated, tmp_path, pinned_home):
    """Per-table rows, embedding counts and dimensions, measured not guessed."""
    dsn = isolated["dsn"]
    seed(dsn)
    created = take_snapshot(dsn, tmp_path / "backups", pinned_home)
    pg = created["manifest"]["pg"]
    live = census(dsn)
    for table, claim in pg["tables"].items():
        assert claim["rows"] == live["rows"][table], table
    assert pg["tables"]["semantic_cache"]["with_embedding"] == SEED_ROWS
    assert pg["tables"]["semantic_cache"]["vector_dims"] == 1024
    assert len(pg["applied_migrations"]) >= 25
    assert "vector" in pg["extensions"]
    assert pg["server_version"]
    assert created["manifest"]["dsn_fingerprint"] == bs.dsn_fingerprint(dsn)
    assert "://" not in json.dumps(created["manifest"])

"""MEMSAFE counter-proofs (CP1..CP5) — the gate for commit fa0e6f3.

Background
----------
Auto-distill ran as a side effect of every memory write and DELETEd every
consumed original without archiving it. 5,318 distinct ids appear in
``merged_from`` arrays; only 12 survive anywhere. The repair (fa0e6f3) is
four changes across ``get-shit-done/bin/gsd-memory.cjs``,
``services/pg_store.py`` and ``services/amauta-daemon.py``.

Those four changes were proved once, by hand, in a scratchpad. This file is
that proof turned into something CI can run on every push. Each counter-proof
carries a **failure arm**: a control showing the assertion mechanism is able
to report the opposite result. A proof that has only ever passed has never
been tested.

The live store is structurally unreachable from this file
--------------------------------------------------------
Every test runs against a database this module creates and drops itself.

1. The database NAME is generated here (``gsd_memsafe_test_<16 hex>``) from
   ``secrets.token_hex``. It is never read from configuration, so no
   environment variable, .env file, CI secret or DSN can redirect these tests
   at an existing database. Configuration supplies only the *server*
   coordinates (host/port/user/password); the dbname component of
   ``GSD_POSTGRES_URL`` is parsed off and discarded — see ``_server_parts``.
2. ``_assert_ephemeral`` re-derives the name from ``SELECT current_database()``
   on the live connection and matches it against ``_EPHEMERAL_RE``, and against
   an explicit deny-list containing ``gsd_amauta``. It is called before the
   CREATE, after the CONNECT, and before the DROP. A rename or a mistaken reuse
   fails the run before any DML executes.
3. The fixture asserts the freshly created ``gsd_memory`` table is EMPTY. A
   populated table means the connection did not land where this module thinks
   it did, and the run aborts before the first destructive statement.

Running it
----------
    python3 -m pytest tests/test_85_memsafe_counter_proofs.py -v

Without a reachable PostgreSQL server the module SKIPS — unless
``GSD_MEMSAFE_REQUIRE_PG=1``, in which case it FAILS. CI sets that variable,
so an unreachable database can never present itself as a green gate.
"""

import os
import re
import secrets
import sys
import urllib.parse

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "services"))

psycopg2 = pytest.importorskip("psycopg2")

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# ── Structural containment: the live store cannot be named ──────────────────

_EPHEMERAL_PREFIX = "gsd_memsafe_test_"
_EPHEMERAL_RE = re.compile(r"^gsd_memsafe_test_[0-9a-f]{16}$")

# Explicit deny-list. _EPHEMERAL_RE already excludes every one of these; the
# list exists so the refusal names the live store out loud rather than relying
# on a regex the next reader has to evaluate in their head.
_FORBIDDEN_DB_NAMES = frozenset(
    {"gsd_amauta", "gsd", "postgres", "template0", "template1"}
)

_DEFAULT_SERVER = "postgresql://gsd:gsd@127.0.0.1:5433/ignored"

REQUIRE_PG = os.environ.get("GSD_MEMSAFE_REQUIRE_PG") == "1"


def _assert_ephemeral(dbname, where):
    """Refuse to proceed unless ``dbname`` is one this module generated.

    Args:
        dbname: database name to validate.
        where: short label naming the call site, used in the refusal message.

    Raises:
        RuntimeError: if the name is not a generated ephemeral name, or is on
            the deny-list. Never returns False — a bad name is a hard stop, not
            a skip, because the alternative is a destructive test pointed at
            production data.
    """
    if dbname in _FORBIDDEN_DB_NAMES:
        raise RuntimeError(
            f"MEMSAFE refusal at {where}: {dbname!r} is a protected database. "
            "These tests DELETE rows and must only ever run against a database "
            "they created themselves."
        )
    if not _EPHEMERAL_RE.match(dbname or ""):
        raise RuntimeError(
            f"MEMSAFE refusal at {where}: {dbname!r} does not match "
            f"{_EPHEMERAL_RE.pattern} — not a database this module created."
        )
    return dbname


def _server_parts():
    """Parse server coordinates from config, discarding the database name.

    ``GSD_POSTGRES_URL`` (the variable ``PGStore`` itself reads) supplies host,
    port, user and password only. Its path component — the database name — is
    deliberately dropped, which is what makes it impossible to aim this suite
    at the live store by configuration.

    Returns:
        dict with keys host, port, user, password.
    """
    raw = os.environ.get("GSD_POSTGRES_URL") or _DEFAULT_SERVER
    u = urllib.parse.urlsplit(raw)
    return {
        "host": u.hostname or "127.0.0.1",
        "port": u.port or 5433,
        "user": u.username or "gsd",
        "password": u.password or "gsd",
    }


def _dsn_for(dbname):
    p = _server_parts()
    return (
        f"postgresql://{urllib.parse.quote(p['user'])}:"
        f"{urllib.parse.quote(p['password'])}@{p['host']}:{p['port']}/{dbname}"
    )


def _maintenance_connect():
    """Connect to the server's default maintenance database, autocommit on."""
    conn = psycopg2.connect(_dsn_for("postgres"))
    conn.autocommit = True
    return conn


def _gsd_memory_ddl():
    """Return the real ``gsd_memory`` DDL, read from migrations/001-init.sql.

    Reading the migration rather than restating the schema means a schema
    change shows up here instead of silently diverging.

    Returns:
        str: a single ``CREATE TABLE IF NOT EXISTS gsd_memory (...)`` statement.

    Raises:
        RuntimeError: if the statement cannot be located in the migration.
    """
    path = os.path.join(REPO_ROOT, "migrations", "001-init.sql")
    with open(path, encoding="utf-8") as fh:
        sql = fh.read()
    m = re.search(
        r"CREATE TABLE IF NOT EXISTS gsd_memory\s*\(.*?\n\);", sql, re.S
    )
    if not m:
        raise RuntimeError(f"gsd_memory DDL not found in {path}")
    return m.group(0)


# ── Ephemeral database fixture ──────────────────────────────────────────────


@pytest.fixture(scope="module")
def eph_db():
    """Create, verify and finally drop a private database for this module.

    Yields:
        str: the ephemeral database name.
    """
    dbname = _EPHEMERAL_PREFIX + secrets.token_hex(8)
    _assert_ephemeral(dbname, "pre-CREATE")

    try:
        admin = _maintenance_connect()
    except Exception as exc:  # noqa: BLE001 — reported either way
        if REQUIRE_PG:
            pytest.fail(
                "GSD_MEMSAFE_REQUIRE_PG=1 but PostgreSQL is unreachable: "
                f"{exc}. Refusing to report a green gate on an unrun suite."
            )
        pytest.skip(f"PostgreSQL unreachable: {exc}")

    try:
        with admin.cursor() as cur:
            cur.execute(f'CREATE DATABASE "{dbname}"')
    finally:
        admin.close()

    try:
        conn = psycopg2.connect(_dsn_for(dbname))
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                # Guard #2: re-derive the name from the SERVER, not from the
                # string we think we connected with.
                cur.execute("SELECT current_database()")
                _assert_ephemeral(cur.fetchone()[0], "post-CONNECT")

                cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
                cur.execute(_gsd_memory_ddl())

                # Guard #3: a fresh database has an empty table. Anything else
                # means we are not where we think we are.
                cur.execute("SELECT COUNT(*) FROM gsd_memory")
                n = cur.fetchone()[0]
                if n != 0:
                    raise RuntimeError(
                        f"MEMSAFE refusal: freshly created {dbname} already has "
                        f"{n} rows in gsd_memory — aborting before any DML."
                    )
        finally:
            conn.close()

        yield dbname
    finally:
        _assert_ephemeral(dbname, "pre-DROP")
        admin = _maintenance_connect()
        try:
            with admin.cursor() as cur:
                cur.execute(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)')
        finally:
            admin.close()


@pytest.fixture(scope="module")
def store(eph_db):
    """A real ``PGStore`` bound to the ephemeral database."""
    from pg_store import PGStore  # noqa: PLC0415 — needs sys.path set above

    st = PGStore(dsn=_dsn_for(eph_db), min_conn=1, max_conn=4)
    # Fourth guard: the store's own DSN must resolve to the ephemeral name.
    _assert_ephemeral(urllib.parse.urlsplit(st.dsn).path.lstrip("/"), "PGStore.dsn")
    try:
        yield st
    finally:
        try:
            st._pool.closeall()
        except Exception:  # noqa: BLE001 — teardown must not mask a failure
            pass


# ── helpers ─────────────────────────────────────────────────────────────────


def _q(store, sql, params=None, fetch="one"):
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            if fetch == "one":
                row = cur.fetchone()
                return row[0] if row else None
            if fetch == "all":
                return cur.fetchall()
            return cur.rowcount


def _seed(store, mem_id, text="memsafe probe", source="agent"):
    """Insert one row directly, bypassing embedding/classification."""
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO gsd_memory (id, text, agent_id, source) "
                "VALUES (%s, %s, %s, %s)",
                (mem_id, text, "memsafe-test", source),
            )
    return mem_id


def _count(store, source=None):
    if source is None:
        return _q(store, "SELECT COUNT(*) FROM gsd_memory")
    return _q(store, "SELECT COUNT(*) FROM gsd_memory WHERE source = %s", (source,))


def _archive_count(store):
    store._ensure_archive_table()
    return _q(store, "SELECT COUNT(*) FROM gsd_memory_archive")


class _ArchiveWritesBlocked:
    """Context manager: a real ``BEFORE INSERT`` trigger that RAISEs.

    This is deliberately a database trigger and not a mock or a patched
    method. A mock proves the caller handles an exception it was handed; a
    trigger proves the archive INSERT genuinely cannot land and that the
    surrounding transaction really does roll the DELETE back. On exit the
    trigger and its function are dropped and ``pg_trigger`` is verified back
    to zero.
    """

    def __init__(self, store):
        self.store = store

    def __enter__(self):
        self.store._ensure_archive_table()
        with self.store._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE OR REPLACE FUNCTION memsafe_block_archive()
                    RETURNS trigger AS $$
                    BEGIN
                      RAISE EXCEPTION 'MEMSAFE probe: archive write disabled';
                    END;
                    $$ LANGUAGE plpgsql
                    """
                )
                cur.execute(
                    "CREATE TRIGGER memsafe_block_archive_trg "
                    "BEFORE INSERT ON gsd_memory_archive "
                    "FOR EACH ROW EXECUTE FUNCTION memsafe_block_archive()"
                )
        assert self._trigger_count() == 1, "fault injection did not install"
        return self

    def __exit__(self, *exc):
        with self.store._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "DROP TRIGGER IF EXISTS memsafe_block_archive_trg "
                    "ON gsd_memory_archive"
                )
                cur.execute("DROP FUNCTION IF EXISTS memsafe_block_archive()")
        assert self._trigger_count() == 0, "fault injection was not removed"
        return False

    def _trigger_count(self):
        return _q(
            self.store,
            "SELECT COUNT(*) FROM pg_trigger WHERE tgname = "
            "'memsafe_block_archive_trg'",
        )


# ═══════════════════════════════════════════════════════════════════════════
# CP0 — the containment guards themselves are load-bearing
# ═══════════════════════════════════════════════════════════════════════════


def test_cp0_guard_refuses_the_live_store_by_name():
    """The failure arm of the safety guard: it must actually refuse."""
    for bad in ("gsd_amauta", "postgres", "gsd_memsafe_test_", "gsd_memsafe_testXX"):
        with pytest.raises(RuntimeError, match="MEMSAFE refusal"):
            _assert_ephemeral(bad, "unit")
    # ...and must accept a name this module would really generate.
    good = _EPHEMERAL_PREFIX + secrets.token_hex(8)
    assert _assert_ephemeral(good, "unit") == good


def test_cp0_dbname_is_not_configurable(monkeypatch):
    """No environment value can steer the suite at an existing database."""
    monkeypatch.setenv(
        "GSD_POSTGRES_URL", "postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta"
    )
    parts = _server_parts()
    assert "gsd_amauta" not in parts.values()
    assert set(parts) == {"host", "port", "user", "password"}
    # The dbname the suite would use is generated, not taken from the URL.
    assert _EPHEMERAL_RE.match(_EPHEMERAL_PREFIX + secrets.token_hex(8))


# ═══════════════════════════════════════════════════════════════════════════
# CP1 — one store increments by exactly one and creates zero distilled rows
# ═══════════════════════════════════════════════════════════════════════════


def test_cp1_single_store_increments_by_one_and_distills_nothing(store):
    before = _count(store)
    before_distilled = _count(store, "distilled")

    mem_id = _seed(store, "memsafe-cp1-" + secrets.token_hex(4))

    assert _count(store) - before == 1, "a single write must add exactly one row"
    assert _count(store, "distilled") - before_distilled == 0, (
        "a write must not produce a distilled row — that is the incident"
    )

    # Failure arm: both counters must be able to report the other answer, or
    # the two assertions above are vacuous.
    _seed(store, "memsafe-cp1-b-" + secrets.token_hex(4))
    _seed(store, "memsafe-cp1-c-" + secrets.token_hex(4))
    assert _count(store) - before == 3, "row counter cannot discriminate"

    d_id = _seed(store, "memsafe-cp1-d-" + secrets.token_hex(4), source="distilled")
    assert _count(store, "distilled") - before_distilled == 1, (
        "distilled counter cannot return non-zero — it proves nothing"
    )

    _q(store, "DELETE FROM gsd_memory WHERE agent_id = 'memsafe-test'", fetch="rc")
    assert _count(store) == before
    del mem_id, d_id


# ═══════════════════════════════════════════════════════════════════════════
# CP2 — deleting a missing id reports 0 / not-found
# ═══════════════════════════════════════════════════════════════════════════


def test_cp2_missing_id_reports_zero_not_success(store):
    ghost = "memsafe-cp2-ghost-" + secrets.token_hex(4)

    assert store.memory_delete(ghost) == 0, (
        "memory_delete returned None pre-fix, so the daemon answered "
        '{"deleted": true} for an id that matched nothing'
    )
    res = store.memory_archive_and_delete(ghost)
    assert res["found"] is False
    assert res["deleted"] == 0
    assert res["archived"] == 0

    # Failure arm: the same two probes on a real id must report non-zero.
    real = _seed(store, "memsafe-cp2-real-" + secrets.token_hex(4))
    res2 = store.memory_archive_and_delete(real)
    assert res2["found"] is True and res2["deleted"] == 1 and res2["archived"] == 1

    real2 = _seed(store, "memsafe-cp2-real2-" + secrets.token_hex(4))
    assert store.memory_delete(real2) == 1, "memory_delete cannot return non-zero"

    _q(store, "DELETE FROM gsd_memory_archive WHERE id = %s", (real,), fetch="rc")


def test_cp2_daemon_route_reports_the_real_rowcount():
    """The reporting seam, at source level: the route must not hardcode true."""
    path = os.path.join(REPO_ROOT, "services", "amauta-daemon.py")
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    i = src.find("/api/memory/delete")
    assert i != -1, "the delete route disappeared — this pin needs rewriting"
    window = src[i : i + 1200]
    assert '"deleted": True' not in window, (
        "the delete route answers a constant True again — the pre-fix defect"
    )
    assert "rowcount" in window or "deleted_rows" in window or "bool(" in window, (
        "the delete route no longer derives its answer from a row count"
    )


# ═══════════════════════════════════════════════════════════════════════════
# CP3 — red/green under the SAME injected fault
# ═══════════════════════════════════════════════════════════════════════════


def test_cp3_red_green_under_the_same_fault(store):
    red_id = _seed(store, "memsafe-cp3-red-" + secrets.token_hex(4))
    green_id = _seed(store, "memsafe-cp3-green-" + secrets.token_hex(4))
    store._ensure_archive_table()

    with _ArchiveWritesBlocked(store):
        # RED ARM — the exact call the old distill made.
        before = _count(store)
        rows = store.memory_delete(red_id)
        assert rows == 1
        assert _count(store) == before - 1, "red arm did not destroy the row"
        assert (
            _q(store, "SELECT COUNT(*) FROM gsd_memory_archive WHERE id = %s",
               (red_id,)) == 0
        ), "red arm archived something — the fault injection is not active"

        # GREEN ARM — same fault, same database, same moment.
        before = _count(store)
        with pytest.raises(Exception) as exc:
            store.memory_archive_and_delete(green_id)
        assert "MEMSAFE probe" in str(exc.value) or "archive" in str(exc.value).lower()
        assert _count(store) == before, "green arm let the count fall"
        assert _q(
            store, "SELECT COUNT(*) FROM gsd_memory WHERE id = %s", (green_id,)
        ) == 1, "green arm lost the row it was supposed to preserve"

    # Fault removed: the green call must now succeed, or the refusal above
    # proved only that the call always fails.
    ok = store.memory_archive_and_delete(green_id)
    assert ok["deleted"] == 1 and ok["archived"] == 1
    _q(store, "DELETE FROM gsd_memory_archive WHERE id = %s", (green_id,), fetch="rc")


# ═══════════════════════════════════════════════════════════════════════════
# CP4 — every id in merged_from is in the archive, count for count
# ═══════════════════════════════════════════════════════════════════════════


def _reconcile(store, merged_from):
    """Return the ids in ``merged_from`` that are NOT recoverable.

    Mirrors the end-of-run reconciliation in ``cmdDistill``: an id counts as
    recoverable only if it is present in ``gsd_memory_archive`` AND carries a
    non-null ``archived_at``.
    """
    if not merged_from:
        return list(merged_from)
    rows = _q(
        store,
        "SELECT id FROM gsd_memory_archive "
        "WHERE id = ANY(%s) AND archived_at IS NOT NULL",
        (list(merged_from),),
        fetch="all",
    )
    found = {r[0] for r in rows}
    return [i for i in merged_from if i not in found]


def test_cp4_every_merged_from_id_is_archived(store):
    store._ensure_archive_table()
    ids = [_seed(store, f"memsafe-cp4-{i}-" + secrets.token_hex(4)) for i in range(5)]
    before_mem = _count(store)
    before_arc = _archive_count(store)

    merged_from = []
    for mem_id in ids:
        res = store.memory_archive_and_delete(mem_id)
        assert res["deleted"] == 1, f"{mem_id} was not removed: {res}"
        merged_from.append(mem_id)

    assert _count(store) == before_mem - len(ids)
    assert _archive_count(store) == before_arc + len(ids)
    assert _reconcile(store, merged_from) == [], "an id in merged_from is unrecoverable"

    rows = _q(
        store,
        "SELECT COUNT(*) FROM gsd_memory_archive "
        "WHERE id = ANY(%s) AND archived_at IS NOT NULL",
        (merged_from,),
    )
    assert rows == len(merged_from), "count-for-count mismatch"

    # Failure arm: the reconciliation must be able to name a miss. This is the
    # exact shape of the incident — an id recorded in merged_from with no
    # archive copy — so if it does not report, CP4 is decorative.
    phantom = "memsafe-cp4-never-archived"
    assert _reconcile(store, merged_from + [phantom]) == [phantom]

    _q(store, "DELETE FROM gsd_memory_archive WHERE id = ANY(%s)",
       (merged_from,), fetch="rc")


# ═══════════════════════════════════════════════════════════════════════════
# CP5 — archiving is a PRECONDITION, not a step that happens to run first
# ═══════════════════════════════════════════════════════════════════════════


def test_cp5_delete_refuses_when_archiving_is_disabled(store):
    target = _seed(store, "memsafe-cp5-" + secrets.token_hex(4), text="load bearing")
    store._ensure_archive_table()
    before_mem = _count(store)
    before_arc = _archive_count(store)

    with _ArchiveWritesBlocked(store) as fault:
        assert fault._trigger_count() == 1
        with pytest.raises(Exception) as exc:
            store.memory_archive_and_delete(target)
        assert "MEMSAFE probe: archive write disabled" in str(exc.value), (
            f"refused for the wrong reason: {exc.value}"
        )
        assert _count(store) == before_mem, "gsd_memory count moved"
        assert _archive_count(store) == before_arc, "archive count moved"
        assert _q(
            store, "SELECT COUNT(*) FROM gsd_memory WHERE id = %s", (target,)
        ) == 1, "the row did not survive"

    # Trigger dropped in __exit__ and pg_trigger verified back to 0 there.
    assert _q(
        store,
        "SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'memsafe_block_archive_trg'",
    ) == 0

    # Failure arm: with archiving available the very same call succeeds, so the
    # refusal above was caused by the fault and not by the call being broken.
    ok = store.memory_archive_and_delete(target)
    assert ok["archived"] == 1 and ok["deleted"] == 1 and ok["found"] is True
    assert _count(store) == before_mem - 1
    _q(store, "DELETE FROM gsd_memory_archive WHERE id = %s", (target,), fetch="rc")

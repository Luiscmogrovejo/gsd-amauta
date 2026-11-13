#!/usr/bin/env python3
"""Phase 89 plan 89-06: the schema applies without pg_search, on both engines.

Decision D3. ``pg_search`` is optional now: migration 011 guards its
``CREATE EXTENSION``, 012 guards its BM25 index, 033 creates plain-PostgreSQL
substitutes where they were skipped, ``infra_detect`` reports the gap instead of
rejecting the server, and ``migrate_runner``'s sentinels follow the engine.

Every database-backed test here runs TWICE, once per engine, against two
databases of the one disposable cluster — see ``tests/support/pg_engines.py``
for exactly what that stand-in proves and what it does not.

Run:
    python3 -m pytest tests/test_89_06_pg_search_optional.py -q -rs -p no:cacheprovider
"""
import pathlib
import sys

import pytest

_REPO = pathlib.Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

import pg_engines  # noqa: E402  (tests/support is on sys.path — see tests/conftest.py)
# One database per engine for the whole session, shared with
# tests/test_89_06_lexical_fallback.py — see pg_engines' fixture comment.
from pg_engines import both, paradedb, plain  # noqa: E402,F401

from services import infra_detect, migrate_runner  # noqa: E402

MIGRATIONS = _REPO / "migrations"
UP_033 = MIGRATIONS / "033-plain-fts-fallback.sql"
DOWN_033 = MIGRATIONS / "033-plain-fts-fallback-DOWN.sql"


def _exec_file(dsn, path):
    """Run one migration file's SQL, as the runner would, and return NOTICEs."""
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            cur.execute(path.read_text(encoding="utf-8"))
        conn.commit()
        return [n.strip() for n in conn.notices]
    finally:
        conn.close()


# ═══════════════════════════════════════════════════════════════════════════
# 1. The migration files, without a database
# ═══════════════════════════════════════════════════════════════════════════

def test_011_and_012_guard_their_pg_search_objects_in_the_house_block():
    """The guard is 025's DO/RAISE NOTICE block, not a second mechanism."""
    for name in ("011-paradedb-setup.sql", "012-rlm-chunks.sql",
                 "033-plain-fts-fallback.sql"):
        sql = (MIGRATIONS / name).read_text(encoding="utf-8")
        assert "DO $$" in sql, f"{name}: no DO block"
        assert "RAISE NOTICE" in sql, f"{name}: a skip with no notice is a silent skip"


def test_011_keeps_the_pgvector_assertion_hard_and_outside_every_guard():
    """pgvector was never the blocker (88-16-RECORD.md:570-598) and stays required."""
    sql = (MIGRATIONS / "011-paradedb-setup.sql").read_text(encoding="utf-8")
    assert "0.8.0" in sql
    # The assertion RAISEs an EXCEPTION; the pg_search block RAISEs a NOTICE.
    assert "RAISE EXCEPTION 'pgvector version % is below required 0.8.0', v;" in sql
    # It is the FIRST DO block in the file and it CLOSES before the
    # pg_search-conditional block opens, so no engine can skip it.
    pgvector_block_end = sql.index("END $$;")
    assert pgvector_block_end < sql.index("pg_available_extensions"), \
        "the pgvector assertion must not sit inside the pg_search guard"
    assert "pg_search" not in sql[sql.index("DO $$"):pgvector_block_end], \
        "the pgvector DO block must not mention pg_search at all"


def test_011_still_carries_the_literal_text_the_substrate_tests_read():
    sql = (MIGRATIONS / "011-paradedb-setup.sql").read_text(encoding="utf-8")
    assert "CREATE EXTENSION IF NOT EXISTS pg_search" in sql
    assert "USING bm25" in sql and "key_field = 'id'" in sql
    assert "bm25_test_table" in sql


def test_033_is_the_only_033_and_has_an_executed_down():
    names = sorted(p.name for p in MIGRATIONS.glob("033-*"))
    assert names == ["033-plain-fts-fallback-DOWN.sql", "033-plain-fts-fallback.sql"]
    down = DOWN_033.read_text(encoding="utf-8")
    for index in pg_engines.FTS_SUBSTITUTE_INDEXES:
        assert f"DROP INDEX IF EXISTS {index};" in down
    # It drops EXACTLY those two: 004's idx_gsd_memory_fts is another
    # migration's index and exists on every engine.
    assert down.count("DROP INDEX") == len(pg_engines.FTS_SUBSTITUTE_INDEXES)
    assert "DROP INDEX IF EXISTS idx_gsd_memory_fts;" not in down


def test_033_creates_nothing_unless_pg_search_is_absent():
    """Both statements sit under the inverted guard — that is the byte-unchanged claim."""
    sql = UP_033.read_text(encoding="utf-8")
    code = "\n".join(line for line in sql.splitlines()
                     if not line.strip().startswith("--"))
    assert code.count("CREATE INDEX IF NOT EXISTS") == 2
    # Every CREATE sits after an `IF EXISTS (... extname = 'pg_search') THEN
    # RAISE NOTICE ... ELSE` — i.e. in the branch taken only when absent.
    assert code.count("IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_search')") == 2
    # Each CREATE follows its own guard's ELSE, never the THEN branch.
    for block in code.split("DO $$")[1:]:
        assert block.index("ELSE") < block.index("CREATE INDEX IF NOT EXISTS"), \
            "a substitute index is created in the pg_search-PRESENT branch"
    for index in pg_engines.FTS_SUBSTITUTE_INDEXES:
        assert index in code


# ═══════════════════════════════════════════════════════════════════════════
# 2. The sentinels, without a database
# ═══════════════════════════════════════════════════════════════════════════

#: migrate_runner.MIGRATION_SENTINELS on master (6bf57c0) for the three files
#: whose BM25 objects are conditional. Copied verbatim, so the defect proof
#: below runs against master's DATA rather than a description of it.
MASTER_SENTINELS = {
    "011-paradedb-setup.sql": [
        ("extension", "pg_search"), ("relation", "bm25_test_table"),
        ("relation", "bm25_test_idx"),
    ],
    "012-rlm-chunks.sql": [
        ("relation", "rlm_chunks"), ("relation", "idx_rlm_chunks_bm25"),
    ],
    "025-memory-hybrid-index.sql": [
        ("extension", "pg_trgm"), ("relation", "idx_gsd_memory_bm25"),
    ],
}


def test_the_three_conditional_sentinels_name_both_engines_objects():
    for filename in MASTER_SENTINELS:
        entry = migrate_runner.MIGRATION_SENTINELS[filename]
        ifexts = [s for s in entry if s[0] == "ifext"]
        assert len(ifexts) == 1, f"{filename}: expected one ifext row"
        assert ifexts[0][1] == "pg_search"


class _FakeCursor:
    """Answers the extension probe, and records anything else it is asked."""

    def __init__(self, extension_present):
        self.extension_present = extension_present
        self.asked = []
        self._row = None

    def execute(self, sql, params=None):
        self.asked.append((" ".join(sql.split()), params))
        if "pg_extension" in sql:
            self._row = (1,) if self.extension_present else None
        elif "to_regclass" in sql:
            # "the relation exists" — so a failure below is the ifext branching,
            # never the inner sentinel.
            self._row = (True,)
        else:
            self._row = (True,)

    def fetchone(self):
        return self._row


def test_an_ifext_with_a_none_branch_is_satisfied_without_asking_anything_else():
    """A `None` branch means "this engine creates nothing here" — not False."""
    cur = _FakeCursor(extension_present=False)
    assert migrate_runner._sentinel_satisfied(
        cur, ("ifext", "pg_search", ("relation", "bm25_test_idx"), None)) is True
    assert len(cur.asked) == 1 and "pg_extension" in cur.asked[0][0], (
        "the None branch must short-circuit, not probe for the skipped index"
    )


def test_an_ifext_asks_the_present_branch_only_when_the_extension_is_there():
    present = _FakeCursor(extension_present=True)
    migrate_runner._sentinel_satisfied(
        present, ("ifext", "pg_search", ("relation", "idx_rlm_chunks_bm25"),
                  ("relation", "idx_rlm_chunks_fts")))
    assert present.asked[1][1] == ("idx_rlm_chunks_bm25",)

    absent = _FakeCursor(extension_present=False)
    migrate_runner._sentinel_satisfied(
        absent, ("ifext", "pg_search", ("relation", "idx_rlm_chunks_bm25"),
                 ("relation", "idx_rlm_chunks_fts")))
    assert absent.asked[1][1] == ("idx_rlm_chunks_fts",)


# ═══════════════════════════════════════════════════════════════════════════
# 3. The full apply, on both engines
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.integration
def test_every_migration_applies_on_both_engines_with_the_same_count(both):
    """D3 at the schema level: 011 no longer takes the schema down with it."""
    counts = {engine: db["applied"] for engine, db in both.items()}
    assert counts["postgres_fts"] == counts["pg_search_bm25"], (
        "the two engines applied different numbers of migrations: %r" % counts
    )
    on_disk = len(list(migrate_runner.discover_migrations(str(MIGRATIONS))))
    assert counts["postgres_fts"] == on_disk, (
        "%d of %d migrations applied on the pg_search-less database"
        % (counts["postgres_fts"], on_disk)
    )


@pytest.mark.integration
def test_the_plain_database_really_has_no_pg_search(plain):
    assert pg_engines.has_pg_search(plain["dsn"]) is False


@pytest.mark.integration
def test_the_paradedb_database_really_has_pg_search(paradedb):
    assert pg_engines.has_pg_search(paradedb["dsn"]) is True


@pytest.mark.integration
def test_the_substitutes_exist_exactly_where_the_bm25_indexes_do_not(both):
    plain_names = pg_engines.index_names(both["postgres_fts"]["dsn"])
    bm25_names = pg_engines.index_names(both["pg_search_bm25"]["dsn"])

    for index in pg_engines.BM25_INDEXES:
        assert index not in plain_names, f"{index} on a pg_search-less database"
        assert index in bm25_names, f"{index} missing on the ParadeDB database"
    for index in pg_engines.FTS_SUBSTITUTE_INDEXES:
        assert index in plain_names, f"migration 033 did not create {index}"
        assert index not in bm25_names, f"{index} on a ParadeDB database"

    # 004's index is NOT one of 033's and must exist on both.
    assert "idx_gsd_memory_fts" in plain_names
    assert "idx_gsd_memory_fts" in bm25_names


@pytest.mark.integration
def test_a_paradedb_database_is_unchanged_by_migration_033(paradedb):
    """The byte-unchanged claim, measured as a pg_indexes diff across the apply."""
    before = pg_engines.index_defs(paradedb["dsn"])
    notices = _exec_file(paradedb["dsn"], UP_033)
    after = pg_engines.index_defs(paradedb["dsn"])
    assert after == before, "migration 033 changed a ParadeDB database: %r" % (
        {k: (before.get(k), after.get(k)) for k in set(before) ^ set(after)}
    )
    assert any("pg_search extension installed" in n for n in notices), notices


@pytest.mark.integration
def test_033_down_drops_only_its_own_two_indexes_and_up_restores_them(plain):
    before = pg_engines.index_defs(plain["dsn"])
    _exec_file(plain["dsn"], DOWN_033)
    after_down = pg_engines.index_defs(plain["dsn"])
    assert set(before) - set(after_down) == set(pg_engines.FTS_SUBSTITUTE_INDEXES)
    assert "idx_gsd_memory_fts" in after_down, "004's index is not 033's to drop"

    _exec_file(plain["dsn"], UP_033)
    assert pg_engines.index_defs(plain["dsn"]) == before, "033 is not reversible"


@pytest.mark.integration
def test_033_down_is_a_noop_on_a_paradedb_database(paradedb):
    before = pg_engines.index_defs(paradedb["dsn"])
    _exec_file(paradedb["dsn"], DOWN_033)
    assert pg_engines.index_defs(paradedb["dsn"]) == before


# ═══════════════════════════════════════════════════════════════════════════
# 4. detect_applied_by_schema / auto_baseline on both engines,
#    and the 025 sentinel defect master still carries
# ═══════════════════════════════════════════════════════════════════════════

def _applied_by_schema(dsn):
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=10)
    try:
        return migrate_runner.detect_applied_by_schema(conn, str(MIGRATIONS))
    finally:
        conn.close()


def _master_entry_satisfied(dsn, filename):
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=10)
    try:
        with conn.cursor() as cur:
            return all(migrate_runner._sentinel_satisfied(cur, s)
                       for s in MASTER_SENTINELS[filename])
    finally:
        conn.close()


@pytest.mark.integration
def test_detect_applied_by_schema_is_right_on_both_engines(both):
    for engine, db in both.items():
        applied, unknown = _applied_by_schema(db["dsn"])
        assert unknown == [], f"{engine}: migrations with no sentinel: {unknown}"
        for filename in ("011-paradedb-setup.sql", "012-rlm-chunks.sql",
                         "025-memory-hybrid-index.sql",
                         "033-plain-fts-fallback.sql"):
            assert filename in applied, (
                f"{engine}: {filename} ran, and schema detection says it did not"
            )


@pytest.mark.integration
def test_masters_sentinels_are_wrong_on_a_pg_search_less_database(plain):
    """The pre-existing defect, proven against master's own data.

    MIGRATION_SENTINELS["025-..."] required ("relation","idx_gsd_memory_bm25")
    while 025-memory-hybrid-index.sql:35-46 SKIPS that index without pg_search.
    So on this database — where 025 demonstrably RAN — master's entry answers
    "not applied", and auto_baseline would have re-run it forever.
    """
    for filename in MASTER_SENTINELS:
        assert _master_entry_satisfied(plain["dsn"], filename) is False, (
            f"{filename}: master's sentinel was satisfied, so the defect proof "
            f"is vacuous — check MASTER_SENTINELS against 6bf57c0"
        )
    applied, _ = _applied_by_schema(plain["dsn"])
    for filename in MASTER_SENTINELS:
        assert filename in applied, f"{filename}: this plan's sentinel is wrong too"


@pytest.mark.integration
def test_masters_sentinels_are_right_on_a_paradedb_database(paradedb):
    """The defect is engine-specific: nothing was broken on ParadeDB."""
    for filename in MASTER_SENTINELS:
        assert _master_entry_satisfied(paradedb["dsn"], filename) is True


@pytest.mark.integration
def test_auto_baseline_records_the_whole_set_on_both_engines(postgres_dsn):
    """A database migrated the OLD way (no schema_migrations) baselines right."""
    import psycopg2

    for force_plain in (False, True):
        with pg_engines.scratch_database(postgres_dsn, force_plain=force_plain) as dsn:
            # Apply every file the way the pre-runner psql loop did: no
            # tracking table at all.
            conn = psycopg2.connect(dsn, connect_timeout=10)
            try:
                for name, path, _digest in migrate_runner.discover_migrations(str(MIGRATIONS)):
                    with conn.cursor() as cur:
                        cur.execute(pathlib.Path(path).read_text(encoding="utf-8"))
                    conn.commit()
            finally:
                conn.close()

            conn = psycopg2.connect(dsn, connect_timeout=10)
            try:
                migrate_runner.ensure_tracking_table(conn)
                # dry_run: classify without writing, so the plan 89-04 backup
                # guard (which arms on a WRITE) is not what this test measures.
                baselined = migrate_runner.auto_baseline(
                    conn, str(MIGRATIONS), dry_run=True, log=lambda *_: None)
            finally:
                conn.close()
            names = {n for n, _, _ in migrate_runner.discover_migrations(str(MIGRATIONS))}
            assert set(baselined) == names, (
                "force_plain=%s: auto_baseline missed %r"
                % (force_plain, sorted(names - set(baselined)))
            )


# ═══════════════════════════════════════════════════════════════════════════
# 5. pg_search is PREFERRED, not REQUIRED
# ═══════════════════════════════════════════════════════════════════════════

def test_the_constant_split_exists():
    assert infra_detect.REQUIRED_EXTENSIONS == ("vector",)
    assert infra_detect.PREFERRED_EXTENSIONS == ("pg_search",)


def test_the_fallback_sentence_is_decision_d3s_words():
    assert infra_detect.LEXICAL_FALLBACK_SENTENCE == (
        "lexical search: plain PostgreSQL full-text (pg_search not installed) "
        "— ranking differs from the ParadeDB BM25 leg"
    )


@pytest.mark.integration
def test_a_plain_postgresql_is_accepted_with_a_named_degradation(plain):
    ok, report = infra_detect.check_pg_capabilities(plain["dsn"])
    assert ok is True, report["reason"]
    assert report["degradations"] == [infra_detect.DEGRADATION_PG_SEARCH_ABSENT]
    assert report["preferred_missing"] == ["pg_search"]
    assert report["lexical_engine"] == infra_detect.LEXICAL_POSTGRES_FTS
    assert report["lexical_engine_reason"] == infra_detect.LEXICAL_FALLBACK_SENTENCE
    assert report["reason"] is None, "a degradation is not a rejection"
    assert "***" in report["url"] or "@" not in report["url"], "the DSN must be masked"


@pytest.mark.integration
def test_a_paradedb_server_reports_the_bm25_engine_and_no_degradation(paradedb):
    ok, report = infra_detect.check_pg_capabilities(paradedb["dsn"])
    assert ok is True, report["reason"]
    assert report["degradations"] == []
    assert report["lexical_engine"] == infra_detect.LEXICAL_PG_SEARCH
    assert "pg_search" in report["lexical_engine_reason"]


@pytest.mark.integration
def test_a_server_without_vector_is_still_rejected(plain):
    """`vector` is genuinely required: the rejection path is intact."""
    ok, report = infra_detect.check_pg_capabilities(
        plain["dsn"], required_extensions=("vector", "definitely_not_an_extension"))
    assert ok is False
    assert "definitely_not_an_extension" in report["reason"]


@pytest.mark.integration
def test_the_mutation_proves_the_split_is_load_bearing(plain):
    """Put pg_search back in REQUIRED_EXTENSIONS: the plain database is refused again."""
    ok, report = infra_detect.check_pg_capabilities(
        plain["dsn"], required_extensions=("vector", "pg_search"))
    assert ok is False, (
        "the plain database passed even with pg_search required — the accept "
        "above proves nothing"
    )
    assert "pg_search" in report["reason"]


# ═══════════════════════════════════════════════════════════════════════════
# 6. One resolver, and the start path untouched
# ═══════════════════════════════════════════════════════════════════════════

@pytest.mark.integration
def test_the_resolver_names_the_right_engine_on_each_database(both):
    import psycopg2

    for engine, db in both.items():
        conn = psycopg2.connect(db["dsn"], connect_timeout=10)
        try:
            infra_detect.reset_lexical_engine_cache()
            answer = infra_detect.lexical_engine(conn)
        finally:
            conn.close()
        assert answer["lexical_engine"] == engine
        assert answer["reason"], "an engine with no sentence is a silent divergence"


# ═══════════════════════════════════════════════════════════════════════════
# 7. `doctor` and `/health` say which engine answered — through 89-09's hooks
# ═══════════════════════════════════════════════════════════════════════════

def test_the_row_arrives_through_the_hook_not_through_an_edit():
    """Plan 89-09 built the hooks so this plan edits neither reader."""
    from services import report_hooks

    assert "_89_06_reporting" in report_hooks.PROVIDER_MODULES
    rows = report_hooks.extra_doctor_rows({"GSD_FORCE_SQLITE": "1"})
    assert report_hooks.DEGRADED_KEY not in dict(
        (r[1], r) for r in rows), "the provider raised"


def test_the_provider_reports_nothing_rather_than_guessing():
    """SQLite, or no DSN at all: there is no engine to name."""
    from services import _89_06_reporting as reporting

    reporting.reset_cache()
    assert reporting.health_fragment({"GSD_FORCE_SQLITE": "1"}) is None
    assert reporting.doctor_rows({"GSD_FORCE_SQLITE": "1"}) is None
    reporting.reset_cache()
    assert reporting.health_fragment({}) is None, "no DSN must not be a guess"
    assert reporting.doctor_rows({}) is None


@pytest.mark.integration
def test_doctor_warns_on_the_plain_engine_and_is_ok_on_paradedb(both):
    from services import _89_06_reporting as reporting
    from services import report_hooks

    expected = {"postgres_fts": report_hooks.STATUS_WARN,
                "pg_search_bm25": report_hooks.STATUS_OK}
    for engine, db in both.items():
        reporting.reset_cache()
        rows = reporting.doctor_rows({"GSD_POSTGRES_URL": db["dsn"]})
        assert rows and len(rows) == 1, rows
        status, category, detail, data = rows[0]
        assert status == expected[engine], (engine, status, detail)
        assert category == reporting.DOCTOR_CATEGORY
        assert data["lexical_engine"] == engine
        if engine == "postgres_fts":
            assert detail == infra_detect.LEXICAL_FALLBACK_SENTENCE, detail


@pytest.mark.integration
def test_health_carries_the_same_answer_under_a_stable_key(both):
    from services import _89_06_reporting as reporting
    from services import report_hooks

    for engine, db in both.items():
        reporting.reset_cache()
        section = report_hooks.extra_health_rows({"GSD_POSTGRES_URL": db["dsn"]})
        assert report_hooks.DEGRADED_KEY not in section, section
        fragment = section[reporting.HEALTH_KEY]
        assert fragment["lexical_engine"] == engine
        assert fragment["degraded"] is (engine != "pg_search_bm25")
        # Both readers read ONE resolver: same engine, same sentence.
        doctor_detail = reporting.doctor_rows(
            {"GSD_POSTGRES_URL": db["dsn"]})[0][2]
        assert fragment["reason"] == doctor_detail


@pytest.mark.integration
def test_the_report_never_carries_a_dsn_or_a_password(both):
    for engine, db in both.items():
        from services import _89_06_reporting as reporting

        reporting.reset_cache()
        rows = reporting.doctor_rows({"GSD_POSTGRES_URL": db["dsn"]})
        blob = repr(rows)
        assert "gsd:gsd@" not in blob, "a credential reached a doctor row"
        assert db["dsn"] not in blob


def test_this_plan_does_not_touch_the_container_start_path():
    """Changing `auto_start` is plan 89-11's; this plan only moved an extension."""
    source = (_REPO / "services" / "infra_detect.py").read_text(encoding="utf-8")
    assert "def detect_infrastructure(auto_start=True):" in source
    assert '"up", "-d", "postgres"' in source

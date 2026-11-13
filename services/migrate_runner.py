#!/usr/bin/env python3
"""Tracked PostgreSQL migration runner for GSD-Amauta.

Replaces two broken paths:

  * ``docker/docker-compose.yml`` mounted ONLY migrations 001-005 into
    ``/docker-entrypoint-initdb.d`` — those five ran once, on first volume
    creation, and never again. The other 23 were somebody else's problem.
  * ``bin/init.cjs`` shelled out to the host's ``psql`` for every ``*.sql``
    file with no tracking table, swallowed every failure as "already applied",
    and reported a green ``pass`` as long as at least one file succeeded.

This runner:

  * records each applied file in ``schema_migrations`` (filename, sha256
    checksum, applied_at, duration) so a re-run is a genuine no-op;
  * applies each pending UP file inside ITS OWN transaction — a failure rolls
    that file back and stops, instead of leaving a half-applied file behind;
  * never applies a DOWN file (``NNN-name-DOWN.sql`` — see ``is_down_file``);
  * exits non-zero with the file name, SQLSTATE and message on any failure;
  * supports ``--status``, ``--dry-run`` and ``--baseline``;
  * detects a database migrated by the old untracked path and says so.

Usage:
    python3 services/migrate_runner.py              # apply pending
    python3 services/migrate_runner.py --status
    python3 services/migrate_runner.py --dry-run
    python3 services/migrate_runner.py --baseline   # record, do not execute
    python3 services/migrate_runner.py --dsn postgresql://...
"""

import argparse
import hashlib
import os
import re
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from services.pg_dsn import local_docker_dsn, mask_dsn, require_dsn
except ImportError:  # pragma: no cover - script-launched from services/
    from pg_dsn import local_docker_dsn, mask_dsn, require_dsn

try:
    from services import backup_guard
    from services.backup_snapshot import dsn_fingerprint
except ImportError:  # pragma: no cover - script-launched from services/
    import backup_guard
    from backup_snapshot import dsn_fingerprint

DEFAULT_MIGRATIONS_DIR = os.path.join(_REPO_ROOT, "migrations")

#: ``NNN-slug.sql`` is an UP migration; ``NNN-slug-DOWN.sql`` is its rollback.
#: The repo has one DOWN file per UP file and the runner must never touch them.
UP_FILE_RE = re.compile(r"^(\d{3,})-(?!.*-DOWN\.sql$).+\.sql$", re.IGNORECASE)
DOWN_FILE_RE = re.compile(r"-DOWN\.sql$", re.IGNORECASE)

TRACKING_TABLE = "schema_migrations"

#: Any one of these relations existing means the DB already carries GSD schema.
#: Used to recognise a database migrated by the old untracked psql loop.
LEGACY_SENTINELS = ("gsd_memory", "gsd_tasks", "gsd_shared_kb")

# ══════════════════════════════════════════════════════════════════
# Schema sentinels — "is this migration already applied?"
# ══════════════════════════════════════════════════════════════════
#
# The real target database was migrated by the old untracked psql loop up to
# SOME migration and then abandoned for SQLite. It has no schema_migrations
# table, so the runner has to work out what is already there by looking at the
# schema, not by assuming all-or-nothing.
#
# Each entry lists objects that exist IF AND ONLY IF that migration ran. A
# migration counts as already applied only when EVERY sentinel is satisfied;
# anything else stays pending and is applied normally (every UP file is
# idempotent, so a false "pending" costs time, not data).
#
# Why this matters beyond speed: 003-embedding-1024.sql contains
#   UPDATE gsd_memory SET embedding = NULL WHERE embedding IS NOT NULL;
# inside a guard that fires when gsd_memory.embedding is not already
# vector(1024). Its sentinel is exactly that column type, so on a database
# whose 5 267 embeddings are already vector(1024) the file is recognised as
# applied and never re-entered. 025 likewise DROPs and rebuilds a BM25 index
# over gsd_memory, and 012's bm25 index covers 164 311 rlm_chunks rows —
# both expensive to redo for nothing.
#
# Sentinel kinds:
#   ("relation", name)                  -- table/index/view exists
#   ("norelation", name)                -- table/index/view does NOT exist
#   ("column", table, column)           -- column exists
#   ("extension", name)                 -- extension installed
#   ("coltype", table, column, type)    -- column has exactly this format_type
#   ("unbounded", table, column)        -- column has no length limit (TEXT)
#   ("ifext", ext, when_present, when_absent_or_None)
#                                       -- evaluate ONE of two inner sentinels,
#                                          by whether `ext` is installed here
#
# "norelation" exists for a DROP migration (Phase 89 plan 89-05, migration 032).
# Every other kind asserts that something the file CREATED is there; a file whose
# whole job is a DROP is detectable only by the absence of what it dropped.
#
# "ifext" exists because a migration can now create DIFFERENT objects on two
# engines (Phase 89 / decision D3, plan 89-06). 011, 012 and 025 each create a
# pg_search BM25 index where the extension is installed and nothing where it is
# not -- 033 then creates a plain-PostgreSQL substitute instead. A sentinel that
# names only the BM25 index therefore reads "not applied" forever on a
# pg_search-less database, which is a PRE-EXISTING DEFECT this plan fixes:
# MIGRATION_SENTINELS["025-memory-hybrid-index.sql"] has required
# ("relation", "idx_gsd_memory_bm25") since Phase 66 even though
# 025-memory-hybrid-index.sql:35-46 SKIPS that very index when pg_search is
# absent, so detect_applied_by_schema / auto_baseline is wrong on such a
# database today, before this plan changes anything
# (tests/test_89_06_pg_search_optional.py proves it against master's dict).
#
# WHY A SENTINEL KIND AND NOT A SENTINEL LIST BUILT FROM THE CONNECTION:
# building the list per connection would move the condition out of this table,
# and this table is the thing a reader checks against a migration file. The
# condition stays declarative and next to what it guards, MIGRATION_SENTINELS
# stays a static, importable, unit-testable dict (tests/test_89_02_decimal_phase
# and tests/test_89_05_inbox_round_trip both read it without a database), and
# `_sentinel_satisfied` keeps being the only place a sentinel is evaluated.
#
# The test is `pg_extension` -- installed in THIS database -- never
# `pg_available_extensions` and never 011's `gsd.lexical_engine` opt-out: what
# decides which objects exist is which branch of the guard RAN, and that is
# exactly what `pg_extension` records. (Mixed state: a database that had
# pg_search when it was migrated and was pinned to the plain leg afterwards
# keeps its BM25 indexes, so the "present" branch is still the right one.)
MIGRATION_SENTINELS = {
    "001-init.sql": [
        ("relation", "gsd_memory"), ("relation", "gsd_shared_kb"),
        ("relation", "gsd_tasks"), ("relation", "gsd_task_validations"),
        ("relation", "gitflow_log"),
    ],
    "002-embedding-index.sql": [("relation", "idx_gsd_memory_embedding_hnsw")],
    # The DO block's own guard condition — see the note above.
    "003-embedding-1024.sql": [
        ("coltype", "gsd_memory", "embedding", "vector(1024)"),
        ("relation", "idx_gsd_memory_embedding_hnsw"),
    ],
    "004-fulltext-indexes.sql": [
        ("relation", "idx_gsd_memory_fts"), ("relation", "idx_gsd_skb_fts"),
        ("relation", "idx_gsd_task_validations_task_created"),
        ("relation", "idx_gsd_tasks_project_status"),
    ],
    "005-agent-performance.sql": [("relation", "gsd_agent_performance")],
    "006-audit-log.sql": [("relation", "gsd_audit_log")],
    "007-task-fields.sql": [
        ("column", "gsd_tasks", "doc_refs"), ("column", "gsd_tasks", "risks"),
        ("column", "gsd_tasks", "validation_checklist"),
        ("column", "gsd_tasks", "estimated_hours"),
        ("column", "gsd_tasks", "due_date"), ("column", "gsd_tasks", "sprint"),
        ("column", "gsd_tasks", "children"),
    ],
    "008-applied-count.sql": [("column", "gsd_memory", "applied_count")],
    "009-rpetd-context.sql": [("relation", "rpetd_context")],
    "010-semantic-cache.sql": [("relation", "semantic_cache")],
    # Phase 89 plan 89-06 (D3). bm25_test_table is created UNCONDITIONALLY by
    # 011 and by nothing else, so it carries the "011 ran" fact on both
    # engines. The extension and its smoke index are the pg_search half: where
    # the extension is installed they must both be there (an index USING bm25
    # cannot exist without it, which is why the old explicit
    # ("extension", "pg_search") row is now redundant rather than dropped);
    # where it is not, 011 skipped them with a RAISE NOTICE and there is
    # nothing to find. bm25_test_idx gets no 033 substitute -- see 033's header.
    "011-paradedb-setup.sql": [
        ("relation", "bm25_test_table"),
        ("ifext", "pg_search", ("relation", "bm25_test_idx"), None),
    ],
    # Phase 89 plan 89-06 (D3): 012's TABLE is unconditional; its lexical index
    # is idx_rlm_chunks_bm25 with pg_search and 033's idx_rlm_chunks_fts
    # without, so the sentinel names whichever one this engine should have.
    "012-rlm-chunks.sql": [
        ("relation", "rlm_chunks"),
        ("ifext", "pg_search",
         ("relation", "idx_rlm_chunks_bm25"), ("relation", "idx_rlm_chunks_fts")),
    ],
    "013-code-embeddings.sql": [("column", "rlm_chunks", "embedding_code")],
    "014-agent-findings.sql": [("relation", "agent_findings")],
    "015-agent-messages.sql": [("relation", "agent_messages")],
    "016-agent-metrics.sql": [("relation", "agent_metrics")],
    "017-step-handoffs.sql": [("relation", "step_handoffs")],
    "018-task-completions.sql": [("relation", "task_completions")],
    "019-skill-invocations.sql": [("relation", "skill_invocations")],
    "020-agent-findings-hydration.sql": [
        ("column", "agent_findings", "recipient_agent"),
        ("column", "agent_findings", "severity"),
    ],
    "021-party-sessions.sql": [
        ("relation", "party_sessions"),
        ("column", "agent_findings", "session_id"),
    ],
    "022-module-installs.sql": [("relation", "module_installs")],
    "023-party-decisions.sql": [("column", "agent_findings", "decision_type")],
    # Phase 89 plan 89-05 (ORC-02). 024 CREATED a2a_messages and 032 DROPS it, so
    # the pair shares ONE sentinel: "the table is absent". 024's old
    # ("relation", "a2a_messages") was only correct while nothing dropped the
    # table -- after 032, a database at the intended end state would have read
    # 024 as NOT applied, which is the hazard this change removes. The key stays
    # (024 is still on disk, and tests/test_docker_pg_migration.py's
    # TestSentinelsUnit requires an entry for every file on disk); only its
    # meaning moves to the post-032 state.
    #
    # Correct in all three database shapes, which
    # tests/test_89_05_inbox_round_trip.py asserts against a real server:
    #   * table present (a pre-089 database): both pending -> 024's
    #     CREATE TABLE IF NOT EXISTS is a no-op, 032 drops it. Converges.
    #   * table absent, both already run: both applied. Nothing to do.
    #   * table absent, neither ever run (a database baselined before 024
    #     existed): both recorded as applied without running, and the end state
    #     is identical to running them.
    "024-a2a-messages.sql": [("norelation", "a2a_messages")],
    # Phase 89 plan 89-06 (D3) fixes the pre-existing defect described in the
    # "ifext" note above: 025 itself skips idx_gsd_memory_bm25 when pg_search
    # is absent (025-memory-hybrid-index.sql:35-46), so requiring that index
    # unconditionally made this entry unsatisfiable on exactly the databases
    # Phase 89 exists to support. pg_trgm stays unconditional -- 025 is the only
    # file in migrations/ that creates it, and it creates it on every engine.
    "025-memory-hybrid-index.sql": [
        ("extension", "pg_trgm"),
        ("ifext", "pg_search",
         ("relation", "idx_gsd_memory_bm25"),
         ("relation", "idx_gsd_memory_fts_fallback")),
    ],
    "026-bitemporal-memory.sql": [
        ("column", "gsd_memory", "valid_at"),
        ("column", "gsd_memory", "invalid_at"),
    ],
    "027-audit-findings.sql": [
        ("column", "agent_findings", "rule_id"),
        ("column", "agent_findings", "dedup_key"),
    ],
    "028-task-project-backfill.sql": [("relation", "gsd_task_project_backfill")],
    "029-sqlite-import-compat.sql": [
        ("relation", "gsd_memory_archive"),
        ("unbounded", "gsd_tasks", "title"),
    ],
    "030-rlm-chunk-provenance.sql": [
        ("column", "rlm_chunks", "embedding_model"),
        ("column", "rlm_chunks", "file_mtime"),
        ("column", "rlm_chunks", "file_size"),
    ],
    # Phase 89 plan 89-02 (FND-11). A "column" sentinel cannot see this migration:
    # both columns already existed as INTEGER, so only the TYPE says whether 031 ran.
    # The two strings are `format_type(atttypid, atttypmod)`, which is what
    # `_sentinel_satisfied`'s "coltype" branch compares against; they are asserted
    # from the catalogue in tests/test_89_02_decimal_phase.py rather than guessed.
    "031-decimal-phase-number.sql": [
        ("coltype", "step_handoffs", "phase_number", "numeric(10,3)"),
        ("coltype", "task_completions", "phase_number", "numeric(10,3)"),
    ],
    # Phase 89 plan 89-05 (ORC-02): the same sentinel as 024, for the reason
    # written there. A DROP migration is detectable only by the absence of what
    # it dropped.
    "032-drop-a2a-messages.sql": [("norelation", "a2a_messages")],
    # Phase 89 plan 89-06 (D3). 033 creates the plain-PostgreSQL substitutes
    # where pg_search is absent and NOTHING where it is present -- a ParadeDB
    # database comes out of it byte-unchanged. So on ParadeDB the only
    # observable is the absence of both substitutes, which is what the inverted
    # branch says; the "norelation" pair is the same device 024/032 use for a
    # file whose effect on this engine is nil.
    "033-plain-fts-fallback.sql": [
        ("ifext", "pg_search",
         ("norelation", "idx_rlm_chunks_fts"), ("relation", "idx_rlm_chunks_fts")),
        ("ifext", "pg_search",
         ("norelation", "idx_gsd_memory_fts_fallback"),
         ("relation", "idx_gsd_memory_fts_fallback")),
    ],
}


def _sentinel_satisfied(cur, sentinel):
    """Evaluate one sentinel spec against the live catalog."""
    kind = sentinel[0]
    if kind == "ifext":
        # Phase 89 plan 89-06: pick the branch this engine should satisfy. A
        # None branch means "this engine creates nothing here", which is
        # satisfied by definition -- never a silent False.
        _kind, ext, when_present, when_absent = sentinel
        inner = (when_present if _sentinel_satisfied(cur, ("extension", ext))
                 else when_absent)
        if inner is None:
            return True
        return _sentinel_satisfied(cur, inner)
    if kind == "relation":
        cur.execute("SELECT to_regclass(%s) IS NOT NULL", (sentinel[1],))
        return bool(cur.fetchone()[0])
    if kind == "norelation":
        # The inverse, for a migration whose job is a DROP (plan 89-05's 032).
        cur.execute("SELECT to_regclass(%s) IS NULL", (sentinel[1],))
        return bool(cur.fetchone()[0])
    if kind == "column":
        cur.execute("""
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = %s AND column_name = %s
        """, (sentinel[1], sentinel[2]))
        return cur.fetchone() is not None
    if kind == "extension":
        cur.execute("SELECT 1 FROM pg_extension WHERE extname = %s", (sentinel[1],))
        return cur.fetchone() is not None
    if kind == "coltype":
        cur.execute("""
            SELECT format_type(a.atttypid, a.atttypmod)
            FROM pg_attribute a
            WHERE a.attrelid = to_regclass(%s) AND a.attname = %s
              AND a.attnum > 0 AND NOT a.attisdropped
        """, (sentinel[1], sentinel[2]))
        row = cur.fetchone()
        return bool(row) and row[0] == sentinel[3]
    if kind == "unbounded":
        cur.execute("""
            SELECT character_maximum_length IS NULL
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = %s AND column_name = %s
        """, (sentinel[1], sentinel[2]))
        row = cur.fetchone()
        return bool(row) and bool(row[0])
    raise ValueError(f"unknown sentinel kind: {kind!r}")


def detect_applied_by_schema(conn, migrations_dir=DEFAULT_MIGRATIONS_DIR):
    """Which migrations the live schema says are already applied.

    Returns ``(applied, unknown)``: filenames whose every sentinel is
    satisfied, and filenames with no sentinel entry (those are never assumed
    applied — they stay pending).
    """
    applied, unknown = [], []
    with conn.cursor() as cur:
        for filename, _path, _digest in discover_migrations(migrations_dir):
            sentinels = MIGRATION_SENTINELS.get(filename)
            if not sentinels:
                unknown.append(filename)
                continue
            if all(_sentinel_satisfied(cur, s) for s in sentinels):
                applied.append(filename)
    return applied, unknown


class MigrationError(RuntimeError):
    """Raised when a migration file fails to apply."""

    def __init__(self, filename, message, sqlstate=None):
        self.filename = filename
        self.sqlstate = sqlstate
        super().__init__(message)


def is_down_file(filename):
    """True when *filename* is a rollback (DOWN) migration."""
    return bool(DOWN_FILE_RE.search(filename))


def checksum(text):
    """SHA-256 of a migration file's contents (newline-normalised)."""
    return hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()


def discover_migrations(migrations_dir=DEFAULT_MIGRATIONS_DIR):
    """Return ordered ``[(filename, path, checksum)]`` for every UP migration.

    Ordering is by the numeric prefix, then filename, so ``009`` precedes
    ``010`` (plain lexicographic sort of zero-padded names agrees, but the
    numeric key keeps working if anyone ever adds a 4-digit prefix).
    """
    if not os.path.isdir(migrations_dir):
        raise FileNotFoundError(f"migrations directory not found: {migrations_dir}")
    found = []
    for name in os.listdir(migrations_dir):
        if is_down_file(name):
            continue
        match = UP_FILE_RE.match(name)
        if not match:
            continue
        path = os.path.join(migrations_dir, name)
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
        found.append((int(match.group(1)), name, path, checksum(text)))
    found.sort(key=lambda row: (row[0], row[1]))
    return [(name, path, digest) for _, name, path, digest in found]


def _connect(dsn):
    import psycopg2

    conn = psycopg2.connect(dsn, connect_timeout=10)
    conn.autocommit = False
    return conn


def ensure_tracking_table(conn):
    """Create ``schema_migrations`` if missing. Idempotent."""
    with conn.cursor() as cur:
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS {TRACKING_TABLE} (
                filename    TEXT PRIMARY KEY,
                checksum    CHAR(64) NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                duration_ms INTEGER,
                baselined   BOOLEAN NOT NULL DEFAULT FALSE
            )
        """)
    conn.commit()


def tracking_table_exists(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass(%s) IS NOT NULL", (TRACKING_TABLE,))
        return bool(cur.fetchone()[0])


def looks_pre_migrated(conn):
    """True when GSD tables exist but nothing was ever tracked.

    That is the fingerprint of the old ``bin/init.cjs`` psql loop. Reported so
    an operator knows why ``--status`` shows everything pending; the runner
    still re-applies, because every UP file in this repo is idempotent.
    """
    with conn.cursor() as cur:
        for relation in LEGACY_SENTINELS:
            cur.execute("SELECT to_regclass(%s) IS NOT NULL", (relation,))
            if cur.fetchone()[0]:
                return True
    return False


def applied_migrations(conn):
    """Return ``{filename: {checksum, applied_at, baselined}}``."""
    if not tracking_table_exists(conn):
        return {}
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT filename, checksum, applied_at, baselined FROM {TRACKING_TABLE}"
        )
        return {
            row[0]: {"checksum": row[1], "applied_at": row[2], "baselined": row[3]}
            for row in cur.fetchall()
        }


def _record(conn, filename, digest, duration_ms, baselined):
    with conn.cursor() as cur:
        cur.execute(
            f"""
            INSERT INTO {TRACKING_TABLE}
                (filename, checksum, applied_at, duration_ms, baselined)
            VALUES (%s, %s, NOW(), %s, %s)
            ON CONFLICT (filename) DO UPDATE
                SET checksum = EXCLUDED.checksum,
                    applied_at = EXCLUDED.applied_at,
                    duration_ms = EXCLUDED.duration_ms,
                    baselined = EXCLUDED.baselined
            """,
            (filename, digest, duration_ms, baselined),
        )


def plan(conn, migrations_dir=DEFAULT_MIGRATIONS_DIR):
    """Return ``(pending, already, drifted)`` lists of ``(filename, path, checksum)``.

    ``drifted`` holds files whose on-disk checksum no longer matches what was
    recorded — an edited, already-applied migration. Those are reported, not
    re-run: silently re-executing an edited migration is how data gets lost.
    """
    discovered = discover_migrations(migrations_dir)
    done = applied_migrations(conn)
    pending, already, drifted = [], [], []
    for filename, path, digest in discovered:
        record = done.get(filename)
        if record is None:
            pending.append((filename, path, digest))
        elif record["checksum"] != digest:
            drifted.append((filename, path, digest))
            already.append((filename, path, digest))
        else:
            already.append((filename, path, digest))
    return pending, already, drifted


def auto_baseline(conn, migrations_dir=DEFAULT_MIGRATIONS_DIR, dry_run=False,
                  log=print, dsn=None, backups_dir=None,
                  allow_stale_backup=False, no_backup_check=False, env=None):
    """Record, as applied, the migrations the live schema already satisfies.

    Called once on a database that carries GSD schema but has no tracking
    table — the fingerprint of the old untracked psql loop, which is exactly
    the state of the real ``gsd-pg-data`` volume. Returns the list of
    filenames baselined.

    Plan 89-04: baselining WRITES ``schema_migrations`` rows, so it is a
    data-touching step and the backup guard applies — except under
    ``dry_run``, which records nothing and is never gated.

    Args:
        conn: an open connection.
        migrations_dir: where the migration files live.
        dry_run: classify without recording; never gated.
        log: a line sink.
        dsn: the target DSN, for the guard's fingerprint and the override row.
        backups_dir: where the guard looks for snapshots.
        allow_stale_backup: accept an older snapshot, and record that.
        no_backup_check: skip the guard, print the consequence, record it.
        env: the environment to read.

    Returns:
        list[str]: the filenames baselined.

    Raises:
        backup_guard.BackupRequired: when the guard is armed and no verified
            snapshot newer than 24 hours covers this database.
    """
    if not dry_run:
        backup_guard.require_recent_backup(
            step="migrations", backups_dir=backups_dir,
            dsn_fingerprint=dsn_fingerprint(dsn) if dsn else None,
            env=env, allow_stale_backup=allow_stale_backup,
            no_backup_check=no_backup_check, dsn=dsn, log=log)
    detected, unknown = detect_applied_by_schema(conn, migrations_dir)
    for filename in unknown:
        log(f"  NOTE  {filename} has no schema sentinel — treated as pending")
    if not dry_run and detected:
        digests = {n: d for n, _, d in discover_migrations(migrations_dir)}
        for filename in detected:
            _record(conn, filename, digests[filename], 0, True)
        conn.commit()
    return detected


def apply_migrations(dsn=None, migrations_dir=DEFAULT_MIGRATIONS_DIR,
                     dry_run=False, baseline=False, auto_baseline_enabled=True,
                     log=print, backups_dir=None, allow_stale_backup=False,
                     no_backup_check=False, env=None):
    """Apply every pending UP migration, each in its own transaction.

    Args:
        baseline: record EVERY pending migration as applied without running it.
        auto_baseline_enabled: on an untracked database that already carries
            GSD schema, record the migrations whose schema sentinels are all
            satisfied (see MIGRATION_SENTINELS) and apply only the rest.
            Default True. Pass False to apply every file regardless.
        backups_dir: where the backup guard looks for snapshots.
        allow_stale_backup: accept a snapshot older than 24 hours, and record
            that override in the audit log and the install record.
        no_backup_check: skip the guard entirely; prints the full consequence
            sentence and records the override.
        env: the environment the guard reads.

    Returns a result dict. Raises :class:`MigrationError` on the first failure
    (after rolling that file back); earlier files stay applied and recorded.

    Raises:
        backup_guard.BackupRequired: when the guard is armed and no verified
            snapshot newer than 24 hours covers this database. The refusal is
            typed and names the one command that fixes it.

    Plan 89-04: the guard runs HERE — after the DSN is resolved and **before
    the first BEGIN**, so a refusal has not even opened a connection, let alone
    started a transaction. ``dry_run`` is never gated.
    """
    dsn = require_dsn(dsn, component="migrate_runner")
    if not dry_run:
        backup_guard.require_recent_backup(
            step="migrations", backups_dir=backups_dir,
            dsn_fingerprint=dsn_fingerprint(dsn), env=env,
            allow_stale_backup=allow_stale_backup,
            no_backup_check=no_backup_check, dsn=dsn, log=log)
    conn = _connect(dsn)
    try:
        pre_migrated = looks_pre_migrated(conn) and not tracking_table_exists(conn)
        if not dry_run:
            ensure_tracking_table(conn)

        baselined = []
        if pre_migrated and auto_baseline_enabled and not baseline:
            log(
                "NOTE: this database carries GSD tables but has no "
                "schema_migrations — it was migrated by the old untracked psql "
                "loop. Inspecting the schema to work out which migrations are "
                "already applied."
            )
            baselined = auto_baseline(conn, migrations_dir, dry_run=dry_run,
                                      log=log, dsn=dsn,
                                      backups_dir=backups_dir,
                                      allow_stale_backup=allow_stale_backup,
                                      no_backup_check=no_backup_check, env=env)
            log(f"  baselined from schema: {len(baselined)} migration(s)"
                + (f" (through {baselined[-1]})" if baselined else ""))

        pending, already, drifted = (
            plan(conn, migrations_dir) if tracking_table_exists(conn)
            else (discover_migrations(migrations_dir), [], [])
        )
        if dry_run and pre_migrated and auto_baseline_enabled and not baseline:
            # Nothing was recorded, so subtract the detected set by hand.
            detected = set(baselined)
            already = [row for row in pending if row[0] in detected]
            pending = [row for row in pending if row[0] not in detected]

        result = {
            "dsn": mask_dsn(dsn),
            "total": len(pending) + len(already),
            "already_applied": len(already),
            "pending": [name for name, _, _ in pending],
            "applied": [],
            "baselined": baselined,
            "drifted": [name for name, _, _ in drifted],
            "dry_run": dry_run,
            "baseline": baseline,
            "pre_migrated_detected": pre_migrated,
        }

        for name in result["drifted"]:
            log(f"WARN: {name} changed on disk after it was applied — not re-run.")

        if dry_run:
            for name, _, _ in pending:
                log(f"  would apply  {name}")
            return result

        for filename, path, digest in pending:
            with open(path, "r", encoding="utf-8") as handle:
                sql = handle.read()
            if baseline:
                _record(conn, filename, digest, 0, True)
                conn.commit()
                result["applied"].append(filename)
                log(f"  baselined    {filename}")
                continue
            started = time.time()
            try:
                with conn.cursor() as cur:
                    cur.execute(sql)
                duration_ms = int((time.time() - started) * 1000)
                _record(conn, filename, digest, duration_ms, False)
                conn.commit()
            except Exception as exc:  # noqa: BLE001 - re-raised as MigrationError
                conn.rollback()
                sqlstate = getattr(exc, "pgcode", None)
                detail = str(exc).strip().splitlines()
                message = detail[0] if detail else repr(exc)
                raise MigrationError(
                    filename,
                    f"migration {filename} FAILED "
                    f"(sqlstate={sqlstate or 'n/a'}): {message}",
                    sqlstate,
                ) from exc
            result["applied"].append(filename)
            log(f"  applied      {filename}  ({duration_ms} ms)")

        if not pending:
            log("  nothing to do — all migrations already applied")
        return result
    finally:
        try:
            conn.close()
        except Exception:
            pass


def status(dsn=None, migrations_dir=DEFAULT_MIGRATIONS_DIR):
    """Return a status dict without changing anything."""
    dsn = require_dsn(dsn, component="migrate_runner")
    conn = _connect(dsn)
    try:
        tracked = tracking_table_exists(conn)
        pre_migrated = looks_pre_migrated(conn) and not tracked
        detected_by_schema = []
        if tracked:
            pending, already, drifted = plan(conn, migrations_dir)
        else:
            pending, already, drifted = discover_migrations(migrations_dir), [], []
            if pre_migrated:
                # Report what an `apply` would auto-baseline, without writing.
                detected_by_schema, _unknown = detect_applied_by_schema(
                    conn, migrations_dir)
                detected = set(detected_by_schema)
                already = [row for row in pending if row[0] in detected]
                pending = [row for row in pending if row[0] not in detected]
        return {
            "dsn": mask_dsn(dsn),
            "tracking_table": tracked,
            "pre_migrated_detected": pre_migrated,
            "detected_by_schema": detected_by_schema,
            "total": len(pending) + len(already),
            "applied": [name for name, _, _ in already],
            "pending": [name for name, _, _ in pending],
            "drifted": [name for name, _, _ in drifted],
        }
    finally:
        try:
            conn.close()
        except Exception:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Apply tracked PostgreSQL migrations for GSD-Amauta."
    )
    parser.add_argument("--dsn", default=None,
                        help="PostgreSQL DSN. Default: GSD_POSTGRES_URL, DATABASE_URL or "
                             "AMAUTA_MEMORY_DATABASE_URL. With none set the command refuses "
                             "to guess a database (see services/pg_dsn.py).")
    parser.add_argument("--local-docker", action="store_true",
                        help="Target this project's own Docker PostgreSQL "
                             "(127.0.0.1:$GSD_PG_PORT, default 5433) explicitly.")
    parser.add_argument("--migrations-dir", default=DEFAULT_MIGRATIONS_DIR)
    parser.add_argument("--status", action="store_true",
                        help="Print applied/pending migrations and exit 0.")
    parser.add_argument("--dry-run", action="store_true",
                        help="List what would be applied; change nothing.")
    parser.add_argument("--baseline", action="store_true",
                        help="Record ALL pending migrations as applied WITHOUT "
                             "running them.")
    parser.add_argument("--no-auto-baseline", action="store_true",
                        help="On an untracked database, do not infer which "
                             "migrations are already applied from the schema — "
                             "apply every file (safe but slow: rebuilds BM25 "
                             "indexes).")
    parser.add_argument("--backups-dir", default=None,
                        help="Where the backup guard looks for verified "
                             "snapshots. Default: the backup module's own "
                             "resolution (AMAUTA_DATA_DIR/backups, else "
                             "<home>/.amauta/backups).")
    parser.add_argument("--allow-stale-backup", action="store_true",
                        help="Proceed with a verified snapshot OLDER than 24 "
                             "hours. Explicit, and recorded in the audit log "
                             "and the install record as last_override.")
    parser.add_argument("--no-backup-check", action="store_true",
                        help="Disable the backup guard for this run. Prints "
                             "the full consequence sentence and records the "
                             "override. --dry-run and --status are never "
                             "gated, so neither needs this flag.")
    parser.add_argument("--json", action="store_true", help="Machine-readable output.")
    args = parser.parse_args(argv)
    if args.local_docker and not args.dsn:
        args.dsn = local_docker_dsn()

    import json as _json

    # With --json, stdout must contain ONLY the JSON document: bin/init.cjs
    # parses it. Progress lines go to stderr.
    def log(message):
        print(message, file=sys.stderr if args.json else sys.stdout)

    try:
        if args.status:
            payload = status(args.dsn, args.migrations_dir)
            if args.json:
                print(_json.dumps(payload, indent=2, default=str))
            else:
                print(f"DSN:      {payload['dsn']}")
                print(f"tracked:  {payload['tracking_table']}")
                if payload["pre_migrated_detected"]:
                    print("NOTE:     pre-existing GSD schema with no tracking "
                          "table — the listing below is what the schema says")
                    print(f"          schema says applied: "
                          f"{len(payload['detected_by_schema'])}")
                print(f"applied:  {len(payload['applied'])}/{payload['total']}")
                for name in payload["pending"]:
                    print(f"  pending  {name}")
                for name in payload["drifted"]:
                    print(f"  DRIFTED  {name}")
            return 0

        result = apply_migrations(
            dsn=args.dsn,
            migrations_dir=args.migrations_dir,
            dry_run=args.dry_run,
            baseline=args.baseline,
            auto_baseline_enabled=not args.no_auto_baseline,
            log=log,
            backups_dir=args.backups_dir,
            allow_stale_backup=args.allow_stale_backup,
            no_backup_check=args.no_backup_check,
        )
        if args.json:
            print(_json.dumps(result, indent=2, default=str))
        else:
            print(
                f"migrations: {len(result['applied'])} applied, "
                f"{result['already_applied']} already applied "
                f"({len(result['baselined'])} baselined from schema), "
                f"{len(result['drifted'])} drifted"
            )
        return 0
    except backup_guard.BackupRequired as exc:
        # Plan 89-04: a typed refusal, so bin/init.cjs (plan 89-11) and the
        # cutover can branch on the payload rather than on a message.
        if args.json:
            print(_json.dumps(exc.payload, indent=2, default=str))
        print(f"ERROR: {exc.payload['message']}", file=sys.stderr)
        return 1
    except MigrationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - top-level CLI guard
        print(f"ERROR: migration runner failed: {exc}", file=sys.stderr)
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

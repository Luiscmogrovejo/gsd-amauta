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
#   ("column", table, column)           -- column exists
#   ("extension", name)                 -- extension installed
#   ("coltype", table, column, type)    -- column has exactly this format_type
#   ("unbounded", table, column)        -- column has no length limit (TEXT)
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
    "011-paradedb-setup.sql": [
        ("extension", "pg_search"), ("relation", "bm25_test_table"),
        ("relation", "bm25_test_idx"),
    ],
    "012-rlm-chunks.sql": [
        ("relation", "rlm_chunks"), ("relation", "idx_rlm_chunks_bm25"),
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
    "024-a2a-messages.sql": [("relation", "a2a_messages")],
    "025-memory-hybrid-index.sql": [
        ("extension", "pg_trgm"), ("relation", "idx_gsd_memory_bm25"),
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
}


def _sentinel_satisfied(cur, sentinel):
    """Evaluate one sentinel spec against the live catalog."""
    kind = sentinel[0]
    if kind == "relation":
        cur.execute("SELECT to_regclass(%s) IS NOT NULL", (sentinel[1],))
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
                  log=print):
    """Record, as applied, the migrations the live schema already satisfies.

    Called once on a database that carries GSD schema but has no tracking
    table — the fingerprint of the old untracked psql loop, which is exactly
    the state of the real ``gsd-pg-data`` volume. Returns the list of
    filenames baselined.
    """
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
                     log=print):
    """Apply every pending UP migration, each in its own transaction.

    Args:
        baseline: record EVERY pending migration as applied without running it.
        auto_baseline_enabled: on an untracked database that already carries
            GSD schema, record the migrations whose schema sentinels are all
            satisfied (see MIGRATION_SENTINELS) and apply only the rest.
            Default True. Pass False to apply every file regardless.

    Returns a result dict. Raises :class:`MigrationError` on the first failure
    (after rolling that file back); earlier files stay applied and recorded.
    """
    dsn = require_dsn(dsn, component="migrate_runner")
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
                                      log=log)
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

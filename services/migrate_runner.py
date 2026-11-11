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
    from services.pg_dsn import mask_dsn, resolve_dsn
except ImportError:  # pragma: no cover - script-launched from services/
    from pg_dsn import mask_dsn, resolve_dsn

DEFAULT_MIGRATIONS_DIR = os.path.join(_REPO_ROOT, "migrations")

#: ``NNN-slug.sql`` is an UP migration; ``NNN-slug-DOWN.sql`` is its rollback.
#: The repo has one DOWN file per UP file and the runner must never touch them.
UP_FILE_RE = re.compile(r"^(\d{3,})-(?!.*-DOWN\.sql$).+\.sql$", re.IGNORECASE)
DOWN_FILE_RE = re.compile(r"-DOWN\.sql$", re.IGNORECASE)

TRACKING_TABLE = "schema_migrations"

#: Any one of these relations existing means the DB already carries GSD schema.
#: Used for baseline detection only — never to skip an individual migration.
LEGACY_SENTINELS = ("gsd_memory", "gsd_tasks", "gsd_shared_kb")


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


def apply_migrations(dsn=None, migrations_dir=DEFAULT_MIGRATIONS_DIR,
                     dry_run=False, baseline=False, log=print):
    """Apply every pending UP migration, each in its own transaction.

    Returns a result dict. Raises :class:`MigrationError` on the first failure
    (after rolling that file back); earlier files stay applied and recorded.
    """
    dsn = resolve_dsn(dsn)
    conn = _connect(dsn)
    try:
        pre_migrated = looks_pre_migrated(conn) and not tracking_table_exists(conn)
        if not dry_run:
            ensure_tracking_table(conn)
        pending, already, drifted = (
            plan(conn, migrations_dir) if tracking_table_exists(conn)
            else (discover_migrations(migrations_dir), [], [])
        )

        result = {
            "dsn": mask_dsn(dsn),
            "total": len(pending) + len(already),
            "already_applied": len(already),
            "pending": [name for name, _, _ in pending],
            "applied": [],
            "drifted": [name for name, _, _ in drifted],
            "dry_run": dry_run,
            "baseline": baseline,
            "pre_migrated_detected": pre_migrated,
        }

        if pre_migrated:
            log(
                "NOTE: this database has GSD tables but no schema_migrations — "
                "it was migrated by the old untracked psql loop. Every UP file "
                "in migrations/ is idempotent, so re-applying is safe; use "
                "--baseline to record them as applied without executing."
            )
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
    dsn = resolve_dsn(dsn)
    conn = _connect(dsn)
    try:
        tracked = tracking_table_exists(conn)
        pre_migrated = looks_pre_migrated(conn) and not tracked
        if tracked:
            pending, already, drifted = plan(conn, migrations_dir)
        else:
            pending, already, drifted = discover_migrations(migrations_dir), [], []
        return {
            "dsn": mask_dsn(dsn),
            "tracking_table": tracked,
            "pre_migrated_detected": pre_migrated,
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
                        help="PostgreSQL DSN (default: services/pg_dsn.py resolution)")
    parser.add_argument("--migrations-dir", default=DEFAULT_MIGRATIONS_DIR)
    parser.add_argument("--status", action="store_true",
                        help="Print applied/pending migrations and exit 0.")
    parser.add_argument("--dry-run", action="store_true",
                        help="List what would be applied; change nothing.")
    parser.add_argument("--baseline", action="store_true",
                        help="Record pending migrations as applied WITHOUT running "
                             "them (for a DB already migrated by the old psql loop).")
    parser.add_argument("--json", action="store_true", help="Machine-readable output.")
    args = parser.parse_args(argv)

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
                    print("NOTE:     pre-existing GSD schema with no tracking table")
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
            log=log,
        )
        if args.json:
            print(_json.dumps(result, indent=2, default=str))
        else:
            print(
                f"migrations: {len(result['applied'])} applied, "
                f"{result['already_applied']} already applied, "
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
    sys.exit(main())

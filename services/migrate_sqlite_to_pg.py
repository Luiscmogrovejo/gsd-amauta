#!/usr/bin/env python3
"""Copy a GSD-Amauta SQLite database into PostgreSQL. Re-runnable.

The SQLite file is opened READ-ONLY (``file:...?mode=ro``) and is never
written, so it stays a usable fallback if the Postgres move is abandoned.

What it copies: every table that exists on BOTH sides. For the live database
that is gsd_memory, gsd_memory_archive, gsd_shared_kb, gsd_tasks,
gsd_task_validations and gsd_audit_log; gsd_agent_performance is copied too on
installs that have it. SQLite FTS5 shadow tables (``*_fts``, ``*_fts_data``,
...) are skipped — Postgres builds its own full-text and BM25 indexes from the
migrations.

What it does NOT do: embeddings. No embedding API is called and no vector
column is written. Imported rows land with ``embedding IS NULL`` and are
picked up afterwards by::

    gsd-memory backfill-embeddings --batch-size 500

(repeat until it reports ``remaining: 0``).

Idempotency: every INSERT carries the source primary key and uses
``ON CONFLICT (id) DO NOTHING``, so a second run inserts nothing and reports
every row as skipped. SERIAL sequences are fast-forwarded past the imported
ids so the next natural INSERT does not collide.

Exit status: 0 only when every row was inserted or already present AND the
post-copy verification finds every source primary key in Postgres. Any failed
row or missing key exits 1.

Usage:
    python3 services/migrate_sqlite_to_pg.py --dry-run
    python3 services/migrate_sqlite_to_pg.py
    python3 services/migrate_sqlite_to_pg.py \
        --sqlite ~/.amauta/data/gsd_amauta.db \
        --dsn postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta
"""

import argparse
import json
import os
import sqlite3
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

try:
    from services.pg_dsn import mask_dsn, resolve_dsn
    from services.pg_store import PGStore
except ImportError:  # pragma: no cover - script-launched from services/
    from pg_dsn import mask_dsn, resolve_dsn
    from pg_store import PGStore

DEFAULT_SQLITE_PATH = os.path.join(
    os.environ.get("GSD_DATA_DIR", os.path.expanduser("~/.amauta/data")),
    "gsd_amauta.db",
)

#: Copy order matters only for readability — there are no FK constraints
#: between these tables in 001-init.sql, so a failure in one does not cascade.
PREFERRED_ORDER = (
    "gsd_memory",
    "gsd_memory_archive",
    "gsd_shared_kb",
    "gsd_tasks",
    "gsd_task_validations",
    "gsd_audit_log",
    "gsd_agent_performance",
)

#: SQLite internals and FTS5 shadow tables — never copied.
SKIP_SUFFIXES = ("_fts", "_fts_config", "_fts_data", "_fts_docsize",
                 "_fts_idx", "_fts_content", "_fts_idx_segments")

#: Postgres types where SQLite's empty string is not a valid value.
_EMPTY_IS_NULL_TYPES = (
    "timestamp with time zone", "timestamp without time zone", "date", "time",
    "integer", "bigint", "smallint", "numeric", "real", "double precision",
    "boolean", "uuid",
)


def open_sqlite_readonly(path):
    """Open *path* strictly read-only. Raises if the file does not exist."""
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isfile(path):
        raise FileNotFoundError(f"SQLite database not found: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def sqlite_tables(conn):
    """User tables in the SQLite database, FTS shadow tables excluded."""
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    names = []
    for (name,) in cur.fetchall():
        if name.startswith("sqlite_"):
            continue
        if any(name.endswith(suffix) for suffix in SKIP_SUFFIXES):
            continue
        names.append(name)
    return names


def sqlite_columns(conn, table):
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]


def pg_columns(store, table):
    """``{column: data_type}`` for *table* in Postgres, {} when absent."""
    with store._get_conn() as conn:
        return dict(store._table_columns(conn, table))


def common_tables(sqlite_conn, store):
    """Ordered list of tables present on both sides."""
    present = set(sqlite_tables(sqlite_conn))
    ordered = [t for t in PREFERRED_ORDER if t in present]
    ordered += sorted(present - set(ordered))
    return [t for t in ordered if pg_columns(store, t)]


def normalise_row(row, columns):
    """SQLite row -> dict ready for the Postgres importer.

    * empty strings become NULL for non-text destination columns (SQLite is
      happy to store '' in a date column; Postgres is not);
    * JSON columns are left as the stored JSON *text*, which the importer
      casts with ``::jsonb``;
    * 0/1 integers become booleans where the destination says boolean.
    """
    out = {}
    for key in row.keys():
        pg_type = columns.get(key)
        if pg_type is None:
            continue  # column does not exist on the Postgres side
        value = row[key]
        if value == "" and pg_type in _EMPTY_IS_NULL_TYPES:
            value = None
        elif pg_type == "boolean" and isinstance(value, int):
            value = bool(value)
        out[key] = value
    return out


def copy_table(sqlite_conn, store, table, pk="id", batch_size=500,
               dry_run=False, mode="merge"):
    """Copy one table. Returns a per-table stats dict."""
    columns = pg_columns(store, table)
    src_columns = set(sqlite_columns(sqlite_conn, table))
    shared = [c for c in columns if c in src_columns]
    dropped = sorted(src_columns - set(columns))
    source_count = sqlite_conn.execute(
        f"SELECT COUNT(*) FROM {table}"
    ).fetchone()[0]

    stats = {
        "table": table,
        "source": source_count,
        "inserted": 0,
        "skipped": 0,
        "failed": 0,
        "failures": [],
        "columns_copied": shared,
        "columns_dropped": dropped,
    }
    if dry_run or source_count == 0:
        return stats

    cursor = sqlite_conn.execute(f"SELECT * FROM {table}")
    while True:
        chunk = cursor.fetchmany(batch_size)
        if not chunk:
            break
        rows = [normalise_row(row, columns) for row in chunk]
        result = store._import_rows(table, rows, mode=mode, conflict_column=pk)
        stats["inserted"] += int(result)
        stats["skipped"] += getattr(result, "skipped", 0)
        stats["failed"] += getattr(result, "failed", 0)
        stats["failures"].extend(getattr(result, "failures", [])[:20])
        # Only replace on the FIRST batch, otherwise batch 2 truncates batch 1.
        mode = "merge"
    stats["failures"] = stats["failures"][:20]
    return stats


def verify_table(sqlite_conn, store, table, pk="id", batch_size=1000):
    """Check that every source primary key is now present in Postgres.

    A plain row-count comparison would pass while rows were silently swapped
    or dropped against pre-existing data, so the key set is what is checked.
    """
    if pk not in pg_columns(store, table):
        return {"table": table, "checked": 0, "missing": 0,
                "missing_ids": [], "note": f"no {pk} column — not verified"}
    ids = [row[0] for row in sqlite_conn.execute(f"SELECT {pk} FROM {table}")]
    missing = []
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            for start in range(0, len(ids), batch_size):
                batch = ids[start:start + batch_size]
                cur.execute(
                    f"SELECT {pk} FROM {table} WHERE {pk} = ANY(%s)", (batch,)
                )
                found = {row[0] for row in cur.fetchall()}
                missing.extend(i for i in batch if i not in found)
    return {
        "table": table,
        "checked": len(ids),
        "missing": len(missing),
        "missing_ids": [str(i) for i in missing[:20]],
    }


def migrate(sqlite_path=DEFAULT_SQLITE_PATH, dsn=None, dry_run=False,
            mode="merge", tables=None, batch_size=500, log=print):
    """Run the whole copy. Returns ``(ok, report)``."""
    dsn = resolve_dsn(dsn)
    sqlite_conn = open_sqlite_readonly(sqlite_path)
    store = PGStore(dsn=dsn, min_conn=1, max_conn=4)
    try:
        selected = tables or common_tables(sqlite_conn, store)
        report = {
            "sqlite": os.path.abspath(os.path.expanduser(sqlite_path)),
            "dsn": mask_dsn(dsn),
            "mode": mode,
            "dry_run": dry_run,
            "tables": [],
            "verification": [],
            "ok": True,
        }
        skipped_tables = [
            t for t in sqlite_tables(sqlite_conn) if t not in selected
        ]
        report["tables_skipped"] = skipped_tables

        for table in selected:
            stats = copy_table(sqlite_conn, store, table, batch_size=batch_size,
                               dry_run=dry_run, mode=mode)
            report["tables"].append(stats)
            if stats["failed"]:
                report["ok"] = False

        if not dry_run:
            for table in selected:
                check = verify_table(sqlite_conn, store, table)
                report["verification"].append(check)
                if check["missing"]:
                    report["ok"] = False

        _print_report(report, log)
        return report["ok"], report
    finally:
        try:
            sqlite_conn.close()
        except Exception:
            pass
        try:
            store.close()
        except Exception:
            pass


def _print_report(report, log):
    log("")
    log(f"SQLite : {report['sqlite']}")
    log(f"Postgres: {report['dsn']}")
    if report["dry_run"]:
        log("DRY RUN — nothing was written")
    log("")
    header = f"{'table':<26}{'source':>9}{'inserted':>10}{'skipped':>9}{'failed':>8}"
    log(header)
    log("-" * len(header))
    totals = {"source": 0, "inserted": 0, "skipped": 0, "failed": 0}
    for stats in report["tables"]:
        log(f"{stats['table']:<26}{stats['source']:>9}{stats['inserted']:>10}"
            f"{stats['skipped']:>9}{stats['failed']:>8}")
        for key in totals:
            totals[key] += stats[key]
        if stats["columns_dropped"]:
            log(f"{'':<26}  columns absent in Postgres, not copied: "
                f"{', '.join(stats['columns_dropped'])}")
        for failure in stats["failures"]:
            log(f"{'':<26}  FAILED id={failure.get('id')!r}: {failure.get('error')}")
    log("-" * len(header))
    log(f"{'TOTAL':<26}{totals['source']:>9}{totals['inserted']:>10}"
        f"{totals['skipped']:>9}{totals['failed']:>8}")
    if report.get("tables_skipped"):
        log(f"\nnot copied (no matching Postgres table): "
            f"{', '.join(report['tables_skipped'])}")
    if report["verification"]:
        log("\nverification (every source primary key present in Postgres):")
        for check in report["verification"]:
            state = "OK" if not check["missing"] else f"MISSING {check['missing']}"
            log(f"  {check['table']:<26}{check['checked']:>9} keys  {state}")
            if check["missing_ids"]:
                log(f"    first missing ids: {', '.join(check['missing_ids'])}")
    log("")
    log("RESULT: " + ("OK" if report["ok"] else "FAILED"))
    if report["ok"] and not report["dry_run"]:
        log("Embeddings were NOT generated. Next step:")
        log("  gsd-memory backfill-embeddings --batch-size 500   "
            "(repeat until remaining: 0)")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Copy a GSD-Amauta SQLite database into PostgreSQL."
    )
    parser.add_argument("--sqlite", default=DEFAULT_SQLITE_PATH,
                        help=f"SQLite file (default {DEFAULT_SQLITE_PATH})")
    parser.add_argument("--dsn", default=None,
                        help="PostgreSQL DSN (default: services/pg_dsn.py resolution)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report source counts and column mapping; write nothing.")
    parser.add_argument("--mode", choices=("merge", "replace"), default="merge",
                        help="merge (default, ON CONFLICT DO NOTHING) or replace "
                             "(TRUNCATE each table first — destructive).")
    parser.add_argument("--table", action="append", dest="tables",
                        help="Copy only this table (repeatable).")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--json", action="store_true",
                        help="Print the report as JSON instead of a table.")
    args = parser.parse_args(argv)

    collected = []
    log = collected.append if args.json else print
    try:
        ok, report = migrate(
            sqlite_path=args.sqlite, dsn=args.dsn, dry_run=args.dry_run,
            mode=args.mode, tables=args.tables, batch_size=args.batch_size,
            log=log,
        )
    except Exception as exc:  # noqa: BLE001 - top-level CLI guard
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, indent=2, default=str))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

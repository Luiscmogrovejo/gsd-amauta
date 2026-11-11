#!/usr/bin/env python3
"""MERGE a GSD-Amauta SQLite database into PostgreSQL. Re-runnable.

The real target is NOT an empty database. The ``gsd-pg-data`` volume was the
main backend until late September (gsd_memory ~5 615 rows, 5 267 of them with
embeddings; gsd_shared_kb ~768; gsd_tasks ~2 599; rlm_chunks ~164 311) and the
daemon has been on SQLite since. This command therefore merges newer SQLite
rows INTO a populated database rather than loading a fresh one.

The SQLite file is opened READ-ONLY (``file:...?mode=ro``) and is never
written, so it stays a usable fallback if the Postgres move is abandoned.

MERGE RULES
-----------
Same primary key on both sides -> **the PostgreSQL row always wins.** The
command only ever INSERTs; it never UPDATEs or DELETEs. Consequences, all
deliberate:

  * an existing embedding can never be nulled out — the row is not touched;
  * a row is never duplicated — the insert carries the source id and uses
    ``ON CONFLICT (id) DO NOTHING``;
  * where the two sides disagree the SQLite value is NOT silently discarded:
    the row is reported as a **conflict** with the differing column and both
    values, and the run exits non-zero unless ``--allow-conflicts`` is given.

"Disagree" is judged on a small per-table identity column set (see
``TABLE_POLICY``) rather than on every column, because SQLite stores
timestamps as text and JSON as strings, and comparing those formats across the
two engines produces noise, not findings. For gsd_tasks the identity column is
``title`` — exactly the "same TK-nnnn, different task" case.

Same content under a DIFFERENT id (the daemon may have re-issued ids after
falling back to SQLite) is detected by content hash for the tables where
content is meaningfully unique — gsd_memory, gsd_memory_archive and
gsd_shared_kb. It is REPORTED by default and inserted anyway;
``--skip-content-duplicates`` omits those rows instead. gsd_tasks has no
content key: task titles repeat legitimately, so a title hash would produce
false positives. Task divergence is covered by the id-conflict report.

What it does NOT do: embeddings. No embedding API is called and no vector
column is written. Inserted rows land with ``embedding IS NULL`` and are
picked up afterwards by::

    gsd-memory backfill-embeddings --batch-size 500

(repeat until it reports ``remaining: 0``). As a guard, the number of
PostgreSQL rows holding an embedding is counted before and after; a decrease
fails the run.

Exit status: 0 only when nothing failed, every source primary key is present
in PostgreSQL afterwards, no embedding was lost, and either there were no
conflicts or ``--allow-conflicts`` was passed.

Usage:
    python3 services/migrate_sqlite_to_pg.py --dry-run        # full merge plan
    python3 services/migrate_sqlite_to_pg.py --exclude-table gsd_tasks
    python3 services/migrate_sqlite_to_pg.py --allow-conflicts
    python3 services/migrate_sqlite_to_pg.py \
        --sqlite ~/.amauta/data/gsd_amauta.db \
        --dsn postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta

NOTE ON TASKS: data/tasks.json is the source of truth for tasks and the
database is a mirror of it. Migrating gsd_tasks out of SQLite therefore copies
a mirror into a mirror. Prefer ``--exclude-table gsd_tasks`` and let the
daemon re-mirror from tasks.json; use the gsd_tasks conflict report to decide.
"""

import argparse
import hashlib
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

#: Per-table merge policy.
#:
#: ``identity``  columns compared when the same primary key exists on both
#:               sides. A difference is a CONFLICT, reported and (by default)
#:               fatal. Deliberately small: timestamps are text in SQLite and
#:               timestamptz in Postgres, and JSON is text vs jsonb, so
#:               comparing every column reports formatting, not divergence.
#: ``content``   columns hashed to spot the same content under a different id.
#:               None disables the check for that table.
TABLE_POLICY = {
    "gsd_memory": {"pk": "id", "identity": ("text",), "content": ("text",)},
    "gsd_memory_archive": {"pk": "id", "identity": ("text",), "content": ("text",)},
    "gsd_shared_kb": {"pk": "id", "identity": ("title", "content"),
                      "content": ("title", "content")},
    # No content key: task titles legitimately repeat ("Update docs"), so a
    # title hash would manufacture duplicates. The id-conflict report is what
    # covers diverged tasks.
    "gsd_tasks": {"pk": "id", "identity": ("title",), "content": None},
    "gsd_task_validations": {"pk": "id",
                             "identity": ("task_id", "validator_id", "status"),
                             "content": None},
    "gsd_audit_log": {"pk": "id", "identity": ("task_id", "event_type"),
                      "content": None},
    "gsd_agent_performance": {"pk": "id",
                              "identity": ("agent_id", "task_id", "outcome"),
                              "content": None},
}

DEFAULT_POLICY = {"pk": "id", "identity": None, "content": None}

#: Tables whose rows carry an embedding that must never be lost.
EMBEDDING_TABLES = ("gsd_memory", "gsd_memory_archive")


def table_policy(table):
    policy = dict(DEFAULT_POLICY)
    policy.update(TABLE_POLICY.get(table, {}))
    return policy


def content_hash(values):
    """Stable hash of a row's content columns. md5 — dedup, not security."""
    joined = "\x1f".join("" if v is None else str(v) for v in values)
    return hashlib.md5(joined.encode("utf-8")).hexdigest()


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


def _comparable(value):
    """Normalise a value for identity comparison across the two engines."""
    if value is None:
        return ""
    return str(value).strip()


def _pg_content_index(store, table, content_columns):
    """``{content_hash: first pg id}`` for an existing Postgres table."""
    if not content_columns:
        return {}
    select = ", ".join(content_columns)
    index = {}
    with store._get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT id, {select} FROM {table}")
            for row in cur:
                digest = content_hash([_comparable(v) for v in row[1:]])
                index.setdefault(digest, row[0])
    return index


def plan_table(sqlite_conn, store, table, batch_size=500,
               skip_content_duplicates=False, max_examples=20):
    """Classify every source row without writing anything.

    Returns ``(plan, rows_to_insert)``. ``plan`` counts, per table:
      insert            — primary key absent from Postgres
      identical         — primary key present and the identity columns agree
      conflict          — primary key present and an identity column differs
      content_duplicate — would be inserted, but identical content already
                          exists in Postgres under a different id
    """
    policy = table_policy(table)
    pk = policy["pk"]
    columns = pg_columns(store, table)
    src_columns = set(sqlite_columns(sqlite_conn, table))
    shared = [c for c in columns if c in src_columns]
    dropped = sorted(src_columns - set(columns))
    identity = [c for c in (policy["identity"] or ())
                if c in columns and c in src_columns]
    content_columns = [c for c in (policy["content"] or ())
                       if c in columns and c in src_columns]
    source_count = sqlite_conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    plan = {
        "table": table,
        "source": source_count,
        "insert": 0,
        "identical": 0,
        "conflict": 0,
        "content_duplicate": 0,
        "conflicts": [],
        "duplicates": [],
        "skipped_duplicate_ids": [],
        "identity_columns": identity,
        "content_columns": content_columns,
        "columns_copied": shared,
        "columns_dropped": dropped,
        "pg_before": _count(store, table),
        "inserted": 0,
        "skipped": 0,
        "failed": 0,
        "failures": [],
    }
    if source_count == 0 or pk not in columns:
        if pk not in columns:
            plan["note"] = f"no {pk} column in Postgres — table not merged"
        return plan, []

    content_index = _pg_content_index(store, table, content_columns)
    seen_this_run = {}
    to_insert = []

    cursor = sqlite_conn.execute(f"SELECT * FROM {table}")
    while True:
        chunk = cursor.fetchmany(batch_size)
        if not chunk:
            break
        rows = [normalise_row(row, columns) for row in chunk]
        ids = [r.get(pk) for r in rows if r.get(pk) is not None]
        existing = {}
        if ids:
            select = ", ".join([pk] + identity) if identity else pk
            with store._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        f"SELECT {select} FROM {table} WHERE {pk} = ANY(%s)", (ids,)
                    )
                    for row in cur:
                        existing[row[0]] = row[1:]

        for row in rows:
            row_id = row.get(pk)
            if row_id in existing:
                differences = [
                    {"column": column,
                     "sqlite": _comparable(row.get(column))[:120],
                     "postgres": _comparable(value)[:120]}
                    for column, value in zip(identity, existing[row_id])
                    if _comparable(row.get(column)) != _comparable(value)
                ]
                if differences:
                    plan["conflict"] += 1
                    if len(plan["conflicts"]) < max_examples:
                        plan["conflicts"].append({"id": row_id,
                                                  "differences": differences})
                else:
                    plan["identical"] += 1
                continue

            if content_columns:
                digest = content_hash(
                    [_comparable(row.get(c)) for c in content_columns])
                match = content_index.get(digest) or seen_this_run.get(digest)
                if match is not None:
                    plan["content_duplicate"] += 1
                    if len(plan["duplicates"]) < max_examples:
                        plan["duplicates"].append(
                            {"id": row_id, "same_content_as": match})
                    if skip_content_duplicates:
                        plan["skipped_duplicate_ids"].append(row_id)
                        continue
                else:
                    seen_this_run[digest] = row_id

            plan["insert"] += 1
            to_insert.append(row)

    return plan, to_insert


def apply_plan(store, table, rows, plan, batch_size=500, mode="merge"):
    """Insert the planned rows. Never updates, never deletes."""
    policy = table_policy(table)
    pk = policy["pk"]
    for start in range(0, len(rows), batch_size):
        batch = rows[start:start + batch_size]
        # 'replace' only makes sense on the very first batch.
        batch_mode = mode if start == 0 else "merge"
        result = store._import_rows(table, batch, mode=batch_mode,
                                    conflict_column=pk)
        plan["inserted"] += int(result)
        plan["skipped"] += getattr(result, "skipped", 0)
        plan["failed"] += getattr(result, "failed", 0)
        plan["failures"].extend(getattr(result, "failures", []))
    plan["failures"] = plan["failures"][:20]
    plan["pg_after"] = _count(store, table)
    return plan


def _count(store, table, where=""):
    try:
        with store._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT COUNT(*) FROM {table} {where}")
                return cur.fetchone()[0]
    except Exception:
        return None


def embedding_census(store):
    """``{table: rows holding an embedding}`` — the never-lose-this guard."""
    census = {}
    for table in EMBEDDING_TABLES:
        if "embedding" in pg_columns(store, table):
            census[table] = _count(store, table, "WHERE embedding IS NOT NULL")
    return census


def verify_table(sqlite_conn, store, table, pk="id", batch_size=1000,
                 expected_missing=()):
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
    # Rows deliberately omitted by --skip-content-duplicates are not losses.
    expected = set(expected_missing or ())
    unexpected = [i for i in missing if i not in expected]
    return {
        "table": table,
        "checked": len(ids),
        "skipped_on_purpose": len(missing) - len(unexpected),
        "missing": len(unexpected),
        "missing_ids": [str(i) for i in unexpected[:20]],
    }


def migrate(sqlite_path=DEFAULT_SQLITE_PATH, dsn=None, dry_run=False,
            mode="merge", tables=None, exclude_tables=(), batch_size=500,
            skip_content_duplicates=False, allow_conflicts=False, log=print):
    """Plan and (unless dry_run) apply the merge. Returns ``(ok, report)``."""
    dsn = resolve_dsn(dsn)
    sqlite_conn = open_sqlite_readonly(sqlite_path)
    store = PGStore(dsn=dsn, min_conn=1, max_conn=4)
    try:
        selected = [t for t in (tables or common_tables(sqlite_conn, store))
                    if t not in set(exclude_tables or ())]
        report = {
            "sqlite": os.path.abspath(os.path.expanduser(sqlite_path)),
            "dsn": mask_dsn(dsn),
            "mode": mode,
            "dry_run": dry_run,
            "skip_content_duplicates": skip_content_duplicates,
            "allow_conflicts": allow_conflicts,
            "tables": [],
            "verification": [],
            "embeddings_before": embedding_census(store),
            "embeddings_after": {},
            "total_conflicts": 0,
            "ok": True,
        }
        report["tables_skipped"] = [
            t for t in sqlite_tables(sqlite_conn) if t not in selected
        ]

        # ── Plan: read-only classification of every source row ──────────
        planned = []
        for table in selected:
            plan, rows = plan_table(
                sqlite_conn, store, table, batch_size=batch_size,
                skip_content_duplicates=skip_content_duplicates)
            planned.append((plan, rows))
            report["tables"].append(plan)
            report["total_conflicts"] += plan["conflict"]

        # ── Apply ───────────────────────────────────────────────────────
        if not dry_run:
            for plan, rows in planned:
                apply_plan(store, plan["table"], rows, plan,
                           batch_size=batch_size, mode=mode)
                if plan["failed"]:
                    report["ok"] = False

            for plan, _rows in planned:
                check = verify_table(
                    sqlite_conn, store, plan["table"],
                    pk=table_policy(plan["table"])["pk"],
                    expected_missing=plan["skipped_duplicate_ids"])
                report["verification"].append(check)
                if check["missing"]:
                    report["ok"] = False

            report["embeddings_after"] = embedding_census(store)
            for table, before in report["embeddings_before"].items():
                after = report["embeddings_after"].get(table)
                if before is not None and after is not None and after < before:
                    report["ok"] = False
                    report.setdefault("errors", []).append(
                        f"{table}: embedded rows went {before} -> {after}"
                    )

        if report["total_conflicts"] and not allow_conflicts:
            report["ok"] = False
            report.setdefault("errors", []).append(
                f"{report['total_conflicts']} id conflict(s) — the PostgreSQL "
                f"rows were kept. Review them, then re-run with "
                f"--allow-conflicts to accept keeping the PostgreSQL side."
            )

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
    log(f"SQLite  : {report['sqlite']}")
    log(f"Postgres: {report['dsn']}")
    log("MERGE PLAN (nothing written)" if report["dry_run"]
        else "MERGE (PostgreSQL rows always win; inserts only)")
    log("")
    header = (f"{'table':<24}{'sqlite':>8}{'pg_before':>11}{'insert':>8}"
              f"{'same':>7}{'conflict':>10}{'dup':>6}{'failed':>8}")
    log(header)
    log("-" * len(header))
    totals = dict.fromkeys(
        ("source", "insert", "identical", "conflict", "content_duplicate",
         "failed"), 0)
    for plan in report["tables"]:
        log(f"{plan['table']:<24}{plan['source']:>8}"
            f"{str(plan.get('pg_before')):>11}{plan['insert']:>8}"
            f"{plan['identical']:>7}{plan['conflict']:>10}"
            f"{plan['content_duplicate']:>6}{plan['failed']:>8}")
        for key in totals:
            totals[key] += plan.get(key, 0)
        if plan.get("note"):
            log(f"{'':<24}  {plan['note']}")
        if plan["columns_dropped"]:
            log(f"{'':<24}  columns absent in Postgres, not copied: "
                f"{', '.join(plan['columns_dropped'])}")
    log("-" * len(header))
    log(f"{'TOTAL':<24}{totals['source']:>8}{'':>11}{totals['insert']:>8}"
        f"{totals['identical']:>7}{totals['conflict']:>10}"
        f"{totals['content_duplicate']:>6}{totals['failed']:>8}")
    if not report["dry_run"]:
        inserted = sum(p.get("inserted", 0) for p in report["tables"])
        log(f"{'rows actually inserted':<24}{inserted:>8}")

    for plan in report["tables"]:
        if plan["conflict"]:
            log(f"\nCONFLICTS in {plan['table']} "
                f"({plan['conflict']}; same id, different "
                f"{'/'.join(plan['identity_columns'])}) — PostgreSQL kept:")
            for item in plan["conflicts"]:
                for difference in item["differences"]:
                    log(f"  {item['id']}  {difference['column']}:")
                    log(f"      sqlite  : {difference['sqlite']}")
                    log(f"      postgres: {difference['postgres']}")
            if plan["conflict"] > len(plan["conflicts"]):
                log(f"  ... and {plan['conflict'] - len(plan['conflicts'])} more")
        if plan["content_duplicate"]:
            verb = "SKIPPED" if report["skip_content_duplicates"] else "INSERTED ANYWAY"
            log(f"\nLIKELY DUPLICATES in {plan['table']} "
                f"({plan['content_duplicate']}; same "
                f"{'+'.join(plan['content_columns'])} under a different id) "
                f"— {verb}:")
            for item in plan["duplicates"][:10]:
                log(f"  {item['id']}  same content as {item['same_content_as']}")
            if plan["content_duplicate"] > len(plan["duplicates"][:10]):
                log(f"  ... and "
                    f"{plan['content_duplicate'] - len(plan['duplicates'][:10])} more"
                    f" (use --skip-content-duplicates to omit them)")
        for failure in plan["failures"]:
            log(f"  FAILED {plan['table']} id={failure.get('id')!r}: "
                f"{failure.get('error')}")

    if report.get("tables_skipped"):
        log(f"\nnot merged (no matching Postgres table, or excluded): "
            f"{', '.join(report['tables_skipped'])}")
    if report["verification"]:
        log("\nverification (every source primary key present in Postgres):")
        for check in report["verification"]:
            state = "OK" if not check["missing"] else f"MISSING {check['missing']}"
            log(f"  {check['table']:<24}{check['checked']:>8} keys  {state}")
            if check["missing_ids"]:
                log(f"    first missing ids: {', '.join(check['missing_ids'])}")
    if report["embeddings_before"]:
        log("\nembedding guard (rows holding a vector):")
        for table, before in report["embeddings_before"].items():
            after = report["embeddings_after"].get(table, "-")
            log(f"  {table:<24}before={before}  after={after}")
    for message in report.get("errors", []):
        log(f"\nERROR: {message}")
    log("")
    log("RESULT: " + ("OK" if report["ok"] else "FAILED"))
    if not report["dry_run"] and report["ok"]:
        log("Embeddings were NOT generated for the inserted rows. Next step:")
        log("  gsd-memory backfill-embeddings --batch-size 500   "
            "(repeat until remaining: 0)")



def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Merge a GSD-Amauta SQLite database into PostgreSQL. "
                    "PostgreSQL rows always win; this command only inserts."
    )
    parser.add_argument("--sqlite", default=DEFAULT_SQLITE_PATH,
                        help=f"SQLite file (default {DEFAULT_SQLITE_PATH})")
    parser.add_argument("--dsn", default=None,
                        help="PostgreSQL DSN (default: services/pg_dsn.py resolution)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print the full merge plan (insert / identical / "
                             "conflict / duplicate per table) and write nothing.")
    parser.add_argument("--mode", choices=("merge", "replace"), default="merge",
                        help="merge (default: insert what is missing) or replace "
                             "(TRUNCATE each table first — DESTROYS the rows "
                             "PostgreSQL already has; needs --allow-truncate).")
    parser.add_argument("--allow-truncate", action="store_true",
                        help="Required confirmation for --mode replace.")
    parser.add_argument("--table", action="append", dest="tables",
                        help="Merge only this table (repeatable).")
    parser.add_argument("--exclude-table", action="append", dest="exclude_tables",
                        default=[],
                        help="Skip this table (repeatable). Consider "
                             "`--exclude-table gsd_tasks`: data/tasks.json is the "
                             "source of truth for tasks and the DB is its mirror.")
    parser.add_argument("--skip-content-duplicates", action="store_true",
                        help="Do not insert a row whose content already exists in "
                             "PostgreSQL under a different id (gsd_memory, "
                             "gsd_memory_archive, gsd_shared_kb).")
    parser.add_argument("--allow-conflicts", action="store_true",
                        help="Exit 0 even when rows share an id but differ. The "
                             "PostgreSQL row is kept either way; without this "
                             "flag a conflict is a non-zero exit so it gets read.")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--json", action="store_true",
                        help="Print the report as JSON instead of a table.")
    args = parser.parse_args(argv)

    if args.mode == "replace" and not args.allow_truncate:
        print("ERROR: --mode replace TRUNCATEs every selected table, destroying "
              "rows that exist only in PostgreSQL (including every embedding). "
              "Pass --allow-truncate if that is really what you want.",
              file=sys.stderr)
        return 2

    collected = []
    log = collected.append if args.json else print
    try:
        ok, report = migrate(
            sqlite_path=args.sqlite, dsn=args.dsn, dry_run=args.dry_run,
            mode=args.mode, tables=args.tables,
            exclude_tables=args.exclude_tables,
            batch_size=args.batch_size,
            skip_content_duplicates=args.skip_content_duplicates,
            allow_conflicts=args.allow_conflicts,
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

#!/usr/bin/env python3
"""
Purge test/synthetic data from gsd_memory and gsd_shared_kb.

Usage:
    python scripts/purge-test-data.py            # dry-run (default)
    python scripts/purge-test-data.py --execute   # actually delete

The script connects to PostgreSQL using GSD_POSTGRES_URL (or default),
identifies test entries via conservative AND-combined patterns,
and deletes them in a single transaction.

Idempotent: running twice with --execute produces 0 additional deletions.
"""

import argparse
import os
import sys
from urllib.parse import urlparse

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 is required. Install with: pip install psycopg2-binary")
    sys.exit(1)


# ─── Connection ───────────────────────────────────────────────────────

def get_connection():
    """Connect to PostgreSQL using GSD_POSTGRES_URL or default."""
    url = os.environ.get(
        "GSD_POSTGRES_URL",
        "postgresql://luismogrovejo@127.0.0.1:5432/gsd_amauta",
    )
    parsed = urlparse(url)
    params = {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 5432,
        "dbname": parsed.path.lstrip("/") or "gsd_amauta",
    }
    if parsed.username:
        params["user"] = parsed.username
    if parsed.password:
        params["password"] = parsed.password

    conn = psycopg2.connect(**params)
    conn.autocommit = False
    return conn


# ─── Pattern definitions ─────────────────────────────────────────────

# gsd_memory purge patterns (ordered most-specific first)
MEMORY_PATTERNS = [
    {
        "name": "source=distilled (corrupted re-merged artifacts)",
        "where": "source = 'distilled'",
    },
    {
        "name": "TK-0001 (synthetic test task)",
        "where": "text LIKE '%TK-0001%'",
    },
    {
        "name": "E2E-LIFECYCLE (E2E lifecycle entries)",
        "where": "text LIKE '%E2E-LIFECYCLE%'",
    },
    {
        "name": "E2E offline test",
        "where": "text LIKE '%E2E offline test%'",
    },
    {
        "name": "Integration test alpha",
        "where": "text LIKE '%Integration test alpha%'",
    },
    {
        "name": "TK-E2E1 / TK-TEST1 (test task IDs)",
        "where": "text LIKE '%TK-E2E1%' OR text LIKE '%TK-TEST1%'",
    },
    {
        "name": "E2E test learning",
        "where": "text LIKE '%E2E test learning%'",
    },
    {
        "name": "cleanup after test",
        "where": "text LIKE '%cleanup after test%'",
    },
    {
        "name": "TK-LEARN1 (learning test task)",
        "where": "text LIKE '%TK-LEARN1%'",
    },
    {
        "name": "TK-ASSIGN1 (assign test task)",
        "where": "text LIKE '%TK-ASSIGN1%'",
    },
    {
        "name": "TK-SKB1 (SKB promotion test)",
        "where": "text LIKE '%TK-SKB1%'",
    },
    {
        "name": "TK-AUDIT1 (audit trail test)",
        "where": "text LIKE '%TK-AUDIT1%'",
    },
    {
        "name": "TK-0002 (done/progress test task)",
        "where": "text LIKE '%TK-0002%'",
    },
    {
        "name": "E2E test memory entry",
        "where": "text LIKE '%E2E test memory entry%'",
    },
]

# gsd_shared_kb purge patterns
SKB_PATTERNS = [
    {
        "name": "Validated: E2E-LIFECYCLE-*",
        "where": "title LIKE 'Validated: E2E-LIFECYCLE%'",
    },
    {
        "name": "VALIDATED PATTERN: E2E-*",
        "where": "title LIKE 'VALIDATED PATTERN: E2E-%'",
    },
    {
        "name": "Validated: GSD-AMAUTA-TEST-TASK-AUTO",
        "where": "title LIKE 'Validated: GSD-AMAUTA-TEST-TASK-AUTO%'",
    },
    {
        "name": "VALIDATED PATTERN: GSD-AMAUTA-TEST-TASK-AUTO",
        "where": "title LIKE 'VALIDATED PATTERN: GSD-AMAUTA-TEST-TASK-AUTO%'",
    },
    {
        "name": "VALIDATED PATTERN: SKB promotion test",
        "where": "title LIKE 'VALIDATED PATTERN: SKB promotion test%'",
    },
    {
        "name": "VALIDATED PATTERN: Test task for gate validation",
        "where": "title LIKE 'VALIDATED PATTERN: Test task for gate validation%'",
    },
    {
        "name": "content contains TK-0001",
        "where": "content LIKE '%TK-0001%'",
    },
    {
        "name": "content contains E2E-LIFECYCLE",
        "where": "content LIKE '%E2E-LIFECYCLE%'",
    },
    {
        "name": "content contains TK-E2E1",
        "where": "content LIKE '%TK-E2E1%'",
    },
    {
        "name": "content contains TK-TEST1",
        "where": "content LIKE '%TK-TEST1%'",
    },
    {
        "name": "content contains TK-SKB1",
        "where": "content LIKE '%TK-SKB1%'",
    },
    {
        "name": "title/content contains test_alpha",
        "where": "title LIKE '%test_alpha%' OR content LIKE '%test_alpha%'",
    },
]


# ─── Helpers ──────────────────────────────────────────────────────────

def print_header(title):
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


def print_counts(cur, label):
    """Print current counts for both tables."""
    cur.execute("SELECT count(*) FROM gsd_memory")
    mem_count = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM gsd_shared_kb")
    skb_count = cur.fetchone()[0]
    print(f"\n  [{label}] gsd_memory:   {mem_count}")
    print(f"  [{label}] gsd_shared_kb: {skb_count}")
    return mem_count, skb_count


def print_source_breakdown(cur, label):
    """Print gsd_memory source breakdown."""
    cur.execute(
        "SELECT source, count(*) FROM gsd_memory GROUP BY source ORDER BY count DESC"
    )
    rows = cur.fetchall()
    print(f"\n  [{label}] gsd_memory by source:")
    for source, cnt in rows:
        print(f"    {source:<20s} {cnt:>5d}")


def build_combined_where(patterns):
    """Build a single WHERE clause that matches ANY of the patterns."""
    clauses = [f"({p['where']})" for p in patterns]
    return " OR ".join(clauses)


# ─── Dry-run ─────────────────────────────────────────────────────────

def dry_run(conn):
    """Show what WOULD be deleted without deleting anything."""
    print_header("DRY RUN -- no data will be deleted")

    with conn.cursor() as cur:
        before_mem, before_skb = print_counts(cur, "BEFORE")
        print_source_breakdown(cur, "BEFORE")

        # -- gsd_memory patterns --
        print_header("gsd_memory patterns (per-pattern match counts)")
        total_unique_mem = 0
        for p in MEMORY_PATTERNS:
            cur.execute(f"SELECT count(*) FROM gsd_memory WHERE {p['where']}")
            cnt = cur.fetchone()[0]
            marker = " *" if cnt > 0 else ""
            print(f"  {p['name']:<55s} {cnt:>5d}{marker}")

        # Total unique (union of all patterns)
        combined = build_combined_where(MEMORY_PATTERNS)
        cur.execute(f"SELECT count(*) FROM gsd_memory WHERE {combined}")
        total_unique_mem = cur.fetchone()[0]
        remaining_mem = before_mem - total_unique_mem
        print(f"\n  {'TOTAL UNIQUE MATCHES':<55s} {total_unique_mem:>5d}")
        print(f"  {'WOULD REMAIN':<55s} {remaining_mem:>5d}")

        # -- gsd_shared_kb patterns --
        print_header("gsd_shared_kb patterns (per-pattern match counts)")
        for p in SKB_PATTERNS:
            cur.execute(f"SELECT count(*) FROM gsd_shared_kb WHERE {p['where']}")
            cnt = cur.fetchone()[0]
            marker = " *" if cnt > 0 else ""
            print(f"  {p['name']:<55s} {cnt:>5d}{marker}")

        combined_skb = build_combined_where(SKB_PATTERNS)
        cur.execute(f"SELECT count(*) FROM gsd_shared_kb WHERE {combined_skb}")
        total_unique_skb = cur.fetchone()[0]
        remaining_skb = before_skb - total_unique_skb
        print(f"\n  {'TOTAL UNIQUE MATCHES':<55s} {total_unique_skb:>5d}")
        print(f"  {'WOULD REMAIN':<55s} {remaining_skb:>5d}")

        # -- Summary --
        print_header("PROJECTED SUMMARY")
        pct_mem = (total_unique_mem / before_mem * 100) if before_mem else 0
        pct_skb = (total_unique_skb / before_skb * 100) if before_skb else 0
        print(f"  gsd_memory:   {before_mem} -> {remaining_mem}  ({pct_mem:.1f}% purged)")
        print(f"  gsd_shared_kb: {before_skb} -> {remaining_skb}  ({pct_skb:.1f}% purged)")
        print(f"\n  ** No data was deleted. Run with --execute to apply. **\n")

    return 0


# ─── Execute ─────────────────────────────────────────────────────────

def execute(conn):
    """Delete test data in a single transaction."""
    print_header("EXECUTE MODE -- deleting test data")

    try:
        with conn.cursor() as cur:
            before_mem, before_skb = print_counts(cur, "BEFORE")
            print_source_breakdown(cur, "BEFORE")

            # -- Delete from gsd_memory --
            print_header("Deleting from gsd_memory")
            combined_mem = build_combined_where(MEMORY_PATTERNS)
            cur.execute(
                f"DELETE FROM gsd_memory WHERE {combined_mem} RETURNING id"
            )
            deleted_mem_ids = cur.fetchall()
            deleted_mem = len(deleted_mem_ids)
            print(f"  Deleted: {deleted_mem} rows")

            # -- Delete from gsd_shared_kb --
            print_header("Deleting from gsd_shared_kb")
            combined_skb = build_combined_where(SKB_PATTERNS)
            cur.execute(
                f"DELETE FROM gsd_shared_kb WHERE {combined_skb} RETURNING id"
            )
            deleted_skb_ids = cur.fetchall()
            deleted_skb = len(deleted_skb_ids)
            print(f"  Deleted: {deleted_skb} rows")

            # Commit the transaction
            conn.commit()
            print("\n  Transaction committed successfully.")

            # -- After counts --
            after_mem, after_skb = print_counts(cur, "AFTER")
            print_source_breakdown(cur, "AFTER")

            # -- Summary --
            print_header("PURGE SUMMARY")
            pct_mem = (deleted_mem / before_mem * 100) if before_mem else 0
            pct_skb = (deleted_skb / before_skb * 100) if before_skb else 0
            print(f"  gsd_memory:   {before_mem} -> {after_mem}  (deleted {deleted_mem}, {pct_mem:.1f}%)")
            print(f"  gsd_shared_kb: {before_skb} -> {after_skb}  (deleted {deleted_skb}, {pct_skb:.1f}%)")
            print()

    except Exception as e:
        conn.rollback()
        print(f"\n  ERROR: {e}")
        print("  Transaction rolled back. No data was deleted.")
        return 1

    return 0


# ─── Main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Purge test/synthetic data from gsd_memory and gsd_shared_kb"
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually delete data (default is dry-run)",
    )
    args = parser.parse_args()

    try:
        conn = get_connection()
    except Exception as e:
        print(f"ERROR: Cannot connect to PostgreSQL: {e}")
        sys.exit(1)

    try:
        if args.execute:
            rc = execute(conn)
        else:
            rc = dry_run(conn)
    finally:
        conn.close()

    sys.exit(rc)


if __name__ == "__main__":
    main()

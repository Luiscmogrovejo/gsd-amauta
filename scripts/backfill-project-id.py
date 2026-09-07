#!/usr/bin/env python3
"""TK-2229 -- backfill gsd_tasks.project_id / tasks.json project_id by EVIDENCE.

Every task in the store says project_id = 'default' because nothing ever wrote
the column. This script assigns a project ONLY where the row itself carries
evidence of which repository it belongs to. It deliberately does NOT guess from
an identifier range, a creation date, or contiguity -- those heuristics are the
reason TK-2229 exists.

Rules, first match wins (rule name is recorded in the journal per row):

  repo_tag      A `repo:<name>` tag. <name> is resolved through
                scripts/project-aliases.json, then accepted only if it names a
                real checkout.
  title_prefix  Title begins with `name:` or `[name]` where <name> is in the
                alias map (so 'contracts: publish v0.2.0' is claimed, but
                'phase 4: …' is not -- unknown prefixes are never a rule).
  repo_path     Exactly ONE distinct absolute checkout path
                (/…/Code/<dir>) appears anywhere in the task's JSON, and <dir>
                is a real checkout. Two or more distinct repos -> AMBIGUOUS,
                claimed by nobody.
  plan_owner    A `plan:NN-MM` tag whose plan file
                (.planning/phases/*/NN-MM-PLAN.md) exists in exactly ONE
                checkout. Two or more owners -> AMBIGUOUS.

Anything unclaimed keeps 'default'. That is the correct answer for a row whose
project is genuinely not knowable from what it carries.

SAFETY
  * Dry-run is the DEFAULT. Nothing is written without --apply.
  * --apply writes tasks.json (atomically, with a .bak) and PG (ONE transaction,
    committed only if every UPDATE succeeded).
  * Every changed row is journalled in gsd_task_project_backfill with its old
    value, the rule, and the literal evidence -> migrations/028-…-DOWN.sql
    reverts it, and so does --revert.
  * --rollback-probe runs the whole PG half inside a transaction that is then
    ROLLED BACK, and reports the counts it would have written.

USAGE
  python3 scripts/backfill-project-id.py                    # dry run + counts
  python3 scripts/backfill-project-id.py --verify-aliases   # check the alias map
  python3 scripts/backfill-project-id.py --rollback-probe   # write + ROLLBACK
  python3 scripts/backfill-project-id.py --apply            # write for real
  python3 scripts/backfill-project-id.py --revert --batch <uuid>

Exit codes: 0 success, 1 error, 2 bad usage.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ALIAS_FILE = ROOT / "scripts" / "project-aliases.json"
DEFAULT_PROJECT_ID = "default"

# Rule names, in application order. Also the journal's `rule` vocabulary.
# Order matters: an EXPLICIT human statement about the repository (a repo: tag,
# a "name:" title prefix) outranks a path INFERRED from the task's work log. A
# BareRouter task whose R-phase quotes a ~/Code/gsd-amauta path is still a
# BareRouter task, and its title says so.
RULES = ("repo_tag", "title_prefix", "repo_path", "plan_owner")


# ── Inputs ────────────────────────────────────────────────────────────────────

def _data_dir() -> Path:
    """Resolve the amauta data directory the same way amauta.py does.

    Returns:
        Path to the directory holding tasks.json.
    """
    env = os.environ.get("AMAUTA_DATA_DIR")
    if env:
        return Path(env)
    return Path.home() / ".amauta"


def _checkout_root() -> Path:
    """Directory holding the sibling checkouts used as project-name evidence.

    Returns:
        Path from GSD_CHECKOUT_ROOT, else ~/Code.
    """
    return Path(os.environ.get("GSD_CHECKOUT_ROOT", str(Path.home() / "Code")))


def _load_aliases() -> dict:
    """Load the reviewable alias map.

    Returns:
        dict mapping alias -> project_id (empty when the file is absent).
    """
    try:
        with open(ALIAS_FILE) as f:
            return (json.load(f) or {}).get("aliases", {}) or {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        raise SystemExit(f"ERROR: {ALIAS_FILE} is unreadable: {e}")


def _known_checkouts() -> set:
    """Names of real GIT checkouts under the checkout root.

    A plain directory is not a project: `~/Code/GitHub` is a container that
    holds repositories, and _resolve_project_id would never name it, because
    it resolves to the nearest ancestor holding .git. Requiring .git here keeps
    the backfill's notion of a project identical to the registration rule's.

    Returns:
        set of directory names that are git working trees.
    """
    root = _checkout_root()
    if not root.is_dir():
        return set()
    return {p.name for p in root.iterdir()
            if p.is_dir() and (p / ".git").exists()}


def _plan_owners() -> dict:
    """Map every plan id (NN-MM) to the checkouts that contain its PLAN file.

    Returns:
        dict plan_id -> set of project ids.
    """
    owners: dict = {}
    root = _checkout_root()
    if not root.is_dir():
        return owners
    checkouts = _known_checkouts()
    for repo in root.iterdir():
        if repo.name not in checkouts:
            continue  # same definition of "a project" as _known_checkouts()
        phases = repo / ".planning" / "phases"
        if not phases.is_dir():
            continue
        for phase in phases.iterdir():
            if not phase.is_dir():
                continue
            for f in phase.iterdir():
                m = re.fullmatch(r"(\d{2}-\d{2})-PLAN\.md", f.name)
                if m:
                    owners.setdefault(m.group(1), set()).add(repo.name)
    return owners


@contextlib.contextmanager
def _tasks_lock(data_dir: Path):
    """Hold amauta.py's own exclusive tasks lock for the whole read-modify-write.

    tasks.json is shared with every live agent. amauta.py serialises its
    mutations on DATA_DIR/.amauta.lock (amauta.py: class _file_lock); this
    script must take the SAME lock or a concurrent `amauta add` landing between
    our read and our write is silently discarded.

    Args:
        data_dir: The amauta data directory.

    Yields:
        None, with the lock held.
    """
    lock_path = data_dir / ".amauta.lock"
    fd = open(lock_path, "w")
    try:
        if fcntl:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        if fcntl:
            fcntl.flock(fd, fcntl.LOCK_UN)
        fd.close()


# ── The rules ─────────────────────────────────────────────────────────────────

_PATH_RE = re.compile(r"/Users/[A-Za-z0-9._-]+/Code/([A-Za-z0-9._-]+)")
_PLAN_TAG_RE = re.compile(r'^plan:"?(\d{2}-\d{2})"?$')
_COLON_PREFIX_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]{1,30}):\s")
_BRACKET_PREFIX_RE = re.compile(r"^\[([A-Za-z0-9][A-Za-z0-9._-]{1,30})\]")


def _rule_repo_tag(item, ctx):
    """A `repo:<name>` tag naming a known checkout (directly or via alias)."""
    for tag in item.get("tags") or []:
        if not isinstance(tag, str) or not tag.lower().startswith("repo:"):
            continue
        name = tag.split(":", 1)[1].strip().strip('"')
        target = ctx["aliases"].get(name, name)
        if target in ctx["checkouts"]:
            return target, tag
    return None, None


def _rule_repo_path(item, ctx):
    """Exactly one distinct known checkout path anywhere in the task."""
    blob = json.dumps(item, ensure_ascii=False)
    found = set()
    for m in _PATH_RE.finditer(blob):
        name = m.group(1).rstrip(".")
        if name in ctx["checkouts"]:
            found.add(name)
    if len(found) == 1:
        name = next(iter(found))
        return name, f"path:/Code/{name}"
    if len(found) > 1:
        ctx["ambiguous"]["repo_path"] += 1
    return None, None


def _rule_plan_owner(item, ctx):
    """A plan:NN-MM tag whose PLAN file exists in exactly one checkout."""
    for tag in item.get("tags") or []:
        if not isinstance(tag, str):
            continue
        m = _PLAN_TAG_RE.match(tag)
        if not m:
            continue
        owners = ctx["plan_owners"].get(m.group(1)) or set()
        if len(owners) == 1:
            return next(iter(owners)), tag
        if len(owners) > 1:
            ctx["ambiguous"]["plan_owner"] += 1
    return None, None


def _rule_title_prefix(item, ctx):
    """Title starts with an ALIASED project name, as `name:` or `[name]`."""
    title = item.get("title") or ""
    for regex in (_BRACKET_PREFIX_RE, _COLON_PREFIX_RE):
        m = regex.match(title)
        if not m:
            continue
        name = m.group(1).strip().lower()
        target = ctx["aliases"].get(name)
        if target and target in ctx["checkouts"]:
            return target, f"title-prefix:{name}"
    return None, None


_RULE_FUNCS = {
    "repo_tag": _rule_repo_tag,
    "repo_path": _rule_repo_path,
    "plan_owner": _rule_plan_owner,
    "title_prefix": _rule_title_prefix,
}


def classify(items, ctx):
    """Apply the rules to every item, first match wins.

    Args:
        items: List of task item dicts.
        ctx: Rule context (aliases, checkouts, plan_owners, ambiguous counter).

    Returns:
        (changes, counts) where changes is a list of dicts
        {id, old, new, rule, evidence} for rows whose project actually moves.
    """
    changes = []
    counts = {r: 0 for r in RULES}
    counts["unchanged"] = 0
    counts["already_set"] = 0
    for item in items:
        old = (item.get("project_id") or DEFAULT_PROJECT_ID).strip() or DEFAULT_PROJECT_ID
        if old != DEFAULT_PROJECT_ID:
            counts["already_set"] += 1
            continue
        for rule in RULES:
            new, evidence = _RULE_FUNCS[rule](item, ctx)
            if new and new != old:
                counts[rule] += 1
                changes.append({"id": item["id"], "old": old, "new": new,
                                "rule": rule, "evidence": evidence})
                break
        else:
            counts["unchanged"] += 1
    return changes, counts


# ── PG side ───────────────────────────────────────────────────────────────────

def _pg_url():
    """Resolve the PG DSN from the environment. Never printed.

    Returns:
        The DSN string, or None when nothing is configured.
    """
    for key in ("GSD_POSTGRES_URL", "AMAUTA_MEMORY_DATABASE_URL", "DATABASE_URL"):
        v = os.environ.get(key)
        if v:
            return v
    env_file = ROOT / ".env"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            if line.startswith("GSD_POSTGRES_URL="):
                return line.split("=", 1)[1].strip()
    return None


def _pg_connect():
    """Open a PG connection with autocommit OFF (we manage the transaction).

    Returns:
        psycopg2 connection.

    Raises:
        SystemExit: when psycopg2 or the DSN is unavailable.
    """
    dsn = _pg_url()
    if not dsn:
        raise SystemExit("ERROR: no PG DSN (set GSD_POSTGRES_URL).")
    try:
        import psycopg2
    except ImportError:
        raise SystemExit("ERROR: psycopg2 not installed.")
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    return conn


def _write_pg(conn, changes, batch_id, commit):
    """Apply every change to PG inside ONE transaction, plus the journal rows.

    Args:
        conn: Open psycopg2 connection (autocommit off).
        changes: Output of classify().
        batch_id: UUID string identifying this run.
        commit: True to COMMIT, False to ROLLBACK (probe mode).

    Returns:
        dict with updated / missing counts.
    """
    updated = 0
    missing = []
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS gsd_task_project_backfill (
              task_id VARCHAR(16) NOT NULL, old_project_id VARCHAR(128) NOT NULL,
              new_project_id VARCHAR(128) NOT NULL, rule VARCHAR(32) NOT NULL,
              evidence TEXT, batch_id UUID NOT NULL,
              applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              PRIMARY KEY (task_id, batch_id))
        """)
        for ch in changes:
            cur.execute(
                "UPDATE gsd_tasks SET project_id = %s, updated_at = NOW() "
                "WHERE id = %s AND project_id = %s",
                (ch["new"], ch["id"], ch["old"]),
            )
            if cur.rowcount == 1:
                updated += 1
                cur.execute(
                    "INSERT INTO gsd_task_project_backfill "
                    "(task_id, old_project_id, new_project_id, rule, evidence, batch_id) "
                    "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
                    (ch["id"], ch["old"], ch["new"], ch["rule"], ch["evidence"], batch_id),
                )
            else:
                missing.append(ch["id"])
    if commit:
        conn.commit()
    else:
        conn.rollback()
    return {"updated": updated, "missing": missing}


def _revert_pg(conn, batch_id):
    """Restore project_id from the journal for one batch (or all).

    Args:
        conn: Open psycopg2 connection.
        batch_id: Batch UUID, or None for every batch.

    Returns:
        int: rows restored.
    """
    with conn.cursor() as cur:
        if batch_id:
            cur.execute("""
                UPDATE gsd_tasks t SET project_id = b.old_project_id, updated_at = NOW()
                  FROM gsd_task_project_backfill b
                 WHERE t.id = b.task_id AND t.project_id = b.new_project_id
                   AND b.batch_id = %s
            """, (batch_id,))
        else:
            cur.execute("""
                UPDATE gsd_tasks t SET project_id = b.old_project_id, updated_at = NOW()
                  FROM gsd_task_project_backfill b
                 WHERE t.id = b.task_id AND t.project_id = b.new_project_id
            """)
        n = cur.rowcount
    conn.commit()
    return n


# ── tasks.json side ───────────────────────────────────────────────────────────

def _write_tasks_json(tasks_file: Path, data: dict, changes, key="new"):
    """Stamp project_id onto items and rewrite tasks.json atomically.

    Args:
        tasks_file: Path to tasks.json.
        data: The loaded document.
        changes: Output of classify() (or the journal, for a revert).
        key: 'new' to apply, 'old' to revert.

    Returns:
        int: number of items stamped.
    """
    by_id = {c["id"]: c for c in changes}
    n = 0
    for item in data.get("items", []):
        ch = by_id.get(item.get("id"))
        if ch:
            item["project_id"] = ch[key]
            n += 1
    backup = Path(str(tasks_file) + ".bak")
    if tasks_file.exists():
        shutil.copy2(tasks_file, backup)
    with tempfile.NamedTemporaryFile("w", dir=str(tasks_file.parent),
                                     delete=False, suffix=".tmp") as tmp:
        json.dump(data, tmp, indent=2)
        tmp.flush()
        os.fsync(tmp.fileno())
    os.replace(tmp.name, tasks_file)
    return n


# ── Reporting ─────────────────────────────────────────────────────────────────

def _report(changes, counts, ctx, total):
    """Print the per-rule claim table and the residual 'default' count."""
    claimed = len(changes)
    print(f"Rows examined:            {total}")
    print(f"Already non-default:      {counts['already_set']}")
    print("Claimed, by rule (first match wins):")
    for rule in RULES:
        print(f"  {rule:14s} {counts[rule]:6d}"
              f"   (ambiguous, refused: {ctx['ambiguous'].get(rule, 0)})")
    print(f"  {'TOTAL claimed':14s} {claimed:6d}")
    remaining = counts["unchanged"]
    print(f"Left as 'default':        {remaining}"
          "   (no repo tag, no unambiguous path, no single-owner plan, no known prefix)")
    if claimed:
        hist = {}
        for c in changes:
            hist[c["new"]] = hist.get(c["new"], 0) + 1
        print("Projects assigned:")
        for p, n in sorted(hist.items(), key=lambda kv: (-kv[1], kv[0])):
            print(f"  {p:32s} {n}")


def _verify_aliases(ctx):
    """Check every alias against the real checkout's origin remote.

    Returns:
        int: 0 when every alias verifies, 1 otherwise.
    """
    import subprocess
    bad = 0
    for alias, project in sorted(ctx["aliases"].items()):
        path = _checkout_root() / project
        if not path.is_dir():
            print(f"  FAIL {alias:14s} -> {project}: no such checkout")
            bad += 1
            continue
        try:
            url = subprocess.run(["git", "-C", str(path), "remote", "get-url", "origin"],
                                 capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception as e:
            print(f"  FAIL {alias:14s} -> {project}: git failed ({e})")
            bad += 1
            continue
        if url.rstrip("/").endswith(f"/{alias}.git") or url.rstrip("/").endswith(f"/{alias}"):
            print(f"  ok   {alias:14s} -> {project}")
        else:
            print(f"  FAIL {alias:14s} -> {project}: origin is {url!r}")
            bad += 1
    return 1 if bad else 0


# ── Entry point ───────────────────────────────────────────────────────────────

def main(argv=None):
    """Parse arguments and run the requested mode.

    Returns:
        int: process exit code.
    """
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="Write the changes (default is dry-run)")
    ap.add_argument("--rollback-probe", action="store_true", dest="rollback_probe",
                    help="Run the PG writes inside a transaction and ROLL BACK")
    ap.add_argument("--revert", action="store_true",
                    help="Restore project_id from the journal")
    ap.add_argument("--batch", default=None,
                    help="Batch UUID for --revert (default: every batch)")
    ap.add_argument("--json-only", action="store_true", dest="json_only",
                    help="Skip PG entirely; operate on tasks.json only")
    ap.add_argument("--verify-aliases", action="store_true", dest="verify_aliases",
                    help="Check scripts/project-aliases.json against real remotes")
    args = ap.parse_args(argv)

    if args.apply and args.rollback_probe:
        print("ERROR: --apply and --rollback-probe are mutually exclusive", file=sys.stderr)
        return 2

    ctx = {
        "aliases": {k.lower(): v for k, v in _load_aliases().items()},
        "checkouts": _known_checkouts(),
        "plan_owners": _plan_owners(),
        "ambiguous": {r: 0 for r in RULES},
    }

    if args.verify_aliases:
        print(f"Verifying {len(ctx['aliases'])} aliases against {_checkout_root()}:")
        return _verify_aliases(ctx)

    data_dir = _data_dir()
    tasks_file = data_dir / "tasks.json"
    if not tasks_file.is_file():
        print(f"ERROR: {tasks_file} not found (set AMAUTA_DATA_DIR)", file=sys.stderr)
        return 1

    # A mode that WRITES holds amauta.py's own tasks lock across the whole
    # read-modify-write, so a concurrent `amauta add` cannot be lost. A dry run
    # or a rollback probe only reads, and must not block live agents.
    writes = args.apply or args.revert
    with (_tasks_lock(data_dir) if writes else contextlib.nullcontext()):
        return _run(args, ctx, tasks_file)


def _run(args, ctx, tasks_file):
    """Body of main(), executed under the tasks lock when the mode writes.

    Args:
        args: Parsed arguments.
        ctx: Rule context.
        tasks_file: Path to tasks.json.

    Returns:
        int: process exit code.
    """
    with open(tasks_file) as f:
        data = json.load(f)
    items = data.get("items", [])

    if args.revert:
        if args.json_only:
            print("ERROR: --revert needs PG (the journal lives there)", file=sys.stderr)
            return 2
        conn = _pg_connect()
        try:
            with conn.cursor() as cur:
                if args.batch:
                    cur.execute("SELECT task_id, old_project_id, new_project_id "
                                "FROM gsd_task_project_backfill WHERE batch_id = %s",
                                (args.batch,))
                else:
                    cur.execute("SELECT task_id, old_project_id, new_project_id "
                                "FROM gsd_task_project_backfill")
                journal = [{"id": r[0], "old": r[1], "new": r[2]} for r in cur.fetchall()]
            n_pg = _revert_pg(conn, args.batch)
        finally:
            conn.close()
        n_json = _write_tasks_json(tasks_file, data, journal, key="old")
        print(f"Reverted: {n_pg} PG rows, {n_json} tasks.json items "
              f"(batch={args.batch or 'ALL'})")
        return 0

    changes, counts = classify(items, ctx)
    batch_id = str(uuid.uuid4())

    mode = "APPLY" if args.apply else ("ROLLBACK-PROBE" if args.rollback_probe else "DRY RUN")
    print(f"=== TK-2229 project backfill -- {mode} ===")
    print(f"tasks.json: {tasks_file}")
    print(f"checkouts:  {_checkout_root()}  ({len(ctx['checkouts'])} directories)")
    print()
    _report(changes, counts, ctx, len(items))
    print()

    if not changes:
        print("Nothing to do.")
        return 0

    if not (args.apply or args.rollback_probe):
        print("Sample (first 15):")
        for ch in changes[:15]:
            print(f"  {ch['id']:9s} {ch['old']} -> {ch['new']:24s} "
                  f"[{ch['rule']}] {ch['evidence']}")
        print()
        print("Dry run: nothing written. Re-run with --rollback-probe, then --apply.")
        return 0

    if not args.json_only:
        conn = _pg_connect()
        try:
            result = _write_pg(conn, changes, batch_id, commit=args.apply)
        finally:
            conn.close()
        verb = "UPDATED" if args.apply else "would update (ROLLED BACK)"
        print(f"PG: {verb} {result['updated']} rows; "
              f"{len(result['missing'])} not matched in gsd_tasks")
        if result["missing"]:
            print(f"    not matched: {', '.join(result['missing'][:10])}"
                  f"{' …' if len(result['missing']) > 10 else ''}")

    if args.apply:
        n_json = _write_tasks_json(tasks_file, data, changes, key="new")
        print(f"tasks.json: stamped {n_json} items (backup at {tasks_file}.bak)")
        print(f"batch_id: {batch_id}")
        print("Revert with: python3 scripts/backfill-project-id.py --revert "
              f"--batch {batch_id}")
    else:
        print("Probe only: PG rolled back, tasks.json untouched.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

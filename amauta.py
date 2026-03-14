#!/usr/bin/env python3
"""
Amauta — Multi-Agent Task Manager v2.0
RLM/RPETD-native. Designed for OpenClaw 6-agent system + opencode VPS agent.

Hierarchy:  Epic > Story > Task > Bug
Schema:     Rich context fields — details, test_strategy, success_criteria,
            deliverables, risks, rpetd_phases, doc_refs, sprint, scoring.
Agents use: next → claim → rpetd (×5) → status validation → [validator] validate

All data: ~/.amauta/tasks.json  (or $AMAUTA_DATA_DIR)
No internet. No LLM calls. Pure offline. Atomic writes.
"""

import argparse
import json
import os
import re
import sys
import fcntl
import socket
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

# ── ANSI ──────────────────────────────────────────────────────────────────────
RESET   = "\033[0m"
BOLD    = "\033[1m"
DIM     = "\033[2m"
RED     = "\033[91m"
GREEN   = "\033[92m"
YELLOW  = "\033[93m"
BLUE    = "\033[94m"
MAGENTA = "\033[95m"
CYAN    = "\033[96m"
WHITE   = "\033[97m"

def c(text, colour): return f"{colour}{text}{RESET}"
def bold(t):         return c(t, BOLD)
def dim(t):          return c(t, DIM)

# ── Constants ──────────────────────────────────────────────────────────────────
AGENTS    = [
    "operator", "researcher", "coder", "coder-frontend", "coder-backend", "coder-infra", "coder-ui", "coder-db",
    "marketing", "finance", "validator", "security-auditor", "maintainer",
    "opencode", "opencode-general", "opencode-network", "opencode-memory", "opencode-openclaw", "opencode-project",
    "public-relations", "accountant", "legal",
]
TYPES     = ["epic", "story", "task", "bug"]
STATUSES  = ["pending", "in-progress", "validation", "done", "failed", "deferred"]
PRIORITIES= ["low", "medium", "high", "critical"]
PHASES    = ["R", "P", "E", "T", "D"]
PHASE_NAMES = {"R": "Research", "P": "Plan", "E": "Execute", "T": "Test", "D": "Document"}

PREFIX = {"epic": "EP", "story": "ST", "task": "TK", "bug": "BG"}

PRIORITY_SCORE = {"low": 1, "medium": 2, "high": 3, "critical": 5}

DOMAIN_TAG_HINTS = {
    "auth": ["auth", "oauth", "token", "login", "signup", "password", "session"],
    "billing": ["billing", "stripe", "pricing", "checkout", "subscription", "invoice"],
    "security": ["security", "vuln", "cve", "hardening", "audit", "sandbox"],
    "performance": ["cwv", "lcp", "inp", "cls", "bundle", "performance", "lighthouse"],
    "database": ["db", "database", "sql", "migration", "postgres", "pg", "schema"],
    "frontend": ["frontend", "ui", "page", "component", "css", "react", "next"],
    "backend": ["backend", "api", "endpoint", "service", "worker"],
    "infra": ["infra", "docker", "compose", "vps", "nginx", "deploy", "host"],
    "docs": ["docs", "documentation", "spec", "report", "analysis", "research"],
}

TYPE_COL   = {"epic": MAGENTA, "story": BLUE, "task": CYAN, "bug": RED}
STATUS_COL = {
    "pending":     DIM,
    "in-progress": YELLOW,
    "validation":  CYAN,
    "done":        GREEN,
    "failed":      RED,
    "deferred":    DIM,
}
PRIORITY_COL = {"low": DIM, "medium": WHITE, "high": YELLOW, "critical": RED}

STATUS_ICON = {
    "pending":     "○",
    "in-progress": "◐",
    "validation":  "◑",
    "done":        "●",
    "failed":      "✗",
    "deferred":    "–",
}

# ── Data directory ─────────────────────────────────────────────────────────────
DATA_DIR   = Path(os.environ.get("AMAUTA_DATA_DIR", Path.home() / ".amauta"))
TASKS_FILE = DATA_DIR / "tasks.json"
MEMORY_FILE = DATA_DIR / "memory.jsonl"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ── Time ───────────────────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()

def _fmt_ts(ts: str) -> str:
    """Format ISO timestamp to human-readable."""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ts

# ── File locking ───────────────────────────────────────────────────────────────
_LOCK_FILE = DATA_DIR / ".amauta.lock"

class _file_lock:
    """Exclusive file lock for concurrent-safe task mutations (add, update, etc.)."""
    def __init__(self):
        self._fd = None
    def __enter__(self):
        self._fd = open(_LOCK_FILE, "w")
        fcntl.flock(self._fd, fcntl.LOCK_EX)
        return self
    def __exit__(self, *exc):
        if self._fd:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            self._fd.close()

# ── Persistence ────────────────────────────────────────────────────────────────
def load() -> dict:
    if TASKS_FILE.exists():
        with open(TASKS_FILE) as f:
            return json.load(f)
    return {
        "items":    [],
        "sprints":  [],
        "metadata": {"created": _now(), "version": "2.0", "updated": _now()},
    }

def save(data: dict):
    """Atomic write — never corrupts tasks.json.
    Always restores ownership to ubuntu:amauta-services 640 after every write,
    regardless of which user (root, ubuntu, node) ran the CLI.
    This keeps the file accessible to:
      - container node user (uid=1000 = ubuntu on host) for read+write
      - amauta-dashboard service for read (via amauta-services group)
      - no world access (principle of least privilege)
    """
    import pwd, grp
    data["metadata"]["updated"] = _now()
    data["metadata"]["version"] = "2.0"
    tmp = tempfile.NamedTemporaryFile(
        mode="w", dir=DATA_DIR, delete=False, suffix=".tmp"
    )
    try:
        json.dump(data, tmp, indent=2)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp.name, TASKS_FILE)
        os.chmod(TASKS_FILE, 0o644)  # owner rw + group/other r — agents run as uid=1000 in containers
        # Always chown to amauta:amauta (uid=1000:gid=1000) so container agents can access
        # Containers run as node/sandbox (uid=1000) which maps to amauta on host
        try:
            os.chown(TASKS_FILE, 1000, 1000)
        except PermissionError:
            pass  # running inside container as node — chown not needed, node IS uid=1000
    except Exception:
        tmp.close()
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise

# ── Lightweight shared memory store (compat layer) ───────────────────────────
def _mem_load() -> list:
    if not MEMORY_FILE.exists():
        return []
    out = []
    with open(MEMORY_FILE, "r", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out

def _mem_append(row: dict):
    with open(MEMORY_FILE, "a") as f:
        f.write(json.dumps(row, ensure_ascii=True) + "\n")

def _mem_db_url() -> str:
    # Priority: AMAUTA_MEMORY_DATABASE_URL > GSD_POSTGRES_URL > /srv/amauta/.env
    dsn = os.environ.get("AMAUTA_MEMORY_DATABASE_URL", "").strip()
    if not dsn:
        dsn = os.environ.get("GSD_POSTGRES_URL", "").strip()
    if not dsn:
        env_file = Path("/srv/amauta/.env")
        if env_file.exists():
            for ln in env_file.read_text(errors="ignore").splitlines():
                if ln.startswith("AMAUTA_MEMORY_DATABASE_URL="):
                    dsn = ln.split("=", 1)[1].strip().strip('"').strip("'")
                    break
                if ln.startswith("GSD_POSTGRES_URL=") and not dsn:
                    dsn = ln.split("=", 1)[1].strip().strip('"').strip("'")
    if not dsn:
        return ""

    # Some sandboxes cannot route to docker bridge IP 172.17.0.1 but can resolve
    # the compose service name. If bridge IP is unreachable, transparently
    # swap host to amauta-postgres.
    try:
        u = urlsplit(dsn)
        host = u.hostname or ""
        port = int(u.port or 5432)
        if host == "172.17.0.1":
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.8)
            try:
                s.connect((host, port))
            except Exception:
                # Try service DNS; if reachable, rewrite DSN host.
                s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s2.settimeout(0.8)
                try:
                    s2.connect(("amauta-postgres", port))
                    netloc = (u.netloc or "").replace("172.17.0.1", "amauta-postgres")
                    dsn = urlunsplit((u.scheme, netloc, u.path, u.query, u.fragment))
                except Exception:
                    pass
                finally:
                    s2.close()
            finally:
                s.close()
    except Exception:
        # Keep original DSN if parsing or probing fails.
        pass

    return dsn

def _mem_backend() -> str:
    """Return the configured memory backend ('postgres' or '').
    Checks env var first, falls back to /srv/amauta/.env (same pattern as _mem_db_url).
    If GSD_POSTGRES_URL is set (and no explicit backend override), infers 'postgres'."""
    val = os.environ.get("AMAUTA_MEMORY_BACKEND", "").strip().lower()
    if val:
        return val
    # If GSD_POSTGRES_URL is set, infer postgres backend automatically
    if os.environ.get("GSD_POSTGRES_URL", "").strip():
        return "postgres"
    env_file = Path("/srv/amauta/.env")
    if env_file.exists():
        for ln in env_file.read_text(errors="ignore").splitlines():
            if ln.startswith("AMAUTA_MEMORY_BACKEND="):
                return ln.split("=", 1)[1].strip().strip('"').strip("'").lower()
            if ln.startswith("GSD_POSTGRES_URL="):
                return "postgres"
    return ""

def _mem_pg_available() -> bool:
    return _mem_backend() == "postgres" and bool(_mem_db_url())

def _mem_pg_add(agent_id: str, tags: list, text: str):
    import psycopg2
    dsn = _mem_db_url()
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    cur = conn.cursor()
    now = datetime.now(timezone.utc)
    m = re.search(r"\b(TK-\d{3,6}|BG-\d{3,6}|ST-\d{3,6}|EP-\d{3,6})\b", text or "", flags=re.IGNORECASE)
    task_id = (m.group(1).upper() if m else "")
    cur.execute(
        """
        INSERT INTO amauta_memory (id, text, agent_id, source, tags, metadata, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)
        """,
        (
            str(uuid.uuid4()),
            text,
            agent_id,
            "agent",
            json.dumps(tags),
            json.dumps({"via": "amauta memory add", "task_id": task_id}),
            now,
            now,
        ),
    )
    cur.close()
    conn.close()

def _mem_pg_search(query: str, agent_id: Optional[str], top_k: int) -> list:
    """
    Search amauta_memory with source-aware scoring.
    - Boosts auto_learning + web_search_result + lesson-learned (high signal)
    - Returns source field so callers can show where results came from
    - High-signal sources get +3 score boost so they surface above raw task_events
    """
    import psycopg2
    dsn = _mem_db_url()
    conn = psycopg2.connect(dsn)
    cur = conn.cursor()

    # Split query into individual terms for OR-based matching
    terms = [t.strip() for t in re.split(r"\s+", query.strip()) if t.strip()]
    if not terms:
        return []

    # Build per-term LIKE conditions and score expression
    like_pats = [f"%{t}%" for t in terms]
    # WHERE: match any term in text or tags
    where_parts = []
    params: list = []
    for pat in like_pats:
        where_parts.append("(lower(text) LIKE lower(%s) OR lower(tags::text) LIKE lower(%s))")
        params.extend([pat, pat])
    where_clause = " OR ".join(where_parts)

    # SCORE: base relevance + source boost (auto_learning/web_search_result rank higher)
    score_parts = []
    score_params: list = []
    for pat in like_pats:
        score_parts.append("(CASE WHEN lower(text) LIKE lower(%s) THEN 1 ELSE 0 END)")
        score_params.append(pat)
    # Source-quality boost: learning sources rank above raw task events
    source_boost = (
        "CASE source "
        "WHEN 'auto_learning' THEN 3 "
        "WHEN 'web_search_result' THEN 3 "
        "WHEN 'lesson-learned' THEN 4 "
        "WHEN 'best-practice' THEN 4 "
        "WHEN 'session-learning' THEN 3 "
        "WHEN 'distilled' THEN 2 "
        "WHEN 'rpetd_phase' THEN 1 "
        "ELSE 0 END"
    )
    score_expr = f"({' + '.join(score_parts) if score_parts else '0'}) + ({source_boost})"

    if agent_id:
        sql = f"""
            SELECT created_at, agent_id, text, tags, source,
                   ({score_expr}) AS score
            FROM amauta_memory
            WHERE agent_id = %s AND ({where_clause})
            ORDER BY score DESC, created_at DESC
            LIMIT %s
        """
        cur.execute(sql, score_params + [agent_id] + params + [max(1, top_k)])
    else:
        sql = f"""
            SELECT created_at, agent_id, text, tags, source,
                   ({score_expr}) AS score
            FROM amauta_memory
            WHERE {where_clause}
            ORDER BY score DESC, created_at DESC
            LIMIT %s
        """
        cur.execute(sql, score_params + params + [max(1, top_k)])

    rows = cur.fetchall()
    cur.close()
    conn.close()
    out = []
    for created_at, ag, text, tags, source, score in rows:
        out.append(
            {
                "ts": created_at.isoformat() if hasattr(created_at, "isoformat") else str(created_at),
                "agent_id": ag,
                "text": text,
                "tags": tags if isinstance(tags, list) else [],
                "source": source or "unknown",
                "score": int(score or 0),
            }
        )
    return out

def _mem_pg_stats() -> tuple[int, list]:
    import psycopg2
    dsn = _mem_db_url()
    conn = psycopg2.connect(dsn)
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM amauta_memory")
    row = cur.fetchone()
    total = int(row[0]) if row else 0
    cur.execute("SELECT COALESCE(agent_id, 'unknown') AS a, COUNT(*) AS n FROM amauta_memory GROUP BY a ORDER BY n DESC, a ASC")
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return total, rows


def _skb_search(query: str, top_k: int = 5) -> list:
    """
    Search agent_shared_knowledge — the curated global KB of policies,
    workflow guides, bug fixes, and routing rules.
    Returns list of dicts with keys: title, content, category, tags, importance.
    Best-effort — never raises.
    """
    if not _mem_pg_available():
        return []
    try:
        import psycopg2
        conn = psycopg2.connect(_mem_db_url())
        cur = conn.cursor()
        terms = [t.strip() for t in re.split(r"\s+", query.strip()) if t.strip() and len(t) > 2]
        if not terms:
            cur.close(); conn.close()
            return []
        # Score by term frequency in title+content, rank by importance DESC
        where_parts, score_parts, params, score_params = [], [], [], []
        for t in terms[:6]:
            pat = f"%{t}%"
            where_parts.append("(lower(title) LIKE lower(%s) OR lower(content) LIKE lower(%s) OR lower(tags::text) LIKE lower(%s))")
            params.extend([pat, pat, pat])
            score_parts.append("(CASE WHEN lower(title) LIKE lower(%s) THEN 2 WHEN lower(content) LIKE lower(%s) THEN 1 ELSE 0 END)")
            score_params.extend([pat, pat])
        sql = f"""
            SELECT title, content, category, tags, COALESCE(importance, 5) as imp,
                   ({' + '.join(score_parts)}) AS score
            FROM agent_shared_knowledge
            WHERE {' OR '.join(where_parts)}
            ORDER BY score DESC, imp DESC
            LIMIT %s
        """
        cur.execute(sql, score_params + params + [max(1, top_k)])
        rows = cur.fetchall()
        cur.close(); conn.close()
        return [
            {"title": r[0], "content": r[1], "category": r[2],
             "tags": r[3] if isinstance(r[3], list) else [],
             "importance": r[4], "score": int(r[5] or 0)}
            for r in rows if int(r[5] or 0) >= 1
        ]
    except Exception:
        return []


def _skb_promote(title: str, content: str, category: str, agent_id: str = "system",
                 tags: Optional[list] = None, importance: int = 7):
    """
    Write a new entry to agent_shared_knowledge (the curated global KB).
    Called when a high-value pattern is detected (repeated validation passes,
    distilled best practices, critical policy confirmations).
    Best-effort — never raises.
    """
    if not _mem_pg_available():
        return
    try:
        import psycopg2
        conn = psycopg2.connect(_mem_db_url())
        conn.autocommit = True
        cur = conn.cursor()
        # Dedup: skip if a very similar title already exists
        cur.execute("SELECT COUNT(*) FROM agent_shared_knowledge WHERE lower(title) = lower(%s)", (title,))
        _row = cur.fetchone()
        if _row and _row[0] > 0:
            cur.close(); conn.close()
            return
        now = datetime.now(timezone.utc)
        entry_id = f"SKB-{uuid.uuid4().hex[:12]}"
        cur.execute("""
            INSERT INTO agent_shared_knowledge
                (id, title, content, category, agent_id, tags, importance, created_at, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s)
        """, (entry_id, title, content, category, agent_id,
              json.dumps(tags or []), importance, now, now))
        cur.close(); conn.close()
    except Exception:
        pass


def _mem_log_event(agent_id: str, tags: list[str], text: str, *, source: str = "task_event", metadata: Optional[dict] = None):
    """Best-effort event logger into shared memory.
    Writes to PostgreSQL when configured, otherwise falls back to JSONL.
    For auto_learning and web_search_result: deduplicates by task_id to prevent
    the same task writing learning multiple times.
    Never raises (telemetry must not break task operations).
    """
    clean_tags = [str(t).strip() for t in (tags or []) if str(t).strip()]
    row = {
        "ts": _now(),
        "agent_id": agent_id or "system",
        "tags": clean_tags,
        "text": text,
    }
    try:
        if _mem_pg_available():
            import psycopg2

            now = datetime.now(timezone.utc)
            dsn = _mem_db_url()
            conn = psycopg2.connect(dsn)
            conn.autocommit = True
            cur = conn.cursor()

            # Dedup: for learning sources, check if we already wrote for this task
            if source in ("auto_learning", "web_search_result") and metadata:
                task_id = (metadata or {}).get("task_id", "")
                if task_id:
                    cur.execute(
                        "SELECT COUNT(*) FROM amauta_memory WHERE source=%s AND metadata->>'task_id'=%s",
                        (source, task_id)
                    )
                    existing = cur.fetchone()
                    if existing and existing[0] >= 3:
                        # Already have 3+ entries for this task+source — skip to prevent flooding
                        cur.close(); conn.close()
                        return

            cur.execute(
                """
                INSERT INTO amauta_memory (id, text, agent_id, source, tags, metadata, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s)
                """,
                (
                    f"MEM-{uuid.uuid4().hex[:12]}",
                    text,
                    agent_id or "system",
                    source,
                    json.dumps(clean_tags),
                    json.dumps(metadata or {}),
                    now,
                    now,
                ),
            )
            cur.close()
            conn.close()
        else:
            _mem_append(row)
    except Exception:
        try:
            _mem_append(row)
        except Exception:
            pass


def _mem_log_task_transition(item: dict, old_status: str, new_status: str, actor: str, note: str = ""):
    task_id = str(item.get("id", ""))
    title = str(item.get("title", ""))
    owner = str(item.get("assigned_to") or item.get("agent") or "unassigned")
    text = f"TASK EVENT: {task_id} status {old_status}->{new_status} by @{actor}. owner=@{owner}. title={title}"
    if note:
        text += f". note={note[:240]}"

    tags = [
        "task",
        task_id.lower(),
        "event:status_change",
        f"status:{new_status}",
        f"from:{old_status}",
    ]
    low_note = (note or "").lower()
    if new_status in ("failed", "deferred") or "fail" in low_note or "blocked" in low_note or "gate_fail" in low_note:
        tags += ["failure", "autolearn"]
    if new_status == "done":
        tags += ["success"]

    _mem_log_event(
        actor or "system",
        tags,
        text,
        source="task_event",
        metadata={
            "task_id": task_id,
            "old_status": old_status,
            "new_status": new_status,
            "assigned_to": owner,
            "priority": item.get("priority", ""),
            "event": "status_change",
        },
    )

def cmd_memory(args):
    if args.mem_cmd == "add":
        tags = [t.strip() for t in (args.tags or "").split(",") if t.strip()]
        agent_id = args.agent_id or "unknown"
        try:
            if _mem_pg_available():
                _mem_pg_add(agent_id, tags, args.text)
            else:
                row = {"ts": _now(), "agent_id": agent_id, "tags": tags, "text": args.text}
                _mem_append(row)
        except Exception as e:
            row = {"ts": _now(), "agent_id": agent_id, "tags": tags, "text": args.text}
            _mem_append(row)
            print(dim(f"memory fallback(file): {e}"))
        print(c("Memory added", GREEN))
        return

    rows = _mem_load()
    if _mem_pg_available():
        try:
            if args.mem_cmd == "stats":
                total, pg_rows = _mem_pg_stats()
                print(c(f"entries: {total}", CYAN))
                for a, n in pg_rows:
                    print(f"  @{a}: {n}")
                return
            if args.mem_cmd == "search":
                rows = _mem_pg_search(args.query or "", args.agent_id, args.top_k)
        except Exception as e:
            print(dim(f"memory fallback(file): {e}"))

    if args.mem_cmd == "stats":
        by_agent = {}
        for r in rows:
            a = r.get("agent_id", "unknown")
            by_agent[a] = by_agent.get(a, 0) + 1
        print(c(f"entries: {len(rows)}", CYAN))
        for a, n in sorted(by_agent.items(), key=lambda x: (-x[1], x[0])):
            print(f"  @{a}: {n}")
        return

    if args.mem_cmd == "search":
        q = (args.query or "").strip().lower()
        if not q:
            print(c("query is required", RED))
            sys.exit(1)
        q_terms = [t for t in re.split(r"\s+", q) if t]

        scored = []
        for r in rows:
            if args.agent_id and r.get("agent_id") != args.agent_id:
                continue
            tag_txt = " ".join(r.get("tags", []) if isinstance(r.get("tags"), list) else [])
            hay = f"{r.get('text','')} {tag_txt}".lower()
            score = sum(hay.count(t) for t in q_terms)
            if score > 0 or q in hay:
                scored.append((score, r))

        scored.sort(key=lambda x: (-x[0], x[1].get("ts", "")))
        top = scored[: max(1, args.top_k)]

        if args.json:
            print(json.dumps([r for _, r in top], indent=2))
            return

        if not top:
            print(dim("no memory hits"))
            return
        for score, r in top:
            src = r.get("source", "")
            src_label = f" [{src}]" if src else ""
            print(c(f"[{r.get('ts','')}] @{r.get('agent_id','unknown')} score={score}{src_label}", CYAN))
            if r.get("tags"):
                tags_list = r.get("tags", [])
                if isinstance(tags_list, list):
                    print(dim("  tags: " + ", ".join(str(t) for t in tags_list[:8])))
            print("  " + (r.get("text", "")[:300]))

# ── ID generation ──────────────────────────────────────────────────────────────
def _next_id(items: list, itype: str) -> str:
    pre = PREFIX[itype]
    nums = [
        int(i["id"].split("-")[1])
        for i in items
        if i.get("type") == itype
        and "-" in i["id"]
        and i["id"].split("-")[0] == pre
        and i["id"].split("-")[1].isdigit()
    ]
    return f"{pre}-{(max(nums, default=0) + 1):04d}"

# ── Schema factory ─────────────────────────────────────────────────────────────
def _new_item(itype: str, title: str) -> dict:
    """Return a fully-populated item skeleton with all v2 fields."""
    return {
        # ── Core identity ──────────────────────────────────────────────────
        "id":           "",           # set by caller
        "type":         itype,
        "title":        title,
        "description":  "",           # what + why (1-3 sentences)
        "details":      "",           # full context: background, constraints, approach hints
        # ── Work definition ────────────────────────────────────────────────
        "test_strategy":     "",      # how to verify this is truly done
        "success_criteria":  [],      # list[str] — specific pass conditions
        "deliverables":      [],      # list[str] — concrete outputs expected
        "risks":             [],      # list[{risk, mitigation}]
        # ── File/context references ────────────────────────────────────────
        "doc_refs": [],               # list[{path, type, title, note}]
                                      # types: workspace_file, shared_kb, memory_note,
                                      #        external_url, code_file, config_file, other
        # ── RPETD inline work log ──────────────────────────────────────────
        "rpetd_phases": {
            "R": "",   # Research  — what was found
            "P": "",   # Plan      — what will be done
            "E": "",   # Execute   — what was done
            "T": "",   # Test      — evidence of verification
            "D": "",   # Document  — what was documented/updated
        },
        "rpetd_complete": False,
        # ── Scheduling / capacity ──────────────────────────────────────────
        "estimated_hours": None,      # float
        "due_date":        None,      # ISO date string YYYY-MM-DD
        "sprint":          None,      # sprint name/label
        # ── Priority scoring (1-5 each) ────────────────────────────────────
        # Score = (importance×0.4) + (urgency×0.3) + (dep_count×0.3)
        # `next` uses this to rank tasks per agent
        "importance": 3,              # 1=nice-to-have … 5=business-critical
        "urgency":    3,              # 1=someday … 5=blocking right now
        # ── Hierarchy ─────────────────────────────────────────────────────
        "parent":       None,
        "children":     [],
        "dependencies": [],           # list of IDs this item blocks on
        # ── Assignment ────────────────────────────────────────────────────
        "assigned_to": "unassigned",
        "claimed_at":  None,          # when agent claimed it
        "claimed_by":  None,          # which agent claimed it
        # ── Classification ────────────────────────────────────────────────
        "status":   "pending",
        "priority": "medium",
        "tags":     [],
        # ── Validation ────────────────────────────────────────────────────
        "validation_checklist": [],   # list[str] — items validator must tick
        "validation_notes":     "",
        "validated_by":         "",
        # ── Notes / audit trail ────────────────────────────────────────────
        "notes": [],                  # list[{ts, by, text}]
        # ── Timestamps ────────────────────────────────────────────────────
        "created_at": _now(),
        "updated_at": _now(),
    }

# ── Finders ────────────────────────────────────────────────────────────────────
def _find(items: list, item_id: str) -> Optional[dict]:
    u = item_id.upper()
    return next((i for i in items if i["id"].upper() == u), None)

def _append_note(item: dict, text: str, by: str = "system"):
    item.setdefault("notes", []).append({"ts": _now(), "by": by, "text": text})


def _normalize_tags(tags: list) -> list:
    out = []
    seen = set()
    for t in tags or []:
        s = str(t).strip().lower().replace(" ", "-")
        if not s:
            continue
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def _is_memory_hygiene_task(item: dict) -> bool:
    text = " ".join([
        str(item.get("title", "")),
        str(item.get("description", "")),
        str(item.get("details", "")),
        " ".join(item.get("deliverables", []) or []),
        " ".join(item.get("success_criteria", []) or []),
    ]).lower()
    return (
        "memory.md stale" in text
        or ("memory.md" in text and "c3" in text)
        or "c3 checklist" in text
    )


def _infer_lane(item: dict) -> str:
    owner = (item.get("assigned_to") or item.get("agent") or "").strip().lower()
    non_code_agents = {"researcher", "finance", "marketing", "security-auditor", "operator", "validator",
                       "public-relations", "accountant", "legal"}
    if _is_memory_hygiene_task(item):
        return "non-code"
    if owner in non_code_agents:
        return "non-code"
    if owner:
        return "code"
    text = " ".join([
        str(item.get("title", "")),
        str(item.get("description", "")),
        str(item.get("details", "")),
    ]).lower()
    if any(k in text for k in ["research", "report", "analysis", "spec", "strategy", "audit"]):
        return "non-code"
    return "code"


def _infer_domain_tags(item: dict) -> list:
    text = " ".join([
        str(item.get("title", "")),
        str(item.get("description", "")),
        str(item.get("details", "")),
        " ".join(item.get("deliverables", []) or []),
        " ".join(item.get("success_criteria", []) or []),
    ]).lower()
    out = []
    for tag, hints in DOMAIN_TAG_HINTS.items():
        if any(h in text for h in hints):
            out.append(tag)
    return out


def _augment_task_metadata(item: dict):
    tags = list(item.get("tags") or [])
    lane = _infer_lane(item)
    tags += [
        f"lane:{lane}",
        f"priority:{str(item.get('priority', 'medium')).lower()}",
    ]
    if item.get("id"):
        tags.append(item["id"].lower())
    if item.get("assigned_to") and item.get("assigned_to") != "unassigned":
        tags.append(f"agent:{item['assigned_to']}")
    tags += _infer_domain_tags(item)

    # Non-code tasks should never require gitflow gates.
    if lane == "non-code":
        tags += ["non-code", "no-gitflow"]

    item["tags"] = _normalize_tags(tags)

    checklist = list(item.get("validation_checklist") or [])
    if not checklist:
        if lane == "code":
            checklist = [
                "RPETD R/P/E/T/D logged",
                "E phase includes branch evidence",
                "T phase includes actual command output",
                "D phase includes PR URL",
                "All success criteria met",
            ]
        else:
            checklist = [
                "RPETD R/P/E/T/D logged",
                "Artifact path(s) documented",
                "Verification command output captured",
                "All success criteria met",
            ]
    item["validation_checklist"] = checklist


def _task_hygiene_gaps(item: dict) -> list:
    gaps = []
    if not str(item.get("description", "")).strip():
        gaps.append("missing_description")
    if not str(item.get("details", "")).strip():
        gaps.append("missing_details")
    if not str(item.get("test_strategy", "")).strip():
        gaps.append("missing_test_strategy")
    if not (item.get("success_criteria") or []):
        gaps.append("missing_success_criteria")
    if not (item.get("doc_refs") or []):
        gaps.append("missing_doc_refs")
    return gaps


GATE_COOLDOWN_MINUTES = int(os.environ.get("AMAUTA_GATE_COOLDOWN_MINUTES", "20"))


def _parse_iso(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except Exception:
        return None


def _gate_fail_age_seconds(item: dict) -> Optional[int]:
    now = datetime.now(timezone.utc)
    for n in reversed(item.get("notes", []) or []):
        if isinstance(n, str):
            txt = n
        else:
            txt = str((n or {}).get("text", ""))
        if "GATE_FAIL:" not in txt:
            continue
        if isinstance(n, str):
            ts = _parse_iso(str(item.get("updated_at", "")))
        else:
            ts = _parse_iso(str((n or {}).get("ts", ""))) or _parse_iso(str(item.get("updated_at", "")))
        if not ts:
            return 0
        return max(0, int((now - ts).total_seconds()))
    return None


def _in_gate_cooldown(item: dict) -> bool:
    age = _gate_fail_age_seconds(item)
    return age is not None and age < (GATE_COOLDOWN_MINUTES * 60)


# ── Priority score ─────────────────────────────────────────────────────────────
def _score(item: dict, all_items: list) -> float:
    """
    Weighted priority score used by `next` to rank tasks.
    Score = (importance×0.4) + (urgency×0.3) + (dep_pressure×0.3)
    dep_pressure = number of OTHER items that depend on this one (capped at 5).
    """
    imp = max(1, min(5, item.get("importance", 3)))
    urg = max(1, min(5, item.get("urgency", 3)))
    # How many items depend on this one (it's blocking them)
    iid = item["id"]
    blocking = sum(1 for x in all_items if iid in x.get("dependencies", []))
    dep_p = min(5, blocking)
    # Boost critical priority
    if item.get("priority") == "critical":
        imp = min(5, imp + 1)
    # Due-date urgency bump
    if item.get("due_date"):
        try:
            due = datetime.fromisoformat(str(item["due_date"]))
            days_left = (due - datetime.now()).days
            if days_left <= 0:
                urg = 5
            elif days_left <= 1:
                urg = min(5, urg + 2)
            elif days_left <= 3:
                urg = min(5, urg + 1)
        except Exception:
            pass
    return round((imp * 0.4) + (urg * 0.3) + (dep_p * 0.3), 2)

def _deps_met(item: dict, all_items: list) -> bool:
    """True if all dependencies are done."""
    for dep_id in item.get("dependencies", []):
        dep = _find(all_items, dep_id)
        if dep and dep.get("status") != "done":
            return False
    return True

# ── Pretty print helpers ───────────────────────────────────────────────────────
def _type_label(itype: str) -> str:
    return c(f"[{itype.upper()[:2]}]", TYPE_COL.get(itype, WHITE))

def _status_label(status: str) -> str:
    icon = STATUS_ICON.get(status, "?")
    return c(f"{icon} {status}", STATUS_COL.get(status, WHITE))

def _priority_label(priority: str) -> str:
    return c(priority.upper(), PRIORITY_COL.get(priority, WHITE))

def _print_item_line(item: dict, indent: int = 0, score: Optional[float] = None):
    pad = "  " * indent
    tl  = _type_label(item.get("type", "task"))
    sl  = _status_label(item.get("status", "pending"))
    pl  = _priority_label(item.get("priority", "medium"))
    ag  = item.get("assigned_to", "unassigned")
    iid = bold(item["id"])
    sc_str = dim(f"  score:{score}") if score is not None else ""
    sprint = f"  [{item['sprint']}]" if item.get("sprint") else ""
    print(f"{pad}{tl} {iid}  {sl}  {pl}  @{ag}{sprint}{sc_str}")
    print(f"{pad}   {item['title']}")
    if item.get("description"):
        print(f"{pad}   {dim(item['description'][:120])}")
    tags = item.get("tags", [])
    if tags:
        print(f"{pad}   {dim('tags: ' + ', '.join(tags))}")

def _print_item_full(item: dict, all_items: list):
    """Detailed single-item view."""
    tl = _type_label(item.get("type", "task"))
    print(f"\n{tl} {bold(item['id'])} — {item['title']}")
    print(f"  Status:    {_status_label(item.get('status','pending'))}")
    print(f"  Priority:  {_priority_label(item.get('priority','medium'))}")
    print(f"  Assigned:  @{item.get('assigned_to','unassigned')}")
    sc = _score(item, all_items)
    print(f"  Score:     {sc}  (importance={item.get('importance',3)} urgency={item.get('urgency',3)})")

    for label, key in [
        ("Description",   "description"),
        ("Details",       "details"),
        ("Test Strategy", "test_strategy"),
    ]:
        val = item.get(key, "")
        if val:
            print(f"\n  {bold(label)}:")
            for line in val.split("\n"):
                print(f"    {line}")

    for label, key in [
        ("Success Criteria",     "success_criteria"),
        ("Deliverables",         "deliverables"),
        ("Validation Checklist", "validation_checklist"),
    ]:
        lst = item.get(key, [])
        if lst:
            print(f"\n  {bold(label)}:")
            for entry in lst:
                print(f"    • {entry}")

    risks = item.get("risks", [])
    if risks:
        print(f"\n  {bold('Risks')}:")
        for r in risks:
            if isinstance(r, dict):
                print(f"    ⚠ {r.get('risk','?')}")
                if r.get("mitigation"):
                    print(f"      → {r['mitigation']}")
            else:
                print(f"    ⚠ {r}")

    refs = item.get("doc_refs", [])
    if refs:
        print(f"\n  {bold('References')}:")
        for r in refs:
            if isinstance(r, str):
                print(f"    {r}")
            elif isinstance(r, dict):
                title = r.get("title") or r.get("path", "")
                rtype = r.get("type", "")
                note  = f"  — {r['note']}" if r.get("note") else ""
                print(f"    [{rtype}] {r.get('path','')}  {dim(title)}{dim(note)}")
            else:
                print(f"    {r}")

    # RPETD phases
    phases = item.get("rpetd_phases", {})
    has_phases = any(phases.get(ph, "") for ph in PHASES)
    if has_phases:
        complete = item.get("rpetd_complete", False)
        status_str = c("COMPLETE", GREEN) if complete else c("IN PROGRESS", YELLOW)
        print(f"\n  {bold('RPETD')} ({status_str}):")
        for ph in PHASES:
            content = phases.get(ph, "")
            ph_label = f"  [{ph}] {PHASE_NAMES[ph]}:"
            if content:
                print(f"  {bold(ph_label)}")
                for line in content[:300].split("\n"):
                    print(f"      {line}")
                if len(content) > 300:
                    print(f"      {dim('… (truncated, use show --json for full)')}")
            else:
                print(f"  {dim(ph_label + ' (empty)')}")

    # Hierarchy
    if item.get("parent"):
        print(f"\n  Parent:       {item['parent']}")
    if item.get("children"):
        print(f"  Children:     {', '.join(item['children'])}")
    if item.get("dependencies"):
        print(f"  Depends on:   {', '.join(item['dependencies'])}")

    # Scheduling
    sched = []
    if item.get("sprint"):     sched.append(f"Sprint: {item['sprint']}")
    if item.get("due_date"):   sched.append(f"Due: {item['due_date']}")
    if item.get("estimated_hours"): sched.append(f"Est: {item['estimated_hours']}h")
    if sched:
        print(f"\n  {bold('Schedule')}: {' | '.join(sched)}")

    # Validation
    if item.get("validation_notes") or item.get("validated_by"):
        print(f"\n  {bold('Validation')}: {item.get('validation_notes','')}  by @{item.get('validated_by','')}")

    # Notes
    notes = item.get("notes", [])
    if notes:
        print(f"\n  {bold('Notes')} ({len(notes)}):")
        for n in notes[-5:]:
            if isinstance(n, str):
                print(f"    {dim('')} {n}")
                continue
            by  = n.get("by", "?")
            ts  = _fmt_ts(n.get("ts", ""))
            txt = n.get("text", "")
            print(f"    {dim(ts)} @{by}: {txt}")
        if len(notes) > 5:
            print(f"    {dim(f'… {len(notes)-5} older notes (use show --json)')}")

    print(f"\n  Created: {_fmt_ts(item.get('created_at',''))}  "
          f"Updated: {_fmt_ts(item.get('updated_at',''))}")
    if item.get("claimed_by"):
        print(f"  Claimed: @{item['claimed_by']} at {_fmt_ts(item.get('claimed_at',''))}")


# ══════════════════════════════════════════════════════════════════════════════
# ── RLM / REPL + PostgreSQL Context Enrichment Engine ─────────────────────────
# ══════════════════════════════════════════════════════════════════════════════
# Three enrichment layers:
#   Layer 1: _enrich_task_context() — claim-time: parent/sibling/PG memory/SKB context
#   Layer 2: _rpetd_phase_enrich()  — per-phase: ALL 5 phases covered:
#     R: RLM architecture analysis + PG memory (related experiences) + SKB (global KB)
#     P: RLM plan review vs architecture + SKB (workflow guides)
#     E: RLM execution review (branch name, commit format, file coverage) + PG failure history
#     T: RLM criteria validation (or PG fallback if no criteria)
#     D: RLM delivery quality check (PR completeness vs criteria) + PG delivery event write
#        + auto-promotes successful delivery patterns to agent_shared_knowledge
#   Layer 3: RLM client --enrich    — agent-initiated: amauta_memory + SKB injected into
#            every RLM call via _fetch_pg_context() + _fetch_skb() in rlm_client.py
#
# agent_shared_knowledge (global curated KB, 84 entries):
#   READ:  _skb_search() — called in R-phase, P-phase, claim-time enrichment, rlm_client
#   WRITE: _skb_promote() — called in D-phase (delivery patterns) + validation passes
#
# All enrichment is best-effort — never blocks, never raises, never breaks flow.
# ══════════════════════════════════════════════════════════════════════════════

# ── Domain document mapping for RLM architecture queries ─────────────────────
_DOMAIN_DOCS = {
    # ── Code domains ──────────────────────────────────────────────────────────
    "frontend":    "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "backend":     "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "billing":     "/srv/amauta/shared-kb/AUGMENT_CREDITS_MODEL.md",
    "pricing":     "/srv/amauta/shared-kb/AUGMENT_CREDITS_MODEL.md",
    "stripe":      "/srv/amauta/shared-kb/AUGMENT_CREDITS_MODEL.md",
    "checkout":    "/srv/amauta/shared-kb/AUGMENT_CREDITS_MODEL.md",
    "credit":      "/srv/amauta/shared-kb/AUGMENT_CREDITS_MODEL.md",
    "social":      "/srv/amauta/shared-kb/AUGMENT_SOCIAL_LAYER.md",
    "profile":     "/srv/amauta/shared-kb/AUGMENT_SOCIAL_LAYER.md",
    "community":   "/srv/amauta/shared-kb/AUGMENT_SOCIAL_LAYER.md",
    "auth":        "/srv/amauta/shared-kb/AUGMENT_PLATFORM.md",
    "seo":         "/srv/amauta/shared-kb/AUGMENT_PLATFORM.md",
    "api":         "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "job":         "/srv/amauta/shared-kb/AUGMENT_PLATFORM.md",
    "infra":       "/srv/amauta/shared-kb/ARCHITECTURE.md",
    "docker":      "/srv/amauta/shared-kb/ARCHITECTURE.md",
    "nginx":       "/srv/amauta/shared-kb/ARCHITECTURE.md",
    "deploy":      "/srv/amauta/shared-kb/ARCHITECTURE.md",
    "container":   "/srv/amauta/shared-kb/ARCHITECTURE.md",
    "systemd":     "/srv/amauta/shared-kb/ARCHITECTURE.md",
    "saas":        "/srv/amauta/shared-kb/AMAUTA_SAAS_ARCHITECTURE.md",
    "leaderboard": "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "xp":          "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "league":      "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "match":       "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "supabase":    "/srv/amauta/shared-kb/SUPABASE_GUIDE.md",
    "database":    "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "postgres":    "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "drizzle":     "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "dashboard":   "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md",
    "integration": "/srv/amauta/shared-kb/INTEGRATIONS.md",
    "webhook":     "/srv/amauta/shared-kb/INTEGRATIONS.md",
    "hybrid":      "/srv/amauta/shared-kb/HYBRID_ARCHITECTURE_GUIDE.md",
    "dual":        "/srv/amauta/shared-kb/DUAL_LLM_ARCHITECTURE_SPEC.md",
    "agentic":     "/srv/amauta/shared-kb/AGENTIC_AI_DESIGN_PATTERNS.md",
    "pattern":     "/srv/amauta/shared-kb/AGENTIC_AI_DESIGN_PATTERNS.md",
    "automation":  "/srv/amauta/shared-kb/AUTOMATION.md",
    "decision":    "/srv/amauta/shared-kb/AUGMENT_DECISIONS_LOG.md",
    "knowledge":   "/srv/amauta/shared-kb/KNOWLEDGE_BASE.md",
    # ── Non-code domains (researcher/finance/marketing/legal/security) ────────
    "revenue":     "/srv/amauta/shared-kb/REVENUE_ARCHITECTURE.md",
    "finance":     "/srv/amauta/shared-kb/FINANCE_SAAS_V3.md",
    "financial":   "/srv/amauta/shared-kb/FINANCE_SAAS_V3.md",
    "payment":     "/srv/amauta/shared-kb/FINANCE_SAAS_V3.md",
    "invoice":     "/srv/amauta/shared-kb/FINANCE_SAAS_V3.md",
    "subscription":"/srv/amauta/shared-kb/FINANCE_SAAS_V3.md",
    "budget":      "/srv/amauta/shared-kb/FINANCE_SAAS_V3.md",
    "accounting":  "/srv/amauta/shared-kb/FINANCE_SAAS_V3.md",
    "research":    "/srv/amauta/shared-kb/AGENT_SYSTEM_KNOWLEDGE.md",
    "analysis":    "/srv/amauta/shared-kb/AGENT_SYSTEM_KNOWLEDGE.md",
    "report":      "/srv/amauta/shared-kb/AGENT_SYSTEM_KNOWLEDGE.md",
    "market":      "/srv/amauta/shared-kb/GTM_PLAN.md",
    "competitor":  "/srv/amauta/shared-kb/GTM_PLAN.md",
    "gtm":         "/srv/amauta/shared-kb/GTM_PLAN.md",
    "marketing":   "/srv/amauta/shared-kb/GTM_PLAN.md",
    "content":     "/srv/amauta/shared-kb/GTM_PLAN.md",
    "brand":       "/srv/amauta/shared-kb/GTM_PLAN.md",
    "campaign":    "/srv/amauta/shared-kb/GTM_PLAN.md",
    "growth":      "/srv/amauta/shared-kb/GTM_PLAN.md",
    "sales":       "/srv/amauta/shared-kb/GTM_PLAN.md",
    "security":    "/srv/amauta/shared-kb/SECURITY_POLICY.md",
    "audit":       "/srv/amauta/shared-kb/AUDIT_RUNBOOK.md",
    "cve":         "/srv/amauta/shared-kb/SECURITY_POLICY.md",
    "vulnerab":    "/srv/amauta/shared-kb/SECURITY_POLICY.md",
    "compliance":  "/srv/amauta/shared-kb/SECURITY_POLICY.md",
    "gdpr":        "/srv/amauta/shared-kb/SECURITY_POLICY.md",
    "legal":       "/srv/amauta/shared-kb/SECURITY_POLICY.md",
    "privacy":     "/srv/amauta/shared-kb/SECURITY_POLICY.md",
    "licensing":   "/srv/amauta/shared-kb/SECURITY_POLICY.md",
    "frontend_sec":"/srv/amauta/shared-kb/FRONTEND_SECURITY.md",
    "vps":         "/srv/amauta/shared-kb/VPS_SECURITY_AUDIT.md",
    "orchestrat":  "/srv/amauta/shared-kb/AGENT_SYSTEM_KNOWLEDGE.md",
    "coordinat":   "/srv/amauta/shared-kb/COLLABORATION.md",
    "collaborat":  "/srv/amauta/shared-kb/COLLABORATION.md",
    "roster":      "/srv/amauta/shared-kb/AGENT_ROSTER.md",
    "agent":       "/srv/amauta/shared-kb/AGENT_ROSTER.md",
    "system":      "/srv/amauta/shared-kb/SYSTEM.md",
    "architecture":"/srv/amauta/shared-kb/ARCHITECTURE.md",
    "ideas":       "/srv/amauta/shared-kb/IDEAS_SYSTEM.md",
    "vote":        "/srv/amauta/shared-kb/IDEAS_SYSTEM.md",
    "daily":       "/srv/amauta/shared-kb/IDEAS_SYSTEM.md",
    "git":         "/srv/amauta/shared-kb/GIT_WORKFLOW.md",
    "workflow":    "/srv/amauta/shared-kb/GIT_WORKFLOW.md",
    "gitflow":     "/srv/amauta/shared-kb/GIT_WORKFLOW.md",
    "branch":      "/srv/amauta/shared-kb/GIT_WORKFLOW.md",
    "pull request":"/srv/amauta/shared-kb/GIT_WORKFLOW.md",
    "dreamteam":   "/srv/amauta/shared-kb/DREAMTEAM_SPEC.md",
    "tournament":  "/srv/amauta/shared-kb/DREAMTEAM_SPEC.md",
    "bracket":     "/srv/amauta/shared-kb/DREAMTEAM_SPEC.md",
    "fantasy":     "/srv/amauta/shared-kb/DREAMTEAM_SPEC.md",
    "football":    "/srv/amauta/shared-kb/API_FOOTBALL_EVENT_MAPPING.md",
    "rlm":         "/srv/amauta/shared-kb/RLM_USAGE.md",
    "memory":      "/srv/openclaw/shared-kb/SHARED_MEMORY.md",
    "shared_mem":  "/srv/openclaw/shared-kb/SHARED_MEMORY.md",
    "rpetd":       "/srv/amauta/shared-kb/RPETD_SLA_POLICY.md",
    "phase":       "/srv/amauta/shared-kb/RPETD_SLA_POLICY.md",
    "subagent":    "/srv/amauta/shared-kb/SUBAGENT_PATTERNS.md",
    "parallel":    "/srv/amauta/shared-kb/SUBAGENT_PATTERNS.md",
    "session":     "/srv/amauta/shared-kb/SUBAGENT_PATTERNS.md",
    "perplexity":  "/srv/amauta/shared-kb/PERPLEXITY_API.md",
    "web_search":  "/srv/amauta/shared-kb/PERPLEXITY_API.md",
    "amauta":      "/srv/amauta/shared-kb/AMAUTA_GUIDE.md",
    "guide":       "/srv/amauta/shared-kb/AMAUTA_GUIDE.md",
    "distill":     "/srv/amauta/shared-kb/MEMORY_COMPACTION_PROTOCOL.md",
    "compaction":  "/srv/amauta/shared-kb/MEMORY_COMPACTION_PROTOCOL.md",
    "matchfantasy":"/srv/amauta/shared-kb/MATCHFANTASY_LESSONS.md",
    "lesson":      "/srv/amauta/shared-kb/MATCHFANTASY_LESSONS.md",
    "inter":       "/srv/amauta/shared-kb/INTER_SERVICE_CONNECTIONS.md",
    "service":     "/srv/amauta/shared-kb/INTER_SERVICE_CONNECTIONS.md",
}
_DEFAULT_DOC = "/srv/amauta/shared-kb/AUGMENT_ARCHITECTURE.md"


def _pick_domain_doc(title: str, desc: str) -> str:
    """Pick the best architecture doc based on task keywords.
    Returns the first matching doc that exists on disk.
    Multi-word keywords (like 'pull request') are supported.
    """
    text = (title + " " + desc).lower()
    for keyword, doc_path in _DOMAIN_DOCS.items():
        if keyword in text:
            if os.path.exists(doc_path):
                return doc_path
    # Fallback to default doc
    if os.path.exists(_DEFAULT_DOC):
        return _DEFAULT_DOC
    # Last resort: any existing doc
    for _, doc_path in _DOMAIN_DOCS.items():
        if os.path.exists(doc_path):
            return doc_path
    return ""


def _rlm_find_node() -> str:
    """Find node binary — try PATH, then NVM default, then common macOS locations."""
    import shutil
    node = shutil.which("node")
    if node:
        return node
    for candidate in [
        os.path.expanduser("~/.nvm/versions/node/v22.14.0/bin/node"),
        os.path.expanduser("~/.nvm/versions/node/v20.0.0/bin/node"),
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
    ]:
        if os.path.exists(candidate):
            return candidate
    return "node"  # last resort


def _rlm_find_cli() -> str:
    """Find gsd-rlm.cjs — prefer installed ~/.claude path, fallback to source repo."""
    candidates = [
        os.path.expanduser("~/.claude/get-shit-done/bin/gsd-rlm.cjs"),
        os.path.join(os.path.dirname(__file__), "..", "..", "..", ".claude",
                     "get-shit-done", "bin", "gsd-rlm.cjs"),
        os.path.join(os.path.dirname(__file__), "get-shit-done", "bin", "gsd-rlm.cjs"),
    ]
    for c in candidates:
        if os.path.exists(os.path.normpath(c)):
            return os.path.normpath(c)
    return ""


def _rlm_query(query: str, doc_path: str = "", text: str = "", task_id: str = "") -> str:
    """
    Call gsd-rlm.cjs query to get relevant code context.
    Uses --dir (for directory queries) or --path (for single-file queries).
    Returns top-k chunk text concatenated, or empty string on failure.
    Best-effort — never raises.
    """
    import subprocess
    try:
        node = _rlm_find_node()
        rlm_cli = _rlm_find_cli()
        if not rlm_cli:
            return ""

        # Determine query target: prefer doc_path, then project cwd
        if doc_path and os.path.isfile(doc_path):
            cmd = [node, rlm_cli, "query", query, "--path", doc_path, "--top-k", "3", "--compact"]
        elif doc_path and os.path.isdir(doc_path):
            cmd = [node, rlm_cli, "query", query, "--dir", doc_path, "--top-k", "3", "--compact"]
        elif text:
            # No path available — skip RLM (can't query plain text without a file)
            return ""
        else:
            # Query current working directory
            cwd = os.getcwd()
            cmd = [node, rlm_cli, "query", query, "--dir", cwd, "--top-k", "3", "--compact"]

        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30,
            env={**os.environ},
        )
        if result.returncode == 0 and result.stdout.strip():
            # Filter out the fallback "RLM service unavailable" message
            out = result.stdout.strip()
            if "Suggested @ references" in out or "RLM service unavailable" in out:
                return ""
            return out[:1200]
    except Exception:
        pass
    return ""


def _rpetd_phase_enrich(phase: str, item: dict, agent_content: str) -> str:
    """
    Enrich an RPETD phase with RLM analysis + PostgreSQL memory.
    Returns supplement string to append, or empty string.
    Best-effort — never raises, never blocks.
    """
    try:
        task_id = item.get("id", "")
        title = item.get("title", "")
        desc = item.get("description", "")
        criteria = item.get("success_criteria") or []
        criteria_str = " | ".join(str(c) for c in criteria[:5])

        supplement_parts = []

        _stop = {"the","a","an","and","or","for","to","in","on","of","is","it","with","from","by",
                 "all","this","that","be","as","at","have","do","not","but","are","was","were",
                 "augment","implement","build","add","create","fix","update","code"}
        _title_words = [w for w in re.split(r"\W+", title.lower()) if w and len(w) > 2 and w not in _stop]
        _search_q = " ".join(_title_words[:4])

        if phase == "R":
            # ── RLM architecture analysis ──────────────────────────────────
            doc_path = _pick_domain_doc(title, desc)
            if doc_path:
                rlm_answer = _rlm_query(
                    f"For the task '{title}': {desc[:300]}. Which existing components, files, or "
                    f"patterns in this architecture should be used or modified? Be specific about "
                    f"file paths, data models, and API endpoints.",
                    doc_path=doc_path,
                    task_id=task_id,
                )
                if rlm_answer:
                    supplement_parts.append(f"[RLM] Architecture analysis:\n  {rlm_answer[:600]}")

            # ── PostgreSQL memory: related experiences ─────────────────────
            if _search_q and _mem_pg_available():
                results = _mem_pg_search(_search_q, None, 5)
                relevant = [r for r in results
                            if r.get("score", 0) >= 2
                            and "event:claim" not in str(r.get("tags", []))]
                if relevant:
                    mem_lines = ["[PG] Related experiences:"]
                    for r in relevant[:3]:
                        mem_lines.append(f"  - {r['text'][:250].replace(chr(10), ' ')}")
                    supplement_parts.append("\n".join(mem_lines))

            # ── agent_shared_knowledge: global policies + workflow guides ──
            skb = _skb_search(_search_q or title, top_k=5)
            if skb:
                skb_lines = ["[SKB] Global knowledge base:"]
                for e in skb[:3]:
                    skb_lines.append(f"  [{e['category']}] {e['title']}: {e['content'][:200].replace(chr(10),' ')}")
                supplement_parts.append("\n".join(skb_lines))

        elif phase == "P":
            # ── RLM plan review against architecture ──────────────────────
            doc_path = _pick_domain_doc(title, desc)
            if doc_path and agent_content:
                rlm_answer = _rlm_query(
                    f"Review this plan for task '{title}': {agent_content[:600]}. Does it align "
                    f"with the architecture? Are there constraints, existing patterns, or risks "
                    f"the plan misses? What files should be modified?",
                    doc_path=doc_path,
                    task_id=task_id,
                )
                if rlm_answer:
                    supplement_parts.append(f"[RLM] Plan review:\n  {rlm_answer[:600]}")

            # ── agent_shared_knowledge: workflow guides relevant to plan ───
            skb = _skb_search(_search_q or title, top_k=3)
            if skb:
                skb_lines = ["[SKB] Relevant workflow guides:"]
                for e in skb[:2]:
                    skb_lines.append(f"  [{e['category']}] {e['title']}: {e['content'][:150].replace(chr(10),' ')}")
                supplement_parts.append("\n".join(skb_lines))

        elif phase == "E":
            # ── RLM execution analysis: catch bad commits / missing files ──
            if agent_content and len(agent_content.strip()) > 30:
                phases_so_far = item.get("rpetd_phases", {}) or {}
                plan_context = str(phases_so_far.get("P", ""))[:400]
                rlm_answer = _rlm_query(
                    f"Task '{title}'. Plan was: {plan_context}. "
                    f"Execution output: {agent_content[:600]}. "
                    f"Check: (1) Does the branch name follow feat/TK-XXXX-desc convention? "
                    f"(2) Are all files from the plan accounted for in the execution? "
                    f"(3) Does the commit message follow conventional commits format? "
                    f"(4) Any errors or blockers in the output? Flag any issues.",
                    text=agent_content[:3000],
                    task_id=task_id,
                )
                if rlm_answer:
                    supplement_parts.append(f"[RLM] Execution review:\n  {rlm_answer[:600]}")

            # ── PostgreSQL memory: any past failures on same domain ────────
            if _search_q and _mem_pg_available():
                results = _mem_pg_search(f"{_search_q} fail error blocker", None, 5)
                relevant = [r for r in results
                            if r.get("score", 0) >= 2
                            and any(kw in r.get("text","").lower()
                                    for kw in ("fail","error","blocker","blocked","timeout"))]
                if relevant:
                    mem_lines = ["[PG] Past execution failures (learn from these):"]
                    for r in relevant[:2]:
                        mem_lines.append(f"  - {r['text'][:200].replace(chr(10), ' ')}")
                    supplement_parts.append("\n".join(mem_lines))

        elif phase == "T":
            # ── RLM criteria validation ────────────────────────────────────
            if criteria_str and agent_content:
                rlm_answer = _rlm_query(
                    f"Task: '{title}'. Success criteria: {criteria_str}. "
                    f"Test output: {agent_content[:800]}. "
                    f"Does the test output demonstrate that ALL success criteria are met? List any gaps.",
                    text=agent_content[:2000],
                    task_id=task_id,
                )
                if rlm_answer:
                    supplement_parts.append(f"[RLM] Criteria check:\n  {rlm_answer[:600]}")
            elif agent_content and not criteria_str:
                if _mem_pg_available():
                    results = _mem_pg_search(f"{item.get('id','')} test validation", None, 3)
                    if results:
                        mem_lines = ["[PG] Past validation patterns:"]
                        for r in results[:2]:
                            mem_lines.append(f"  - {r['text'][:200].replace(chr(10), ' ')}")
                        supplement_parts.append("\n".join(mem_lines))

        elif phase == "D":
            # ── RLM delivery quality check ─────────────────────────────────
            if agent_content and len(agent_content.strip()) > 20:
                phases_so_far = item.get("rpetd_phases", {}) or {}
                t_phase = str(phases_so_far.get("T", ""))[:300]
                rlm_answer = _rlm_query(
                    f"Task '{title}'. Success criteria: {criteria_str or 'not specified'}. "
                    f"Test evidence: {t_phase}. "
                    f"Delivery description: {agent_content[:600]}. "
                    f"Check: (1) Does the PR/deliverable description reference the task ID? "
                    f"(2) Does it match what the success criteria required? "
                    f"(3) Is the PR URL present? "
                    f"(4) Any red flags that would cause validator to reject this?",
                    text=agent_content[:2000],
                    task_id=task_id,
                )
                if rlm_answer:
                    supplement_parts.append(f"[RLM] Delivery check:\n  {rlm_answer[:600]}")

            # ── Write delivery event to amauta_memory ─────────────────────
            if _mem_pg_available():
                _mem_log_event(
                    item.get("claimed_by", "system"),
                    ["task", task_id.lower(), "event:delivery", f"status:{item.get('status','')}"],
                    f"DELIVERY: {task_id} | {title} | {agent_content[:300]}",
                    source="rpetd_delivery",
                )

            # ── Auto-extract and persist web_search findings ───────────────
            # If agent included web_search results in D-phase or R-phase,
            # extract them and write to memory so they are searchable later.
            # This ensures web_search knowledge is NEVER lost between cycles.
            if _mem_pg_available():
                phases_for_ws = item.get("rpetd_phases", {}) or {}
                for _ph_name, _ph_content in [("R", phases_for_ws.get("R", "")),
                                               ("P", phases_for_ws.get("P", "")),
                                               ("D", agent_content)]:
                    if not _ph_content:
                        continue
                    # Look for web_search result blocks
                    ws_matches = re.findall(
                        r'web_search\s+findings?[:\s]+(.{30,500}?)(?:\n\n|\Z|LEARNING:|exec:|web_search:)',
                        str(_ph_content), re.I | re.S
                    )
                    if not ws_matches:
                        # Also capture anything after "web_search: " query line that looks like results
                        ws_matches = re.findall(
                            r'(?:web_search|perplexity)[^\n]*\n(.{50,400}?)(?:\n\n|\Z)',
                            str(_ph_content), re.I | re.S
                        )
                    for ws_result in ws_matches[:2]:
                        ws_text = ws_result.strip()
                        if len(ws_text) > 40:
                            agent_name = item.get("claimed_by") or item.get("assigned_to") or "system"
                            _mem_log_event(
                                agent_name,
                                ["web_search_result", task_id.lower(), f"phase:{_ph_name}",
                                 f"agent:{agent_name}", "autolearn"],
                                f"WEB_SEARCH FINDING [{_ph_name}-phase] {task_id} | {title[:60]}\n{ws_text[:400]}",
                                source="web_search_result",
                                metadata={"task_id": task_id, "phase": _ph_name, "event": "web_search_result"},
                            )

            # ── Auto-promote to SKB if high-quality delivery pattern ───────
            # When a task has clean RPETD and this is the D-phase, record the
            # delivery pattern in agent_shared_knowledge for future agents.
            if _search_q and criteria_str:
                phases_so_far = item.get("rpetd_phases", {}) or {}
                has_all = all(phases_so_far.get(p, "").strip() for p in ["R","P","E","T"])
                if has_all:
                    agent_name = item.get("claimed_by") or item.get("assigned_to") or "system"
                    lane = item.get("lane") or item.get("type") or "task"
                    _skb_promote(
                        title=f"DELIVERY PATTERN: {title[:80]}",
                        content=(
                            f"Task: {task_id} | Agent: {agent_name} | Lane: {lane}\n"
                            f"Criteria: {criteria_str[:300]}\n"
                            f"Delivery: {agent_content[:400]}"
                        ),
                        category="delivery",
                        agent_id=agent_name,
                        tags=["delivery", "rpetd", "pattern", f"agent:{agent_name}"],
                        importance=5,
                    )

        if supplement_parts:
            return "\n\n".join(supplement_parts)
    except Exception:
        pass
    return ""


def _enrich_task_context(item: dict, items: list) -> str:
    """
    Layer 1: Claim-time context enrichment.
    Pulls from parent tasks, sibling tasks, past failures,
    PG memory, previous attempts, and domain KB guides.
    Returns a context block (2-5KB) to inject into task notes.
    Best-effort — never raises.
    """
    try:
        parts = []
        task_id = item.get("id", "")
        title = item.get("title", "")
        desc = item.get("description", "")
        deps = item.get("dependencies") or []

        # ── Parent/dependency context ──────────────────────────────────
        if deps:
            for dep_id in deps[:3]:
                dep = _find(items, dep_id)
                if dep:
                    dep_phases = dep.get("rpetd_phases", {})
                    dep_notes = dep.get("notes") or []
                    summary = f"[DEP {dep_id}] {dep.get('title','')} (status={dep.get('status','')})"
                    if dep_phases.get("D"):
                        summary += f"\n  Delivery: {dep_phases['D'][:200]}"
                    if dep_notes:
                        last = dep_notes[-1] if isinstance(dep_notes[-1], str) else dep_notes[-1].get("text", "")
                        summary += f"\n  Last note: {str(last)[:150]}"
                    parts.append(summary)

        # ── Sibling tasks (same sprint/epic) ───────────────────────────
        sprint = item.get("sprint", "")
        if sprint:
            siblings = [i for i in items if i.get("sprint") == sprint
                       and i.get("id") != task_id
                       and i.get("status") in ("done", "in-progress")][:3]
            if siblings:
                sib_lines = [f"[SIBLING] Same sprint '{sprint}':"]
                for s in siblings:
                    sib_lines.append(f"  - {s['id']} {s.get('title','')} ({s.get('status','')})")
                parts.append("\n".join(sib_lines))

        # ── Past failures on this task ─────────────────────────────────
        notes = item.get("notes") or []
        fail_notes = [n for n in notes if isinstance(n, dict) and "FAIL" in str(n.get("text", "")).upper()]
        if not fail_notes:
            fail_notes = [n for n in notes if isinstance(n, str) and "FAIL" in n.upper()]
        if fail_notes:
            parts.append(f"[PAST FAILURES] {len(fail_notes)} previous failure(s):")
            for fn in fail_notes[-3:]:
                txt = fn.get("text", fn) if isinstance(fn, dict) else fn
                parts.append(f"  - {str(txt)[:200]}")

        # ── PG memory search for related experiences ───────────────────
        if _mem_pg_available():
            stop = {"the","a","an","and","or","for","to","in","on","of","is","it","with","from","by",
                     "all","this","that","be","as","at","have","do","not","but","are","code","augment"}
            words = [w for w in re.split(r"\W+", title.lower()) if w and len(w) > 2 and w not in stop]
            search_q = " ".join(words[:5])
            if search_q:
                # Search all sources — especially auto_learning and web_search_result
                results = _mem_pg_search(search_q, None, 8)
                relevant = [r for r in results
                           if r.get("score", 0) >= 2
                           and "event:claim" not in str(r.get("tags", []))
                           and task_id.lower() not in str(r.get("tags", []))]
                if relevant:
                    parts.append("[PG MEMORY] Related experiences (check these FIRST — avoid repeating work):")
                    for r in relevant[:4]:
                        src = r.get("source", "")
                        prefix = f"[{src}]" if src else ""
                        parts.append(f"  {prefix} {r['text'][:280].replace(chr(10), ' ')}")

            # ── Pull recent LEARNING + web_search_result from memory for same domain ──
            # This is the core of the "never repeat work" system
            if _mem_pg_available() and search_q:
                try:
                    import psycopg2
                    conn_e = psycopg2.connect(_mem_db_url())
                    conn_e.autocommit = True
                    cur_e = conn_e.cursor()
                    cur_e.execute("""
                        SELECT agent_id, source, text, created_at FROM gsd_memory
                        WHERE source IN ('auto_learning', 'web_search_result', 'lesson-learned', 'best-practice')
                          AND text ILIKE %s
                        ORDER BY created_at DESC
                        LIMIT 4
                    """, (f"%{words[0]}%" if words else "%",))
                    prior_learning = cur_e.fetchall()
                    cur_e.close(); conn_e.close()
                    if prior_learning:
                        learn_lines = ["[PRIOR LEARNING] Agents already learned this — use their findings:"]
                        for row_e in prior_learning:
                            learn_lines.append(f"  [{row_e[1]}@{row_e[3].isoformat()[:10]}] {str(row_e[2])[:240].replace(chr(10),' ')}")
                        parts.append("\n".join(learn_lines))
                except Exception:
                    pass

        # ── Domain KB guide reference ──────────────────────────────────
        doc_path = _pick_domain_doc(title, desc)
        if doc_path:
            parts.append(f"[DOMAIN KB] Reference: {os.path.basename(doc_path)}")

        # ── agent_shared_knowledge: global policies + best practices ──
        stop2 = {"the","a","an","and","or","for","to","in","on","of","is","it","with","from","by",
                 "all","this","that","be","as","at","have","do","not","but","are","augment","code"}
        words2 = [w for w in re.split(r"\W+", (title+" "+desc).lower())
                  if w and len(w) > 2 and w not in stop2]
        skb_q = " ".join(words2[:5])
        if skb_q:
            skb = _skb_search(skb_q, top_k=6)
            if skb:
                skb_lines = ["[SKB] Global knowledge base (policies / workflow guides / bug fixes):"]
                for e in skb[:4]:
                    skb_lines.append(f"  [{e['category']}] {e['title']}:")
                    skb_lines.append(f"    {e['content'][:300].replace(chr(10),' ')}")
                parts.append("\n".join(skb_lines))

        if parts:
            ctx = "\n\n".join(parts)
            return f"=== AUTO-ENRICHED CONTEXT (claim-time) ===\n{ctx}\n=== END AUTO-ENRICHED CONTEXT ==="
    except Exception:
        pass
    return ""


# ── Commands ───────────────────────────────────────────────────────────────────

def _dedup_check(items, title, agent):
    """
    Check for existing pending/in-progress tasks with very similar titles
    assigned to the same agent. Returns the duplicate task ID if found, else None.
    Prevents agents from creating redundant blocker/escalation tasks.
    """
    import difflib
    title_lower = title.lower().strip()
    stop = {"the","a","an","and","or","for","to","in","on","of","is","it","with",
            "fix","task","blocker","unblock","resolve","issue","check","pr","due"}
    title_words = set(w for w in title_lower.split() if w not in stop and len(w) > 2)

    for t in items:
        if not isinstance(t, dict):
            continue
        status = t.get("status", "")
        if status not in ("pending", "in-progress"):
            continue
        existing_agent = (t.get("assigned_to") or "").lower()
        if agent and existing_agent != agent.lower():
            continue
        existing_title = (t.get("title") or "").lower().strip()
        ratio = difflib.SequenceMatcher(None, title_lower, existing_title).ratio()
        if ratio >= 0.70:
            return t.get("id")
        existing_words = set(w for w in existing_title.split() if w not in stop and len(w) > 2)
        if title_words and existing_words:
            overlap = len(title_words & existing_words) / max(len(title_words), len(existing_words))
            if overlap >= 0.60:
                return t.get("id")
    return None


def cmd_add(args):
    with _file_lock():  # prevent duplicate TK IDs under concurrent writes
        data  = load()
        items = data["items"]

        # ── Dedup guard: reject if a very similar task already exists ──
        agent_hint = args.agent if hasattr(args, 'agent') and args.agent else None
        dup_id = _dedup_check(items, args.title, agent_hint)
        if dup_id:
            print(c(f"DEDUP BLOCKED: similar task {dup_id} already exists for @{agent_hint or '?'}. "
                     f"Add a note to {dup_id} instead of creating a duplicate.", YELLOW))
            print(dim(f"  Use: amauta note {dup_id} --content \"your context here\""))
            sys.exit(0)

        itype = args.type
        nid   = _next_id(items, itype)
        item  = _new_item(itype, args.title)
        item["id"] = nid

        # Basic fields
        if args.description:  item["description"]  = args.description
        if args.details:      item["details"]       = args.details
        if args.status:       item["status"]        = args.status
        if args.priority:     item["priority"]      = args.priority
        if args.agent:        item["assigned_to"]   = args.agent
        if args.sprint:       item["sprint"]        = args.sprint
        if args.due:          item["due_date"]      = args.due
        if args.hours:        item["estimated_hours"] = args.hours
        if args.importance:   item["importance"]    = args.importance
        if args.urgency:      item["urgency"]       = args.urgency
        if args.tags:         item["tags"]          = [t.strip() for t in args.tags.split(",")]
        if args.deps:         item["dependencies"]  = [d.strip() for d in args.deps.split(",")]

        # Structured lists
        if args.criteria:
            item["success_criteria"] = [s.strip() for s in args.criteria.split("|")]
        if args.deliverables:
            item["deliverables"] = [s.strip() for s in args.deliverables.split("|")]
        if args.checklist:
            item["validation_checklist"] = [s.strip() for s in args.checklist.split("|")]
        if args.test_strategy:
            item["test_strategy"] = args.test_strategy
        if args.refs:
            refs = [r.strip() for r in args.refs.split("|") if r.strip()]
            for r in refs:
                item.setdefault("doc_refs", []).append(
                    {"path": r, "type": "code_file" if "/" in r else "workspace_file", "title": "", "note": ""}
                )

        # Parent linkage
        if args.parent:
            parent = _find(items, args.parent)
            if not parent:
                print(c(f"Parent {args.parent} not found.", RED)); sys.exit(1)
            item["parent"] = args.parent
            if nid not in parent.get("children", []):
                parent.setdefault("children", []).append(nid)

        # Dep validation
        for dep_id in item["dependencies"]:
            if not _find(items, dep_id):
                print(c(f"Dependency {dep_id} not found.", RED)); sys.exit(1)

        _augment_task_metadata(item)

        items.append(item)
        save(data)
    print(c(f"Created {itype} {nid}: {args.title}", GREEN))
    print(dim(f"  assigned=@{item['assigned_to']}  priority={item['priority']}  score={_score(item, items)}"))


def cmd_show(args):
    data  = load()
    item  = _find(data["items"], args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)
    if args.json:
        print(json.dumps(item, indent=2))
    else:
        _print_item_full(item, data["items"])


def cmd_list(args):
    data  = load()
    items = data["items"]

    # Filters
    if args.agent:    items = [i for i in items if (i.get("assigned_to") or "").lower() == args.agent.lower()]
    if args.type:     items = [i for i in items if i.get("type") == args.type]
    if args.status:   items = [i for i in items if i.get("status") == args.status]
    if args.priority: items = [i for i in items if i.get("priority") == args.priority]
    if args.sprint:   items = [i for i in items if i.get("sprint") == args.sprint]
    if args.tag:      items = [i for i in items if args.tag in i.get("tags", [])]

    if not items:
        print(dim("No items match.")); return

    if args.tree:
        _print_tree(items, data["items"])
    elif args.scored:
        all_items = data["items"]
        scored = sorted(items, key=lambda i: _score(i, all_items), reverse=True)
        for item in scored:
            _print_item_line(item, score=_score(item, all_items))
    else:
        for item in items:
            _print_item_line(item)


def _print_tree(filtered: list, all_items: list, parent_id=None, indent=0):
    children = [i for i in filtered if i.get("parent") == parent_id]
    for item in children:
        _print_item_line(item, indent)
        _print_tree(filtered, all_items, item["id"], indent + 1)


def cmd_update(args):
    data  = load()
    items = data["items"]
    item  = _find(items, args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)

    changed = []
    simple_fields = [
        ("title",        args.title),
        ("description",  args.description),
        ("details",      args.details),
        ("status",       args.status),
        ("priority",     args.priority),
        ("assigned_to",  args.agent),
        ("sprint",       args.sprint),
        ("due_date",     args.due),
        ("test_strategy",args.test_strategy),
        ("validation_notes", args.validation_notes),
        ("validated_by",     args.validated_by),
    ]
    for field, val in simple_fields:
        if val is not None:
            item[field] = val
            changed.append(field)
    if args.hours is not None:
        item["estimated_hours"] = args.hours; changed.append("estimated_hours")
    if args.importance is not None:
        item["importance"] = args.importance; changed.append("importance")
    if args.urgency is not None:
        item["urgency"] = args.urgency; changed.append("urgency")
    if args.tags is not None:
        item["tags"] = [t.strip() for t in args.tags.split(",")]; changed.append("tags")
    if args.criteria is not None:
        item["success_criteria"] = [s.strip() for s in args.criteria.split("|")]; changed.append("success_criteria")
    if args.deliverables is not None:
        item["deliverables"] = [s.strip() for s in args.deliverables.split("|")]; changed.append("deliverables")
    if args.checklist is not None:
        item["validation_checklist"] = [s.strip() for s in args.checklist.split("|")]; changed.append("validation_checklist")

    item["updated_at"] = _now()
    save(data)
    print(c(f"Updated {args.id}: {', '.join(changed)}", GREEN))


def _needs_gitflow_gate(item: dict) -> bool:
    tags = {str(t).strip().lower() for t in (item.get("tags") or [])}
    if {"no-gitflow", "no_gitflow", "non-code", "non_code"} & tags:
        return False
    if _is_memory_hygiene_task(item):
        return False

    # Deterministic policy exemption: stale MEMORY.md hygiene tasks with file paths
    # excluded by workspace git policy should not be blocked on PR evidence.
    if _is_gitignored_memory_hygiene_task(item):
        return False

    owner = (item.get("assigned_to") or item.get("agent") or "").strip().lower()

    # Opencode agents do BOTH code PRs and infra/host config work.
    # When their task is tagged lane:infra (and NOT touching a git repo),
    # they should NOT be gated on PR evidence — there's no repo to PR against.
    opencode_agents = {"opencode", "opencode-general", "opencode-network", "opencode-memory",
                       "opencode-openclaw", "opencode-project"}
    if owner in opencode_agents and "lane:infra" in tags:
        return False

    code_agents = {"coder", "coder-frontend", "coder-backend", "coder-infra", "coder-ui", "coder-db",
                   "maintainer"} | opencode_agents
    non_code_agents = {"researcher", "finance", "marketing", "security-auditor", "operator", "validator",
                       "public-relations", "accountant", "legal"}
    if owner in code_agents:
        return True
    # Non-code agents produce reports/analysis, not PRs — never gate them
    if owner in non_code_agents:
        return False

    text = " ".join([
        str(item.get("title", "")),
        str(item.get("description", "")),
        str(item.get("details", "")),
        " ".join(item.get("deliverables", []) or []),
        " ".join(item.get("success_criteria", []) or []),
    ]).lower()
    keywords = (
        "pull request", "github.com", "git ", " branch", " commit", " repo", "codebase", "typecheck", "lint"
    )
    return any(k in text for k in keywords)


def _extract_pr_url(item: dict) -> str:
    pat = re.compile(r"https://github\.com/[^/\s]+/[^/\s]+/pull/\d+", re.I)
    phases = item.get("rpetd_phases", {}) or {}
    d_phase = str(phases.get("D", ""))
    m = pat.search(d_phase)
    if m:
        return m.group(0)
    for n in item.get("notes", []) or []:
        txt = n if isinstance(n, str) else str((n or {}).get("text", ""))
        m = pat.search(txt)
        if m:
            return m.group(0)
    return ""


def _is_infra_host_only(item: dict) -> bool:
    tags = {str(t).strip().lower() for t in (item.get("tags") or [])}
    if "lane:infra" in tags or "infra" in tags or "no-gitflow" in tags or "no_gitflow" in tags:
        return True

    text = " ".join([
        str(item.get("title", "")),
        str(item.get("description", "")),
        str(item.get("details", "")),
        " ".join(item.get("deliverables", []) or []),
        " ".join(item.get("success_criteria", []) or []),
    ]).lower()
    host_markers = (
        "host-only", "host level", "systemd", "docker", "nginx", "permissions",
        "root access", "filesystem", "cron", "runtime ops"
    )
    return any(m in text for m in host_markers)


def _has_no_pr_needed_marker(item: dict) -> bool:
    phases = item.get("rpetd_phases", {}) or {}
    text_parts = [
        str(phases.get("D", "") or ""),
        str(phases.get("T", "") or ""),
    ]
    for n in item.get("notes", []) or []:
        txt = n if isinstance(n, str) else str((n or {}).get("text", ""))
        text_parts.append(txt)

    text = "\n".join(text_parts)
    marker = re.compile(r"\bpr[_\s-]?url\s*[:=]\s*(?:no-?pr-?needed|n/?a|none)\b|\bno-?pr-?needed\b", re.I)
    return bool(marker.search(text))


def _iter_task_text_blobs(item: dict):
    phases = item.get("rpetd_phases", {}) or {}
    yield str(item.get("title", "") or "")
    yield str(item.get("description", "") or "")
    yield str(item.get("details", "") or "")
    yield str(phases.get("R", "") or "")
    yield str(phases.get("P", "") or "")
    yield str(phases.get("E", "") or "")
    yield str(phases.get("T", "") or "")
    yield str(phases.get("D", "") or "")
    for d in item.get("deliverables", []) or []:
        yield str(d or "")
    for s in item.get("success_criteria", []) or []:
        yield str(s or "")
    for n in item.get("notes", []) or []:
        yield n if isinstance(n, str) else str((n or {}).get("text", "") or "")


def _extract_abs_paths_from_item(item: dict) -> list[str]:
    text = "\n".join(_iter_task_text_blobs(item))
    # Absolute unix-like paths up to whitespace/terminator.
    raw = re.findall(r"(/[^\s'\"`;,]+)", text)
    cleaned = []
    for p in raw:
        p = p.rstrip(".:)]")
        if p.startswith("/"):
            cleaned.append(p)
    # Preserve order, de-duplicate.
    out, seen = [], set()
    for p in cleaned:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _path_is_gitignored(path: str) -> bool:
    """Return True when a path is excluded by git ignore/exclude rules."""
    import subprocess
    p = Path(path)
    if not p.exists():
        return False
    workdir = str(p.parent if p.is_file() else p)
    try:
        top = subprocess.run(
            ["git", "-C", workdir, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=3
        )
        if top.returncode != 0:
            return False
        repo_root = top.stdout.strip()
        rel = os.path.relpath(str(p), repo_root)
        chk = subprocess.run(
            ["git", "-C", repo_root, "check-ignore", "-q", "--", rel],
            timeout=3
        )
        return chk.returncode == 0
    except Exception:
        return False


def _is_gitignored_memory_hygiene_task(item: dict) -> bool:
    tags = {str(t).strip().lower() for t in (item.get("tags") or [])}
    all_text = "\n".join(_iter_task_text_blobs(item)).lower()

    looks_like_memory_hygiene = (
        "memory.md" in all_text
        and (
            "stale" in all_text
            or "hygiene" in all_text
            or "memory-hygiene" in tags
            or "memory hygiene" in all_text
        )
    )
    if not looks_like_memory_hygiene:
        return False

    for p in _extract_abs_paths_from_item(item):
        if p.lower().endswith("/memory.md") and _path_is_gitignored(p):
            return True
    return False


def _extract_branch_name(text: str) -> str:
    """Extract branch name from RPETD E-phase text."""
    # Match patterns like: branch=feat/TK-1234-desc, git checkout -b feat/TK-1234-desc
    m = re.search(r"(?:branch\s*[:=]\s*|git\s+checkout\s+-b\s+)([\w./-]+)", text or "", re.I)
    if m:
        return m.group(1)
    # Match bare branch names like feat/TK-1234-desc
    m = re.search(r"\b((?:feat|fix|chore|hotfix|refactor|release)/[\w./-]+)", text or "", re.I)
    if m:
        return m.group(1)
    return ""


def _extract_pr_number(pr_url: str) -> int:
    """Extract PR number from a GitHub PR URL."""
    m = re.search(r"/pull/(\d+)", pr_url or "")
    return int(m.group(1)) if m else 0


def _extract_commit_sha(text: str) -> str:
    """Extract commit SHA from text."""
    m = re.search(r"\b([0-9a-f]{7,40})\b", text or "")
    return m.group(1) if m else ""


def _gitflow_log(task_id: str, agent_id: str, action: str, *,
                 branch_name: Optional[str] = None, pr_url: Optional[str] = None,
                 pr_number: Optional[int] = None, commit_sha: Optional[str] = None,
                 notes: Optional[str] = None):
    """Best-effort gitflow audit log to PostgreSQL. Never raises."""
    try:
        if not _mem_pg_available():
            return
        import psycopg2
        conn = psycopg2.connect(_mem_db_url())
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO gitflow_log (task_id, agent_id, action, branch_name,
                                     pr_url, pr_number, commit_sha, notes)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """, (task_id, agent_id, action, branch_name, pr_url,
              pr_number, commit_sha, notes))
        cur.close()
        conn.close()
    except Exception:
        pass  # Telemetry must not break task operations


def _has_gitflow_action(task_id: str, action: str) -> bool:
    """Check whether a gitflow action already exists for a task."""
    try:
        if not task_id or not action or not _mem_pg_available():
            return False
        import psycopg2
        conn = psycopg2.connect(_mem_db_url())
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM gitflow_log WHERE task_id=%s AND action=%s",
            (task_id, action),
        )
        row = cur.fetchone()
        cur.close(); conn.close()
        return bool(row and int(row[0] or 0) > 0)
    except Exception:
        return False


def _has_learning_persisted(item: dict) -> bool:
    """
    Strict learning gate: confirm learning is persisted in PostgreSQL memory.
    A task can only pass validation if learning landed in DB.

    Degraded-mode safeguard:
    If PostgreSQL access is configured but unavailable in the current runtime
    (e.g., missing psycopg2 in a sandbox), fall back to explicit task learning
    evidence so validation does not false-negative on infrastructure/tooling gaps.
    """
    task_id = str(item.get("id", "") or "").strip()
    if not task_id:
        return False

    # No DB backend available in this runtime: rely on explicit learning evidence.
    if not _mem_pg_available():
        return _has_explicit_learning_written(item)

    try:
        import psycopg2
        conn = psycopg2.connect(_mem_db_url())
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute(
            """
            SELECT COUNT(*)
            FROM amauta_memory
            WHERE source IN ('auto_learning', 'web_search_result', 'lesson-learned', 'session-learning', 'manual', 'rpetd_phase', 'agent')
              AND (source <> 'rpetd_phase' OR lower(text) LIKE '%learning%')
              AND (
                metadata->>'task_id' = %s
                OR lower(tags::text) LIKE %s
                OR lower(text) LIKE %s
              )
            """,
            (task_id, f"%{task_id.lower()}%", f"%{task_id.lower()}%"),
        )
        row = cur.fetchone()
        cur.close(); conn.close()
        return bool(row and int(row[0] or 0) > 0)
    except Exception:
        # Fail-open to explicit learning evidence when DB probe is unavailable.
        return _has_explicit_learning_written(item)


def _has_merge_evidence(item: dict, extra_text: str = "") -> bool:
    """Require explicit merge evidence before code task validation passes."""
    if not _needs_gitflow_gate(item):
        return True

    task_id = str(item.get("id", "") or "").strip()
    if task_id and _has_gitflow_action(task_id, "merge"):
        return True

    neg_pat = re.compile(r"not\s+merged|merge\s+conflict|cannot\s+merge|failed\s+to\s+merge", re.I)
    pos_pat = re.compile(r"\bmerged\b|gh\s+pr\s+merge|squash\s+merge|merge\s+commit|auto-?merge", re.I)

    text_parts = [
        extra_text or "",
        str((item.get("rpetd_phases", {}) or {}).get("D", "") or ""),
        str((item.get("rpetd_phases", {}) or {}).get("T", "") or ""),
    ]
    for n in item.get("notes", []) or []:
        txt = n if isinstance(n, str) else str((n or {}).get("text", ""))
        text_parts.append(txt)

    merged_text = "\n".join(text_parts)
    if neg_pat.search(merged_text):
        return False
    return bool(pos_pat.search(merged_text))


def _has_learning_written(item: dict) -> bool:
    """
    Check whether the agent explicitly wrote a LEARNING: block or called memory add
    anywhere in the task's D-phase, R-phase, notes, or metadata.
    Both code and non-code tasks must record their learning before validation passes.
    Checks all RPETD phases + all notes for any learning signal.
    """
    phases = item.get("rpetd_phases", {}) or {}
    # Check D-phase and R-phase for LEARNING content (agents sometimes write it in R)
    for ph in ("D", "R", "P", "T", "E"):
        ph_text = str(phases.get(ph, ""))
        if not ph_text:
            continue
        # Explicit LEARNING: block
        if re.search(r"LEARNING\s*:", ph_text, re.I):
            return True
        # memory add call evidence (agent ran the command)
        if re.search(r"memory\s+add|memory-add|_mem_log|amauta.*memory.*add", ph_text, re.I):
            return True
        # LESSON or SKB write
        if re.search(r"LESSON\s*:|SKB\s*:|what.worked:|what.failed:|reusable.pattern:", ph_text, re.I):
            return True
    # Check notes for LEARNING written
    for n in item.get("notes", []) or []:
        txt = n if isinstance(n, str) else str((n or {}).get("text", ""))
        if re.search(r"LEARNING\s*:|memory\s+add|LESSON\s*:|SKB\s*:|AUTO-LEARNING|auto_learning", txt, re.I):
            return True
    # Check if auto_learning was already written to PG for this task
    task_id = item.get("id", "")
    if task_id and _mem_pg_available():
        try:
            import psycopg2
            conn = psycopg2.connect(_mem_db_url())
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute(
                "SELECT COUNT(*) FROM amauta_memory WHERE source IN ('auto_learning','web_search_result') "
                "AND (metadata->>'task_id' = %s OR tags::text ILIKE %s)",
                (task_id, f"%{task_id.lower()}%")
            )
            row = cur.fetchone()
            cur.close(); conn.close()
            if row and row[0] > 0:
                return True  # Already captured in DB — learning is there
        except Exception:
            pass
    return False


def _has_explicit_learning_written(item: dict) -> bool:
    """
    Strict learning signal check used by validation PASS gate.
    Requires agent-authored LEARNING evidence in RPETD text or notes.
    Does NOT count auto_learning records from PostgreSQL.
    """
    phases = item.get("rpetd_phases", {}) or {}
    for ph in ("D", "R", "P", "T", "E"):
        ph_text = str(phases.get(ph, ""))
        if not ph_text:
            continue
        if re.search(r"LEARNING\s*:|LESSON\s*:|SKB\s*:|what.worked:|what.failed:|reusable.pattern:", ph_text, re.I):
            return True
        if re.search(r"memory\s+add|memory-add|_mem_log|amauta.*memory.*add", ph_text, re.I):
            return True

    for n in item.get("notes", []) or []:
        txt = n if isinstance(n, str) else str((n or {}).get("text", ""))
        if re.search(r"LEARNING\s*:|LESSON\s*:|SKB\s*:|memory\s+add|memory-add", txt, re.I):
            return True

    return False


def _auto_write_learning(item: dict, agent_id: str):
    """
    If the agent did not write a LEARNING: block, auto-generate one from all RPETD phases
    and write it to amauta_memory so the knowledge is NEVER lost.
    Captures: task outcome, web_search findings, failure patterns, reusable patterns.
    Also promotes to SKB if criteria present.
    Best-effort — never raises.
    """
    try:
        if not _mem_pg_available():
            return False
        phases = item.get("rpetd_phases", {}) or {}
        task_id = item.get("id", "")
        title = item.get("title", "")
        criteria = " | ".join(str(c) for c in (item.get("success_criteria") or [])[:3])
        r_text = str(phases.get("R", ""))[:300]
        p_text = str(phases.get("P", ""))[:200]
        e_text = str(phases.get("E", ""))[:200]
        t_text = str(phases.get("T", ""))[:200]
        d_text = str(phases.get("D", ""))[:400]
        lane = "code" if _needs_gitflow_gate(item) else "non-code"
        owner = item.get("claimed_by") or item.get("assigned_to") or "system"

        # Extract any web_search findings from any phase
        ws_findings = ""
        for _ph, _ph_txt in [("R", r_text), ("P", p_text), ("D", d_text)]:
            ws_m = re.search(r'web.?search\s+findings?[:\s]+(.{20,300})', str(_ph_txt), re.I | re.S)
            if ws_m:
                ws_findings = ws_m.group(1).strip()[:200]
                break

        # Extract failure patterns
        fail_notes = [n for n in (item.get("notes") or [])
                      if re.search(r"FAIL|GATE|BLOCK|error", str(n), re.I)]
        fail_summary = " | ".join(str(n)[:100] for n in fail_notes[-2:]) if fail_notes else "none"

        learning_text = (
            f"AUTO-LEARNING: {task_id} | {title}\n"
            f"Agent: {owner} | Lane: {lane}\n"
            f"R-phase findings: {r_text[:200]}\n"
            f"P-phase design: {p_text[:150]}\n"
            f"E-phase execution: {e_text[:150]}\n"
            f"T-phase evidence: {t_text[:150]}\n"
            f"D-phase delivery: {d_text[:250]}\n"
            f"web_search findings: {ws_findings or 'not recorded'}\n"
            f"Past failures on task: {fail_summary}\n"
            f"Criteria met: {criteria or 'not specified'}\n"
            f"Validated by: {agent_id}"
        )
        _mem_log_event(
            owner,
            ["task", task_id.lower(), "event:learning", "autolearn", f"lane:{lane}", f"agent:{owner}"],
            learning_text,
            source="auto_learning",
            metadata={"task_id": task_id, "event": "auto_learning", "lane": lane, "auto_writer": agent_id},
        )
        # Promote to SKB — always, not just when criteria present
        # This ensures every validated task contributes to global knowledge
        _skb_promote(
            title=f"LESSON: {title[:80]}",
            content=learning_text,
            category="workflow" if lane == "code" else "process",
            agent_id=owner,
            tags=["lesson", "learning", f"agent:{owner}", f"lane:{lane}", "auto_learning"],
            importance=5,
        )
        # Also write web_search findings separately for easy retrieval
        if ws_findings:
            _mem_log_event(
                owner,
                ["web_search_result", task_id.lower(), "phase:auto", f"agent:{owner}", "autolearn"],
                f"WEB_SEARCH FINDING [auto-extracted] {task_id} | {title[:60]}\n{ws_findings}",
                source="web_search_result",
                metadata={"task_id": task_id, "phase": "auto", "event": "web_search_result"},
            )
        return True
    except Exception:
        return False


def _has_branch_evidence(e_phase: str) -> bool:
    return bool(re.search(r"git\s+checkout\s+-b|\bbranch\b\s*[:=]|\b(feat|fix|chore|hotfix|refactor|release)/", e_phase or "", re.I))


def _has_test_evidence(t_phase: str) -> bool:
    t = t_phase or ""
    success = re.compile(
        r"exit\s*(?:code\s*)?[:=]?\s*0\b"           # exit 0, exit code 0, exit=0
        r"|\b\d+\s+(?:tests?\s+)?passed\b|\bpassed\b" # N passed, N tests passed, passed
        r"|\b0\s+failed\b|all tests passed"           # 0 failed, all tests passed
        r"|build\s+pass|build\s+successful"           # build pass/successful
        r"|lint\s+pass|lint.*completed"                # lint pass/completed
        r"|tsc\s+--noemit"                             # tsc --noEmit (ran type-check)
        r"|go\s+test.*\bok\b|cargo\s+test.*\bok\b"    # go test ok, cargo test ok
        r"|status\s*checks?.*(?:success|pass)"         # status checks success/pass
        r"|ci\s*checks?.*(?:success|pass)"             # ci checks success/pass
        r"|all\s*checks\s*(?:success|pass)"            # all checks success/pass
        r"|checks\s*green"                             # checks green
        r"|_CODE\s*=\s*0\b"                            # PASS_CODE=0, GOOD_CODE=0
        r"|\[COMPLETED\]"                              # lint-staged [COMPLETED]
        r"|criteria.*(?:met|satisfied|appear\s+met)"   # RLM: criteria met/satisfied
        r"|successfully\b"                             # ran successfully
        r"|verification.*(?:pass|complete|confirm)"    # verification pass/complete
        r"|prettier\s+--write"                         # prettier ran
        r"|eslint\s+--fix",                            # eslint ran
        re.I,
    )
    # RPETD T is append-only in some flows. If a task was previously blocked but
    # later includes explicit passing evidence, prefer the positive signal.
    if success.search(t):
        return True

    blocker = re.compile(
        r"command not found|ENOENT|No such file or directory|permission denied|EROFS|read-only filesystem|node_modules missing|failed to connect to the docker API",
        re.I,
    )
    if blocker.search(t):
        return False
    # If T-phase has substantial content (>100 chars) but no clear pass/fail signal,
    # allow it through — the validator will review the evidence manually.
    if len(t) > 100:
        return True
    return False

def cmd_status(args):
    data = load()
    item = _find(data["items"], args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)

    # ── GITFLOW ENFORCEMENT: code tasks MUST go through validator to reach done ──
    # Agents cannot shortcut `status done` for code tasks — they MUST submit to
    # validation first, then the validator uses `validate --pass` after confirming
    # the PR is merged and tests pass.
    if args.status == "done" and _needs_gitflow_gate(item):
        caller = (args.agent or "").lower()
        if caller != "validator" and caller != "opencode":
            _append_note(item, f"GATE_BLOCKED: code task cannot be set to done directly. "
                         f"Submit to validation first, validator will verify PR merge. "
                         f"Caller: @{caller}", caller or "system")
            item["updated_at"] = _now()
            save(data)
            print(c(f"{args.id}: BLOCKED — code tasks must go through validation, not direct done", RED))
            print(dim("  Use: amauta status <id> validation  (then validator will review + merge PR)"))
            sys.exit(1)

    if args.status == "validation" and _needs_gitflow_gate(item):
        phases = item.get("rpetd_phases", {}) or {}
        e_phase = str(phases.get("E", ""))
        t_phase = str(phases.get("T", ""))
        missing = []
        if not _has_branch_evidence(e_phase):
            missing.append("missing_branch_evidence_E")
        if not _has_test_evidence(t_phase):
            missing.append("missing_test_evidence_T")
        if not _extract_pr_url(item):
            # Infra/host-only tasks may legitimately have no PR.
            # Accept explicit PR_URL:no-pr-needed (or equivalent) marker.
            if not (_is_infra_host_only(item) and _has_no_pr_needed_marker(item)):
                missing.append("missing_pr_url_D_or_notes")

        if missing:
            gate_msg = "GATE_FAIL: " + ", ".join(missing)
            _append_note(item, gate_msg + " | status unchanged", args.agent or "system")
            item["updated_at"] = _now()
            save(data)
            print(c(f"{args.id}: validation blocked by gitflow gate", YELLOW))
            print(dim(f"  {gate_msg}"))
            print(dim("  Add missing RPETD evidence and retry status validation."))
            sys.exit(1)

    old = item["status"]
    item["status"] = args.status
    item["updated_at"] = _now()
    if args.note:
        _append_note(item, args.note, args.agent or "system")
    _mem_log_task_transition(item, old, args.status, args.agent or "system", args.note or "")

    # ── Gitflow audit: log submission to validation ────────────────────────
    if args.status == "validation" and _needs_gitflow_gate(item):
        _pr = _extract_pr_url(item)
        _phases = item.get("rpetd_phases", {}) or {}
        _gitflow_log(
            item.get("id", ""), args.agent or "system", "validation-submit",
            branch_name=_extract_branch_name(str(_phases.get("E", ""))),
            pr_url=_pr or None,
            pr_number=_extract_pr_number(_pr) or None,
            commit_sha=_extract_commit_sha(str(_phases.get("E", ""))),
            notes=f"Submitted for validation by @{args.agent or 'system'}"
        )

    save(data)
    print(c(f"{args.id}: {old} → {args.status}", GREEN))


def cmd_assign(args):
    data = load()
    item = _find(data["items"], args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)
    old = item.get("assigned_to", "unassigned")
    item["assigned_to"] = args.agent
    item["agent"] = args.agent  # keep both fields in sync
    item["updated_at"]  = _now()
    _append_note(item, f"Reassigned from @{old} to @{args.agent}", "system")
    _mem_log_event(
        "system",
        ["task", item.get("id", "").lower(), "event:assignment", f"to:{args.agent}"],
        f"TASK EVENT: {item.get('id')} reassigned @{old}->@{args.agent}. title={item.get('title','')}",
        source="task_event",
        metadata={
            "task_id": item.get("id"),
            "event": "assignment",
            "from": old,
            "to": args.agent,
        },
    )
    save(data)
    print(c(f"{args.id} assigned to @{args.agent}", GREEN))


def cmd_delete(args):
    data  = load()
    items = data["items"]
    item  = _find(items, args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)
    # Remove from parent
    for i in items:
        if item["id"] in i.get("children", []):
            i["children"].remove(item["id"])
    data["items"] = [i for i in items if i["id"] != item["id"]]
    save(data)
    print(c(f"Deleted {args.id}: {item['title']}", RED))


# ── NEXT — agent's primary entry point ────────────────────────────────────────
def cmd_next(args):
    """
    Return the single highest-priority pending task for an agent.
    Filters: assigned to agent, status=pending, deps met.
    Ranks by: score = (importance×0.4) + (urgency×0.3) + (dep_pressure×0.3)
    Output: compact line (default) or JSON (--json) for agent parsing.
    This is the heartbeat entry point. Agent calls this first every 15 min.
    """
    data      = load()
    all_items = data["items"]
    agent     = args.agent

    candidates = [
        i for i in all_items
        if (i.get("assigned_to") or "").lower() == agent.lower()
        and i.get("status") == "pending"
        and _deps_met(i, all_items)
        and not _in_gate_cooldown(i)
    ]

    if not candidates:
        # Also surface failed tasks — they need retry
        failed = [
            i for i in all_items
            if (i.get("assigned_to") or "").lower() == agent.lower()
            and i.get("status") == "failed"
        ]
        if failed:
            best = sorted(failed, key=lambda i: _score(i, all_items), reverse=True)[0]
            if args.json:
                print(json.dumps({"status": "retry", "item": best}, indent=2))
            else:
                print(c("RETRY NEEDED:", YELLOW))
                _print_item_line(best, score=_score(best, all_items))
            return
        # For validator: also surface validation-status tasks (their primary queue)
        if agent.lower() == "validator":
            validation_tasks = [
                i for i in all_items
                if i.get("status") == "validation"
            ]
            if validation_tasks:
                best = sorted(validation_tasks, key=lambda i: _score(i, all_items), reverse=True)[0]
                if args.json:
                    sc = _score(best, all_items)
                    out = dict(best)
                    out["_score"] = sc
                    out["status_hint"] = "validation_pending"
                    print(json.dumps(out, indent=2))
                else:
                    print(c("VALIDATION QUEUE:", CYAN))
                    _print_item_line(best, score=_score(best, all_items))
                    print(dim(f"\n  → To review: amauta show {best['id']}"))
                return
        cooled = [
            i for i in all_items
            if (i.get("assigned_to") or "").lower() == agent.lower()
            and i.get("status") == "pending"
            and _in_gate_cooldown(i)
        ]
        if args.json:
            print(json.dumps({"status": "empty", "item": None}))
        else:
            if cooled:
                print(dim(f"No eligible pending tasks for @{agent}. {len(cooled)} task(s) cooling down after GATE_FAIL."))
            else:
                print(dim(f"No pending tasks for @{agent}. Queue clear."))
        return

    best = sorted(candidates, key=lambda i: _score(i, all_items), reverse=True)[0]

    if args.json:
        sc = _score(best, all_items)
        out = dict(best)
        out["_score"] = sc
        out["_deps_met"] = True
        print(json.dumps(out, indent=2))
    else:
        sc = _score(best, all_items)
        print(c(f"NEXT TASK for @{agent}:", BOLD))
        _print_item_line(best, score=sc)
        if best.get("details"):
            print(f"   {dim('Details: ' + best['details'][:200])}")
        print(dim(f"\n  → To start: amauta claim {best['id']} --agent {agent}"))


# ── CLAIM — atomic take ownership ─────────────────────────────────────────────
def cmd_claim(args):
    """
    Atomic: set status=in-progress, record claimed_by + claimed_at.
    Validates: item must be pending or failed (retry allowed).
    After claim, agent should begin RPETD and log phases via `amauta rpetd`.
    """
    data  = load()
    items = data["items"]
    item  = _find(items, args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)

    if item["status"] not in ("pending", "failed", "deferred"):
        print(c(f"{args.id} is '{item['status']}' — only pending/failed/deferred can be claimed.", YELLOW))
        if item["status"] == "in-progress" and item.get("claimed_by"):
            print(dim(f"  Currently claimed by @{item['claimed_by']} at {_fmt_ts(item.get('claimed_at',''))}"))
        sys.exit(1)

    if not _deps_met(item, items):
        blocking = [d for d in item.get("dependencies", []) if (dep := _find(items, d)) is not None and dep.get("status") != "done"]
        print(c(f"{args.id} blocked by unmet deps: {', '.join(blocking)}", YELLOW))
        sys.exit(1)

    if item.get("status") == "pending" and _in_gate_cooldown(item):
        age = _gate_fail_age_seconds(item) or 0
        wait_s = max(0, (GATE_COOLDOWN_MINUTES * 60) - age)
        print(c(f"{args.id} is cooling down after recent GATE_FAIL ({wait_s}s remaining).", YELLOW))
        print(dim("  Avoid immediate retry loops; add missing evidence then retry later."))
        sys.exit(1)

    gaps = _task_hygiene_gaps(item)
    if gaps:
        _append_note(
            item,
            "TASK_HYGIENE_WARN before claim: " + ", ".join(gaps) +
            ". Add richer context (details/test_strategy/success_criteria/doc_refs) for better autonomous execution.",
            "system",
        )

    now = _now()
    item["status"]     = "in-progress"
    item["claimed_by"] = args.agent
    item["assigned_to"] = args.agent  # keep both fields in sync
    item["agent"] = args.agent        # keep both fields in sync
    item["claimed_at"] = now
    item["updated_at"] = now
    _append_note(item, f"Claimed by @{args.agent}", args.agent)
    _mem_log_event(
        args.agent,
        ["task", item.get("id", "").lower(), "event:claim", "status:in-progress"],
        f"TASK EVENT: {item.get('id')} claimed by @{args.agent}. title={item.get('title','')}",
        source="task_event",
        metadata={
            "task_id": item.get("id"),
            "event": "claim",
            "agent": args.agent,
        },
    )

    # ── Layer 1: Claim-time context enrichment ─────────────────────────────
    # Inject parent/sibling/PG/KB context into task notes so agent has rich
    # context before starting RPETD. Best-effort, non-blocking.
    try:
        ctx = _enrich_task_context(item, items)
        if ctx:
            _append_note(item, ctx, "system-enrichment")
    except Exception:
        pass  # Enrichment must never block claims

    save(data)

    print(c(f"CLAIMED: {args.id} → in-progress  @{args.agent}", GREEN))
    print(dim(f"  Title: {item['title']}"))
    if item.get("details"):
        print(dim(f"  Details: {item['details'][:200]}"))
    if item.get("success_criteria"):
        print(dim(f"  Success criteria: {' | '.join(item['success_criteria'][:3])}"))
    print(dim(f"\n  → Log work: amauta rpetd {args.id} --phase R --content \"...\""))
    print(dim(f"  → Finish:   amauta status {args.id} validation --agent {args.agent} --note \"done\""))


# ── RPETD — inline work log ────────────────────────────────────────────────────
def cmd_rpetd(args):
    """
    Agent writes its RPETD phase log directly into the task.
    This is the 10x context record — agents document what they found/did/proved.
    Appends to existing content (doesn't overwrite) so multiple writes accumulate.
    Auto-marks rpetd_complete=True when all 5 phases have content.
    """
    data  = load()
    items = data["items"]
    item  = _find(items, args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)

    phase = args.phase.upper()
    if phase not in PHASES:
        print(c(f"Phase must be one of: {', '.join(PHASES)}", RED)); sys.exit(1)

    phases = item.setdefault("rpetd_phases", {ph: "" for ph in PHASES})
    existing = phases.get(phase, "")

    if existing and not args.append:
        # Default: append with separator
        phases[phase] = existing + f"\n\n[{_now()}]\n" + args.content
    else:
        phases[phase] = (existing + "\n" + args.content).strip() if existing else args.content

    # ── Layer 2: RPETD Phase Enrichment via RLM + PostgreSQL ───────────────
    # Each phase gets intelligent context injection:
    #   R: RLM analyzes project architecture docs → suggests files/approach
    #      + PG memory search for past experiences on this domain
    #   P: RLM cross-checks plan against architecture constraints
    #   E: (no auto-enrichment — agent's own execution output)
    #   T: RLM validates test output against success criteria
    #   D: PG memory logs delivery for system learning
    phase_supplement = ""
    try:
        phase_supplement = _rpetd_phase_enrich(phase, item, args.content)
        if phase_supplement:
            phases[phase] = phases[phase] + "\n\n" + phase_supplement
    except Exception:
        pass  # Phase enrichment is best-effort, never blocks

    # Auto-complete check
    if all(phases.get(ph, "").strip() for ph in PHASES):
        item["rpetd_complete"] = True

    item["updated_at"] = _now()
    _append_note(item, f"RPETD[{phase}] updated", args.agent or item.get("claimed_by", "system"))

    # ── Gitflow audit log for code tasks ──────────────────────────────────
    if _needs_gitflow_gate(item):
        _agent = args.agent or item.get("claimed_by", "system")
        _tid = item.get("id", "")
        if phase == "E":
            _branch = _extract_branch_name(args.content)
            _sha = _extract_commit_sha(args.content)
            if _branch:
                _gitflow_log(_tid, _agent, "branch-create", branch_name=_branch,
                             commit_sha=_sha or None, notes=f"E-phase branch evidence")
        elif phase == "D":
            _pr = _extract_pr_url(item)
            if _pr:
                _gitflow_log(_tid, _agent, "pr-create", pr_url=_pr,
                             pr_number=_extract_pr_number(_pr) or None,
                             branch_name=_extract_branch_name(str(phases.get("E", ""))),
                             notes=f"D-phase PR delivery")

    # ── Log phase to PG memory for system learning ─────────────────────────
    _mem_log_event(
        args.agent or item.get("claimed_by", "system"),
        ["task", item.get("id", "").lower(), f"event:rpetd_{phase.lower()}", f"status:{item.get('status','')}"],
        f"[rpetd_{phase.lower()}] {item.get('id')} status={item.get('status','')} by @{args.agent or item.get('claimed_by','?')} | {item.get('title','')} | {args.content[:200]}",
        source="rpetd_phase",
        metadata={"task_id": item.get("id"), "phase": phase, "agent": args.agent},
    )

    # If D-phase includes explicit learning, persist a dedicated learning record now
    # so validation can prove learning landed in memory without requiring manual re-entry.
    if phase == "D":
        d_text = str(phases.get("D", "") or "")
        if re.search(r"LEARNING\s*:|LESSON\s*:|what.worked:|what.failed:|reusable.pattern:", d_text, re.I):
            owner = args.agent or item.get("claimed_by") or item.get("assigned_to") or "system"
            task_id = item.get("id", "")
            title = item.get("title", "")
            learn_excerpt = d_text[:900]
            _mem_log_event(
                owner,
                ["task", task_id.lower(), "event:learning", "rpetd-d", f"agent:{owner}"],
                f"LEARNING: {task_id} | {title}\n{learn_excerpt}",
                source="session-learning",
                metadata={"task_id": task_id, "phase": "D", "event": "learning_capture"},
            )

    save(data)

    complete_str = c(" ✓ RPETD COMPLETE", GREEN) if item.get("rpetd_complete", False) else ""
    print(c(f"[{phase}] {PHASE_NAMES[phase]} logged on {args.id}{complete_str}", GREEN))
    remaining = [ph for ph in PHASES if not phases.get(ph, "").strip()]
    if remaining:
        print(dim(f"  Remaining phases: {', '.join(remaining)}"))
    if phase_supplement:
        lines = phase_supplement.split("\n")
        print(c(f"  + RLM/Memory enrichment ({len(phase_supplement)} chars):", CYAN))
        for line in lines[:4]:
            print(dim(f"    {line}"))
        if len(lines) > 4:
            print(dim(f"    ... {len(lines)-4} more lines"))


# ── NOTE — append a timestamped note with author ───────────────────────────────
def cmd_note(args):
    data = load()
    item = _find(data["items"], args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)
    _append_note(item, args.content, args.agent or "system")

    # Gitflow telemetry from free-form notes (best-effort).
    # Validators/coders often paste merge evidence in notes.
    if _needs_gitflow_gate(item):
        note_text = args.content or ""
        pr_pat = re.compile(r"https://github\.com/[^/\s]+/[^/\s]+/pull/(\d+)", re.I)
        m = pr_pat.search(note_text)
        pr_url = m.group(0) if m else (_extract_pr_url(item) or None)
        pr_num = int(m.group(1)) if m else (_extract_pr_number(pr_url) if pr_url else None)

        if m:
            _gitflow_log(
                item.get("id", ""), args.agent or "system", "pr-note",
                pr_url=pr_url,
                pr_number=pr_num,
                notes="PR URL captured from task note",
            )

        if re.search(r"\bmerged\b|gh\s+pr\s+merge|squash\s+merge|merge\s+commit", note_text, re.I) and \
           not re.search(r"not\s+merged|merge\s+conflict|failed\s+to\s+merge", note_text, re.I):
            _gitflow_log(
                item.get("id", ""), args.agent or "system", "merge",
                pr_url=pr_url,
                pr_number=pr_num,
                branch_name=_extract_branch_name(str((item.get("rpetd_phases", {}) or {}).get("E", ""))),
                notes=note_text[:200],
            )

    item["updated_at"] = _now()
    save(data)
    print(c(f"Note added to {args.id}", GREEN))


# ── ATOMIZE ────────────────────────────────────────────────────────────────────
def cmd_atomize(args):
    """
    Split a large task into smaller subtasks.
    Each subtask inherits priority, agent, and tags from the parent.
    Parent task is marked deferred with a note listing child IDs.
    Usage: amauta atomize TK-XXXX --subtasks "do A\ndo B\ndo C" --agent coder
           amauta atomize TK-XXXX --subtasks-file /path/to/subtasks.txt --agent coder
    """
    data = load()
    parent = _find(data["items"], args.id)
    if not parent:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)

    # Gather subtask titles
    subtask_titles: list[str] = []
    if args.subtasks:
        # Split on newlines or semicolons
        raw = args.subtasks.replace("\\n", "\n")
        subtask_titles = [s.strip() for s in re.split(r"[\n;]+", raw) if s.strip()]
    elif args.subtasks_file:
        import pathlib
        lines = pathlib.Path(args.subtasks_file).read_text().splitlines()
        subtask_titles = [l.strip() for l in lines if l.strip() and not l.startswith("#")]

    if not subtask_titles:
        print(c("No subtasks provided. Use --subtasks 'task A\ntask B' or --subtasks-file FILE", RED))
        sys.exit(1)

    agent = args.agent or parent.get("assigned_to") or parent.get("agent") or ""
    priority = args.priority or parent.get("priority", "medium")
    parent_tags = list(parent.get("tags") or [])
    child_ids: list[str] = []

    for title in subtask_titles:
        # Build a minimal add-args namespace
        class _FakeArgs:
            pass
        fa = _FakeArgs()
        fa.type = "task"
        fa.title = title
        fa.description = f"Subtask of {args.id}: {parent.get('title', '')}"
        fa.details = ""
        fa.status = "pending"
        fa.priority = priority
        fa.agent = agent
        fa.tags = ",".join(parent_tags) if parent_tags else ""
        fa.sprint = None
        fa.due = None
        fa.hours = None
        fa.importance = parent.get("importance") or 3
        fa.urgency = parent.get("urgency") or 3
        fa.criteria = None
        fa.deliverables = None
        fa.checklist = None
        fa.test_strategy = None
        fa.refs = None
        fa.parent = args.id
        fa.deps = None
        # Temporarily suppress print output
        import io, sys as _sys
        _buf = io.StringIO()
        _old_stdout = _sys.stdout
        _sys.stdout = _buf
        _exit_code = None
        try:
            cmd_add(fa)
        except SystemExit as _e:
            _exit_code = _e.code
        finally:
            _sys.stdout = _old_stdout
        output = _buf.getvalue()
        stripped_output = output.strip()

        # Dedup from cmd_add can include an existing TK id; don't treat that as a newly created child.
        if "DEDUP BLOCKED" in output:
            print(c(f"  Subtask skipped (dedup): {title}", YELLOW))
            if stripped_output:
                print(stripped_output)
            continue

        # Extract only IDs from successful creation lines.
        m = re.search(r'Created\s+\w+\s+(TK-\d+):', output)
        if m:
            child_ids.append(m.group(1))
            print(c(f"  Created subtask: {m.group(1)} — {title}", GREEN))
        else:
            if stripped_output:
                print(c(f"  Subtask warning: {title}", YELLOW))
                print(stripped_output)
            elif _exit_code not in (None, 0):
                print(c(f"  Subtask failed (exit {_exit_code}): {title}", RED))

    if child_ids:
        # Reload latest data so we don't overwrite parent/children updates made by cmd_add()
        data = load()
        parent = _find(data["items"], args.id)
        if not parent:
            print(c(f"{args.id} not found after subtask creation.", RED)); sys.exit(1)

        # Mark parent as deferred with note and merge child linkage
        parent["status"] = "deferred"
        existing_children = list(parent.get("children") or [])
        for cid in child_ids:
            if cid not in existing_children:
                existing_children.append(cid)
        parent["children"] = existing_children

        note_text = f"ATOMIZED: split into {len(child_ids)} subtasks: {', '.join(child_ids)}"
        _append_note(parent, note_text, args.agent or "system")
        parent["updated_at"] = _now()
        save(data)
        print(c(f"\n{args.id} → deferred. Created {len(child_ids)} subtasks: {', '.join(child_ids)}", GREEN))
        # Write to memory so agents know about the atomization
        _mem_log_event(
            args.agent or "system",
            ["atomize", "task-split", args.id.lower(), "event:atomized"],
            f"ATOMIZED: {args.id} split into {len(child_ids)} subtasks: {', '.join(child_ids)}. "
            f"Parent: {parent.get('title', '')}",
            source="task_event",
            metadata={"task_id": args.id, "child_ids": child_ids, "event": "atomized"},
        )
    else:
        print(c("No subtasks were created successfully.", RED))
        sys.exit(1)


# ── VALIDATE ───────────────────────────────────────────────────────────────────
def cmd_validate(args):
    """
    Validator-only: mark done or failed with evidence.
    Checks rpetd_complete before passing (warns if not).
    """
    data = load()
    item = _find(data["items"], args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)

    if item["status"] not in ("validation", "in-progress"):
        if getattr(args, "force", False):
            print(c(f"Warning: {args.id} is '{item['status']}', expected 'validation' (--force override)", YELLOW))
        else:
            print(c(f"BLOCKED: {args.id} is '{item['status']}' — must be 'in-progress' or 'validation' before validation.", RED))
            print(dim("  Use --force to override status check."))
            sys.exit(1)

    if args.pass_:
        if not item.get("rpetd_complete") and not args.force:
            print(c(f"Warning: RPETD not complete on {args.id}. Use --force to override.", YELLOW))
            print(dim("  Incomplete phases: " + ", ".join(
                ph for ph in PHASES if not item.get("rpetd_phases", {}).get(ph, "").strip()
            )))
            sys.exit(1)

        # ── LEARNING GATE: hard blocking gate for all tasks ───────────────────
        # Tasks CANNOT pass validation without agent-authored LEARNING evidence.
        # We still auto-capture best-effort to avoid knowledge loss, but PASS is
        # blocked until explicit LEARNING is present in RPETD/notes.
        _validator_id = args.validator or "validator"
        if not _has_explicit_learning_written(item) and not args.force:
            auto_ok = _auto_write_learning(item, _validator_id)
            _append_note(
                item,
                "LEARNING_GATE BLOCKED: missing explicit LEARNING evidence in RPETD/notes. "
                f"Auto-capture {'succeeded' if auto_ok else 'failed'} for retention, but PASS is blocked. "
                "Agent must add LEARNING: block in D-phase (or memory add evidence) and resubmit.",
                _validator_id,
            )
            item["updated_at"] = _now()
            save(data)
            print(c(f"{args.id}: PASS blocked — missing explicit LEARNING block", RED))
            print(dim("  Required: add LEARNING: content in RPETD D-phase or note memory add evidence."))
            print(dim("  Re-run validation after LEARNING is explicitly written. Use --force only for emergencies."))
            sys.exit(1)

        if not _has_learning_persisted(item) and not args.force:
            _append_note(
                item,
                "LEARNING_GATE BLOCKED: no persisted learning entry found in amauta_memory for this task. "
                "Run amauta memory add with task-specific LEARNING content, then re-submit validation.",
                _validator_id,
            )
            item["updated_at"] = _now()
            save(data)
            print(c(f"{args.id}: PASS blocked — learning not persisted to PostgreSQL memory", RED))
            print(dim("  Required: amauta memory add --agent <agent> --tags 'task,learning,autolearn' --text 'LEARNING: ...'"))
            print(dim("  Re-run validation after memory write. Use --force only for emergencies."))
            sys.exit(1)

        # ── GITFLOW ENFORCEMENT: code tasks require PR URL in notes before PASS ──
        # Validator MUST confirm a PR exists before passing. The validator agent
        # should merge the PR first, then pass. This gate catches cases where
        # the validator tries to pass without a PR reference.
        if _needs_gitflow_gate(item) and not args.force:
            pr_url = _extract_pr_url(item)
            if not pr_url:
                notes_text = args.notes or ""
                # Also check if PR URL is in the validate notes being passed right now
                import re as _re
                pr_in_notes = _re.search(r'(?:pull/|PR\s*#)\d+', notes_text)
                if not pr_in_notes:
                    _append_note(item, "VALIDATE_GATE: PASS blocked — no PR URL found in task notes. "
                                 "Validator must merge PR first, then include PR URL in notes or task.",
                                 args.validator or "validator")
                    item["updated_at"] = _now()
                    save(data)
                    print(c(f"{args.id}: PASS blocked — code task has no PR URL. Merge PR first.", RED))
                    print(dim("  Add PR URL via: amauta note <id> --content 'PR: <url>' --agent validator"))
                    print(dim("  Or use --force to override."))
                    sys.exit(1)

            if not _has_merge_evidence(item, args.notes or ""):
                _append_note(item, "VALIDATE_GATE: PASS blocked — no merge evidence found. "
                             "Validator must merge PR and record evidence in notes before PASS.",
                             args.validator or "validator")
                item["updated_at"] = _now()
                save(data)
                print(c(f"{args.id}: PASS blocked — no merge evidence. Merge PR first.", RED))
                print(dim("  Add evidence note: amauta note <id> --content 'Merged PR https://github.com/.../pull/N' --agent validator"))
                print(dim("  Or use --force to override."))
                sys.exit(1)

        item["status"]           = "done"
        item["validated_by"]     = args.validator or "validator"
        item["validation_notes"] = args.notes or "Validated OK"
        _append_note(item, f"PASS: {item['validation_notes']}", item["validated_by"])
        _mem_log_event(
            item["validated_by"],
            ["task", item.get("id", "").lower(), "event:validation_pass", "status:done", "success"],
            f"VALIDATION PASS: {item.get('id')} by @{item['validated_by']}. notes={item.get('validation_notes','')[:240]}",
            source="task_event",
            metadata={
                "task_id": item.get("id"),
                "event": "validation_pass",
                "status": "done",
            },
        )
        # ── Gitflow audit: log validation-pass AND merge ───────────────────
        if _needs_gitflow_gate(item):
            _pr = _extract_pr_url(item)
            _phases = item.get("rpetd_phases", {}) or {}
            _branch = _extract_branch_name(str(_phases.get("E", "")))
            _pr_num = _extract_pr_number(_pr) if _pr else 0
            _gitflow_log(
                item.get("id", ""), item["validated_by"], "validation-pass",
                pr_url=_pr or None,
                pr_number=_pr_num or None,
                branch_name=_branch,
                notes=f"PASS: {item.get('validation_notes', '')[:200]}"
            )
            # Log merge only when real merge evidence exists and no merge event logged yet.
            if _pr and _has_merge_evidence(item, item.get("validation_notes", "")) and not _has_gitflow_action(item.get("id", ""), "merge"):
                _gitflow_log(
                    item.get("id", ""), item["validated_by"], "merge",
                    pr_url=_pr,
                    pr_number=_pr_num or None,
                    branch_name=_branch,
                    notes=f"Merged via validator PASS. PR: {_pr}"
                )

        # ── Non-code: log validation-pass to gitflow_log as non-code-pass ──
        # Non-code tasks don't have PRs but we still audit their completion
        if not _needs_gitflow_gate(item):
            _gitflow_log(
                item.get("id", ""), item["validated_by"], "non-code-pass",
                notes=f"Non-code PASS: {item.get('validation_notes', '')[:200]}"
            )

        # ── Auto-promote validation passes to SKB ──────────────────────
        # When a task passes validation with complete RPETD, promote a
        # success pattern to agent_shared_knowledge so ALL agents learn.
        # This fires for BOTH code and non-code tasks.
        _phases_v = item.get("rpetd_phases", {}) or {}
        _criteria_v = " | ".join(str(c) for c in (item.get("success_criteria") or [])[:3])
        _agent_v = item.get("claimed_by") or item.get("assigned_to") or "system"
        _title_v = item.get("title", "")[:80]
        _lane_v = "code" if _needs_gitflow_gate(item) else "non-code"
        # Extract web_search findings from all phases for SKB entry
        _ws_in_phases = ""
        for _ph_n in ("R", "P", "D"):
            _ph_t = str(_phases_v.get(_ph_n, ""))
            _ws_m = re.search(r'web.?search\s+findings?[:\s]+(.{20,300})', _ph_t, re.I | re.S)
            if _ws_m:
                _ws_in_phases = _ws_m.group(1).strip()[:200]
                break
        _skb_promote(
            title=f"VALIDATED PATTERN: {_title_v}",
            content=(
                f"Task {item.get('id')} PASSED validation. Agent: {_agent_v}. Lane: {_lane_v}.\n"
                f"Criteria met: {_criteria_v or 'completed'}\n"
                f"Validator notes: {item.get('validation_notes','')[:200]}\n"
                f"web_search findings: {_ws_in_phases or 'not recorded'}"
            ),
            category="workflow" if _lane_v == "code" else "process",
            agent_id=item["validated_by"],
            tags=["validated", "pattern", "success", f"agent:{_agent_v}", f"lane:{_lane_v}"],
            importance=6,
        )
        # Persist web_search findings to memory separately if found
        if _ws_in_phases:
            _mem_log_event(
                _agent_v,
                ["web_search_result", item.get("id","").lower(), "phase:validation", f"agent:{_agent_v}"],
                f"WEB_SEARCH FINDING [validation] {item.get('id','')} | {_title_v}\n{_ws_in_phases}",
                source="web_search_result",
                metadata={"task_id": item.get("id"), "phase": "validation", "event": "web_search_result"},
            )

        print(c(f"VALIDATED ✓  {args.id} → DONE", GREEN))
    else:
        fail_notes = (args.notes or "").lower()
        non_code_gitflow_false_fail = (
            ("gitflow" in fail_notes or "no pr url" in fail_notes or "pull request" in fail_notes)
            and not _needs_gitflow_gate(item)
            and bool(item.get("rpetd_complete"))
        )

        if non_code_gitflow_false_fail:
            item["status"] = "done"
            item["validated_by"] = args.validator or "validator"
            item["validation_notes"] = (
                "Policy correction: non-code task with complete RPETD does not require PR/gitflow evidence. "
                "Marked done automatically to prevent false-fail loops."
            )
            _append_note(item, f"PASS: {item['validation_notes']}", item["validated_by"])
            _mem_log_event(
                item["validated_by"],
                [
                    "task",
                    item.get("id", "").lower(),
                    "event:validation_policy_correction",
                    "status:done",
                    "non-code",
                    "autolearn",
                ],
                f"VALIDATION POLICY CORRECTION: {item.get('id')} auto-passed (non-code RPETD-complete task incorrectly failed for gitflow/PR).",
                source="task_event",
                metadata={
                    "task_id": item.get("id"),
                    "event": "validation_policy_correction",
                    "reason": "non_code_gitflow_false_fail",
                    "status": "done",
                },
            )
            print(c(f"POLICY-CORRECTED ✓  {args.id} → DONE (non-code task)", GREEN))
            item["updated_at"] = _now()
            save(data)
            return

        # Validation fail returns task to pending queue (not failed).
        # Keep failed for system-level incidents only.
        item["status"]           = "pending"
        item["validated_by"]     = args.validator or "validator"
        item["validation_notes"] = args.notes or "Validation failed"
        _append_note(item, f"FAIL: {item['validation_notes']}", item["validated_by"])
        _mem_log_event(
            item["validated_by"],
            ["task", item.get("id", "").lower(), "event:validation_fail", "status:pending", "failure", "autolearn"],
            f"VALIDATION FAIL: {item.get('id')} by @{item['validated_by']}. reason={item.get('validation_notes','')[:240]}",
            source="task_event",
            metadata={
                "task_id": item.get("id"),
                "event": "validation_fail",
                "status": "pending",
            },
        )
        # ── Gitflow audit: log validation fail ─────────────────────────────
        if _needs_gitflow_gate(item):
            _pr = _extract_pr_url(item)
            _gitflow_log(
                item.get("id", ""), item["validated_by"], "validation-fail",
                pr_url=_pr or None,
                pr_number=_extract_pr_number(_pr) or None,
                notes=f"FAIL: {item.get('validation_notes', '')[:200]}"
            )
        print(c(f"FAILED ✗  {args.id} → returned to queue", RED))
        print(dim("  Agent must re-claim and redo failing phases."))

        # ── Atomize on fail: if --subtasks provided, split into subtasks ──
        if getattr(args, "subtasks", None):
            item["updated_at"] = _now()
            save(data)
            # Build fake args for cmd_atomize
            subtask_titles = args.subtasks.replace("|", "\n")
            class _AtomizeArgs:
                pass
            aa = _AtomizeArgs()
            aa.id = args.id
            aa.subtasks = subtask_titles
            aa.subtasks_file = None
            aa.agent = item.get("assigned_to") or item.get("agent") or ""
            aa.priority = item.get("priority", "medium")
            print(dim(f"  Atomizing {args.id} into subtasks..."))
            cmd_atomize(aa)
            return

    item["updated_at"] = _now()
    save(data)


# ── BOARD — kanban view ────────────────────────────────────────────────────────
def cmd_board(args):
    data  = load()
    items = data["items"]

    if args.agent:
        items = [i for i in items if (i.get("assigned_to") or "").lower() == args.agent.lower()]
    if args.sprint:
        items = [i for i in items if i.get("sprint") == args.sprint]

    cols = ["pending", "in-progress", "validation", "done", "failed", "deferred"]
    col_items = {s: [i for i in items if i.get("status") == s] for s in cols}

    active_cols = [s for s in cols if col_items[s] or s in ("pending","in-progress","validation")]

    agent_str = f" — @{args.agent}" if args.agent else ""
    sprint_str = f" [{args.sprint}]" if args.sprint else ""
    print(bold(f"\nAMAUTA BOARD{agent_str}{sprint_str}\n"))

    for status in active_cols:
        col = col_items[status]
        header = c(f"  {STATUS_ICON.get(status,'?')} {status.upper()} ({len(col)})", STATUS_COL.get(status, WHITE))
        print(header)
        print(dim("  " + "─" * 50))
        if not col:
            print(dim("    (empty)"))
        else:
            for item in sorted(col[:args.limit], key=lambda i: _score(i, items), reverse=True):
                tl = _type_label(item.get("type","task"))
                pl = _priority_label(item.get("priority","medium"))
                ag = f"@{item.get('assigned_to','?')}"
                print(f"    {tl} {bold(item['id'])}  {pl}  {ag}")
                print(f"       {item['title'][:60]}")
            if len(col) > args.limit:
                print(dim(f"    … {len(col)-args.limit} more"))
        print()


# ── SEARCH — full text across all fields ───────────────────────────────────────
def cmd_search(args):
    data  = load()
    items = data["items"]
    q     = str(args.query or "").lower()

    def _safe_text(v) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        return str(v)

    def _safe_join(vals) -> str:
        if not vals:
            return ""
        return " ".join(_safe_text(x) for x in vals)

    def _matches(item: dict) -> bool:
        fields = [
            _safe_text(item.get("title", "")),
            _safe_text(item.get("description", "")),
            _safe_text(item.get("details", "")),
            _safe_text(item.get("test_strategy", "")),
            _safe_text(item.get("assigned_to", "")),
            _safe_text(item.get("sprint", "") or ""),
            _safe_join(item.get("tags", [])),
            _safe_join(item.get("success_criteria", [])),
            _safe_join(item.get("deliverables", [])),
            _safe_join(item.get("validation_checklist", [])),
            _safe_join((_safe_text(n) if isinstance(n, str) else _safe_text((n or {}).get("text", ""))) for n in (item.get("notes", []) or [])),
            _safe_join(v for v in ((item.get("rpetd_phases", {}) or {}).values()) if v is not None),
            _safe_text(item.get("validation_notes", "") or ""),
        ]
        return any(q in _safe_text(f).lower() for f in fields)

    results = [i for i in items if _matches(i)]

    if not results:
        print(dim(f"No results for '{args.query}'"))
        return

    print(bold(f"\n{len(results)} result(s) for '{args.query}':\n"))
    for item in results:
        _print_item_line(item)


# ── SCORE — show computed priority score ───────────────────────────────────────
def cmd_score(args):
    data  = load()
    items = data["items"]
    item  = _find(items, args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)

    imp    = item.get("importance", 3)
    urg    = item.get("urgency", 3)
    iid    = item["id"]
    blocking = sum(1 for x in items if iid in x.get("dependencies", []))
    dep_p  = min(5, blocking)
    sc     = _score(item, items)

    print(bold(f"\nPriority Score: {sc}  —  {args.id}"))
    print(f"  importance   = {imp}  × 0.4  = {round(imp*0.4, 2)}")
    print(f"  urgency      = {urg}  × 0.3  = {round(urg*0.3, 2)}")
    print(f"  dep_pressure = {dep_p}  × 0.3  = {round(dep_p*0.3, 2)}")
    print(dim(f"  (dep_pressure = {blocking} items blocked by this one, capped at 5)"))
    print(dim(f"  priority string = '{item.get('priority','medium')}' (critical adds +1 to importance)"))
    if item.get("due_date"):
        print(dim(f"  due_date = {item['due_date']}  (urgency bumped by proximity)"))


# ── REFS — attach/list file/url references ─────────────────────────────────────
def cmd_refs(args):
    data = load()
    item = _find(data["items"], args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)

    item.setdefault("doc_refs", [])

    if args.refs_cmd == "add":
        ref = {
            "path":  args.path,
            "type":  args.type or "other",
            "title": args.title or "",
            "note":  args.note or "",
        }
        item["doc_refs"].append(ref)
        item["updated_at"] = _now()
        save(data)
        print(c(f"Ref added to {args.id}: [{ref['type']}] {ref['path']}", GREEN))

    elif args.refs_cmd == "list":
        refs = item.get("doc_refs", [])
        if not refs:
            print(dim(f"No refs on {args.id}")); return
        print(bold(f"\nRefs on {args.id} ({len(refs)}):"))
        for r in refs:
            title = f"  {dim(r['title'])}" if r.get("title") else ""
            note  = f"  — {dim(r['note'])}" if r.get("note") else ""
            print(f"  [{r.get('type','?')}] {r['path']}{title}{note}")

    elif args.refs_cmd == "remove":
        before = len(item["doc_refs"])
        item["doc_refs"] = [r for r in item["doc_refs"] if r["path"] != args.path]
        after = len(item["doc_refs"])
        if before == after:
            print(c(f"No ref found with path: {args.path}", YELLOW))
        else:
            item["updated_at"] = _now()
            save(data)
            print(c(f"Removed ref from {args.id}", GREEN))


# ── RISKS — manage risks list ──────────────────────────────────────────────────
def cmd_risk(args):
    data = load()
    item = _find(data["items"], args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)

    item.setdefault("risks", [])

    if args.risk_cmd == "add":
        risk = {"risk": args.risk, "mitigation": args.mitigation or ""}
        item["risks"].append(risk)
        item["updated_at"] = _now()
        save(data)
        print(c(f"Risk added to {args.id}", GREEN))

    elif args.risk_cmd == "list":
        risks = item.get("risks", [])
        if not risks:
            print(dim(f"No risks on {args.id}")); return
        print(bold(f"\nRisks on {args.id}:"))
        for i, r in enumerate(risks):
            if isinstance(r, dict):
                print(f"  {i+1}. ⚠ {r.get('risk','?')}")
                if r.get("mitigation"):
                    print(f"       → {r['mitigation']}")
            else:
                print(f"  {i+1}. ⚠ {r}")


# ── SPRINT commands ────────────────────────────────────────────────────────────
def cmd_sprint(args):
    data = load()
    data.setdefault("sprints", [])

    if args.sprint_cmd == "create":
        existing = [s for s in data["sprints"] if s["name"] == args.name]
        if existing:
            print(c(f"Sprint '{args.name}' already exists.", YELLOW)); return
        sprint = {
            "name":       args.name,
            "goal":       args.goal or "",
            "start_date": args.start or "",
            "end_date":   args.end or "",
            "status":     "active",
            "created_at": _now(),
        }
        data["sprints"].append(sprint)
        save(data)
        print(c(f"Sprint created: {args.name}", GREEN))

    elif args.sprint_cmd == "list":
        sprints = data.get("sprints", [])
        if not sprints:
            print(dim("No sprints.")); return
        print(bold("\nSprints:"))
        for s in sprints:
            task_count = sum(1 for i in data["items"] if i.get("sprint") == s["name"])
            done_count = sum(1 for i in data["items"] if i.get("sprint") == s["name"] and i.get("status") == "done")
            status_col = GREEN if s["status"] == "closed" else YELLOW
            print(f"  {c(s['status'].upper(), status_col)}  {bold(s['name'])}  "
                  f"{done_count}/{task_count} done"
                  + (f"  — {s['goal']}" if s.get("goal") else ""))

    elif args.sprint_cmd == "close":
        sprint = next((s for s in data["sprints"] if s["name"] == args.name), None)
        if not sprint:
            print(c(f"Sprint '{args.name}' not found.", RED)); return
        sprint["status"] = "closed"
        save(data)
        print(c(f"Sprint closed: {args.name}", GREEN))

    elif args.sprint_cmd == "stats":
        name = args.name
        items = [i for i in data["items"] if i.get("sprint") == name]
        if not items:
            print(dim(f"No tasks in sprint '{name}'")); return
        by_status = {}
        for i in items:
            s = i.get("status","?")
            by_status[s] = by_status.get(s, 0) + 1
        print(bold(f"\nSprint: {name}  ({len(items)} tasks)"))
        for s, n in sorted(by_status.items()):
            print(f"  {_status_label(s):30s} {n}")


# ── AGENT-TASKS (heartbeat compat) ────────────────────────────────────────────
def cmd_agent_tasks(args):
    data  = load()
    items = data["items"]
    agent_items = [
        i for i in items
        if (i.get("assigned_to") or "").lower() == args.agent.lower()
        and i["status"] in ("pending", "in-progress", "validation", "failed")
    ]
    if args.json:
        # Enrich with score for agent consumption
        all_items = data["items"]
        for i in agent_items:
            i["_score"] = _score(i, all_items)
            i["_deps_met"] = _deps_met(i, all_items)
        print(json.dumps(agent_items, indent=2))
    else:
        if not agent_items:
            print(dim(f"No open tasks for @{args.agent}")); return
        for i in agent_items:
            _print_item_line(i, score=_score(i, data["items"]))


# ── STATS ──────────────────────────────────────────────────────────────────────
def cmd_stats(args):
    data  = load()
    items = data["items"]
    total = len(items)
    if total == 0:
        print(dim("No items yet.")); return

    by_type, by_status, by_agent, by_sprint = {}, {}, {}, {}
    rpetd_complete = 0
    for i in items:
        t = i.get("type","?");         by_type[t]   = by_type.get(t,0) + 1
        s = i.get("status","?");       by_status[s] = by_status.get(s,0) + 1
        a = i.get("assigned_to","?");  by_agent[a]  = by_agent.get(a,0) + 1
        sp = i.get("sprint") or "—";  by_sprint[sp] = by_sprint.get(sp,0) + 1
        if i.get("rpetd_complete"):    rpetd_complete += 1

    print(bold(f"\nAMAUTA v2 — {total} items\n"))
    print(bold("By type:"))
    for t, n in sorted(by_type.items()):
        print(f"  {c(t, TYPE_COL.get(t,WHITE)):25s} {n}")
    print(bold("\nBy status:"))
    for s, n in sorted(by_status.items()):
        print(f"  {c(s, STATUS_COL.get(s,WHITE)):25s} {n}")
    print(bold("\nBy agent:"))
    for a, n in sorted(by_agent.items()):
        print(f"  {'@'+a:25s} {n}")
    print(bold("\nBy sprint:"))
    for sp, n in sorted(by_sprint.items()):
        print(f"  {sp:25s} {n}")
    print(bold(f"\nRPETD complete: {rpetd_complete}/{total}"))
    print()


# ── SKB (agent_shared_knowledge direct write) ──────────────────────────────────
def cmd_skb(args):
    # Write/search/stats for agent_shared_knowledge (global curated KB)
    if args.skb_cmd == "add":
        if not _mem_pg_available():
            print("SKB not available"); sys.exit(1)
        try:
            import psycopg2, uuid as _u
            conn = psycopg2.connect(_mem_db_url()); conn.autocommit = True; cur = conn.cursor()
            if not getattr(args, 'force', False):
                cur.execute("SELECT id FROM agent_shared_knowledge WHERE lower(title) = lower(%s)", (args.title,))
                if cur.fetchone():
                    print(f"SKB: title already exists: {args.title!r}"); print("  Use --force to overwrite."); cur.close(); conn.close(); return
            entry_id = f"SKB-{_u.uuid4().hex[:12]}"
            tags_list = [t.strip() for t in (args.tags or "").split(",") if t.strip()]
            now = datetime.now(timezone.utc)
            cur.execute("INSERT INTO agent_shared_knowledge (id,title,content,category,agent_id,tags,importance,created_at,updated_at) VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,content=EXCLUDED.content,updated_at=EXCLUDED.updated_at",
                (entry_id,args.title,args.content,args.category or "workflow",args.agent or "system",json.dumps(tags_list),int(args.importance or 7),now,now))
            cur.close(); conn.close()
            print(f"\033[32mSKB entry created: {entry_id}\033[0m")
            print(f"  Title: {args.title} | Category: {args.category or 'workflow'} | Importance: {args.importance or 7}")
        except Exception as e:
            print(f"\033[31mSKB add failed: {e}\033[0m"); sys.exit(1)
    elif args.skb_cmd == "search":
        try:
            import psycopg2
            conn = psycopg2.connect(_mem_db_url()); cur = conn.cursor()
            stop = {"the","a","an","and","or","for","to","in","of","is","with"}
            words = [w for w in args.query.lower().split() if w not in stop and len(w) > 2][:6]
            if not words: print("No search terms"); return
            wp, sp, params, sparams = [], [], [], []
            for t in words:
                pat = f"%{t}%"
                wp.append("(lower(title) LIKE lower(%s) OR lower(content) LIKE lower(%s) OR lower(tags::text) LIKE lower(%s))")
                params.extend([pat, pat, pat])
                sp.append("(CASE WHEN lower(title) LIKE lower(%s) THEN 2 WHEN lower(content) LIKE lower(%s) THEN 1 ELSE 0 END)")
                sparams.extend([pat, pat])
            top_k = getattr(args, 'top_k', 5)
            cur.execute(f"SELECT id,title,category,importance,LEFT(content,300),({' + '.join(sp)}) AS score FROM agent_shared_knowledge WHERE {' OR '.join(wp)} ORDER BY score DESC,importance DESC LIMIT %s", sparams+params+[top_k])
            rows = cur.fetchall(); cur.close(); conn.close()
            if not rows: print(f"No SKB entries for: {args.query!r}"); return
            print(f"SKB ({len(rows)} results for {args.query!r}):")
            for r in rows:
                print(f"  [{r[2]}] imp={r[3]} {r[1]}"); print(f"    {r[4][:150].replace(chr(10),' ')}")
        except Exception as e:
            print(f"SKB search failed: {e}")
    elif args.skb_cmd == "stats":
        try:
            import psycopg2
            conn = psycopg2.connect(_mem_db_url()); cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM agent_shared_knowledge"); total = cur.fetchone()[0]
            cur.execute("SELECT category, COUNT(*) FROM agent_shared_knowledge GROUP BY category ORDER BY COUNT(*) DESC")
            rows = cur.fetchall(); cur.close(); conn.close()
            print(f"agent_shared_knowledge: {total} total entries")
            for r in rows: print(f"  {r[1]:4d}  {r[0]}")
        except Exception as e:
            print(f"SKB stats failed: {e}")


# ── SKB (agent_shared_knowledge direct write) ──────────────────────────────────
# ── EXPORT / IMPORT ────────────────────────────────────────────────────────────
def cmd_export(args):
    data = load()
    out  = json.dumps(data, indent=2)
    if args.output:
        Path(args.output).write_text(out)
        print(c(f"Exported to {args.output}", GREEN))
    else:
        print(out)

def cmd_import(args):
    src = Path(args.file)
    if not src.exists():
        print(c(f"File not found: {args.file}", RED)); sys.exit(1)
    incoming = json.loads(src.read_text())
    if args.replace:
        save(incoming)
        print(c("Replaced all data.", YELLOW)); return
    data = load()
    existing_ids = {i["id"] for i in data["items"]}
    added = 0
    for item in incoming.get("items", []):
        if item["id"] not in existing_ids:
            data["items"].append(item); added += 1
    save(data)
    print(c(f"Merged: {added} new items added.", GREEN))


# ── MIGRATE — upgrade old schema items ────────────────────────────────────────
def cmd_migrate(args):
    """
    Idempotent upgrade: adds all v2 fields to items that are missing them.
    Safe to run multiple times.
    """
    data  = load()
    items = data["items"]
    template = _new_item("task", "")
    upgraded = 0
    synced_assignments = 0
    mismatched_assignments = 0
    for item in items:
        changed = False
        for key, default in template.items():
            if key not in item:
                item[key] = default
                changed = True

        # Sync legacy assignment field safely:
        # only fill assigned_to from legacy agent when assigned_to is missing/unassigned.
        legacy_agent = (item.get("agent") or "").strip()
        assigned_to = (item.get("assigned_to") or "").strip()
        if legacy_agent and assigned_to in ("", "unassigned"):
            item["assigned_to"] = legacy_agent
            changed = True
            synced_assignments += 1
        elif legacy_agent and assigned_to and legacy_agent != assigned_to:
            mismatched_assignments += 1

        # Fix notes: add 'by' field if missing
        for note in item.get("notes", []):
            if "by" not in note:
                note["by"] = "system"
                changed = True
        if changed:
            item["updated_at"] = _now()
            upgraded += 1
    data.setdefault("sprints", [])
    save(data)
    print(c(f"Migration complete: {upgraded}/{len(items)} items upgraded to v2 schema.", GREEN))
    print(dim(f"Assignment sync: filled {synced_assignments}, mismatched(existing) {mismatched_assignments}"))


# ── LINK / UNLINK — dependency management ─────────────────────────────────────
def cmd_link(args):
    data  = load()
    items = data["items"]
    item  = _find(items, args.id)
    dep   = _find(items, args.dep_id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)
    if not dep:
        print(c(f"{args.dep_id} not found.", RED)); sys.exit(1)
    if args.dep_id == args.id:
        print(c("Cannot depend on itself.", RED)); sys.exit(1)
    # Cycle check
    def _reaches(from_id: str, target_id: str, visited: set) -> bool:
        if from_id in visited: return False
        visited.add(from_id)
        node = _find(items, from_id)
        if not node: return False
        for d in node.get("dependencies", []):
            if d == target_id or _reaches(d, target_id, visited):
                return True
        return False
    if _reaches(args.dep_id, args.id, set()):
        print(c(f"Would create circular dependency: {args.id} → {args.dep_id}", RED)); sys.exit(1)
    deps = item.setdefault("dependencies", [])
    if args.dep_id not in deps:
        deps.append(args.dep_id)
        item["updated_at"] = _now()
        save(data)
        print(c(f"{args.id} now depends on {args.dep_id}", GREEN))
    else:
        print(dim(f"{args.id} already depends on {args.dep_id}"))

def cmd_unlink(args):
    data  = load()
    items = data["items"]
    item  = _find(items, args.id)
    if not item:
        print(c(f"{args.id} not found.", RED)); sys.exit(1)
    deps = item.get("dependencies", [])
    if args.dep_id in deps:
        deps.remove(args.dep_id)
        item["updated_at"] = _now()
        save(data)
        print(c(f"Dependency removed: {args.id} no longer depends on {args.dep_id}", GREEN))
    else:
        print(dim(f"{args.id} does not depend on {args.dep_id}"))


# ── PARSER ─────────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="amauta",
        description="Amauta v2 — RLM/RPETD multi-agent task manager",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
AGENT WORKFLOW (heartbeat cycle):
  amauta next <agent> --json        → get best task
  amauta claim <ID> --agent <agent> → atomic take
  amauta rpetd <ID> --phase R --content "..." --agent <agent>
  amauta rpetd <ID> --phase P --content "..."
  amauta rpetd <ID> --phase E --content "..."
  amauta rpetd <ID> --phase T --content "..."
  amauta rpetd <ID> --phase D --content "..."
  amauta status <ID> validation --agent <agent> --note "done"
  [validator]: amauta validate <ID> --pass --validator validator --notes "evidence"
""",
    )
    sub = p.add_subparsers(dest="command", required=True)

    # ── add ───────────────────────────────────────────────────────────────────
    a = sub.add_parser("add", help="Create a new item")
    a.add_argument("type",  choices=TYPES)
    a.add_argument("title")
    a.add_argument("-d", "--description",  help="What + why (1-3 sentences)")
    a.add_argument("--details",            help="Extended context, background, constraints")
    a.add_argument("--test-strategy",      dest="test_strategy", help="How to verify done")
    a.add_argument("-s", "--status",       choices=STATUSES, default="pending")
    a.add_argument("-p", "--priority",     choices=PRIORITIES, default="medium")
    a.add_argument("--agent",              help="Assign to agent")
    a.add_argument("--parent",             help="Parent item ID")
    a.add_argument("--deps",               help="Comma-separated dependency IDs")
    a.add_argument("--tags",               help="Comma-separated tags")
    a.add_argument("--sprint",             help="Sprint name")
    a.add_argument("--due",                help="Due date YYYY-MM-DD")
    a.add_argument("--hours",              type=float, help="Estimated hours")
    a.add_argument("--importance",         type=int, choices=range(1,6), default=3,
                   help="1-5: importance for scoring (default 3)")
    a.add_argument("--urgency",            type=int, choices=range(1,6), default=3,
                   help="1-5: urgency for scoring (default 3)")
    a.add_argument("--criteria",           help="Success criteria, pipe-separated")
    a.add_argument("--deliverables",       help="Deliverables, pipe-separated")
    a.add_argument("--checklist",          help="Validation checklist, pipe-separated")

    # ── show ──────────────────────────────────────────────────────────────────
    sh = sub.add_parser("show", help="Full detail of one item")
    sh.add_argument("id")
    sh.add_argument("--json", action="store_true")

    # ── list ──────────────────────────────────────────────────────────────────
    ls = sub.add_parser("list", aliases=["ls"], help="List items")
    ls.add_argument("--agent")
    ls.add_argument("--type",     choices=TYPES)
    ls.add_argument("--status",   choices=STATUSES)
    ls.add_argument("--priority", choices=PRIORITIES)
    ls.add_argument("--sprint")
    ls.add_argument("--tag")
    ls.add_argument("--tree",   action="store_true")
    ls.add_argument("--scored", action="store_true", help="Sort by priority score")

    # ── update ────────────────────────────────────────────────────────────────
    u = sub.add_parser("update", help="Update fields")
    u.add_argument("id")
    u.add_argument("--title");        u.add_argument("--description")
    u.add_argument("--details");      u.add_argument("--test-strategy", dest="test_strategy")
    u.add_argument("-s","--status",   choices=STATUSES)
    u.add_argument("-p","--priority", choices=PRIORITIES)
    u.add_argument("--agent");        u.add_argument("--sprint")
    u.add_argument("--due");          u.add_argument("--hours", type=float)
    u.add_argument("--importance",    type=int, choices=range(1,6))
    u.add_argument("--urgency",       type=int, choices=range(1,6))
    u.add_argument("--tags");         u.add_argument("--criteria")
    u.add_argument("--deliverables"); u.add_argument("--checklist")
    u.add_argument("--validation-notes", dest="validation_notes")
    u.add_argument("--validated-by",     dest="validated_by")

    # ── status ────────────────────────────────────────────────────────────────
    st = sub.add_parser("status", help="Quick status change")
    st.add_argument("id")
    st.add_argument("status", choices=STATUSES)
    st.add_argument("--note")
    st.add_argument("--agent")

    # ── assign ────────────────────────────────────────────────────────────────
    asgn = sub.add_parser("assign", help="Assign to agent")
    asgn.add_argument("id"); asgn.add_argument("agent")

    # ── delete ────────────────────────────────────────────────────────────────
    dl = sub.add_parser("delete", aliases=["rm"], help="Delete item")
    dl.add_argument("id")

    # ── next — primary agent entry point ──────────────────────────────────────
    nx = sub.add_parser("next", help="Best pending task for agent (heartbeat entry point)")
    nx.add_argument("agent", help="Agent ID")
    nx.add_argument("--json", action="store_true", help="JSON output for agent parsing")

    # ── claim — atomic take ───────────────────────────────────────────────────
    cl = sub.add_parser("claim", help="Atomically claim a task (pending→in-progress)")
    cl.add_argument("id")
    cl.add_argument("--agent", required=True, help="Agent claiming the task")

    # ── metadata refs at creation ─────────────────────────────────────────────
    a.add_argument("--refs", help="Pipe-separated file/reference paths to attach as doc_refs")

    # ── rpetd — inline work log ───────────────────────────────────────────────
    rp = sub.add_parser("rpetd", help="Log an RPETD phase into a task")
    rp.add_argument("id")
    rp.add_argument("--phase",   required=True, choices=PHASES,
                    help="R=Research P=Plan E=Execute T=Test D=Document")
    rp.add_argument("--content", required=True, help="Phase log content")
    rp.add_argument("--agent",   help="Agent writing the log")
    rp.add_argument("--append",  action="store_true", help="Append (default: append with separator)")

    # ── note ──────────────────────────────────────────────────────────────────
    nt = sub.add_parser("note", help="Append a timestamped note with author")
    nt.add_argument("id")
    nt.add_argument("--content", required=True)
    nt.add_argument("--agent")

    # ── atomize ───────────────────────────────────────────────────────────────
    at = sub.add_parser("atomize", help="Split large task into subtasks (defers parent)")
    at.add_argument("id", help="Parent task ID to atomize")
    at.add_argument("--subtasks", help="Newline or semicolon-separated subtask titles")
    at.add_argument("--subtasks-file", dest="subtasks_file", help="File with one subtask title per line")
    at.add_argument("--agent", help="Agent to assign subtasks to (default: inherit from parent)")
    at.add_argument("--priority", help="Priority for subtasks (default: inherit from parent)")

    # ── validate ──────────────────────────────────────────────────────────────
    v = sub.add_parser("validate", help="Validator marks done or failed")
    v.add_argument("id")
    vg = v.add_mutually_exclusive_group(required=True)
    vg.add_argument("--pass", dest="pass_", action="store_true")
    vg.add_argument("--fail",               action="store_true")
    v.add_argument("--notes");     v.add_argument("--validator")
    v.add_argument("--force", action="store_true", help="Override RPETD check")
    v.add_argument("--subtasks", help="Pipe-separated subtask titles to atomize on --fail (e.g. 'fix A|fix B|fix C')")

    # ── board ─────────────────────────────────────────────────────────────────
    bd = sub.add_parser("board", help="Kanban board view")
    bd.add_argument("--agent")
    bd.add_argument("--sprint")
    bd.add_argument("--limit", type=int, default=5, help="Max items per column (default 5)")

    # ── search ────────────────────────────────────────────────────────────────
    sr = sub.add_parser("search", help="Full-text search across all fields")
    sr.add_argument("query")

    # ── score ─────────────────────────────────────────────────────────────────
    sc = sub.add_parser("score", help="Show priority score breakdown for an item")
    sc.add_argument("id")

    # ── refs ──────────────────────────────────────────────────────────────────
    rf = sub.add_parser("refs", help="Manage file/URL references on a task")
    rf.add_argument("id")
    rf_sub = rf.add_subparsers(dest="refs_cmd", required=True)
    rf_add = rf_sub.add_parser("add")
    rf_add.add_argument("--path",  required=True)
    rf_add.add_argument("--type",  default="other",
        help="workspace_file|shared_kb|memory_note|external_url|code_file|config_file|other")
    rf_add.add_argument("--title"); rf_add.add_argument("--note")
    rf_sub.add_parser("list")
    rf_rm = rf_sub.add_parser("remove")
    rf_rm.add_argument("--path", required=True)

    # ── risk ──────────────────────────────────────────────────────────────────
    rk = sub.add_parser("risk", help="Manage risks on a task")
    rk.add_argument("id")
    rk_sub = rk.add_subparsers(dest="risk_cmd", required=True)
    rk_add = rk_sub.add_parser("add")
    rk_add.add_argument("--risk",        required=True)
    rk_add.add_argument("--mitigation")
    rk_sub.add_parser("list")

    # ── sprint ────────────────────────────────────────────────────────────────
    sp = sub.add_parser("sprint", help="Manage sprints")
    sp_sub = sp.add_subparsers(dest="sprint_cmd", required=True)
    sp_cr = sp_sub.add_parser("create")
    sp_cr.add_argument("name")
    sp_cr.add_argument("--goal"); sp_cr.add_argument("--start"); sp_cr.add_argument("--end")
    sp_ls = sp_sub.add_parser("list")
    sp_cl = sp_sub.add_parser("close")
    sp_cl.add_argument("name")
    sp_st = sp_sub.add_parser("stats")
    sp_st.add_argument("name")

    # ── agent-tasks ───────────────────────────────────────────────────────────
    at = sub.add_parser("agent-tasks", help="All open tasks for agent (heartbeat compat)")
    at.add_argument("agent")
    at.add_argument("--json", action="store_true")

    # ── link / unlink ─────────────────────────────────────────────────────────
    lk = sub.add_parser("link",   help="Add a dependency between items")
    lk.add_argument("id"); lk.add_argument("dep_id")
    uk = sub.add_parser("unlink", help="Remove a dependency")
    uk.add_argument("id"); uk.add_argument("dep_id")

    # ── stats ─────────────────────────────────────────────────────────────────
    sub.add_parser("stats", help="Task statistics")

    # ── memory (compat layer) ────────────────────────────────────────────────
    mm = sub.add_parser("memory", help="Lightweight memory store: add/search/stats")
    mm_sub = mm.add_subparsers(dest="mem_cmd", required=True)

    mm_add = mm_sub.add_parser("add", help="Add memory note")
    mm_add.add_argument("--agent-id", dest="agent_id")
    mm_add.add_argument("--tags", default="")
    mm_add.add_argument("--text", required=True)

    mm_search = mm_sub.add_parser("search", help="Search memory notes")
    mm_search.add_argument("--query", required=True)
    mm_search.add_argument("--agent-id", dest="agent_id")
    mm_search.add_argument("--top-k", type=int, default=5)
    mm_search.add_argument("--json", action="store_true")
    mm_search.add_argument("--with-perplexity", action="store_true", help="Ignored (compat)")

    mm_sub.add_parser("stats", help="Memory entry stats")

    # ── skb (agent_shared_knowledge) ─────────────────────────────────────────
    skb_p = sub.add_parser("skb", help="Manage agent_shared_knowledge global KB")
    skb_sub = skb_p.add_subparsers(dest="skb_cmd", required=True)
    skb_add = skb_sub.add_parser("add", help="Add knowledge entry")
    skb_add.add_argument("--title", required=True)
    skb_add.add_argument("--content", required=True)
    skb_add.add_argument("--category", default="workflow")
    skb_add.add_argument("--agent")
    skb_add.add_argument("--tags", default="")
    skb_add.add_argument("--importance", type=int, default=7)
    skb_add.add_argument("--force", action="store_true")
    skb_s = skb_sub.add_parser("search", help="Search SKB")
    skb_s.add_argument("--query", required=True)
    skb_s.add_argument("--top-k", type=int, default=5, dest="top_k")
    skb_sub.add_parser("stats", help="SKB stats")

    # ── export / import ───────────────────────────────────────────────────────
    ex = sub.add_parser("export", help="Export tasks to JSON")
    ex.add_argument("-o","--output")
    im = sub.add_parser("import", help="Import tasks from JSON")
    im.add_argument("file")
    im.add_argument("--replace", action="store_true")

    # ── migrate ───────────────────────────────────────────────────────────────
    sub.add_parser("migrate", help="Upgrade existing tasks to v2 schema (idempotent)")

    return p


def main():
    parser = build_parser()
    args   = parser.parse_args()

    dispatch = {
        "add":         cmd_add,
        "show":        cmd_show,
        "list":        cmd_list,
        "ls":          cmd_list,
        "update":      cmd_update,
        "status":      cmd_status,
        "assign":      cmd_assign,
        "delete":      cmd_delete,
        "rm":          cmd_delete,
        "next":        cmd_next,
        "claim":       cmd_claim,
        "rpetd":       cmd_rpetd,
        "note":        cmd_note,
        "atomize":     cmd_atomize,
        "validate":    cmd_validate,
        "board":       cmd_board,
        "search":      cmd_search,
        "score":       cmd_score,
        "refs":        cmd_refs,
        "risk":        cmd_risk,
        "sprint":      cmd_sprint,
        "agent-tasks": cmd_agent_tasks,
        "link":        cmd_link,
        "unlink":      cmd_unlink,
        "stats":       cmd_stats,
        "memory":      cmd_memory,
        "skb":         cmd_skb,
        "export":      cmd_export,
        "import":      cmd_import,
        "migrate":     cmd_migrate,
    }

    fn = dispatch.get(args.command)
    if fn:
        fn(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

# TK-2045: host-write access verification marker (no runtime effect)

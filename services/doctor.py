#!/usr/bin/env python3
"""gsd-amauta doctor — one-screen install state status table.

STAB-06: Diagnoses install state across 8 categories.
Exits 0 always (failing checks = WARN/FAIL rows, not exceptions).
Run: python3 services/doctor.py  OR  gsd-amauta doctor
"""
import json
import os
import pathlib
import sys
import urllib.request
import urllib.error

# ── Config ────────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("GSD_AMAUTA_PORT", "18799"))
DAEMON_URL = f"http://127.0.0.1:{PORT}/health"
TIMEOUT = 2  # seconds for all HTTP checks

# Resolve repo root relative to this script location
REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

# ── Status symbols ────────────────────────────────────────────────────────────
OK   = "OK  "
WARN = "WARN"
FAIL = "FAIL"

rows = []


def row(status, category, detail):
    rows.append((status, category, detail))


# ── Check 1: Paths ────────────────────────────────────────────────────────────
try:
    cli_bin = REPO_ROOT / "bin" / "cli.cjs"
    init_bin = REPO_ROOT / "bin" / "init.cjs"
    daemon_py = REPO_ROOT / "services" / "amauta-daemon.py"
    missing = [str(p) for p in [cli_bin, init_bin, daemon_py] if not p.exists()]
    if missing:
        row(FAIL, "paths", f"Missing: {', '.join(missing)}")
    else:
        row(OK, "paths", "bin/cli.cjs, bin/init.cjs, services/amauta-daemon.py present")
except Exception as e:
    row(WARN, "paths", f"Check error: {e}")

# ── Check 2: Daemon ───────────────────────────────────────────────────────────
health = None
try:
    req = urllib.request.urlopen(DAEMON_URL, timeout=TIMEOUT)
    health = json.loads(req.read().decode())
    restarts_lifetime = health.get("rlm_restarts_lifetime", 0)
    redis_running = health.get("redis_running", False)
    rlm_running = health.get("rlm_running", False)
    detail = (
        f"up on :{PORT} | rlm={'up' if rlm_running else 'down'} "
        f"| redis={'up' if redis_running else 'down'} "
        f"| rlm_restarts_lifetime={restarts_lifetime}"
    )
    status = OK if restarts_lifetime == 0 else WARN
    if restarts_lifetime > 0:
        detail += f" (WARN: {restarts_lifetime} cumulative RLM restart(s) this session)"
    row(status, "daemon", detail)
except urllib.error.URLError:
    row(WARN, "daemon", f"Not reachable at :{PORT} — start with: python3 services/amauta-daemon.py &")
except Exception as e:
    row(WARN, "daemon", f"Health check error: {e}")

# ── Check 3: PostgreSQL ───────────────────────────────────────────────────────
try:
    if health is not None:
        pg_avail = health.get("pg_available", False)
        backend = health.get("backend", "unknown")
        if pg_avail:
            row(OK, "postgres", f"Available (backend={backend})")
        else:
            row(WARN, "postgres", f"Not available (backend={backend}). Set GSD_POSTGRES_URL.")
    else:
        pg_url = os.environ.get("GSD_POSTGRES_URL", "")
        if pg_url:
            row(WARN, "postgres", "Daemon down — cannot verify; GSD_POSTGRES_URL is set")
        else:
            row(WARN, "postgres", "Daemon down and GSD_POSTGRES_URL not set — PG status unknown")
except Exception as e:
    row(WARN, "postgres", f"Check error: {e}")

# ── Check 4: Valkey/Redis ─────────────────────────────────────────────────────
try:
    if health is not None:
        redis_running = health.get("redis_running", False)
        redis_url = health.get("redis_url") or os.environ.get("GSD_REDIS_URL", "redis://127.0.0.1:6379/0")
        if redis_running:
            row(OK, "valkey", f"Connected ({redis_url})")
        else:
            row(WARN, "valkey", f"Not connected ({redis_url}) — start: docker compose up -d")
    else:
        redis_url = os.environ.get("GSD_REDIS_URL", "redis://127.0.0.1:6379/0")
        row(WARN, "valkey", f"Daemon down — cannot verify ({redis_url})")
except Exception as e:
    row(WARN, "valkey", f"Check error: {e}")

# ── Check 5: API Keys ─────────────────────────────────────────────────────────
try:
    voyage = os.environ.get("VOYAGE_API_KEY", "")
    perplexity = os.environ.get("PERPLEXITY_API_KEY", "")
    anthropic = os.environ.get("ANTHROPIC_API_KEY", "")
    missing_keys = []
    present_keys = []
    for name, val in [
        ("VOYAGE_API_KEY", voyage),
        ("PERPLEXITY_API_KEY", perplexity),
        ("ANTHROPIC_API_KEY", anthropic),
    ]:
        if val:
            present_keys.append(name)
        else:
            missing_keys.append(name)
    if not missing_keys:
        row(OK, "api_keys", f"All 3 present: {', '.join(present_keys)}")
    elif not present_keys:
        row(FAIL, "api_keys", "None set. Required: VOYAGE_API_KEY, PERPLEXITY_API_KEY, ANTHROPIC_API_KEY")
    else:
        row(WARN, "api_keys", f"Present: {', '.join(present_keys)} | Missing: {', '.join(missing_keys)}")
except Exception as e:
    row(WARN, "api_keys", f"Check error: {e}")

# ── Check 6: Migrations ───────────────────────────────────────────────────────
try:
    mig_dir = REPO_ROOT / "migrations"
    up_files = sorted(
        f for f in mig_dir.glob("*.sql")
        if "DOWN" not in f.name.upper()
    )
    count = len(up_files)
    latest = up_files[-1].name if up_files else "none"
    row(OK, "migrations", f"{count} UP migration(s) on disk, latest: {latest}")
except Exception as e:
    row(WARN, "migrations", f"Check error: {e}")

# ── Check 7: Agent files ──────────────────────────────────────────────────────
try:
    agents_dir = REPO_ROOT / "agents"
    agent_files = [
        f for f in agents_dir.glob("gsd-*.md")
        if f.is_file()
    ]
    count = len(agent_files)
    if count >= 17:
        row(OK, "agents", f"{count} agent file(s) present in agents/")
    else:
        row(FAIL, "agents", f"Only {count} agent file(s) found — expected >= 17. Check agents/gsd-*.md")
except Exception as e:
    row(WARN, "agents", f"Check error: {e}")

# ── Check 8: Skill files ──────────────────────────────────────────────────────
try:
    skills_dir = REPO_ROOT / "get-shit-done" / "skills"
    skill_files = list(skills_dir.glob("*/SKILL.md"))
    count = len(skill_files)
    skill_names = [f.parent.name for f in skill_files]
    if count >= 3:
        row(OK, "skills", f"{count} skill(s) present: {', '.join(sorted(skill_names))}")
    else:
        row(WARN, "skills", f"Only {count} skill(s) found — expected >= 3. Check get-shit-done/skills/*/SKILL.md")
except Exception as e:
    row(WARN, "skills", f"Check error: {e}")

# ── Render table ──────────────────────────────────────────────────────────────
WIDTH = 80
print()
print("gsd-amauta doctor".center(WIDTH))
print("=" * WIDTH)
print(f"  {'STATUS':<6}  {'CATEGORY':<12}  DETAIL")
print("-" * WIDTH)
for status, category, detail in rows:
    # Truncate detail to fit one line
    max_detail = WIDTH - 6 - 12 - 8
    if len(detail) > max_detail:
        detail = detail[:max_detail - 3] + "..."
    print(f"  [{status}]  {category:<12}  {detail}")
print("-" * WIDTH)

fail_count = sum(1 for s, _, _ in rows if s.strip() == "FAIL")
warn_count = sum(1 for s, _, _ in rows if s.strip() == "WARN")
ok_count = sum(1 for s, _, _ in rows if s.strip() == "OK")
print(f"  Result: {ok_count} OK, {warn_count} WARN, {fail_count} FAIL")
print()
sys.exit(0)  # Always exit 0 — failing checks are informational

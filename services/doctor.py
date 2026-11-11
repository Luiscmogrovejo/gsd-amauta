#!/usr/bin/env python3
"""gsd-amauta doctor — truthful install-state status table.

STAB-06 + "doctor tells the truth" pass.

Checks (in order):
  paths, path_collision, install_drift, version_skew, daemon, backend,
  postgres, valkey, rlm_index, embeddings, api_keys, migrations, agents,
  skills, mobile

Severity → exit code:
    0  every check OK
    1  at least one WARN (degraded) and no FAIL
    2  at least one FAIL
  --strict promotes WARN to FAIL (so a degraded install exits 2).

Flags:
  --json                 machine-readable report on stdout (no table)
  --strict               treat warnings as failures
  --config-dir <path>    installed-copy root to audit (default: autodetect)
  --help

Run: python3 services/doctor.py  OR  gsd-amauta doctor
"""
import json
import os
import pathlib
import subprocess
from pathlib import Path
import sys
import urllib.request
import urllib.error

# ── Config ────────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("GSD_AMAUTA_PORT", "18799"))
RLM_PORT = int(os.environ.get("GSD_RLM_PORT", "18798"))
HOST = os.environ.get("GSD_AMAUTA_HOST", "127.0.0.1")
DAEMON_URL = f"http://{HOST}:{PORT}/health"
TIMEOUT = 2  # seconds for all HTTP checks

# Resolve repo root relative to this script location
REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

MANIFEST_NAME = "gsd-file-manifest.json"
DRIFT_LIST_CAP = 10

# Features that only exist on the PostgreSQL backend. Used when /health does
# not publish its own `features_off` list.
PG_ONLY_FEATURES = [
    "vector/semantic memory search (pgvector)",
    "RLM code index (rlm_chunks)",
    "blackboard (agent_findings / agent_messages)",
    "semantic cache",
    "A2A exchange log",
]

# ── Status symbols ────────────────────────────────────────────────────────────
OK = "OK  "
WARN = "WARN"
FAIL = "FAIL"

rows = []


def row(status, category, detail, data=None):
    rows.append((status, category, detail, data or {}))


# ── Argument parsing ──────────────────────────────────────────────────────────
def parse_args(argv):
    opts = {"json": False, "strict": False, "config_dir": None, "help": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--json":
            opts["json"] = True
        elif a == "--strict":
            opts["strict"] = True
        elif a in ("--help", "-h"):
            opts["help"] = True
        elif a == "--config-dir" and i + 1 < len(argv):
            i += 1
            opts["config_dir"] = argv[i]
        elif a.startswith("--config-dir="):
            opts["config_dir"] = a.split("=", 1)[1]
        i += 1
    return opts


# ── Helpers ───────────────────────────────────────────────────────────────────
def http_json(url, timeout=TIMEOUT):
    """GET a JSON document. Returns (payload|None, error_string|None)."""
    try:
        resp = urllib.request.urlopen(url, timeout=timeout)
        return json.loads(resp.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return None, f"unreachable ({getattr(e, 'reason', e)})"
    except Exception as e:  # noqa: BLE001 — diagnostics must never crash
        return None, str(e)


def detect_config_dir(explicit=None):
    """Locate the INSTALLED copy of the harness (not this source tree)."""
    if explicit:
        return pathlib.Path(explicit).expanduser()
    env_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if env_dir and (pathlib.Path(env_dir) / "get-shit-done" / "VERSION").exists():
        return pathlib.Path(env_dir)
    home = pathlib.Path(os.path.expanduser("~"))
    for rel in (".claude", ".config/opencode", ".opencode", ".gemini", ".codex"):
        cand = home / rel
        if (cand / "get-shit-done" / "VERSION").exists():
            return cand
    return pathlib.Path(env_dir) if env_dir else home / ".claude"


def package_version():
    try:
        with open(REPO_ROOT / "package.json", encoding="utf-8") as fh:
            return json.load(fh).get("version")
    except Exception:
        return None


def sha256_file(path):
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def which_all(name):
    """Every executable called `name` on PATH, in PATH order."""
    found = []
    path_env = os.environ.get("PATH", "")
    for d in path_env.split(os.pathsep):
        if not d:
            continue
        cand = os.path.join(d, name)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            found.append(cand)
    return found


def classify_path_binary(binary_path):
    """'self' (this package), 'other' (another gsd-amauta copy) or 'foreign'."""
    try:
        real = pathlib.Path(binary_path).resolve()
    except Exception:
        return "foreign"
    try:
        real.relative_to(REPO_ROOT)
        return "self"
    except ValueError:
        pass
    # npm/global installs land in node_modules/gsd-amauta/... — accept those too.
    parts = real.parts
    if "gsd-amauta" in parts and "node_modules" in parts:
        return "self"
    try:
        with open(real, "rb") as fh:
            head = fh.read(4096).decode("utf-8", "replace")
        if "gsd-amauta" in head or "GSD-Amauta" in head:
            return "other"
    except Exception:
        pass
    return "foreign"


# ══ Check 1: Paths ════════════════════════════════════════════════════════════
def check_paths():
    try:
        wanted = [
            REPO_ROOT / "bin" / "cli.cjs",
            REPO_ROOT / "bin" / "init.cjs",
            REPO_ROOT / "services" / "amauta-daemon.py",
        ]
        missing = [str(p) for p in wanted if not p.exists()]
        if missing:
            row(FAIL, "paths", f"Missing: {', '.join(missing)}", {"missing": missing})
        else:
            row(OK, "paths", "bin/cli.cjs, bin/init.cjs, services/amauta-daemon.py present")
    except Exception as e:
        row(WARN, "paths", f"Check error: {e}")


# ══ Check 2: PATH collision ═══════════════════════════════════════════════════
def check_path_collision():
    """A foreign `amauta` / `gsd-amauta` ahead of ours on PATH is a FAIL.

    Real case: the pipx package `amauta-ai` installs a binary literally named
    `amauta` in ~/.local/bin. `which amauta-ai` finds nothing, so the old
    init.cjs check missed it while every `amauta ...` command ran the wrong
    program.
    """
    try:
        collisions = []   # foreign program shadowing us — FAIL
        other_copies = []  # a DIFFERENT gsd-amauta copy ahead of us — WARN
        checked = []
        for name in ("amauta", "gsd-amauta"):
            hits = which_all(name)
            if not hits:
                continue
            first = hits[0]
            checked.append(name)
            kind = classify_path_binary(first)
            if kind == "self":
                continue
            entry = {
                "name": name,
                "resolves_to": first,
                "real_path": str(pathlib.Path(first).resolve()),
                "kind": kind,
            }
            (collisions if kind == "foreign" else other_copies).append(entry)
        if collisions:
            detail = "; ".join(
                f"`{c['name']}` resolves to {c['real_path']} — NOT gsd-amauta"
                for c in collisions
            )
            row(FAIL, "path_collision",
                f"{detail} — fix PATH order, or `pipx uninstall amauta-ai`",
                {"collisions": collisions, "other_copies": other_copies})
        elif other_copies:
            detail = "; ".join(
                f"`{c['name']}` runs another gsd-amauta copy at {c['real_path']}"
                for c in other_copies
            )
            row(WARN, "path_collision", f"{detail} — not this checkout",
                {"collisions": [], "other_copies": other_copies})
        elif checked:
            row(OK, "path_collision", f"{', '.join(checked)} on PATH resolve to this package")
        else:
            row(WARN, "path_collision",
                "no `amauta` / `gsd-amauta` on PATH — run `npm link` or use node bin/cli.cjs")
    except Exception as e:
        row(WARN, "path_collision", f"Check error: {e}")


# ══ Check 3: Install drift ════════════════════════════════════════════════════
def check_install_drift(config_dir):
    """Compare the installed copy against the manifest install.js wrote.

    The manifest records hashes of the files AS INSTALLED, i.e. AFTER install.js
    rewrote `~/.claude/` prefixes inside them, so comparing against it never
    reports that path rewriting as drift.
    """
    try:
        manifest_path = config_dir / MANIFEST_NAME
        if not manifest_path.exists():
            row(WARN, "install_drift",
                f"no {MANIFEST_NAME} under {config_dir} — install state unverifiable; "
                f"run `node bin/init.cjs --upgrade`",
                {"config_dir": str(config_dir)})
            return None
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = json.load(fh)
        files = manifest.get("files", {}) or {}
        modified, missing = [], []
        for rel, expected in files.items():
            full = config_dir / rel
            if not full.exists():
                missing.append(rel)
                continue
            try:
                if sha256_file(full) != expected:
                    modified.append(rel)
            except Exception:
                missing.append(rel)
        total = len(files)
        if not modified and not missing:
            row(OK, "install_drift", f"{total} installed file(s) match the manifest",
                {"config_dir": str(config_dir), "total": total})
        else:
            shown = (modified + missing)[:DRIFT_LIST_CAP]
            more = len(modified) + len(missing) - len(shown)
            detail = (
                f"{len(modified)} modified, {len(missing)} missing of {total} "
                f"under {config_dir}: {', '.join(shown)}"
            )
            if more > 0:
                detail += f" (+{more} more)"
            row(WARN, "install_drift", detail, {
                "config_dir": str(config_dir),
                "total": total,
                "modified": modified[:DRIFT_LIST_CAP],
                "missing": missing[:DRIFT_LIST_CAP],
                "modified_count": len(modified),
                "missing_count": len(missing),
            })
        return manifest
    except Exception as e:
        row(WARN, "install_drift", f"Check error: {e}")
        return None


# ══ Check 4: Version skew ═════════════════════════════════════════════════════
def check_version_skew(config_dir, manifest):
    try:
        pkg_ver = package_version()
        version_file = config_dir / "get-shit-done" / "VERSION"
        installed = None
        if version_file.exists():
            installed = version_file.read_text(encoding="utf-8").strip()
        manifest_ver = (manifest or {}).get("version")
        data = {"package": pkg_ver, "installed": installed, "manifest": manifest_ver}
        if installed is None:
            row(WARN, "version_skew",
                f"no installed VERSION at {version_file} — package is {pkg_ver}", data)
        elif pkg_ver and installed != pkg_ver:
            row(WARN, "version_skew",
                f"installed {installed} != package {pkg_ver} — "
                f"run `git pull && node bin/init.cjs --upgrade`", data)
        elif manifest_ver and pkg_ver and manifest_ver != pkg_ver:
            row(WARN, "version_skew",
                f"manifest written by {manifest_ver}, package is {pkg_ver} — re-run the installer",
                data)
        else:
            row(OK, "version_skew", f"installed VERSION {installed} == package {pkg_ver}", data)
    except Exception as e:
        row(WARN, "version_skew", f"Check error: {e}")


# ══ Check 4b: Stale install (package moved on since the files were installed) ══
def _git_head(root):
    try:
        r = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=5)
        sha = (r.stdout or "").strip()
        return sha if r.returncode == 0 and len(sha) == 40 else None
    except Exception:
        return None


def check_install_stale(record_path=None, package_root=None):
    """The manifest check proves the installed files were not edited; it cannot
    see that the PACKAGE changed after the install. VERSION rarely moves between
    commits, so compare the commit recorded at install time with the package's
    current commit."""
    try:
        record_path = Path(record_path) if record_path else Path.home() / ".amauta" / "data" / "install_record.json"
        package_root = Path(package_root) if package_root else Path(__file__).resolve().parent.parent
        head = _git_head(package_root)
        if head is None:
            row(OK, "install_stale", "package is not a git checkout — nothing to compare")
            return
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            record = None
        installed = (record or {}).get("package_commit")
        data = {"installed_commit": installed, "package_commit": head}
        if not installed:
            row(WARN, "install_stale",
                "no install record with a commit — the installed copy may be older than "
                f"the package ({head[:7]}); run `node bin/init.cjs --upgrade`", data)
        elif installed != head:
            behind = None
            try:
                r = subprocess.run(["git", "-C", str(package_root), "rev-list", "--count", f"{installed}..{head}"],
                                   capture_output=True, text=True, timeout=5)
                behind = int(r.stdout.strip()) if r.returncode == 0 else None
            except Exception:
                behind = None
            data["commits_behind"] = behind
            how = f"{behind} commit(s) behind" if behind is not None else "a different commit"
            row(WARN, "install_stale",
                f"installed from {installed[:7]}, package is at {head[:7]} ({how}); "
                "run `node bin/init.cjs --upgrade`", data)
        else:
            row(OK, "install_stale", f"installed copy matches package commit {head[:7]}", data)
    except Exception as e:
        row(WARN, "install_stale", f"Check error: {e}")


# ══ Check 5: Daemon ═══════════════════════════════════════════════════════════
def check_daemon():
    health, err = http_json(DAEMON_URL)
    if health is None:
        row(WARN, "daemon",
            f"Not reachable at :{PORT} ({err}) — start with: python3 services/amauta-daemon.py &")
        return None
    try:
        restarts_lifetime = health.get("rlm_restarts_lifetime", 0)
        redis_running = health.get("redis_running", False)
        rlm_running = health.get("rlm_running", False)
        detail = (
            f"up on :{PORT} | rlm={'up' if rlm_running else 'down'} "
            f"| redis={'up' if redis_running else 'down'} "
            f"| rlm_restarts_lifetime={restarts_lifetime}"
        )
        status = OK if not restarts_lifetime else WARN
        if restarts_lifetime:
            detail += f" (WARN: {restarts_lifetime} cumulative RLM restart(s))"
        row(status, "daemon", detail, {"rlm_restarts_lifetime": restarts_lifetime})
    except Exception as e:
        row(WARN, "daemon", f"Health check error: {e}")
    return health


# ══ Check 6: Backend (SQLite fallback truth) ══════════════════════════════════
def check_backend(health):
    try:
        if health is None:
            row(WARN, "backend", "Daemon down — backend unknown (no /health to read)")
            return
        backend = health.get("backend", "unknown")
        pg_available = bool(health.get("pg_available", False))
        # Prefer the daemon's own degraded report when it publishes one.
        features_off = health.get("features_off")
        degraded_block = health.get("degraded")
        if features_off is None and isinstance(degraded_block, dict):
            features_off = degraded_block.get("features_off")
        if features_off is None and isinstance(degraded_block, list):
            features_off = degraded_block
        source = "daemon" if features_off is not None else "derived"
        if features_off is None:
            features_off = [] if (backend == "postgresql" and pg_available) else list(PG_ONLY_FEATURES)
        features_off = [str(f) for f in features_off]

        if backend == "postgresql" and pg_available and not features_off:
            row(OK, "backend", "PostgreSQL — all memory features available",
                {"backend": backend, "features_off": [], "source": source})
        elif backend == "postgresql" and not pg_available:
            row(FAIL, "backend",
                "backend=postgresql but PG is NOT answering — writes are failing, not degrading",
                {"backend": backend, "pg_available": False, "features_off": features_off,
                 "source": source})
        else:
            row(WARN, "backend",
                f"DEGRADED: running on {backend} fallback — OFF: {'; '.join(features_off)}. "
                f"Enable PG: docker compose -f docker/docker-compose.yml up -d && node bin/init.cjs",
                {"backend": backend, "pg_available": pg_available,
                 "features_off": features_off, "source": source})
    except Exception as e:
        row(WARN, "backend", f"Check error: {e}")


# ══ Check 7: PostgreSQL ═══════════════════════════════════════════════════════
def check_postgres(health):
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


# ══ Check 8: Valkey/Redis ═════════════════════════════════════════════════════
def check_valkey(health):
    try:
        default_url = os.environ.get("GSD_REDIS_URL", "redis://127.0.0.1:6379/0")
        if health is not None:
            redis_running = health.get("redis_running", False)
            redis_url = health.get("redis_url") or default_url
            if redis_running:
                row(OK, "valkey", f"Connected ({redis_url})")
            else:
                row(WARN, "valkey", f"Not connected ({redis_url}) — start: docker compose up -d")
        else:
            row(WARN, "valkey", f"Daemon down — cannot verify ({default_url})")
    except Exception as e:
        row(WARN, "valkey", f"Check error: {e}")


# ══ Check 9: RLM index ════════════════════════════════════════════════════════
def check_rlm_index(health):
    try:
        if health is not None and not health.get("rlm_running", False):
            row(WARN, "rlm_index", "RLM service not running — code index unavailable")
            return
        payload, err = http_json(f"http://{HOST}:{RLM_PORT}/health")
        if payload is None:
            row(WARN, "rlm_index", f"RLM service not reachable at :{RLM_PORT} ({err})")
            return
        size = payload.get("index_size", payload.get("pg_chunks_count", 0)) or 0
        if size == 0:
            row(WARN, "rlm_index",
                "RLM index is EMPTY (0 chunks) — codebase search returns nothing; "
                "run: gsd-tools reindex <abs-path> --force",
                {"index_size": 0})
        else:
            row(OK, "rlm_index", f"{size} chunk(s) indexed", {"index_size": size})
    except Exception as e:
        row(WARN, "rlm_index", f"Check error: {e}")


# ══ Check 10: Memory embeddings ═══════════════════════════════════════════════
def check_embeddings(health):
    try:
        if health is None:
            row(WARN, "embeddings", "Daemon down — embedding coverage unknown")
            return
        if health.get("backend") != "postgresql" or not health.get("pg_available", False):
            row(WARN, "embeddings",
                "skipped — embeddings require the PostgreSQL backend (see `backend` row)")
            return
        stats, err = http_json(f"http://{HOST}:{PORT}/api/memory/embedding-stats")
        if stats is None or "total" not in (stats or {}):
            row(WARN, "embeddings", f"coverage not exposed by the daemon ({err or 'no counts'})")
            return
        total = stats.get("total", 0)
        without = stats.get("without_embedding", 0)
        provider = stats.get("provider", "none")
        if total == 0:
            row(OK, "embeddings", "no memory rows yet", stats)
        elif without:
            row(WARN, "embeddings",
                f"{without}/{total} memory row(s) have NO embedding "
                f"(provider={provider}) — semantic search misses them",
                stats)
        else:
            row(OK, "embeddings", f"{total}/{total} rows embedded (provider={provider})", stats)
    except Exception as e:
        row(WARN, "embeddings", f"Check error: {e}")


# ══ Check 11: API keys ════════════════════════════════════════════════════════
def check_api_keys():
    try:
        missing_keys, present_keys = [], []
        for name in ("VOYAGE_API_KEY", "PERPLEXITY_API_KEY", "ANTHROPIC_API_KEY"):
            (present_keys if os.environ.get(name, "") else missing_keys).append(name)
        if not missing_keys:
            row(OK, "api_keys", f"All 3 present: {', '.join(present_keys)}")
        elif not present_keys:
            row(FAIL, "api_keys",
                "None set. Required: VOYAGE_API_KEY, PERPLEXITY_API_KEY, ANTHROPIC_API_KEY")
        else:
            row(WARN, "api_keys",
                f"Present: {', '.join(present_keys)} | Missing: {', '.join(missing_keys)}")
    except Exception as e:
        row(WARN, "api_keys", f"Check error: {e}")


# ══ Check 12: Migrations ══════════════════════════════════════════════════════
def check_migrations():
    try:
        mig_dir = REPO_ROOT / "migrations"
        up_files = sorted(f for f in mig_dir.glob("*.sql") if "DOWN" not in f.name.upper())
        count = len(up_files)
        latest = up_files[-1].name if up_files else "none"
        row(OK, "migrations", f"{count} UP migration(s) on disk, latest: {latest}",
            {"count": count, "latest": latest})
    except Exception as e:
        row(WARN, "migrations", f"Check error: {e}")


# ══ Check 13: Agent files ═════════════════════════════════════════════════════
def check_agents():
    try:
        agent_files = [f for f in (REPO_ROOT / "agents").glob("gsd-*.md") if f.is_file()]
        count = len(agent_files)
        if count >= 17:
            row(OK, "agents", f"{count} agent file(s) present in agents/")
        else:
            row(FAIL, "agents",
                f"Only {count} agent file(s) found — expected >= 17. Check agents/gsd-*.md")
    except Exception as e:
        row(WARN, "agents", f"Check error: {e}")


# ══ Check 14: Skill files ═════════════════════════════════════════════════════
def check_skills():
    try:
        skill_files = list((REPO_ROOT / "get-shit-done" / "skills").glob("*/SKILL.md"))
        count = len(skill_files)
        names = sorted(f.parent.name for f in skill_files)
        if count >= 3:
            row(OK, "skills", f"{count} skill(s) present: {', '.join(names)}")
        else:
            row(WARN, "skills",
                f"Only {count} skill(s) found — expected >= 3. Check get-shit-done/skills/*/SKILL.md")
    except Exception as e:
        row(WARN, "skills", f"Check error: {e}")


# ══ Check 15: Mobile toolchain (MOBL-03) ══════════════════════════════════════
def check_mobile():
    try:
        repo_root_str = str(REPO_ROOT)
        if repo_root_str not in sys.path:
            sys.path.insert(0, repo_root_str)
        try:
            from services.mobile_toolchain import detect_all
        except ImportError:
            import mobile_toolchain
            detect_all = mobile_toolchain.detect_all

        result = detect_all()
        for key, label in (("ios", "mobile-ios"), ("android", "mobile-android")):
            entry = result[key]
            outcome = entry["outcome"]
            detail = f"outcome={outcome}"
            if outcome != "full":
                detail += f" | {entry['skip_reason']}"
            row(OK if outcome == "full" else WARN, label, detail, {"outcome": outcome})
    except ImportError as e:
        row(WARN, "mobile", f"mobile_toolchain unavailable: {e}")
    except Exception as e:
        row(WARN, "mobile", f"Check error: {e}")


# ── Render ────────────────────────────────────────────────────────────────────
WIDTH = 92


def render_table(exit_code, strict):
    print()
    print("gsd-amauta doctor".center(WIDTH))
    print("=" * WIDTH)
    print(f"  {'STATUS':<6}  {'CATEGORY':<15}  DETAIL")
    print("-" * WIDTH)
    max_detail = WIDTH - 6 - 15 - 8
    for status, category, detail, _data in rows:
        shown = detail if len(detail) <= max_detail else detail[:max_detail - 3] + "..."
        print(f"  [{status}]  {category:<15}  {shown}")
    print("-" * WIDTH)
    fail_count = sum(1 for s, _, _, _ in rows if s.strip() == "FAIL")
    warn_count = sum(1 for s, _, _, _ in rows if s.strip() == "WARN")
    ok_count = sum(1 for s, _, _, _ in rows if s.strip() == "OK")
    verdict = {0: "healthy", 1: "DEGRADED", 2: "FAILING"}[exit_code]
    suffix = " (--strict: warnings count as failures)" if strict and warn_count else ""
    print(f"  Result: {ok_count} OK, {warn_count} WARN, {fail_count} FAIL "
          f"— {verdict} (exit {exit_code}){suffix}")
    print()


def render_json(exit_code, strict):
    fail_count = sum(1 for s, _, _, _ in rows if s.strip() == "FAIL")
    warn_count = sum(1 for s, _, _, _ in rows if s.strip() == "WARN")
    ok_count = sum(1 for s, _, _, _ in rows if s.strip() == "OK")
    print(json.dumps({
        "verdict": {0: "healthy", 1: "degraded", 2: "failing"}[exit_code],
        "exit_code": exit_code,
        "strict": strict,
        "summary": {"ok": ok_count, "warn": warn_count, "fail": fail_count},
        "checks": [
            {"status": s.strip(), "category": c, "detail": d, "data": data}
            for s, c, d, data in rows
        ],
    }, indent=2))


def main(argv):
    opts = parse_args(argv)
    if opts["help"]:
        print(__doc__)
        return 0

    config_dir = detect_config_dir(opts["config_dir"])

    check_paths()
    check_path_collision()
    manifest = check_install_drift(config_dir)
    check_version_skew(config_dir, manifest)
    check_install_stale()
    health = check_daemon()
    check_backend(health)
    check_postgres(health)
    check_valkey(health)
    check_rlm_index(health)
    check_embeddings(health)
    check_api_keys()
    check_migrations()
    check_agents()
    check_skills()
    check_mobile()

    fail_count = sum(1 for s, _, _, _ in rows if s.strip() == "FAIL")
    warn_count = sum(1 for s, _, _, _ in rows if s.strip() == "WARN")
    if fail_count or (opts["strict"] and warn_count):
        exit_code = 2
    elif warn_count:
        exit_code = 1
    else:
        exit_code = 0

    if opts["json"]:
        render_json(exit_code, opts["strict"])
    else:
        render_table(exit_code, opts["strict"])
    return exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

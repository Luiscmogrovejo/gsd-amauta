#!/usr/bin/env python3
"""gsd-amauta doctor — truthful install-state status table.

STAB-06 + "doctor tells the truth" pass.

Checks (in order):
  paths, path_collision, install_drift, version_skew, install_stale,
  github_access, daemon, backend,
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
import re
import shutil
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
def _path_entries(name, hits):
    """Evidence for one command name: every PATH hit, its real target and class."""
    out = []
    for hit in hits:
        try:
            target = str(pathlib.Path(hit).resolve())
        except Exception:
            target = hit
        out.append({"name": name, "path": hit, "target": target,
                    "classification": classify_path_binary(hit)})
    return out


def check_path_collision():
    """A foreign `amauta` / `gsd-amauta` ahead of ours on PATH is a FAIL.

    Real case: the pipx package `amauta-ai` installs a binary literally named
    `amauta` in ~/.local/bin. `which amauta-ai` finds nothing, so the old
    init.cjs check missed it while every `amauta ...` command ran the wrong
    program.

    Resolution policy: a collision is resolved by removing the shadowing entry
    (or fixing PATH order), not by teaching this checker to ignore it. In
    particular a binary that resolves into the runtime config directory is NOT
    treated as "self": that would silence the warning on every other install too.

    `data["entries"]` lists, for each colliding name, every PATH hit with its
    resolved `target` and the `classification` classify_path_binary gave it.
    """
    try:
        collisions = []   # foreign program shadowing us — FAIL
        other_copies = []  # a DIFFERENT gsd-amauta copy ahead of us — WARN
        entries = []
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
            hit_entries = _path_entries(name, hits)
            entries.extend(hit_entries)
            if len(hit_entries) > 1:
                a, b = hit_entries[0], hit_entries[1]
                entry["shadowing"] = (
                    f"{name} resolves to {a['target']} ({a['classification']}), "
                    f"shadowing {b['target']} ({b['classification']}); "
                    "the first entry on PATH wins"
                )
            (collisions if kind == "foreign" else other_copies).append(entry)
        if collisions:
            detail = "; ".join(
                f"`{c['name']}` resolves to {c['real_path']} — NOT gsd-amauta"
                + (f" ({c['shadowing']})" if c.get("shadowing") else "")
                for c in collisions
            )
            row(FAIL, "path_collision",
                f"{detail} — fix PATH order, or `pipx uninstall amauta-ai`",
                {"collisions": collisions, "other_copies": other_copies, "entries": entries})
        elif other_copies:
            detail = "; ".join(
                c["shadowing"] if c.get("shadowing")
                else f"`{c['name']}` runs another gsd-amauta copy at {c['real_path']}"
                for c in other_copies
            )
            row(WARN, "path_collision", f"{detail} — not this checkout",
                {"collisions": [], "other_copies": other_copies, "entries": entries})
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
# Names that never ship, wherever they sit in a shipped directory. ONE list, kept
# byte-identical to SHIPPED_EXCLUDE_* in bin/init.cjs (the installer writes the
# hash this check reads): tests/test_88_11_shipped_exclusions.py compares the two
# name sets literally and hashes the same tree with both implementations.
#
# `__pycache__` matters because running doctor itself writes it. The `*.pid` and
# `*.log` entries come from plan 88-11: on a machine where `plugin_root` IS the
# repository, the daemon and the RLM service write their pid files into the
# shipped `services/` directory, so every daemon restart produced
# "install_stale WARN: 2 files differ: services/amauta-daemon.pid,
# services/rlm-service.pid". Those are runtime state, not shipped content.
#
# The package's .gitignore is deliberately NOT the source of this list:
# `hooks/dist/` is gitignored AND an entry of package.json `files` (a build
# output committed to npm, not to git), so a gitignore-derived rule would drop a
# whole shipped directory out of the hash.
SHIPPED_EXCLUDE_DIRS = frozenset({
    ".git", "node_modules", "__pycache__", ".pytest_cache", "data", "logs", "backups",
})
SHIPPED_EXCLUDE_NAMES = frozenset({".DS_Store", "Thumbs.db", ".env"})
SHIPPED_EXCLUDE_SUFFIXES = (".pyc", ".pyo", ".pid", ".log", ".sock", ".bak", ".tmp")


def is_shipped_path(rel):
    """Does a relative path survive the shared shipped-set exclusions?

    The one predicate both sides of the comparison use: the installer applies it
    while hashing (``shippedFileMap`` in bin/init.cjs) and this module applies it
    both while re-hashing and while diffing a RECORDED map, so a record written
    before plan 88-11 (which still lists ``services/*.pid``) cannot report a pid
    file as a differing shipped file.

    Args:
        rel: path relative to the package root, posix separators.

    Returns:
        bool: True when the path is part of the shipped set.

    Example:
        >>> is_shipped_path("services/doctor.py")
        True
        >>> is_shipped_path("services/amauta-daemon.pid")
        False
    """
    parts = str(rel).replace("\\", "/").split("/")
    name = parts[-1]
    if name in SHIPPED_EXCLUDE_NAMES or name.endswith(SHIPPED_EXCLUDE_SUFFIXES):
        return False
    return not any(p in SHIPPED_EXCLUDE_DIRS for p in parts[:-1])
INSTALL_UPGRADE_HINT = "node bin/init.cjs --upgrade --files-only"
STALE_PATHS_CAP = 5


def _git_head(root):
    try:
        r = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=5)
        sha = (r.stdout or "").strip()
        return sha if r.returncode == 0 and len(sha) == 40 else None
    except Exception:
        return None


def shipped_file_map(package_root):
    """{relative posix path: sha256 hex of content} for every file the package ships.

    The set comes from the `files` array of package.json (directories expanded
    recursively). `bin/init.cjs` implements the same algorithm in
    `shippedFileMap`; tests/test_doctor_truth.py pins that both give the same
    digest. No mtimes, no absolute paths, no directory-order dependence.

    Args:
        package_root: directory holding package.json.

    Returns:
        dict mapping relative path to the sha256 of the file's bytes.

    Raises:
        OSError / ValueError: package.json unreadable or malformed.
    """
    root = Path(package_root)
    with open(root / "package.json", encoding="utf-8") as fh:
        entries = json.load(fh).get("files") or []
    found = {}

    def add(path):
        rel = path.relative_to(root).as_posix()
        if not is_shipped_path(rel):
            return
        if os.path.isfile(path):  # follows a symlink to a file, like the installer's copy
            found[rel] = sha256_file(path)

    for entry in entries:
        top = root / entry
        if top.is_dir() and not top.is_symlink():
            for dirpath, dirnames, filenames in os.walk(top):
                dirnames[:] = [d for d in dirnames if d not in SHIPPED_EXCLUDE_DIRS]
                for name in filenames:
                    add(Path(dirpath) / name)
        elif top.exists():
            add(top)
    return found


def shipped_hash_from_map(file_map):
    """Fold the per-file digests, sorted by path, into one hex digest.

    digest = sha256 over, for each path in sorted order,
    sha256(relative_path + NUL + sha256(content)) taken as raw bytes.
    """
    import hashlib

    acc = hashlib.sha256()
    for rel in sorted(file_map):
        acc.update(hashlib.sha256(f"{rel}\0{file_map[rel]}".encode("utf-8")).digest())
    return acc.hexdigest()


def shipped_file_hash(package_root):
    """Deterministic content hash of the files the package ships (64 hex chars).

    Args:
        package_root: directory holding package.json.

    Returns:
        hex sha256 string.

    Raises:
        OSError / ValueError: package.json unreadable or malformed.

    Example:
        >>> shipped_file_hash(".")  # doctest: +SKIP
    """
    return shipped_hash_from_map(shipped_file_map(package_root))


def check_install_stale(record_path=None, package_root=None):
    """Is the installed copy older than the package? Compares CONTENT, not git HEAD.

    `package_commit` vs `git rev-parse HEAD` re-triggered on every merge, even a
    docs-only one. The install record now carries `shipped_hash` (and the per-file
    `shipped_files` map) of the shipped file set at install time; this check
    recomputes it for the package as it is now.
      equal hash                  -> OK
      different hash              -> WARN, naming the first changed paths
      record without shipped_hash -> WARN, never a silent pass
    `package_commit` stays in the record as provenance only.
    """
    try:
        record_path = Path(record_path) if record_path else Path.home() / ".amauta" / "data" / "install_record.json"
        package_root = Path(package_root) if package_root else Path(__file__).resolve().parent.parent
        if not (package_root / "package.json").exists():
            row(OK, "install_stale", "package has no package.json — nothing to compare")
            return
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            record = None
        if not isinstance(record, dict):
            record = None
        head = _git_head(package_root)
        installed_commit = (record or {}).get("package_commit")
        recorded_hash = (record or {}).get("shipped_hash")
        data = {"installed_commit": installed_commit, "head": head}
        if record is None:
            row(WARN, "install_stale",
                f"no install record at {record_path}; run: {INSTALL_UPGRADE_HINT}", data)
            return
        if not recorded_hash:
            row(WARN, "install_stale",
                f"install record predates shipped-hash tracking; run: {INSTALL_UPGRADE_HINT}", data)
            return
        current_map = shipped_file_map(package_root)
        current = shipped_hash_from_map(current_map)
        data.update({"shipped_hash": recorded_hash[:12], "package_shipped_hash": current[:12]})
        if recorded_hash == current:
            row(OK, "install_stale",
                f"installed copy matches the shipped files (hash {current[:12]})", data)
            return
        recorded_map = record.get("shipped_files")
        if isinstance(recorded_map, dict):
            # Filter the RECORDED side through the same predicate: a record
            # written before plan 88-11 still lists services/*.pid, and a runtime
            # artefact must not be reported as a differing shipped file.
            recorded_map = {p: h for p, h in recorded_map.items() if is_shipped_path(p)}
            changed = sorted(
                p for p in set(recorded_map) | set(current_map)
                if recorded_map.get(p) != current_map.get(p)
            )
            data["differing"] = changed[:STALE_PATHS_CAP]
            data["differing_count"] = len(changed)
            row(WARN, "install_stale",
                f"installed files differ from the package ({len(changed)} files differ: "
                f"{', '.join(changed[:STALE_PATHS_CAP])}); run: {INSTALL_UPGRADE_HINT}", data)
        else:
            row(WARN, "install_stale",
                f"installed files differ from the package (per-file list not recorded); "
                f"run: {INSTALL_UPGRADE_HINT}", data)
    except Exception as e:
        row(WARN, "install_stale", f"Check error: {e}")


# ══ Check 4c: GitHub access (can this machine push the repo it is a checkout of?) ══
GITHUB_REMOTE_RE = re.compile(
    r"^(?:https?://(?:[^@/]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)"
    r"(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+?)(?:\.git)?/?$"
)
GH_TIMEOUT = float(os.environ.get("GSD_DOCTOR_GH_TIMEOUT", "15"))


def parse_github_remote(url):
    """(owner, repo) of a github.com remote URL, or None for anything else."""
    m = GITHUB_REMOTE_RE.match((url or "").strip())
    return (m.group("owner"), m.group("repo")) if m else None


def parse_gh_auth_status(text):
    """{account: {"scopes": [..] | None, "valid": bool}} for github.com.

    Reads only the account line and the `Token scopes:` line of `gh auth status`.
    The `Token:` line is never kept, so nothing secret can reach a row.
    """
    accounts = {}
    current = None
    for line in text.splitlines():
        m = re.search(r"(Logged in to|Failed to log in to) (\S+) account (\S+)", line)
        if m:
            current = None
            if m.group(2) == "github.com":
                current = m.group(3)
                accounts[current] = {"scopes": None, "valid": m.group(1) == "Logged in to"}
            continue
        if current and "Token scopes:" in line:
            raw = line.split("Token scopes:", 1)[1]
            accounts[current]["scopes"] = [t.strip().strip("'\"") for t in raw.split(",") if t.strip()]
    return accounts


def check_github_access(package_root=None):
    """Can the account that owns `origin` push to it, workflow files included?

    Reports whether `gh` is installed, whether the origin owner is logged in to
    gh, and whether that token has the `repo` and `workflow` scopes. Pushing a
    change under .github/workflows/ needs `workflow`. Never prints a token.

    Skipped cleanly (an OK row saying so, never a WARN) when `gh` is absent, there
    is no origin, the remote is not github.com, or gh gives no usable answer. WARN
    only when the remote is GitHub and the owner is not logged in or a scope is
    missing.
    """
    try:
        package_root = Path(package_root) if package_root else REPO_ROOT
        gh = shutil.which("gh")
        if not gh:
            row(OK, "github_access", "skipped — `gh` is not installed", {"skipped": "gh_absent"})
            return
        try:
            r = subprocess.run(["git", "-C", str(package_root), "remote", "get-url", "origin"],
                               capture_output=True, text=True, timeout=5)
            url = (r.stdout or "").strip() if r.returncode == 0 else ""
        except Exception:
            url = ""
        parsed = parse_github_remote(url)
        if not parsed:
            row(OK, "github_access", "skipped — origin is not a github.com remote",
                {"skipped": "not_github"})
            return
        owner, repo = parsed
        data = {"owner": owner, "repo": repo}
        try:
            res = subprocess.run([gh, "auth", "status", "--hostname", "github.com"],
                                 capture_output=True, text=True, timeout=GH_TIMEOUT)
            accounts = parse_gh_auth_status((res.stdout or "") + "\n" + (res.stderr or ""))
        except Exception as e:  # noqa: BLE001 — diagnostics must never crash
            row(OK, "github_access", f"skipped — could not run `gh auth status` ({type(e).__name__})",
                dict(data, skipped="gh_unusable"))
            return
        data["accounts"] = sorted(accounts)
        match = next((a for a in accounts if a.lower() == owner.lower()), None)
        if match is None or not accounts[match]["valid"]:
            have = ", ".join(sorted(accounts)) or "none"
            row(WARN, "github_access",
                f"gh has no working login for {owner} (origin owner; logged in: {have}) — "
                f"run: gh auth login -h github.com   then   gh auth switch -u {owner}",
                dict(data, owner_logged_in=False))
            return
        scopes = accounts[match]["scopes"]
        if scopes is None:
            row(OK, "github_access",
                f"skipped — gh reports no token scopes for {match} (fine-grained or env token)",
                dict(data, owner_logged_in=True, skipped="no_scopes_reported"))
            return
        data.update({"owner_logged_in": True, "scopes": scopes})
        missing = [sc for sc in ("repo", "workflow") if sc not in scopes]
        if not missing:
            row(OK, "github_access", f"{match} is logged in to gh with repo + workflow scopes", data)
            return
        data["missing_scopes"] = missing
        fix = f"gh auth switch -u {owner}   then   gh auth refresh -h github.com -s {','.join(missing)}"
        row(WARN, "github_access",
            f"{match}'s gh token lacks scope {', '.join(missing)} (pushing .github/workflows needs "
            f"workflow) — run: {fix}", data)
    except Exception as e:
        row(WARN, "github_access", f"Check error: {e}")


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
    """Report the model backend and the two OPTIONAL feature keys (ORC-05, plan 88-17).

    Before this plan the check reported a hard failure, listing all three key variables
    as required, when none was present -- i.e. it told a CORRECTLY configured user their
    installation was broken. Under ORC-05 no Anthropic key is needed at all (model calls
    go through the host runtime), and the other two enable optional features.

    Three distinct statements, and never a failure:
      * Anthropic: not needed. OK when a model backend resolves; a warning, never a
        failure, when none does -- that is a degraded feature, not a broken install.
      * Voyage and Perplexity: OK, "optional, off". NOT a warning: ``--strict`` promotes
        a warning to a failure, and plan 88-11 task 88-11-07 asserts a clean ``--strict``
        on a correctly configured machine.

    The check name stays ``api_keys``: tests/test_doctor.py asserts that category list and
    plan 88-11's close-out reads doctor's JSON by check name.
    """
    try:
        try:
            services_dir = str(pathlib.Path(__file__).resolve().parent)
            if services_dir not in sys.path:
                sys.path.insert(0, services_dir)
            from runtime_llm import resolve_backend
            backend, reason, _cli = resolve_backend()
        except Exception as e:  # pragma: no cover - a tree without services/ on sys.path
            backend, reason = "none", f"runtime_llm unavailable: {type(e).__name__}"

        optional = []
        for name, feature in (("VOYAGE_API_KEY", "embeddings"),
                              ("PERPLEXITY_API_KEY", "research-chain web leg")):
            state = "on" if os.environ.get(name, "") else "off"
            optional.append(f"{feature} {state}")
        optional_text = "; ".join(optional)

        if backend == "cli":
            row(OK, "api_keys",
                f"Anthropic: not needed (model calls use the host runtime CLI). "
                f"Optional: {optional_text}",
                {"model_backend": backend, "model_backend_reason": reason})
        elif backend == "api":
            row(OK, "api_keys",
                f"Anthropic: not needed (direct API selected by explicit opt-in). "
                f"Optional: {optional_text}",
                {"model_backend": backend, "model_backend_reason": reason})
        else:
            row(WARN, "api_keys",
                f"Anthropic: not needed, but no model backend is available "
                f"({reason}) -- features that call a model are off. "
                f"Optional: {optional_text}",
                {"model_backend": backend, "model_backend_reason": reason})
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
    check_github_access()
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
    # Phase 88-13: UTF-8 stdio when the console code page is not (Windows cp1252); a no-op otherwise.
    import os as _os, sys as _sys
    _sys.path.append(_os.path.dirname(_os.path.abspath(__file__)))
    try:
        from _platform import setup_stdio
    except ImportError:  # pragma: no cover - a tree without services/ on sys.path
        def setup_stdio():  # type: ignore[misc]
            return False
    setup_stdio()
    sys.exit(main(sys.argv[1:]))

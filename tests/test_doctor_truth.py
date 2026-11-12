#!/usr/bin/env python3
"""Truthful-doctor tests: PATH collision, install drift, version skew,
SQLite-fallback backend reporting, empty RLM index, missing embeddings,
--json and --strict exit codes.

Hermetic by construction:
  - HOME is a throwaway temp dir (and Path.home() is monkeypatched in-process tests)
  - API keys are set to dummies, so the result never depends on the operator's keys
  - `gh` is a fake script on PATH: the real gh and the network are never reached
  - the daemon / RLM endpoints are a local stub HTTP server on an ephemeral
    port (never the live daemon on 18799 / RLM on 18798)
  - PATH is replaced with temp dirs holding fake binaries

Run: python3 tests/test_doctor_truth.py       (or: pytest tests/test_doctor_truth.py -q)
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import stat
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

PYTHON = sys.executable
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests" / "support"))

import fake_exe  # noqa: E402  (tests/support: portable fake executables)

DOCTOR = str(ROOT / "services" / "doctor.py")
PKG_VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]


# ── Stub daemon ───────────────────────────────────────────────────────────────

class _StubHandler(BaseHTTPRequestHandler):
    routes = {}

    def do_GET(self):  # noqa: N802
        payload = self.routes.get(self.path.split("?")[0])
        if payload is None:
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):  # silence
        pass


def start_stub(routes):
    handler = type("H", (_StubHandler,), {"routes": routes})
    srv = HTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, srv.server_address[1]


# ── Helpers ───────────────────────────────────────────────────────────────────

isolated_path = fake_exe.isolated_path


def force_rmtree(path):
    """``shutil.rmtree`` that also removes read-only files (git's object files are read-only on Windows)."""
    def _writable_then_retry(func, target, _exc):
        os.chmod(target, stat.S_IWRITE)
        func(target)

    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_writable_then_retry)
    else:
        shutil.rmtree(path, onerror=_writable_then_retry)


def base_env(**extra):
    env = dict(os.environ)
    env["HOME"] = tempfile.mkdtemp(prefix="doctor-home-")
    # Path.home() / expanduser read USERPROFILE on Windows and ignore HOME: pin both.
    env["USERPROFILE"] = env["HOME"]
    # Unused ports by default: nothing must reach the live daemon/RLM.
    env["GSD_AMAUTA_PORT"] = "18991"
    env["GSD_RLM_PORT"] = "18992"
    # Default to a PATH with no `amauta` at all, so the operator's own install
    # cannot change a test outcome. Collision tests override PATH explicitly.
    # A fake `gh` leads it: the real one (present on CI runners) is never run.
    env["PATH"] = isolated_path(_fake_gh_dir())
    env.pop("CLAUDE_CONFIG_DIR", None)
    # check_api_keys is FAIL with none set. A runner has none and a laptop has
    # some, so the exit code depended on the machine; fix them.
    for key in ("VOYAGE_API_KEY", "PERPLEXITY_API_KEY", "ANTHROPIC_API_KEY"):
        env[key] = "dummy-not-a-real-key"
    env.update({k: str(v) for k, v in extra.items()})
    return env


NOT_LOGGED_IN = "You are not logged into any GitHub hosts. To log in, run: gh auth login\n"


def make_fake_gh(dirpath, status_text=NOT_LOGGED_IN, exit_code=1):
    """Write a `gh` that answers `auth status` with canned text and logs its argv.

    Any other subcommand exits 99, so a check that strays beyond `auth status`
    is visible in `<dirpath>/gh-calls.log`.
    """
    os.makedirs(dirpath, exist_ok=True)
    pathlib.Path(dirpath, "status.txt").write_text(status_text, encoding="utf-8")
    # A Python body, not a shell script: it behaves the same under sh and under a Windows .cmd shim,
    # and needs nothing from PATH (the launcher execs sys.executable by its absolute path).
    body = (
        "import os, sys\n"
        f"d = {str(dirpath)!r}\n"
        "with open(os.path.join(d, 'gh-calls.log'), 'a', encoding='utf-8', newline='\\n') as f:\n"
        "    f.write(' '.join(sys.argv[1:]) + '\\n')\n"
        "if sys.argv[1:3] == ['auth', 'status']:\n"
        "    with open(os.path.join(d, 'status.txt'), 'rb') as f:\n"
        "        sys.stdout.buffer.write(f.read())\n"
        "    sys.stdout.flush()\n"
        f"    sys.exit({exit_code})\n"
        "sys.exit(99)\n"
    )
    return fake_exe.write_fake_exe(dirpath, "gh", body)


def _fake_gh_dir():
    return os.path.dirname(make_fake_gh(tempfile.mkdtemp(prefix="doctor-fakegh-")))


def run_doctor(env, args=("--json",)):
    res = subprocess.run([PYTHON, DOCTOR, *args], capture_output=True, text=True,
                         timeout=30, env=env, cwd=str(ROOT), encoding="utf-8")
    parsed = None
    if "--json" in args:
        try:
            parsed = json.loads(res.stdout)
        except Exception:
            parsed = None
    return res.returncode, res.stdout, res.stderr, parsed


def check_row(parsed, category):
    for c in parsed["checks"]:
        if c["category"] == category:
            return c
    raise AssertionError(f"no '{category}' row in {[c['category'] for c in parsed['checks']]}")


def make_fake_bin(dirpath, name, body="// stand-in: doctor only looks the file up on PATH, it never runs it\n"):
    """Write a file called ``name`` that is executable by mode, for lookups that never run it."""
    os.makedirs(dirpath, exist_ok=True)
    p = os.path.join(dirpath, name)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(body)
    os.chmod(p, 0o755)
    return p


def sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def make_install(config_dir, version=PKG_VERSION, tamper=False, missing=False):
    """Build a fake installed copy + the manifest install.js would have written."""
    gsd = pathlib.Path(config_dir) / "get-shit-done"
    (gsd / "bin").mkdir(parents=True, exist_ok=True)
    (gsd / "VERSION").write_text(version, encoding="utf-8")
    f1 = gsd / "bin" / "gsd-tools.cjs"
    f1.write_text("// installed copy with rewritten absolute paths\n", encoding="utf-8")
    f2 = gsd / "bin" / "gsd-memory.cjs"
    f2.write_text("// second installed file\n", encoding="utf-8")
    manifest = {
        "version": version,
        "timestamp": "2026-01-01T00:00:00Z",
        "files": {
            "get-shit-done/bin/gsd-tools.cjs": sha256(f1),
            "get-shit-done/bin/gsd-memory.cjs": sha256(f2),
        },
    }
    (pathlib.Path(config_dir) / "gsd-file-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if tamper:
        f1.write_text("// EDITED AFTER INSTALL\n", encoding="utf-8")
    if missing:
        f2.unlink()
    return config_dir


# ── PATH collision ────────────────────────────────────────────────────────────

class TestPathCollision(unittest.TestCase):

    def test_foreign_amauta_first_on_path_is_a_failure(self):
        """A pipx-style `amauta` shadowing ours is FAIL and exits 2."""
        tmp = tempfile.mkdtemp(prefix="doctor-path-")
        make_fake_bin(tmp, "amauta")
        env = base_env(PATH=isolated_path(tmp))
        rc, _out, _err, parsed = run_doctor(env)
        rowc = check_row(parsed, "path_collision")
        self.assertEqual(rowc["status"], "FAIL", rowc["detail"])
        self.assertIn("amauta", rowc["detail"])
        self.assertEqual(rc, 2, "a PATH collision must exit 2")

    def test_our_amauta_on_path_is_ok(self):
        tmp = tempfile.mkdtemp(prefix="doctor-path-ok-")
        os.symlink(str(ROOT / "get-shit-done" / "bin" / "amauta.cjs"),
                   os.path.join(tmp, "amauta"))
        os.symlink(str(ROOT / "bin" / "cli.cjs"), os.path.join(tmp, "gsd-amauta"))
        env = base_env(PATH=isolated_path(tmp))
        _rc, _out, _err, parsed = run_doctor(env)
        rowc = check_row(parsed, "path_collision")
        self.assertEqual(rowc["status"], "OK", rowc["detail"])


# ── Install drift + version skew ──────────────────────────────────────────────

class TestInstallDrift(unittest.TestCase):

    def test_clean_install_reports_no_drift(self):
        cfg = make_install(tempfile.mkdtemp(prefix="doctor-cfg-"))
        env = base_env()
        _rc, _out, _err, parsed = run_doctor(env, ("--json", "--config-dir", cfg))
        rowc = check_row(parsed, "install_drift")
        self.assertEqual(rowc["status"], "OK", rowc["detail"])
        self.assertEqual(rowc["data"]["total"], 2)

    def test_modified_installed_file_is_listed(self):
        cfg = make_install(tempfile.mkdtemp(prefix="doctor-cfg-"), tamper=True)
        env = base_env()
        rc, _out, _err, parsed = run_doctor(env, ("--json", "--config-dir", cfg))
        rowc = check_row(parsed, "install_drift")
        self.assertEqual(rowc["status"], "WARN", rowc["detail"])
        self.assertIn("get-shit-done/bin/gsd-tools.cjs", rowc["data"]["modified"])
        self.assertGreaterEqual(rc, 1)

    def test_missing_installed_file_is_listed(self):
        cfg = make_install(tempfile.mkdtemp(prefix="doctor-cfg-"), missing=True)
        env = base_env()
        _rc, _out, _err, parsed = run_doctor(env, ("--json", "--config-dir", cfg))
        rowc = check_row(parsed, "install_drift")
        self.assertEqual(rowc["status"], "WARN", rowc["detail"])
        self.assertIn("get-shit-done/bin/gsd-memory.cjs", rowc["data"]["missing"])

    def test_no_manifest_is_a_warning_not_silence(self):
        cfg = tempfile.mkdtemp(prefix="doctor-cfg-empty-")
        env = base_env()
        _rc, _out, _err, parsed = run_doctor(env, ("--json", "--config-dir", cfg))
        rowc = check_row(parsed, "install_drift")
        self.assertEqual(rowc["status"], "WARN", rowc["detail"])

    def test_version_skew_detected(self):
        cfg = make_install(tempfile.mkdtemp(prefix="doctor-cfg-"), version="0.0.1")
        env = base_env()
        _rc, _out, _err, parsed = run_doctor(env, ("--json", "--config-dir", cfg))
        rowc = check_row(parsed, "version_skew")
        self.assertEqual(rowc["status"], "WARN", rowc["detail"])
        self.assertEqual(rowc["data"]["installed"], "0.0.1")
        self.assertEqual(rowc["data"]["package"], PKG_VERSION)

    def test_matching_version_is_ok(self):
        cfg = make_install(tempfile.mkdtemp(prefix="doctor-cfg-"))
        env = base_env()
        _rc, _out, _err, parsed = run_doctor(env, ("--json", "--config-dir", cfg))
        rowc = check_row(parsed, "version_skew")
        self.assertEqual(rowc["status"], "OK", rowc["detail"])


# ── Backend / RLM / embeddings, against a stub daemon ─────────────────────────

class TestBackendTruth(unittest.TestCase):

    def _run_with_stub(self, health, extra_routes=None, rlm=None, args=("--json",)):
        routes = {"/health": health}
        routes.update(extra_routes or {})
        srv, port = start_stub(routes)
        rlm_srv = None
        rlm_port = 18992
        if rlm is not None:
            rlm_srv, rlm_port = start_stub({"/health": rlm})
        try:
            env = base_env(GSD_AMAUTA_PORT=port, GSD_RLM_PORT=rlm_port)
            return run_doctor(env, args)
        finally:
            srv.shutdown()
            srv.server_close()
            if rlm_srv:
                rlm_srv.shutdown()
                rlm_srv.server_close()

    def test_sqlite_fallback_is_reported_as_degraded_with_features_off(self):
        health = {"status": "ok", "backend": "sqlite", "pg_available": False,
                  "rlm_running": False, "redis_running": False}
        rc, _out, _err, parsed = self._run_with_stub(health)
        rowc = check_row(parsed, "backend")
        self.assertEqual(rowc["status"], "WARN", rowc["detail"])
        self.assertIn("DEGRADED", rowc["detail"])
        self.assertTrue(rowc["data"]["features_off"], "features_off must be listed")
        self.assertIn("vector", rowc["detail"].lower())
        self.assertGreaterEqual(rc, 1, "a SQLite-fallback install is not healthy")

    def test_daemon_published_features_off_is_preferred(self):
        health = {"status": "ok", "backend": "sqlite", "pg_available": False,
                  "rlm_running": False, "redis_running": False,
                  "degraded": {"features_off": ["only-this-one"]}}
        _rc, _out, _err, parsed = self._run_with_stub(health)
        rowc = check_row(parsed, "backend")
        self.assertEqual(rowc["data"]["features_off"], ["only-this-one"])
        self.assertEqual(rowc["data"]["source"], "daemon")

    def test_pg_healthy_backend_is_ok(self):
        health = {"status": "ok", "backend": "postgresql", "pg_available": True,
                  "rlm_running": False, "redis_running": True}
        _rc, _out, _err, parsed = self._run_with_stub(health)
        rowc = check_row(parsed, "backend")
        self.assertEqual(rowc["status"], "OK", rowc["detail"])

    def test_configured_pg_that_is_down_is_a_failure(self):
        health = {"status": "ok", "backend": "postgresql", "pg_available": False,
                  "rlm_running": False, "redis_running": False}
        rc, _out, _err, parsed = self._run_with_stub(health)
        rowc = check_row(parsed, "backend")
        self.assertEqual(rowc["status"], "FAIL", rowc["detail"])
        self.assertEqual(rc, 2)

    def test_empty_rlm_index_is_reported(self):
        health = {"status": "ok", "backend": "postgresql", "pg_available": True,
                  "rlm_running": True, "redis_running": True}
        _rc, _out, _err, parsed = self._run_with_stub(
            health, rlm={"status": "ok", "index_size": 0, "pg_chunks_count": 0})
        rowc = check_row(parsed, "rlm_index")
        self.assertEqual(rowc["status"], "WARN", rowc["detail"])
        self.assertIn("EMPTY", rowc["detail"])

    def test_populated_rlm_index_is_ok(self):
        health = {"status": "ok", "backend": "postgresql", "pg_available": True,
                  "rlm_running": True, "redis_running": True}
        _rc, _out, _err, parsed = self._run_with_stub(
            health, rlm={"status": "ok", "index_size": 4242, "pg_chunks_count": 4242})
        rowc = check_row(parsed, "rlm_index")
        self.assertEqual(rowc["status"], "OK", rowc["detail"])

    def test_rows_without_embeddings_are_reported(self):
        health = {"status": "ok", "backend": "postgresql", "pg_available": True,
                  "rlm_running": False, "redis_running": True}
        stats = {"total": 100, "with_embedding": 60, "without_embedding": 40,
                 "coverage_pct": 60.0, "provider": "voyage"}
        _rc, _out, _err, parsed = self._run_with_stub(
            health, extra_routes={"/api/memory/embedding-stats": stats})
        rowc = check_row(parsed, "embeddings")
        self.assertEqual(rowc["status"], "WARN", rowc["detail"])
        self.assertIn("40/100", rowc["detail"])

    def test_embeddings_skipped_gracefully_when_not_exposed(self):
        health = {"status": "ok", "backend": "postgresql", "pg_available": True,
                  "rlm_running": False, "redis_running": True}
        _rc, _out, _err, parsed = self._run_with_stub(health)  # no stats route → 404
        rowc = check_row(parsed, "embeddings")
        self.assertEqual(rowc["status"], "WARN", rowc["detail"])
        self.assertIn("not exposed", rowc["detail"])


# ── Output modes / exit codes ─────────────────────────────────────────────────

class TestOutputModes(unittest.TestCase):

    def test_json_mode_is_parseable_and_carries_exit_code(self):
        rc, out, _err, parsed = run_doctor(base_env())
        self.assertIsNotNone(parsed, f"stdout was not JSON:\n{out[:400]}")
        self.assertEqual(parsed["exit_code"], rc)
        self.assertIn(parsed["verdict"], ("healthy", "degraded", "failing"))
        self.assertTrue(parsed["checks"])

    def test_strict_promotes_warnings_to_failure(self):
        env = base_env()
        rc_plain, _o, _e, parsed = run_doctor(env)
        self.assertGreaterEqual(parsed["summary"]["warn"], 1,
                                "this hermetic env should produce warnings")
        rc_strict, _o2, _e2, _p2 = run_doctor(env, ("--json", "--strict"))
        self.assertEqual(rc_plain, 1)
        self.assertEqual(rc_strict, 2, "--strict must treat warnings as failures")

    def test_human_output_is_compact(self):
        _rc, out, _err, _parsed = run_doctor(base_env(), args=())
        self.assertIn("gsd-amauta doctor", out)
        self.assertIn("Result:", out)
        for line in out.splitlines():
            self.assertLessEqual(len(line), 100, f"line too wide: {line}")


if __name__ == "__main__":
    unittest.main()


def load_doctor():
    """A fresh doctor module whose `rows` list the test can read."""
    spec = importlib.util.spec_from_file_location("doctor_under_test", DOCTOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.rows.clear()
    return mod


def write_package(root, files, shipped=("lib",)):
    """A fake package: package.json `files` array plus the given {relpath: text}."""
    root = pathlib.Path(root)
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(json.dumps({"name": "x", "version": "1.0.0",
                                                   "files": list(shipped)}), encoding="utf-8")
    for rel, text in files.items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
    return root


class TestInstallStale(unittest.TestCase):
    """install_stale compares a content hash of the shipped files, never git HEAD."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="doctor-stale-")
        self.pkg = os.path.join(self.tmp, "pkg")
        write_package(self.pkg, {"lib/a.txt": "alpha", "lib/sub/b.txt": "beta", "README.md": "docs"})
        self.git("init", "-q")
        self.commit("one")
        self.first = self.head()
        self.record = os.path.join(self.tmp, "install_record.json")
        self.mod = load_doctor()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", self.pkg, "-c", "user.email=t@t", "-c", "user.name=t",
             "-c", "commit.gpgsign=false", *args],
            capture_output=True, text=True, check=True, encoding="utf-8").stdout.strip()

    def commit(self, name, text=None):
        with open(os.path.join(self.pkg, name), "w", encoding="utf-8") as f:
            f.write(text if text is not None else name)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", name)

    def head(self):
        return self.git("rev-parse", "HEAD")

    def run_check(self):
        self.mod.rows.clear()
        self.mod.check_install_stale(record_path=self.record, package_root=self.pkg)
        self.assertEqual(len(self.mod.rows), 1)
        return self.mod, self.mod.rows[0]

    def write_record(self, commit, with_hash=True):
        rec = {"version": "3.3.0", "package_commit": commit}
        if with_hash:
            fmap = self.mod.shipped_file_map(self.pkg)
            rec["shipped_hash"] = self.mod.shipped_hash_from_map(fmap)
            rec["shipped_files"] = fmap
        with open(self.record, "w", encoding="utf-8") as f:
            json.dump(rec, f)

    def test_matching_hash_is_ok(self):
        self.write_record(self.first)
        mod, (status, cat, _detail, _) = self.run_check()
        self.assertEqual((status, cat), (mod.OK, "install_stale"))

    def test_shipped_hash_is_deterministic(self):
        """Same content hashes the same twice, and whatever order files were created in."""
        a = self.mod.shipped_file_hash(self.pkg)
        self.assertEqual(a, self.mod.shipped_file_hash(self.pkg))
        self.assertEqual(len(a), 64)
        trees = []
        for n, order in enumerate((["lib/a.txt", "lib/sub/b.txt", "lib/z.txt"],
                                   ["lib/z.txt", "lib/sub/b.txt", "lib/a.txt"])):
            root = os.path.join(self.tmp, f"order{n}")
            write_package(root, {rel: rel.upper() for rel in order})
            trees.append(self.mod.shipped_file_hash(root))
        self.assertEqual(trees[0], trees[1])

    def test_head_change_without_file_change_stays_ok(self):
        """FND-10: a commit that touches no shipped file must not mark the install stale."""
        self.write_record(self.first)
        self.commit("NOTES-not-shipped.md")
        self.assertNotEqual(self.head(), self.first, "HEAD must have moved")
        mod, (status, _, _detail, data) = self.run_check()
        self.assertEqual(status, mod.OK)
        self.assertEqual(data["head"], self.head())

    def test_shipped_file_change_is_warn(self):
        self.write_record(self.first)
        self.commit("lib/a.txt", "alpha CHANGED")
        mod, (status, _, detail, data) = self.run_check()
        self.assertEqual(status, mod.WARN)
        self.assertIn("lib/a.txt", data["differing"])
        self.assertEqual(data["differing_count"], 1)
        self.assertIn("--upgrade", detail)

    def test_added_and_removed_shipped_files_are_named(self):
        self.write_record(self.first)
        self.commit("lib/new.txt", "n")
        os.remove(os.path.join(self.pkg, "lib", "sub", "b.txt"))
        mod, (status, _, _detail, data) = self.run_check()
        self.assertEqual(status, mod.WARN)
        self.assertEqual(data["differing"], ["lib/new.txt", "lib/sub/b.txt"])

    def test_pycache_and_ds_store_do_not_count(self):
        self.write_record(self.first)
        for rel in ("lib/__pycache__/a.cpython-312.pyc", "lib/__pycache__/any-name.txt",
                    "lib/.DS_Store", "lib/x.pyc"):
            f = os.path.join(self.pkg, rel)
            os.makedirs(os.path.dirname(f), exist_ok=True)
            open(f, "w", encoding="utf-8").write("junk")
        mod, (status, *_rest) = self.run_check()
        self.assertEqual(status, mod.OK)

    def test_record_without_shipped_hash_is_warn_with_upgrade_hint(self):
        self.write_record(self.first, with_hash=False)
        mod, (status, _, detail, _data) = self.run_check()
        self.assertEqual(status, mod.WARN)
        self.assertIn("node bin/init.cjs --upgrade --files-only", detail)
        self.assertIn("predates shipped-hash tracking", detail)

    def test_missing_record_warns_instead_of_assuming_current(self):
        mod, (status, _, _detail, data) = self.run_check()
        self.assertEqual(status, mod.WARN)
        self.assertIsNone(data["installed_commit"])

    def test_non_git_package_is_not_a_warning(self):
        """Content comparison needs no git: a matching hash is OK without a checkout."""
        self.write_record(self.first)
        force_rmtree(os.path.join(self.pkg, ".git"))
        mod, (status, *_rest) = self.run_check()
        self.assertEqual(status, mod.OK)

    def test_node_and_python_hash_the_same_tree_identically(self):
        """bin/init.cjs writes the hash doctor.py checks: both folds must agree."""
        node = "/opt/homebrew/bin/node" if os.path.exists("/opt/homebrew/bin/node") else shutil.which("node")
        if not node or subprocess.run([node, "--version"], capture_output=True).returncode != 0:
            self.skipTest("needs a working `node` on the runner")
        tricky = os.path.join(self.tmp, "tricky")
        write_package(tricky, {"lib/a b.txt": "x", "lib/\u00e9t\u00e9.txt": "y", "lib/Z.txt": "z",
                               "lib/sub/deep/c.txt": "c", "lib/node_modules/skip.txt": "no",
                               "lib/__pycache__/skip.pyc": "no", "top.txt": "t"},
                      shipped=("lib", "top.txt", "missing-entry"))
        for root in (tricky, str(ROOT)):
            res = subprocess.run(
                [node, "-e", "const i=require('./bin/init.cjs');"
                 "console.log(i.shippedHashFromMap(i.shippedFileMap(process.argv[1])))", root],
                capture_output=True, text=True, cwd=str(ROOT), timeout=60, env=base_env(), encoding="utf-8")
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(res.stdout.strip(), self.mod.shipped_file_hash(root), root)


# ── github_access: a fake `gh` on PATH, never the real one ────────────────────

GH_BOTH = (
    "github.com\n"
    "  \u2713 Logged in to github.com account acme (keyring)\n"
    "  - Active account: true\n"
    "  - Git operations protocol: https\n"
    "  - Token: gho_SUPERSECRETTOKENVALUE0123456789\n"
    "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n"
)
GH_NO_WORKFLOW = GH_BOTH.replace(", 'workflow'", "")
GH_OTHER_ACCOUNT = GH_BOTH.replace("account acme", "account someone-else")


class TestGithubAccess(unittest.TestCase):
    """The check reports login and scopes without printing a token."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="doctor-gh-")
        self.pkg = os.path.join(self.tmp, "pkg")
        write_package(self.pkg, {"lib/a.txt": "a"})
        self.set_remote("https://github.com/acme/widgets.git")
        # PATH holds only `git` and, when asked, the fake gh.
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        git = shutil.which("git")
        self.old_path = os.environ["PATH"]
        if sys.platform == "win32":
            # A symlink named `git` (no .exe) is not an executable to CreateProcess, and Git for Windows
            # finds its helpers relative to its own path, so the real directory goes on PATH instead.
            # That directory holds no `gh`, which is the point: only the fake can be found.
            os.environ["PATH"] = os.pathsep.join([self.bin, os.path.dirname(git)])
        else:
            os.symlink(git, os.path.join(self.bin, "git"))
            os.environ["PATH"] = self.bin
        self.mod = load_doctor()

    def tearDown(self):
        os.environ["PATH"] = self.old_path
        shutil.rmtree(self.tmp, ignore_errors=True)

    def set_remote(self, url):
        subprocess.run(["git", "-C", self.pkg, "init", "-q"], check=True, capture_output=True)
        subprocess.run(["git", "-C", self.pkg, "remote", "remove", "origin"], capture_output=True)
        if url:
            subprocess.run(["git", "-C", self.pkg, "remote", "add", "origin", url],
                           check=True, capture_output=True)

    def install_gh(self, status, exit_code=0):
        make_fake_gh(self.bin, status, exit_code)

    def run_check(self):
        self.mod.rows.clear()
        self.mod.check_github_access(package_root=self.pkg)
        self.assertEqual(len(self.mod.rows), 1)
        status, cat, detail, data = self.mod.rows[0]
        self.assertEqual(cat, "github_access")
        self.assertNotIn("SUPERSECRET", json.dumps([detail, data]), "a token reached the row")
        return status, detail, data

    def gh_calls(self):
        log = pathlib.Path(self.bin, "gh-calls.log")
        return log.read_text(encoding="utf-8").splitlines() if log.exists() else []

    def test_logged_in_with_repo_and_workflow_is_ok(self):
        self.install_gh(GH_BOTH)
        status, detail, data = self.run_check()
        self.assertEqual(status, self.mod.OK, detail)
        self.assertEqual(data["scopes"], ["gist", "read:org", "repo", "workflow"])
        self.assertEqual(self.gh_calls(), ["auth status --hostname github.com"])

    def test_missing_workflow_scope_is_warn_with_the_exact_fix(self):
        self.install_gh(GH_NO_WORKFLOW)
        status, detail, data = self.run_check()
        self.assertEqual(status, self.mod.WARN, detail)
        self.assertEqual(data["missing_scopes"], ["workflow"])
        self.assertIn("gh auth switch -u acme", detail)
        self.assertIn("gh auth refresh -h github.com -s workflow", detail)

    def test_owner_account_not_logged_in_is_warn(self):
        self.install_gh(GH_OTHER_ACCOUNT)
        status, detail, data = self.run_check()
        self.assertEqual(status, self.mod.WARN, detail)
        self.assertFalse(data["owner_logged_in"])
        self.assertIn("acme", detail)
        self.assertIn("gh auth switch -u acme", detail)

    def test_no_accounts_at_all_is_warn(self):
        self.install_gh(NOT_LOGGED_IN, exit_code=1)
        status, detail, _data = self.run_check()
        self.assertEqual(status, self.mod.WARN, detail)

    def test_gh_absent_is_skipped_not_warn(self):
        status, detail, data = self.run_check()
        self.assertEqual(status, self.mod.OK)
        self.assertEqual(data["skipped"], "gh_absent")
        self.assertIn("skipped", detail)

    def test_non_github_remote_is_skipped_not_warn_and_never_asks_gh(self):
        self.install_gh(GH_NO_WORKFLOW)
        self.set_remote("https://gitlab.com/acme/widgets.git")
        status, _detail, data = self.run_check()
        self.assertEqual(status, self.mod.OK)
        self.assertEqual(data["skipped"], "not_github")
        self.assertEqual(self.gh_calls(), [])

    def test_no_origin_is_skipped(self):
        self.install_gh(GH_NO_WORKFLOW)
        self.set_remote(None)
        status, _detail, data = self.run_check()
        self.assertEqual(status, self.mod.OK)
        self.assertEqual(data["skipped"], "not_github")

    def test_parse_github_remote_forms(self):
        p = self.mod.parse_github_remote
        self.assertEqual(p("https://github.com/acme/widgets.git"), ("acme", "widgets"))
        self.assertEqual(p("https://x-access-token:abc@github.com/acme/widgets"), ("acme", "widgets"))
        self.assertEqual(p("git@github.com:acme/widgets.git"), ("acme", "widgets"))
        self.assertEqual(p("ssh://git@github.com/acme/widgets.git"), ("acme", "widgets"))
        self.assertIsNone(p("https://gitlab.com/acme/widgets.git"))
        self.assertIsNone(p("https://github.com.evil.example/acme/widgets"))
        self.assertIsNone(p(""))

    def test_credentials_in_the_remote_url_never_reach_the_row(self):
        self.install_gh(GH_BOTH)
        self.set_remote("https://acme:hunter2-secret@github.com/acme/widgets.git")
        _status, detail, data = self.run_check()
        self.assertNotIn("hunter2", json.dumps([detail, data]))

    def test_doctor_run_uses_only_the_fake_gh(self):
        """End to end: main() with a fake gh leading PATH never reaches the real one."""
        fake = _fake_gh_dir()
        env = base_env(GSD_AMAUTA_PORT=18991)
        env["PATH"] = isolated_path(fake)
        _rc, _out, _err, parsed = run_doctor(env)
        gh_row = check_row(parsed, "github_access")
        self.assertEqual(gh_row["category"], "github_access")
        log = pathlib.Path(fake, "gh-calls.log")
        self.assertTrue(log.exists(), "the fake gh was never run; the row says: %r" % (gh_row,))
        calls = log.read_text(encoding="utf-8").splitlines()
        self.assertEqual(calls, ["auth status --hostname github.com"])

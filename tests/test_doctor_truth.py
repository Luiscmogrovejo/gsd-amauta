#!/usr/bin/env python3
"""Truthful-doctor tests: PATH collision, install drift, version skew,
SQLite-fallback backend reporting, empty RLM index, missing embeddings,
--json and --strict exit codes.

Hermetic by construction:
  - HOME is a throwaway temp dir
  - the daemon / RLM endpoints are a local stub HTTP server on an ephemeral
    port (never the live daemon on 18799 / RLM on 18798)
  - PATH is replaced with temp dirs holding fake binaries

Run: python3 tests/test_doctor_truth.py       (or: pytest tests/test_doctor_truth.py -q)
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

PYTHON = sys.executable
ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCTOR = str(ROOT / "services" / "doctor.py")
PKG_VERSION = json.loads((ROOT / "package.json").read_text())["version"]


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

def base_env(**extra):
    env = dict(os.environ)
    env["HOME"] = tempfile.mkdtemp(prefix="doctor-home-")
    # Unused ports by default: nothing must reach the live daemon/RLM.
    env["GSD_AMAUTA_PORT"] = "18991"
    env["GSD_RLM_PORT"] = "18992"
    # Default to a PATH with no `amauta` at all, so the operator's own install
    # cannot change a test outcome. Collision tests override PATH explicitly.
    env["PATH"] = "/usr/bin:/bin"
    env.pop("CLAUDE_CONFIG_DIR", None)
    env.update({k: str(v) for k, v in extra.items()})
    return env


def run_doctor(env, args=("--json",)):
    res = subprocess.run([PYTHON, DOCTOR, *args], capture_output=True, text=True,
                         timeout=30, env=env, cwd=str(ROOT))
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


def make_fake_bin(dirpath, name, body="#!/bin/sh\necho fake\n"):
    os.makedirs(dirpath, exist_ok=True)
    p = os.path.join(dirpath, name)
    with open(p, "w") as fh:
        fh.write(body)
    os.chmod(p, 0o755)
    return p


def sha256(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def make_install(config_dir, version=PKG_VERSION, tamper=False, missing=False):
    """Build a fake installed copy + the manifest install.js would have written."""
    gsd = pathlib.Path(config_dir) / "get-shit-done"
    (gsd / "bin").mkdir(parents=True, exist_ok=True)
    (gsd / "VERSION").write_text(version)
    f1 = gsd / "bin" / "gsd-tools.cjs"
    f1.write_text("// installed copy with /abs/home/.claude/ rewritten paths\n")
    f2 = gsd / "bin" / "gsd-memory.cjs"
    f2.write_text("// second installed file\n")
    manifest = {
        "version": version,
        "timestamp": "2026-01-01T00:00:00Z",
        "files": {
            "get-shit-done/bin/gsd-tools.cjs": sha256(f1),
            "get-shit-done/bin/gsd-memory.cjs": sha256(f2),
        },
    }
    (pathlib.Path(config_dir) / "gsd-file-manifest.json").write_text(json.dumps(manifest))
    if tamper:
        f1.write_text("// EDITED AFTER INSTALL\n")
    if missing:
        f2.unlink()
    return config_dir


# ── PATH collision ────────────────────────────────────────────────────────────

class TestPathCollision(unittest.TestCase):

    def test_foreign_amauta_first_on_path_is_a_failure(self):
        """A pipx-style `amauta` shadowing ours is FAIL and exits 2."""
        tmp = tempfile.mkdtemp(prefix="doctor-path-")
        make_fake_bin(tmp, "amauta")
        env = base_env(PATH=f"{tmp}:/usr/bin:/bin")
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
        env = base_env(PATH=f"{tmp}:/usr/bin:/bin")
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


class TestInstallStale(unittest.TestCase):
    """The manifest check cannot see that the package moved on after install."""

    def setUp(self):
        import subprocess, tempfile
        self.subprocess = subprocess
        self.tmp = tempfile.mkdtemp(prefix="doctor-stale-")
        self.pkg = os.path.join(self.tmp, "pkg")
        os.makedirs(self.pkg)
        self.git("init", "-q")
        self.commit("one")
        self.first = self.head()
        self.record = os.path.join(self.tmp, "install_record.json")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def git(self, *args):
        return self.subprocess.run(
            ["git", "-C", self.pkg, "-c", "user.email=t@t", "-c", "user.name=t",
             "-c", "commit.gpgsign=false", *args],
            capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, name):
        with open(os.path.join(self.pkg, name), "w") as f:
            f.write(name)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", name)

    def head(self):
        return self.git("rev-parse", "HEAD")

    def run_check(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "doctor_stale", os.path.join(os.path.dirname(__file__), "..", "services", "doctor.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        rows = []
        mod.row = lambda status, cat, detail, data=None: rows.append((status, cat, detail, data))
        mod.check_install_stale(record_path=self.record, package_root=self.pkg)
        self.assertEqual(len(rows), 1)
        return mod, rows[0]

    def write_record(self, commit):
        import json
        with open(self.record, "w") as f:
            json.dump({"version": "3.3.0", "package_commit": commit}, f)

    def test_matching_commit_is_ok(self):
        self.write_record(self.first)
        mod, (status, cat, detail, _) = self.run_check()
        self.assertEqual((status, cat), (mod.OK, "install_stale"))

    def test_package_ahead_of_install_warns_with_distance(self):
        self.write_record(self.first)
        self.commit("two")
        self.commit("three")
        mod, (status, _, detail, data) = self.run_check()
        self.assertEqual(status, mod.WARN)
        self.assertEqual(data["commits_behind"], 2)
        self.assertIn("--upgrade", detail)

    def test_missing_record_warns_instead_of_assuming_current(self):
        mod, (status, _, detail, data) = self.run_check()
        self.assertEqual(status, mod.WARN)
        self.assertIsNone(data["installed_commit"])

    def test_non_git_package_is_not_a_warning(self):
        import shutil
        shutil.rmtree(os.path.join(self.pkg, ".git"))
        mod, (status, _, _, _) = self.run_check()
        self.assertEqual(status, mod.OK)

#!/usr/bin/env python3
"""Plan 88-11: runtime artefacts are not shipped files, and ONE list says so.

The defect this pins: on a machine where ``plugin_root`` IS the repository, the
daemon and the RLM service write their pid files into the shipped ``services/``
directory. ``doctor`` therefore reported, after every daemon restart::

    install_stale WARN: 2 files differ: services/amauta-daemon.pid,
                                        services/rlm-service.pid

Two implementations compute the shipped set -- ``shippedFileMap`` in
``bin/init.cjs`` (the installer writes the hash) and ``shipped_file_map`` in
``services/doctor.py`` (doctor re-computes and compares it). If their exclusion
lists drift, every install reads as stale or a real change reads as clean. These
tests compare the two name sets LITERALLY and hash the same trees with both.

Hermetic by construction: temporary trees only, no HOME write, no git, no
network, no service. The one child process is ``node -e`` against a temp tree.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "services"))

import importlib.util  # noqa: E402

DOCTOR = str(ROOT / "services" / "doctor.py")
INIT = str(ROOT / "bin" / "init.cjs")


def load_doctor():
    """A fresh doctor module whose ``rows`` list the test can read."""
    spec = importlib.util.spec_from_file_location("doctor_excl_under_test", DOCTOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.rows.clear()
    return mod


def node_binary():
    """The node to drive the Node implementation with, or None."""
    for cand in ("/opt/homebrew/bin/node", shutil.which("node")):
        if cand and os.path.exists(cand):
            try:
                if subprocess.run([cand, "--version"], capture_output=True).returncode == 0:
                    return cand
            except OSError:
                continue
    return None


def write_package(root, files, shipped=("lib",)):
    """A fake package: a package.json ``files`` array plus ``{relpath: text}``."""
    root = pathlib.Path(root)
    root.mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text(
        json.dumps({"name": "x", "version": "1.0.0", "files": list(shipped)}),
        encoding="utf-8")
    for rel, text in files.items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
    return root


# Every runtime artefact the two sides must agree to ignore, keyed by the rule
# that catches it. `services/*.pid` is the measured defect; the rest are the same
# class of file and are pinned so a later edit cannot drop one quietly.
RUNTIME_ARTEFACTS = {
    "lib/amauta-daemon.pid": "12345",
    "lib/rlm-service.pid": "12346",
    "lib/amauta-daemon.err.log": "traceback",
    "lib/sub/nested.log": "lines",
    "lib/__pycache__/doctor.cpython-312.pyc": "bytecode",
    "lib/__pycache__/stray.txt": "junk",
    "lib/compiled.pyc": "bytecode",
    "lib/compiled.pyo": "bytecode",
    "lib/data/store.db": "rows",
    "lib/logs/today.txt": "lines",
    "lib/backups/old.json": "{}",
    "lib/node_modules/dep/index.js": "module",
    "lib/.pytest_cache/v/cache/lastfailed": "{}",
    "lib/.DS_Store": "finder",
    "lib/Thumbs.db": "windows",
    "lib/.env": "SECRET=not-read-by-this-test",
    "lib/daemon.sock": "socket",
    "lib/notes.bak": "backup",
    "lib/half-written.tmp": "partial",
}

REAL_SHIPPED = {"lib/a.py": "alpha", "lib/sub/b.cjs": "beta", "top.txt": "t"}


class TestSharedExclusionList(unittest.TestCase):
    """One list, both sides."""

    def setUp(self):
        self.mod = load_doctor()
        self.tmp = tempfile.mkdtemp(prefix="gsd-88-11-excl-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def node_exclusions(self):
        """The three exclusion sets as bin/init.cjs holds them."""
        node = node_binary()
        if not node:
            self.skipTest("needs a working `node` on the runner")
        res = subprocess.run(
            [node, "-e",
             "const i=require('./bin/init.cjs');"
             "console.log(JSON.stringify({dirs:[...i.SHIPPED_EXCLUDE_DIRS].sort(),"
             "names:[...i.SHIPPED_EXCLUDE_NAMES].sort(),"
             "suffixes:[...i.SHIPPED_EXCLUDE_SUFFIXES].sort()}))"],
            capture_output=True, text=True, cwd=str(ROOT), timeout=60, encoding="utf-8")
        self.assertEqual(res.returncode, 0, res.stderr)
        return json.loads(res.stdout.strip())

    def test_the_two_exclusion_lists_are_identical(self):
        """The agreement test the brief asks for: compare the lists, not the effect."""
        node = self.node_exclusions()
        self.assertEqual(node["dirs"], sorted(self.mod.SHIPPED_EXCLUDE_DIRS))
        self.assertEqual(node["names"], sorted(self.mod.SHIPPED_EXCLUDE_NAMES))
        self.assertEqual(node["suffixes"], sorted(self.mod.SHIPPED_EXCLUDE_SUFFIXES))

    def test_pid_and_log_suffixes_are_in_the_list(self):
        """The measured defect, named: without these two the install goes stale."""
        self.assertIn(".pid", self.mod.SHIPPED_EXCLUDE_SUFFIXES)
        self.assertIn(".log", self.mod.SHIPPED_EXCLUDE_SUFFIXES)

    def test_is_shipped_path_classifies_every_artefact(self):
        for rel in RUNTIME_ARTEFACTS:
            self.assertFalse(self.mod.is_shipped_path(rel), rel)
        for rel in REAL_SHIPPED:
            self.assertTrue(self.mod.is_shipped_path(rel), rel)

    def test_a_directory_named_like_an_excluded_one_deeper_down_is_still_excluded(self):
        self.assertFalse(self.mod.is_shipped_path("lib/sub/deep/data/x.txt"))
        self.assertFalse(self.mod.is_shipped_path("lib/sub/__pycache__/x.txt"))
        # A FILE called data (not a directory component) is shipped.
        self.assertTrue(self.mod.is_shipped_path("lib/data.py"))
        # A name that merely starts with an excluded suffix is shipped.
        self.assertTrue(self.mod.is_shipped_path("lib/x.pid.py"))

    def test_hooks_dist_is_gitignored_and_shipped(self):
        """Why .gitignore cannot be the source of the list.

        `hooks/dist/` is an entry of package.json `files` AND a .gitignore rule:
        it is a build output committed to npm, not to git. A gitignore-derived
        exclusion rule would silently drop a whole shipped directory.
        """
        files = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["files"]
        self.assertIn("hooks/dist", files)
        gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("hooks/dist/", [line.strip() for line in gitignore])
        self.assertTrue(self.mod.is_shipped_path("hooks/dist/gsd-shunt-gate.cjs"))

    def test_both_implementations_hash_a_tree_full_of_artefacts_identically(self):
        """The two folds must agree on a tree that holds every artefact class."""
        node = node_binary()
        if not node:
            self.skipTest("needs a working `node` on the runner")
        root = os.path.join(self.tmp, "tricky")
        files = dict(REAL_SHIPPED)
        files.update(RUNTIME_ARTEFACTS)
        # Awkward names the two walkers must agree on, carried from the Phase 88
        # plan 88-10 test: a space, a non-ASCII name, and case.
        files.update({"lib/a b.py": "x", "lib/été.py": "y", "lib/Z.py": "z"})
        write_package(root, files, shipped=("lib", "top.txt", "data", "missing-entry"))
        res = subprocess.run(
            [node, "-e",
             "const i=require('./bin/init.cjs');"
             "console.log(i.shippedHashFromMap(i.shippedFileMap(process.argv[1])))", root],
            capture_output=True, text=True, cwd=str(ROOT), timeout=60, encoding="utf-8")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(res.stdout.strip(), self.mod.shipped_file_hash(root))

    def test_the_hashed_set_holds_the_real_files_and_none_of_the_artefacts(self):
        root = os.path.join(self.tmp, "set")
        files = dict(REAL_SHIPPED)
        files.update(RUNTIME_ARTEFACTS)
        write_package(root, files, shipped=("lib", "top.txt", "data"))
        got = set(self.mod.shipped_file_map(root))
        self.assertEqual(got, set(REAL_SHIPPED), f"unexpected membership: {sorted(got)}")


class TestInstallStaleIgnoresRuntimeArtefacts(unittest.TestCase):
    """The end of the WARN the operator saw, plus the mutation that must still WARN."""

    def setUp(self):
        self.mod = load_doctor()
        self.tmp = tempfile.mkdtemp(prefix="gsd-88-11-stale-")
        self.pkg = os.path.join(self.tmp, "pkg")
        write_package(self.pkg, dict(REAL_SHIPPED), shipped=("lib", "top.txt"))
        self.record = os.path.join(self.tmp, "install_record.json")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_record(self, extra_shipped=None):
        fmap = self.mod.shipped_file_map(self.pkg)
        rec = {"version": "3.3.0", "package_commit": "0" * 40,
               "shipped_hash": self.mod.shipped_hash_from_map(fmap),
               "shipped_files": dict(fmap)}
        if extra_shipped:
            rec["shipped_files"].update(extra_shipped)
        with open(self.record, "w", encoding="utf-8") as fh:
            json.dump(rec, fh)

    def run_check(self):
        self.mod.rows.clear()
        self.mod.check_install_stale(record_path=self.record, package_root=self.pkg)
        self.assertEqual(len(self.mod.rows), 1)
        return self.mod.rows[0]

    def write(self, rel, text):
        f = pathlib.Path(self.pkg) / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")

    def test_a_restarted_daemon_does_not_stale_the_install(self):
        """THE DEFECT: two pid files appearing, then changing, must read OK."""
        self.write_record()
        self.write("lib/amauta-daemon.pid", "11111")
        self.write("lib/rlm-service.pid", "22222")
        status, cat, detail, _data = self.run_check()
        self.assertEqual((status, cat), (self.mod.OK, "install_stale"), detail)
        # ...and again after a restart writes different pids.
        self.write("lib/amauta-daemon.pid", "33333")
        self.write("lib/rlm-service.pid", "44444")
        status, _cat, detail, _data = self.run_check()
        self.assertEqual(status, self.mod.OK, detail)

    def test_a_log_file_growing_does_not_stale_the_install(self):
        self.write_record()
        self.write("lib/amauta-daemon.err.log", "line one\n")
        self.assertEqual(self.run_check()[0], self.mod.OK)
        self.write("lib/amauta-daemon.err.log", "line one\nline two\n")
        self.assertEqual(self.run_check()[0], self.mod.OK)

    def test_MUTATION_a_real_shipped_file_change_still_warns_and_is_named(self):
        """The arm that proves the exclusion did not simply switch the check off."""
        self.write_record()
        self.write("lib/amauta-daemon.pid", "99999")   # noise that must not matter
        self.write("lib/a.py", "alpha CHANGED")        # the change that must matter
        status, _cat, detail, data = self.run_check()
        self.assertEqual(status, self.mod.WARN, detail)
        self.assertEqual(data["differing"], ["lib/a.py"])
        self.assertEqual(data["differing_count"], 1)
        self.assertNotIn("lib/amauta-daemon.pid", detail)

    def test_MUTATION_a_removed_shipped_file_still_warns(self):
        self.write_record()
        os.remove(os.path.join(self.pkg, "lib", "sub", "b.cjs"))
        status, _cat, _detail, data = self.run_check()
        self.assertEqual(status, self.mod.WARN)
        self.assertEqual(data["differing"], ["lib/sub/b.cjs"])

    def test_an_old_record_that_lists_pid_files_is_not_reported_as_differing(self):
        """A record written before this plan still has services/*.pid in its map.

        The recorded side goes through the same predicate, so the stale entries
        cannot produce a differing-files list of their own.
        """
        self.write_record(extra_shipped={"lib/amauta-daemon.pid": "a" * 64,
                                         "lib/rlm-service.pid": "b" * 64})
        status, _cat, detail, _data = self.run_check()
        self.assertEqual(status, self.mod.OK, detail)

    def test_an_old_record_still_warns_about_a_real_change_beside_the_pids(self):
        self.write_record(extra_shipped={"lib/amauta-daemon.pid": "a" * 64})
        self.write("lib/a.py", "alpha CHANGED")
        status, _cat, _detail, data = self.run_check()
        self.assertEqual(status, self.mod.WARN)
        self.assertEqual(data["differing"], ["lib/a.py"])


if __name__ == "__main__":
    unittest.main()

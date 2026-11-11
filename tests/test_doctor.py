#!/usr/bin/env python3
"""STAB-06: gsd-amauta doctor command tests.

Covers:
  - doctor exit code reflects the worst severity (0 healthy / 1 warn / 2 fail)
  - doctor emits >= 8 status rows
  - doctor output contains all required category names
  - doctor header present
  - rlm_restarts_lifetime field consumed (STAB-03 consumer chain)
  - doctor source parses as valid Python
  - bin/cli.cjs has doctor command branch
  - bin/cli.cjs references services/doctor.py
  - Result summary line present

NOTE (truthful-doctor pass): doctor no longer always exits 0 — a degraded
install exits 1 and a failing one exits 2. The old `test_exits_0` asserted the
defect, so it is replaced by `test_exit_code_reflects_severity`.

Every run here is hermetic: a throwaway HOME and unused daemon/RLM ports, so
the test never talks to a real daemon.

Run: pytest tests/test_doctor.py -q
"""
import ast
import os
import re
import subprocess
import sys
import tempfile
import unittest

PYTHON = sys.executable

# Ports deliberately outside the live daemon (18799) / RLM (18798) range.
HERMETIC_PORTS = {"GSD_AMAUTA_PORT": "18991", "GSD_RLM_PORT": "18992"}


def hermetic_env(extra=None):
    env = dict(os.environ)
    env.update(HERMETIC_PORTS)
    env["HOME"] = tempfile.mkdtemp(prefix="doctor-home-")
    env.pop("CLAUDE_CONFIG_DIR", None)
    if extra:
        env.update(extra)
    return env


def run_doctor(env=None, args=()):
    """Run services/doctor.py and return (returncode, stdout, stderr)."""
    result = subprocess.run(
        [PYTHON, "services/doctor.py", *args],
        capture_output=True,
        text=True,
        timeout=20,
        env=env if env is not None else hermetic_env(),
    )
    return result.returncode, result.stdout, result.stderr


class TestDoctorStructure(unittest.TestCase):

    def setUp(self):
        self.src = open("services/doctor.py").read()
        self.tree = ast.parse(self.src)

    def test_exit_code_reflects_severity(self):
        """doctor exits 0/1/2 and the code matches the rendered counts."""
        rc, out, _ = run_doctor()
        self.assertIn(rc, (0, 1, 2), f"doctor must exit 0, 1 or 2 — got {rc}")
        m = re.search(r"Result: (\d+) OK, (\d+) WARN, (\d+) FAIL", out)
        self.assertIsNotNone(m, f"no Result summary line in output:\n{out}")
        _ok, warn, fail = (int(g) for g in m.groups())
        expected = 2 if fail else (1 if warn else 0)
        self.assertEqual(rc, expected,
                         f"exit {rc} does not match {warn} WARN / {fail} FAIL")

    def test_emits_8_rows(self):
        """doctor emits at least 8 status rows."""
        _, out, _ = run_doctor()
        rows = re.findall(r'\[(OK  |WARN|FAIL)\]', out)
        self.assertGreaterEqual(len(rows), 8, f"Expected >= 8 rows, got {len(rows)}")

    def test_all_8_categories_present(self):
        """doctor output contains all 8 required category names."""
        _, out, _ = run_doctor()
        for cat in ["paths", "daemon", "postgres", "valkey", "api_keys", "migrations", "agents", "skills"]:
            self.assertIn(cat, out, f"Category '{cat}' missing from doctor output")

    def test_header_present(self):
        """doctor output contains gsd-amauta doctor header."""
        _, out, _ = run_doctor()
        self.assertIn("gsd-amauta doctor", out)

    def test_rlm_restarts_lifetime_checked(self):
        """doctor source checks rlm_restarts_lifetime from /health endpoint."""
        self.assertIn(
            "rlm_restarts_lifetime",
            self.src,
            "doctor must consume rlm_restarts_lifetime (STAB-03 consumer)",
        )

    def test_syntax_valid(self):
        """services/doctor.py parses without error."""
        ast.parse(self.src)  # raises SyntaxError on failure

    def test_cli_cjs_has_doctor_branch(self):
        """bin/cli.cjs contains doctor command branch."""
        cli_src = open("bin/cli.cjs").read()
        self.assertIn(
            "command === 'doctor'",
            cli_src,
            "bin/cli.cjs must have doctor command branch",
        )

    def test_cli_cjs_references_doctor_py(self):
        """bin/cli.cjs references services/doctor.py."""
        cli_src = open("bin/cli.cjs").read()
        self.assertIn(
            "services/doctor.py",
            cli_src,
            "bin/cli.cjs doctor branch must invoke services/doctor.py",
        )

    def test_result_summary_line_present(self):
        """doctor output ends with a Result summary line."""
        _, out, _ = run_doctor()
        self.assertIn(
            "Result:",
            out,
            "doctor must emit a Result: N OK, N WARN, N FAIL summary line",
        )


if __name__ == "__main__":
    unittest.main()

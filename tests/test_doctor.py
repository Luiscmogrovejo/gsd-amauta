#!/usr/bin/env python3
"""STAB-06: gsd-amauta doctor command tests.

Covers:
  - doctor always exits 0
  - doctor emits >= 8 status rows
  - doctor output contains all 8 required category names
  - doctor header present
  - rlm_restarts_lifetime field consumed (STAB-03 consumer chain)
  - doctor source parses as valid Python
  - bin/cli.cjs has doctor command branch
  - bin/cli.cjs references services/doctor.py
  - Result summary line present

Run: pytest tests/test_doctor.py -q
"""
import ast
import re
import subprocess
import sys
import unittest

PYTHON = sys.executable


def run_doctor(env=None):
    """Run services/doctor.py and return (returncode, stdout, stderr)."""
    result = subprocess.run(
        [PYTHON, "services/doctor.py"],
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )
    return result.returncode, result.stdout, result.stderr


class TestDoctorStructure(unittest.TestCase):

    def setUp(self):
        self.src = open("services/doctor.py").read()
        self.tree = ast.parse(self.src)

    def test_exits_0(self):
        """doctor always exits 0."""
        rc, _, _ = run_doctor()
        self.assertEqual(rc, 0, "doctor must always exit 0")

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

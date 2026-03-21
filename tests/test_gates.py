#!/usr/bin/env python3
"""Static tests for RPETD validation gate functions.

Tests gate logic directly by importing functions from amauta.py.
No daemon, no database -- pure function tests.

Run with:
  python3 tests/test_gates.py
  python3 -m pytest tests/test_gates.py -v
"""
import os
import sys
import unittest

# Prevent module-level side effects during import
os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"
os.environ["PYTEST_CURRENT_TEST"] = "1"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from amauta import (
    _has_branch_evidence,
    _has_test_evidence,
    _has_explicit_learning_written,
    _validate_all_gates,
)


# ── Helper: build a minimal task item dict ────────────────────────────────────
def _make_item(
    rpetd=None, item_type="task", agent="executor-backend", tags=None, notes=None
):
    """Build a minimal task dict suitable for gate functions."""
    phases = rpetd or {}
    all_filled = all(phases.get(ph, "").strip() for ph in ("R", "P", "E", "T", "D"))
    return {
        "id": "TK-TEST-001",
        "type": item_type,
        "title": "Test task for gate verification",
        "status": "validation",
        "assigned_to": agent,
        "claimed_by": agent,
        "rpetd_phases": phases,
        "rpetd_complete": all_filled,
        "tags": tags or [],
        "notes": notes or [],
    }


# ── _has_branch_evidence tests ────────────────────────────────────────────────
class TestBranchEvidence(unittest.TestCase):
    def test_git_checkout_branch(self):
        self.assertTrue(_has_branch_evidence("git checkout -b feat/TK-123-desc"))

    def test_branch_colon_pattern(self):
        self.assertTrue(_has_branch_evidence("branch: fix/login-bug"))

    def test_no_branch_evidence(self):
        self.assertFalse(_has_branch_evidence("did some work on the code"))

    def test_feat_slash_pattern(self):
        self.assertTrue(_has_branch_evidence("feat/TK-0201-gate-enforcement"))

    def test_empty_string(self):
        self.assertFalse(_has_branch_evidence(""))

    def test_fix_slash_pattern(self):
        self.assertTrue(_has_branch_evidence("Working on fix/issue-42"))

    def test_refactor_slash_pattern(self):
        self.assertTrue(_has_branch_evidence("refactor/cleanup-auth"))


# ── _has_test_evidence tests ──────────────────────────────────────────────────
class TestTestEvidence(unittest.TestCase):
    def test_npm_test_output(self):
        self.assertTrue(_has_test_evidence("$ npm test\n5 passing\nexit code: 0"))

    def test_trivial_tests_pass(self):
        """'tests pass' is only 10 chars, below 100 char proxy threshold."""
        self.assertFalse(_has_test_evidence("tests pass"))

    def test_enoent_error(self):
        self.assertFalse(_has_test_evidence("ENOENT: no such file"))

    def test_pytest_output(self):
        self.assertTrue(_has_test_evidence("$ pytest\n===== 12 passed in 3.2s ====="))

    def test_empty_string(self):
        self.assertFalse(_has_test_evidence(""))

    def test_long_content_proxy(self):
        """Content >100 chars with no clear signal should pass as proxy."""
        content = "x" * 101
        self.assertTrue(_has_test_evidence(content))

    def test_exit_code_zero(self):
        self.assertTrue(_has_test_evidence("exit code: 0"))

    def test_permission_denied_blocker(self):
        self.assertFalse(_has_test_evidence("permission denied"))


# ── _has_explicit_learning_written tests ──────────────────────────────────────
class TestLearningWritten(unittest.TestCase):
    def test_learning_in_d_phase(self):
        item = _make_item(rpetd={"D": "LEARNING: use caching pattern for API calls to reduce latency by 40%"})
        self.assertTrue(_has_explicit_learning_written(item))

    def test_no_learning_keyword(self):
        item = _make_item(rpetd={"D": "completed the task successfully"})
        self.assertFalse(_has_explicit_learning_written(item))

    def test_learning_in_notes(self):
        item = _make_item(
            rpetd={"D": "done"},
            notes=[{"text": "LEARNING: always test migrations before deploy"}],
        )
        self.assertTrue(_has_explicit_learning_written(item))

    def test_empty_phases(self):
        item = _make_item(rpetd={})
        self.assertFalse(_has_explicit_learning_written(item))

    def test_lesson_keyword_accepted(self):
        item = _make_item(rpetd={"D": "LESSON: retry logic is essential for flaky APIs"})
        self.assertTrue(_has_explicit_learning_written(item))


# ── _validate_all_gates tests ────────────────────────────────────────────────
class TestValidateAllGates(unittest.TestCase):
    def test_all_phases_empty_returns_5_fails(self):
        """Task with all phases empty should get failures on all gates."""
        item = _make_item(rpetd={})
        results = _validate_all_gates(item)
        fails = [r for r in results if r["status"] == "FAIL"]
        # RPETD_COMPLETE fails, BRANCH_EVIDENCE fails, TEST_EVIDENCE fails,
        # LEARNING_BLOCK fails, PR_URL fails = 5 failures for code task
        self.assertEqual(len(fails), 5, f"Expected 5 failures, got: {fails}")

    def test_non_code_task_all_pass(self):
        """Non-code task with valid content should get only PASS/SKIP."""
        item = _make_item(
            rpetd={
                "R": "Researched the topic thoroughly",
                "P": "Plan: update documentation and verify",
                "E": "Executed the documentation updates",
                "T": "Verified all links work and content is accurate and complete",
                "D": "LEARNING: documentation changes need cross-reference checks to avoid broken links",
            },
            item_type="task",
            agent="gsd-planner",
            tags=["lane:non-code"],
        )
        results = _validate_all_gates(item)
        fails = [r for r in results if r["status"] == "FAIL"]
        self.assertEqual(len(fails), 0, f"Expected 0 failures, got: {fails}")

    def test_code_task_missing_pr_url(self):
        """Code task with valid everything except PR URL should fail PR_URL gate."""
        item = _make_item(
            rpetd={
                "R": "Researched auth patterns",
                "P": "Plan: implement JWT refresh",
                "E": "git checkout -b feat/TK-001-auth\nImplemented refresh tokens\ncommit abc1234",
                "T": "$ npm test\n12 passing (300ms)\nexit code: 0",
                "D": "LEARNING: JWT refresh rotation requires storing old tokens for revocation window",
            },
            agent="executor-backend",
        )
        results = _validate_all_gates(item)
        gate_map = {r["gate"]: r["status"] for r in results}
        self.assertEqual(gate_map["PR_URL"], "FAIL")
        self.assertEqual(gate_map["RPETD_COMPLETE"], "PASS")
        self.assertEqual(gate_map["BRANCH_EVIDENCE"], "PASS")
        self.assertEqual(gate_map["TEST_EVIDENCE"], "PASS")
        self.assertEqual(gate_map["LEARNING_BLOCK"], "PASS")

    def test_all_gates_pass_code_task(self):
        """Code task with all gates satisfied should all PASS (except PR may FAIL)."""
        item = _make_item(
            rpetd={
                "R": "Researched existing auth patterns",
                "P": "Plan: add validation endpoint",
                "E": "git checkout -b feat/TK-001-validate\ncommit abc1234",
                "T": "$ npm test\n5 passing\nexit code: 0",
                "D": "LEARNING: consolidated gate checks reduce scattered validation logic significantly",
            },
            agent="executor-backend",
            notes=[{"text": "PR: https://github.com/org/repo/pull/42"}],
        )
        results = _validate_all_gates(item)
        gate_map = {r["gate"]: r["status"] for r in results}
        self.assertEqual(gate_map["RPETD_COMPLETE"], "PASS")
        self.assertEqual(gate_map["BRANCH_EVIDENCE"], "PASS")
        self.assertEqual(gate_map["TEST_EVIDENCE"], "PASS")
        self.assertEqual(gate_map["LEARNING_BLOCK"], "PASS")
        self.assertEqual(gate_map["PR_URL"], "PASS")

    def test_e_phase_no_branch_fails_branch_gate(self):
        """E-phase with content but no branch pattern should fail BRANCH_EVIDENCE."""
        item = _make_item(
            rpetd={
                "R": "research",
                "P": "plan",
                "E": "did some work on the code",
                "T": "$ npm test\n5 passing\nexit code: 0",
                "D": "LEARNING: always include branch name in execution logs for traceability",
            },
            agent="executor-backend",
        )
        results = _validate_all_gates(item)
        gate_map = {r["gate"]: r["status"] for r in results}
        self.assertEqual(gate_map["BRANCH_EVIDENCE"], "FAIL")

    def test_t_phase_trivial_fails_test_gate(self):
        """T-phase with trivial content like 'tests pass' should fail for code tasks."""
        item = _make_item(
            rpetd={
                "R": "research",
                "P": "plan",
                "E": "git checkout -b feat/TK-001-test",
                "T": "tests pass",
                "D": "LEARNING: always paste actual test runner output, not just a summary statement",
            },
            agent="executor-backend",
        )
        results = _validate_all_gates(item)
        gate_map = {r["gate"]: r["status"] for r in results}
        self.assertEqual(gate_map["TEST_EVIDENCE"], "FAIL")

    def test_learning_too_short_fails(self):
        """D-phase LEARNING block with <20 chars should fail LEARNING_BLOCK gate."""
        item = _make_item(
            rpetd={
                "R": "research",
                "P": "plan",
                "E": "git checkout -b feat/TK-001-learn",
                "T": "$ npm test\n5 passing\nexit code: 0",
                "D": "LEARNING: x",
            },
            agent="executor-backend",
        )
        results = _validate_all_gates(item)
        gate_map = {r["gate"]: r["status"] for r in results}
        self.assertEqual(gate_map["LEARNING_BLOCK"], "FAIL")

    def test_non_code_branch_skipped(self):
        """Non-code tasks should get SKIP for BRANCH_EVIDENCE gate."""
        item = _make_item(
            rpetd={
                "R": "research",
                "P": "plan",
                "E": "executed",
                "T": "verified all documentation is correct and links work properly",
                "D": "LEARNING: non-code tasks still benefit from structured documentation workflow",
            },
            tags=["lane:non-code"],
            agent="gsd-planner",
        )
        results = _validate_all_gates(item)
        gate_map = {r["gate"]: r["status"] for r in results}
        self.assertEqual(gate_map["BRANCH_EVIDENCE"], "SKIP")
        self.assertEqual(gate_map["PR_URL"], "SKIP")

    def test_non_code_t_phase_too_brief(self):
        """Non-code task with T-phase < 20 chars should fail TEST_EVIDENCE."""
        item = _make_item(
            rpetd={
                "R": "research",
                "P": "plan",
                "E": "executed",
                "T": "looks good",
                "D": "LEARNING: always provide substantive verification evidence even for non-code tasks",
            },
            tags=["lane:non-code"],
            agent="gsd-planner",
        )
        results = _validate_all_gates(item)
        gate_map = {r["gate"]: r["status"] for r in results}
        self.assertEqual(gate_map["TEST_EVIDENCE"], "FAIL")

    def test_gate_results_are_dicts_with_required_keys(self):
        """Every gate result must have gate, status, and reason keys."""
        item = _make_item(rpetd={"R": "r", "P": "p", "E": "e", "T": "t", "D": "d"})
        results = _validate_all_gates(item)
        for r in results:
            self.assertIn("gate", r)
            self.assertIn("status", r)
            self.assertIn("reason", r)
            self.assertIn(r["status"], ("PASS", "FAIL", "SKIP"))

    def test_exactly_5_gates_returned(self):
        """_validate_all_gates always returns exactly 5 gate results."""
        item = _make_item(rpetd={})
        results = _validate_all_gates(item)
        self.assertEqual(len(results), 5)

        gate_names = [r["gate"] for r in results]
        self.assertIn("RPETD_COMPLETE", gate_names)
        self.assertIn("BRANCH_EVIDENCE", gate_names)
        self.assertIn("TEST_EVIDENCE", gate_names)
        self.assertIn("LEARNING_BLOCK", gate_names)
        self.assertIn("PR_URL", gate_names)


if __name__ == "__main__":
    unittest.main()

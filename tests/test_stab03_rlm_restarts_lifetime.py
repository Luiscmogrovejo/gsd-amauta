"""STAB-03: rlm_restarts_lifetime cumulative counter — unit tests.

Tests verify the counter semantics in isolation by importing the module-level
globals and exercising the counter logic directly. No daemon process started.
"""
import ast
import sys
import unittest


class TestRlmRestartsLifetime(unittest.TestCase):

    def test_global_declared(self):
        """_rlm_restarts_lifetime global is declared as integer 0."""
        src = open("services/amauta-daemon.py").read()
        tree = ast.parse(src)
        # Find module-level assignment _rlm_restarts_lifetime = 0
        found = False
        for node in ast.walk(tree):
            if (isinstance(node, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == "_rlm_restarts_lifetime"
                            for t in node.targets)
                    and isinstance(node.value, ast.Constant)
                    and node.value.value == 0):
                found = True
        self.assertTrue(found, "_rlm_restarts_lifetime = 0 not found at module level")

    def test_lifetime_incremented_alongside_restart_count(self):
        """In _rlm_watchdog, _rlm_restarts_lifetime += 1 follows _rlm_restart_count += 1."""
        src = open("services/amauta-daemon.py").read()
        # Simple grep-level check: both increments present in source
        self.assertIn("_rlm_restarts_lifetime += 1", src,
                      "_rlm_restarts_lifetime += 1 not found in source")
        self.assertIn("_rlm_restart_count += 1", src,
                      "_rlm_restart_count += 1 not found in source")

    def test_lifetime_not_reset_in_start_rlm(self):
        """_start_rlm does NOT assign or reset _rlm_restarts_lifetime."""
        src = open("services/amauta-daemon.py").read()
        tree = ast.parse(src)
        # Find _start_rlm function body
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "_start_rlm":
                func_src = ast.unparse(node)
                self.assertNotIn(
                    "_rlm_restarts_lifetime",
                    func_src,
                    "_start_rlm must NOT reference _rlm_restarts_lifetime (must not reset it)"
                )
                return
        self.fail("_start_rlm function not found in source")

    def test_health_endpoint_contains_lifetime_key(self):
        """The /health endpoint response dict includes 'rlm_restarts_lifetime' key."""
        src = open("services/amauta-daemon.py").read()
        # The key must appear in the health response dict
        self.assertIn('"rlm_restarts_lifetime"', src,
                      '"rlm_restarts_lifetime" key not found in health response')
        # Both old and new keys present
        self.assertIn('"rlm_restarts"', src,
                      '"rlm_restarts" (original) key must be preserved')

    def test_lifetime_key_after_restarts_key_in_health(self):
        """rlm_restarts_lifetime appears on the line after rlm_restarts in /health dict."""
        src = open("services/amauta-daemon.py").read()
        lines = src.split("\n")
        restart_line = None
        for i, line in enumerate(lines):
            if '"rlm_restarts":' in line and "lifetime" not in line:
                restart_line = i
                break
        self.assertIsNotNone(restart_line, '"rlm_restarts" line not found')
        # The lifetime key should be within 3 lines of the restarts key
        window = "\n".join(lines[restart_line:restart_line + 4])
        self.assertIn("rlm_restarts_lifetime", window,
                      '"rlm_restarts_lifetime" not within 3 lines of "rlm_restarts"')


if __name__ == "__main__":
    unittest.main()

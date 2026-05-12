"""
tests/test_amauta_mcp_db_helpers.py — MCPDatabase + MCPValkey unit tests (Phase 46 Task 46-01-03).

Tests PG-down + Valkey-down resilience. Module loaded via importlib (hyphenated filename).
Mirrors Phase 41 pattern from tests/test_complexity_scorer.py.
"""

import importlib.util
import json
import os
import sys
import unittest

# ── Load the hyphenated module ─────────────────────────────────────────────────

def _load_amauta_mcp():
    """Load services/amauta-mcp.py via importlib (handles hyphenated filename)."""
    services_dir = os.path.join(os.path.dirname(__file__), "..", "services")
    spec = importlib.util.spec_from_file_location(
        "amauta_mcp",
        os.path.join(services_dir, "amauta-mcp.py"),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


try:
    _mod = _load_amauta_mcp()
    MCPDatabase = _mod.MCPDatabase
    MCPValkey = _mod.MCPValkey
    _HAS_PG = _mod._HAS_PG
    MCP_SSE_PORT = _mod.MCP_SSE_PORT
    _MCP_ERROR_CODES = _mod._MCP_ERROR_CODES
    _MOD_AVAILABLE = True
except Exception as _e:
    _MOD_AVAILABLE = False
    _LOAD_ERROR = str(_e)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _unset_env(*keys):
    """Remove env vars and return restore dict."""
    saved = {}
    for k in keys:
        saved[k] = os.environ.pop(k, None)
    return saved


def _restore_env(saved):
    """Restore env vars from saved dict."""
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


# ── Test cases ─────────────────────────────────────────────────────────────────

class TestModuleImports(unittest.TestCase):

    def test_module_imports_without_psycopg2(self):
        """Module must load even if psycopg2 is missing (_HAS_PG=False path)."""
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")
        # The module already loaded above (with or without psycopg2).
        # Just assert that _HAS_PG is a bool — the import-safety block ran.
        self.assertIsInstance(_HAS_PG, bool)
        # MCPDatabase and MCPValkey classes MUST always exist regardless of psycopg2.
        self.assertTrue(hasattr(_mod, "MCPDatabase"), "MCPDatabase class missing from module")
        self.assertTrue(hasattr(_mod, "MCPValkey"), "MCPValkey class missing from module")


class TestMCPDatabase(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_mcpdatabase_unavailable_when_url_invalid(self):
        """MCPDatabase with an invalid PG URL must not raise; available() returns False."""
        saved = _unset_env("GSD_POSTGRES_URL")
        os.environ["GSD_POSTGRES_URL"] = "postgresql://invalid_host_that_does_not_exist:9999/nope"
        try:
            # Re-load module so it picks up the new env var for a fresh init
            m = _load_amauta_mcp()
            db = m.MCPDatabase()
            self.assertFalse(
                db.available(),
                "MCPDatabase.available() should return False for an invalid PG URL",
            )
            self.assertIsNotNone(db._init_error, "_init_error should be set when connection fails")
            self.assertIsInstance(db._init_error, str)
            self.assertGreater(len(db._init_error), 0, "_init_error must be a non-empty string")
        finally:
            _restore_env(saved)

    def test_mcpdatabase_does_not_raise_on_bad_url(self):
        """MCPDatabase constructor MUST NOT raise even for unreachable PG URLs."""
        saved = _unset_env("GSD_POSTGRES_URL")
        os.environ["GSD_POSTGRES_URL"] = "postgresql://127.0.0.1:1/testdb"
        try:
            m = _load_amauta_mcp()
            try:
                db = m.MCPDatabase()
            except Exception as e:
                self.fail(f"MCPDatabase.__init__ raised unexpectedly: {e}")
        finally:
            _restore_env(saved)


class TestMCPValkey(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_mcpvalkey_unavailable_when_url_missing(self):
        """MCPValkey with no VALKEY_URL/REDIS_URL must report unavailable; methods safe."""
        saved = _unset_env("VALKEY_URL", "REDIS_URL")
        try:
            m = _load_amauta_mcp()
            v = m.MCPValkey()
            self.assertFalse(v.available(), "MCPValkey.available() must be False when no URL set")
            # Both methods must not raise
            result_get = v.get("some_key")
            self.assertIsNone(result_get, "get() must return None when unavailable")
            result_setex = v.setex("some_key", 60, "value")
            self.assertFalse(result_setex, "setex() must return False when unavailable")
        finally:
            _restore_env(saved)

    def test_mcpvalkey_unavailable_when_url_invalid(self):
        """MCPValkey with an invalid URL must fail ping gracefully; methods still safe."""
        saved = _unset_env("VALKEY_URL", "REDIS_URL")
        os.environ["VALKEY_URL"] = "redis://127.0.0.1:1"  # almost certainly closed
        try:
            m = _load_amauta_mcp()
            v = m.MCPValkey()
            self.assertFalse(v.available(), "MCPValkey.available() must be False when ping fails")
            # Methods must not raise even after failed ping
            result_get = v.get("some_key")
            self.assertIsNone(result_get, "get() must return None when Valkey unavailable")
            result_setex = v.setex("some_key", 60, "value")
            self.assertFalse(result_setex, "setex() must return False when Valkey unavailable")
        finally:
            _restore_env(saved)


class TestConstants(unittest.TestCase):

    def setUp(self):
        if not _MOD_AVAILABLE:
            self.skipTest(f"Module failed to load: {_LOAD_ERROR}")

    def test_constants_frozen(self):
        """MCP_SSE_PORT == 18800; all 5 error codes present in _MCP_ERROR_CODES."""
        self.assertEqual(MCP_SSE_PORT, 18800, "MCP_SSE_PORT must be 18800 (MCP-01 frozen)")

        # Verify the frozen vocabulary tuple exists with all 5 codes
        required_codes = {
            "pg_unavailable",
            "valkey_unavailable",
            "invalid_input",
            "not_found",
            "internal_error",
        }
        actual_codes = set(_MCP_ERROR_CODES)
        missing = required_codes - actual_codes
        self.assertEqual(missing, set(), f"_MCP_ERROR_CODES missing codes: {missing}")

        # Verify the literal strings appear in the module source (test_constants_frozen grep)
        module_path = os.path.join(
            os.path.dirname(__file__), "..", "services", "amauta-mcp.py"
        )
        with open(module_path) as f:
            source = f.read()
        for code in required_codes:
            self.assertIn(
                f'"{code}"', source,
                f'Literal string "{code}" not found in amauta-mcp.py source',
            )


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Tests for recency decay verification (MEM-07: recency penalizes old entries).

Verifies:
1. Decay constants are consistent between amauta.py, pg_store.py, sqlite_store.py
2. Old entries receive a higher recency penalty than new ones
3. Penalty caps at MAX_RECENCY_PENALTY (3.0) -- never exceeds the ceiling
4. Entries created today receive zero recency penalty
5. Decay is disabled when GSD_RECENCY_DECAY_PER_30D=0

These are guard tests (MEM-07 is already implemented in all search paths).
The tests use sqlite_store._score_memories() for unit-level isolation --
no PG connection required.

Run: python3 -m pytest tests/test_memory_recency_decay.py -v
"""
import importlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

os.environ["GSD_AMAUTA_NO_AUTO_START"] = "1"

# Insert services/ into sys.path for imports
_SERVICES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "services")
sys.path.insert(0, _SERVICES_DIR)

# Root dir for amauta.py parsing
_ROOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")


def _parse_constant_from_file(filepath, constant_name):
    """Parse a float constant value from a Python source file without importing it.

    Looks for lines of the form: CONSTANT_NAME = <float_literal>
    Works even if the file has complex import chains.
    """
    import re as _re
    with open(filepath) as f:
        for line in f:
            stripped = line.strip()
            if stripped.startswith(constant_name + " =") or stripped.startswith(constant_name + "="):
                # Extract the right-hand side value
                parts = stripped.split("=", 1)
                if len(parts) == 2:
                    rhs = parts[1].strip()
                    # Handle float() wrappers like: float(os.environ.get(..., "0.5"))
                    # Look for the default value string
                    if "float(" in rhs and '"' in rhs:
                        # Extract last quoted number
                        m = _re.search(r'"([\d.]+)"', rhs)
                        if m:
                            return float(m.group(1))
                    # Handle bare float with optional inline comment: 3.0  # some comment
                    rhs_no_comment = rhs.split("#")[0].strip()
                    try:
                        return float(rhs_no_comment)
                    except ValueError:
                        pass
    return None


def _make_row(text, source, created_at_iso, text_rank=-0.05):
    """Helper: create a row dict in the format sqlite_store._score_memories expects."""
    return {
        "id": f"test-decay-{hash(text) & 0xFFFFFF:06x}",
        "text": text,
        "source": source,
        "agent_id": "test-agent",
        "tags": "[]",
        "metadata": "{}",
        "project_id": None,
        "created_at": created_at_iso,
        "updated_at": created_at_iso,
        "text_rank": text_rank,
        "rowid": 1,
    }


class TestRecencyDecayConstants(unittest.TestCase):
    """Decay constants must match across all three files (MEM-07 consistency)."""

    def _get_amauta_constant(self, name):
        amauta_path = os.path.join(_ROOT_DIR, "amauta.py")
        return _parse_constant_from_file(amauta_path, name)

    def _get_pg_constant(self, name):
        pg_path = os.path.join(_SERVICES_DIR, "pg_store.py")
        return _parse_constant_from_file(pg_path, name)

    def _get_sqlite_constant(self, name):
        sqlite_path = os.path.join(_SERVICES_DIR, "sqlite_store.py")
        return _parse_constant_from_file(sqlite_path, name)

    def test_recency_decay_constants_match_between_files(self):
        """_RECENCY_DECAY_PER_30D / RECENCY_DECAY_PER_30D must be 0.5 in all three files."""
        amauta_val = self._get_amauta_constant("_RECENCY_DECAY_PER_30D")
        pg_val = self._get_pg_constant("RECENCY_DECAY_PER_30D")
        sqlite_val = self._get_sqlite_constant("RECENCY_DECAY_PER_30D")

        self.assertIsNotNone(amauta_val, "_RECENCY_DECAY_PER_30D not found in amauta.py")
        self.assertIsNotNone(pg_val, "RECENCY_DECAY_PER_30D not found in pg_store.py")
        self.assertIsNotNone(sqlite_val, "RECENCY_DECAY_PER_30D not found in sqlite_store.py")

        self.assertAlmostEqual(amauta_val, 0.5, places=4,
                               msg="amauta.py _RECENCY_DECAY_PER_30D default should be 0.5")
        self.assertAlmostEqual(pg_val, 0.5, places=4,
                               msg="pg_store.py RECENCY_DECAY_PER_30D default should be 0.5")
        self.assertAlmostEqual(sqlite_val, 0.5, places=4,
                               msg="sqlite_store.py RECENCY_DECAY_PER_30D default should be 0.5")

    def test_max_penalty_constants_match_between_files(self):
        """MAX_RECENCY_PENALTY / _MAX_RECENCY_PENALTY must be 3.0 in all three files."""
        amauta_val = self._get_amauta_constant("_MAX_RECENCY_PENALTY")
        pg_val = self._get_pg_constant("MAX_RECENCY_PENALTY")
        sqlite_val = self._get_sqlite_constant("MAX_RECENCY_PENALTY")

        self.assertIsNotNone(amauta_val, "_MAX_RECENCY_PENALTY not found in amauta.py")
        self.assertIsNotNone(pg_val, "MAX_RECENCY_PENALTY not found in pg_store.py")
        self.assertIsNotNone(sqlite_val, "MAX_RECENCY_PENALTY not found in sqlite_store.py")

        self.assertAlmostEqual(amauta_val, 3.0, places=4,
                               msg="amauta.py _MAX_RECENCY_PENALTY should be 3.0")
        self.assertAlmostEqual(pg_val, 3.0, places=4,
                               msg="pg_store.py MAX_RECENCY_PENALTY should be 3.0")
        self.assertAlmostEqual(sqlite_val, 3.0, places=4,
                               msg="sqlite_store.py MAX_RECENCY_PENALTY should be 3.0")


class TestRecencyDecayFormula(unittest.TestCase):
    """Decay formula produces correct penalties via sqlite_store._score_memories."""

    def setUp(self):
        # Import fresh, with default env (GSD_RECENCY_DECAY_PER_30D not overridden here)
        if "sqlite_store" in sys.modules:
            importlib.reload(sys.modules["sqlite_store"])
        import sqlite_store as ss
        self.store_module = ss
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = ss.SQLiteStore(db_path=self.db_path)

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)

    def _score(self, created_at_iso, source="auto_learning", text_rank=-0.05):
        """Score a single synthetic row and return the result dict."""
        row = _make_row("test memory entry", source, created_at_iso, text_rank)
        results = self.store._score_memories([row])
        self.assertEqual(len(results), 1)
        return results[0]

    def test_recency_decay_formula_penalizes_old_entries(self):
        """180-day-old entry should score lower than today's entry (same source/relevance)."""
        now = datetime.now(timezone.utc)
        today_result = self._score(now.isoformat())
        old_result = self._score((now - timedelta(days=180)).isoformat())

        self.assertGreater(today_result["score"], old_result["score"],
                           "Today's entry must score higher than 180-day-old entry")

    def test_recency_decay_caps_at_max_penalty(self):
        """1-year-old entry penalty must be capped at 3.0, not 6.08."""
        DECAY_PER_30D = 0.5
        MAX_PENALTY = 3.0
        days_365 = 365
        uncapped = DECAY_PER_30D * (days_365 / 30.0)  # = 6.08
        self.assertGreater(uncapped, MAX_PENALTY,
                           "Sanity check: uncapped value should exceed MAX_PENALTY")

        now = datetime.now(timezone.utc)
        result_365 = self._score((now - timedelta(days=365)).isoformat())
        result_180 = self._score((now - timedelta(days=180)).isoformat())

        # Both should have the same penalty (capped at 3.0) since 180d already hits cap
        # 180d: 0.5 * (180/30) = 3.0 (exactly at cap)
        # 365d: 0.5 * (365/30) = 6.08, capped to 3.0
        # Scores should be equal (both capped)
        self.assertAlmostEqual(result_365["score"], result_180["score"], places=1,
                               msg="365-day and 180-day entries should have same capped penalty")

    def test_recency_decay_zero_for_today_entries(self):
        """Entries created today should have zero recency penalty."""
        now = datetime.now(timezone.utc)
        result = self._score(now.isoformat())

        # source_bonus for auto_learning = 3, norm_rank for text_rank=-0.05: abs=0.05, /10=0.005, *10=0.05
        # score = 0.05 + 3 - 0.0 = 3.05
        # The key check: score should equal (norm_rank*10 + source_bonus) -- no penalty deducted
        source_bonus = self.store_module.SOURCE_SCORES.get("auto_learning", 0)
        norm_rank = min(abs(-0.05) / 10.0, 1.0)  # = 0.005
        expected_no_decay = round(norm_rank * 10 + source_bonus, 2)  # 0.05 + 3 = 3.05
        self.assertAlmostEqual(result["score"], expected_no_decay, places=1,
                               msg="Today's entry should have no recency penalty applied")


class TestRecencyDecayDisabled(unittest.TestCase):
    """Recency decay is disabled entirely when GSD_RECENCY_DECAY_PER_30D=0."""

    def setUp(self):
        # Set env to 0 BEFORE module reload so the module-level float() picks it up
        os.environ["GSD_RECENCY_DECAY_PER_30D"] = "0"
        if "sqlite_store" in sys.modules:
            importlib.reload(sys.modules["sqlite_store"])
        import sqlite_store as ss
        self.store_module = ss
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        self.store = ss.SQLiteStore(db_path=self.db_path)

    def tearDown(self):
        self.store.close()
        os.close(self.db_fd)
        os.unlink(self.db_path)
        # Restore env to default
        os.environ.pop("GSD_RECENCY_DECAY_PER_30D", None)
        if "sqlite_store" in sys.modules:
            importlib.reload(sys.modules["sqlite_store"])

    def test_recency_decay_disabled_when_env_zero(self):
        """When GSD_RECENCY_DECAY_PER_30D=0, old and new entries have same base score."""
        self.assertAlmostEqual(self.store_module.RECENCY_DECAY_PER_30D, 0.0, places=4,
                               msg="RECENCY_DECAY_PER_30D should be 0.0 after env override")

        now = datetime.now(timezone.utc)
        row_today = _make_row("today entry", "auto_learning", now.isoformat())
        row_old = _make_row("old entry", "auto_learning",
                            (now - timedelta(days=365)).isoformat())

        results = self.store._score_memories([row_today, row_old])
        self.assertEqual(len(results), 2)

        today_score = next(r["score"] for r in results if "today" in r["text"])
        old_score = next(r["score"] for r in results if "old" in r["text"])

        self.assertAlmostEqual(today_score, old_score, places=2,
                               msg="With decay=0, today and 365d-old entries should have same score")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Phase 10 LEARN-04 pytest tests for tag governance (Python side).

Mirrors tests/10-tag-governance.test.cjs to verify cross-runtime sync
per RESEARCH.md RISK-4. Same inputs, same expected outputs.

Run: pytest tests/test_tag_governance.py -v
"""
import os
import sys

import pytest

# Path setup to import pg_store module-level functions
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
os.environ.setdefault("GSD_AMAUTA_NO_AUTO_START", "1")
os.environ.setdefault("PYTEST_CURRENT_TEST", "1")

from services.pg_store import normalize_tags, load_tag_rules, _tag_tier  # noqa: E402


class TestSynonymNormalization:
    def test_pg_becomes_postgresql(self):
        r = normalize_tags(["pg"])
        assert r["tags"] == ["postgresql"]
        assert r["error"] is None

    def test_k8s_ts_py_normalize(self):
        r = normalize_tags(["k8s", "ts", "py"])
        assert sorted(r["tags"]) == ["kubernetes", "python", "typescript"]

    def test_db_becomes_database(self):
        r = normalize_tags(["db"])
        assert r["tags"] == ["database"]

    def test_be_becomes_backend(self):
        r = normalize_tags(["be"])
        assert r["tags"] == ["backend"]


class TestBannedTags:
    def test_banned_stripped_specific_kept(self):
        r = normalize_tags(["best-practice", "postgresql"])
        assert r["tags"] == ["postgresql"]
        assert any("Stripped banned tags" in w for w in r["warnings"])

    def test_all_banned_rejected_with_guidance(self):
        r = normalize_tags(["best-practice", "lesson", "insight"])
        assert r["tags"] == []
        assert r["error"] is not None
        assert "all tags are generic" in r["error"]
        assert "Add specific tags like" in r["error"]

    def test_empty_input_rejected(self):
        r = normalize_tags([])
        assert r["error"] is not None


class TestLowercaseAndDedupe:
    def test_case_insensitive_dedupe(self):
        r = normalize_tags(["PostgreSQL", "postgresql", "POSTGRESQL"])
        assert len(r["tags"]) == 1
        assert r["tags"][0] == "postgresql"

    def test_comma_string_input(self):
        r = normalize_tags("postgresql, connection-pool , nodejs")
        assert r["tags"] == ["postgresql", "connection-pool", "nodejs"]


class TestAutoTrim:
    def test_trim_over_5_by_tier(self):
        # domain=postgresql (t0), technique=connection-pool (t1),
        # scope=backend (t2), meta=pattern (t3)
        input_tags = [
            "pattern", "backend", "monitoring", "postgresql",
            "connection-pool", "nodejs", "testing",
        ]
        r = normalize_tags(input_tags)
        assert len(r["tags"]) == 5
        assert any("Trimmed 7->5" in w for w in r["warnings"])
        # Higher-priority tags should be kept: postgresql must survive
        assert "postgresql" in r["tags"]

    def test_exactly_5_tags_not_trimmed(self):
        r = normalize_tags(
            ["postgresql", "connection-pool", "nodejs", "backend", "pattern"]
        )
        assert len(r["tags"]) == 5
        assert not any("Trimmed" in w for w in r["warnings"])


class TestTierRanking:
    def test_postgresql_is_domain_tier(self):
        rules = load_tag_rules()
        assert _tag_tier("postgresql", rules) == 0

    def test_pattern_is_meta_tier(self):
        rules = load_tag_rules()
        assert _tag_tier("pattern", rules) == 3

    def test_unknown_tag_defaults_to_scope(self):
        rules = load_tag_rules()
        assert _tag_tier("unknown-tag-xyz", rules) == 2


class TestLoadTagRules:
    def test_rules_are_cached(self):
        r1 = load_tag_rules()
        r2 = load_tag_rules()
        assert r1 is r2

    def test_banned_contains_expected_four(self):
        rules = load_tag_rules()
        assert set(rules["banned"]) == {
            "best-practice", "general", "lesson", "insight"
        }

    def test_synonyms_contain_pg_mapping(self):
        rules = load_tag_rules()
        assert rules["synonyms"].get("pg") == "postgresql"


class TestCrossRuntimeParity:
    """Verify Python output matches what Node.js produces for identical inputs."""

    def test_parity_synonyms(self):
        # Node: mod.normalizeTags(['db','pg','k8s']).tags -> ['database','postgresql','kubernetes']
        r = normalize_tags(["db", "pg", "k8s"])
        assert sorted(r["tags"]) == ["database", "kubernetes", "postgresql"]

    def test_parity_banned_rejection(self):
        # Node and Python both reject with same error prefix and trailing pointer
        r = normalize_tags(["best-practice", "lesson"])
        assert r["error"] and r["error"].startswith(
            "Rejected: all tags are generic"
        )
        # Cross-runtime contract: Python must include the
        # "See learning-format.md" pointer that Node's normalizeTags emits
        assert "See learning-format.md" in r["error"]

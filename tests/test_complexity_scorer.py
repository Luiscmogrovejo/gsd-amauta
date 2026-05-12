#!/usr/bin/env python3
"""Tests for complexity_scorer.py — Phase 42 SCALE-01 + SCALE-02 + SCALE-03 + SCALE-04.

Tests the pure-function scoring, bucket selection, feature extraction, escalation
detection/application, and LLM gating behavior. All pure-function tests run without
PG or daemon. Calibration tests use monkeypatching to avoid real DB connections.

Run: pytest tests/test_complexity_scorer.py -v
"""

import importlib.util
import os
import sys
import pytest

# ── Load complexity_scorer via importlib (handles project layout) ─────────────
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "complexity_scorer",
    os.path.join(_ROOT, "services", "complexity_scorer.py"),
)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["complexity_scorer"] = _mod
_spec.loader.exec_module(_mod)

from complexity_scorer import (
    extract_features,
    score_features,
    select_phases,
    detect_escalation,
    apply_escalation,
    calibrate_score,
    _logistic_regression,
    FEATURE_KEYS,
    OUTCOME_LABELS,
    _DEFAULT_BUCKETS,
)

# ── Shared fixtures ───────────────────────────────────────────────────────────

DEFAULT_CONFIG = {
    "complexity_buckets": list(_DEFAULT_BUCKETS),
}

FULL_CONFIG = {
    "complexity_buckets": list(_DEFAULT_BUCKETS),
    "scale_adaptive": {
        "cold_start_threshold": 10,
        "escalation_triggers": {},
        "file_overshoot_multiplier": 1.5,
        "max_escalations_per_task": 2,
    },
}

ZERO_FEATURES = {
    "files_expected": 0,
    "estimated_loc": 0,
    "test_impact": 0,
    "dependency_depth": 0,
    "has_migration": False,
    "has_api_change": False,
    "security_sensitivity": 0,
}

MAX_FEATURES = {
    "files_expected": 20,
    "estimated_loc": 500,
    "test_impact": 10,
    "dependency_depth": 10,
    "has_migration": True,
    "has_api_change": True,
    "security_sensitivity": 10,
}


# ═══════════════════════════════════════════════════════════════════════════════
# SCALE-01: score_features — pure function tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestScoreFeatures:

    def test_score_features_zero(self):
        """All-zero feature vector → score == 0."""
        assert score_features(ZERO_FEATURES) == 0

    def test_score_features_max(self):
        """All-max feature vector → score == 100."""
        assert score_features(MAX_FEATURES) == 100

    def test_score_features_determinism(self):
        """Same input 3 times → same output (pure function)."""
        mid = {
            "files_expected": 5, "estimated_loc": 120, "test_impact": 3,
            "dependency_depth": 2, "has_migration": False, "has_api_change": True,
            "security_sensitivity": 4,
        }
        r1, r2, r3 = score_features(mid), score_features(mid), score_features(mid)
        assert r1 == r2 == r3, f"Non-deterministic: {r1}, {r2}, {r3}"

    def test_score_features_clamping(self):
        """files_expected=999, estimated_loc=99999 → score still <= 100."""
        big = dict(ZERO_FEATURES, files_expected=999, estimated_loc=99999)
        result = score_features(big)
        assert 0 <= result <= 100, f"Score out of range [0,100]: {result}"

    def test_score_features_keys_required(self):
        """Missing key in input → KeyError raised."""
        bad = {k: v for k, v in ZERO_FEATURES.items() if k != "files_expected"}
        with pytest.raises(KeyError):
            score_features(bad)

    def test_score_features_has_migration_weight(self):
        """has_migration True → adds exactly 15 points."""
        base = score_features(ZERO_FEATURES)
        with_mig = score_features(dict(ZERO_FEATURES, has_migration=True))
        assert with_mig - base == 15, f"has_migration weight should be 15, got {with_mig - base}"

    def test_score_features_has_api_change_weight(self):
        """has_api_change True → adds exactly 10 points."""
        base = score_features(ZERO_FEATURES)
        with_api = score_features(dict(ZERO_FEATURES, has_api_change=True))
        assert with_api - base == 10, f"has_api_change weight should be 10, got {with_api - base}"


# ═══════════════════════════════════════════════════════════════════════════════
# SCALE-02: select_phases — bucket selection tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestSelectPhases:

    def test_select_phases_bucket_boundaries(self):
        """Scores at and around each bucket boundary map to correct phase set."""
        cases = [
            (0,   ["E"]),
            (15,  ["E"]),
            (16,  ["P", "E", "T"]),
            (35,  ["P", "E", "T"]),
            (36,  ["R", "P", "E", "T"]),
            (60,  ["R", "P", "E", "T"]),
            (61,  ["R", "P", "E", "T", "D"]),
            (85,  ["R", "P", "E", "T", "D"]),
            (86,  ["R", "P", "E", "T", "D", "S", "A"]),
            (100, ["R", "P", "E", "T", "D", "S", "A"]),
        ]
        for score, expected in cases:
            got = select_phases(score, DEFAULT_CONFIG)
            assert got == expected, f"score={score}: expected {expected}, got {got}"

    def test_select_phases_invalid_negative(self):
        """select_phases(-1, ...) raises ValueError."""
        with pytest.raises(ValueError):
            select_phases(-1, DEFAULT_CONFIG)

    def test_select_phases_invalid_over_100(self):
        """select_phases(101, ...) raises ValueError."""
        with pytest.raises(ValueError):
            select_phases(101, DEFAULT_CONFIG)

    def test_select_phases_custom_buckets(self):
        """Custom 3-bucket config works correctly."""
        cfg = {
            "complexity_buckets": [
                {"max": 30, "phases": ["E"]},
                {"max": 70, "phases": ["P", "E", "T"]},
                {"max": 100, "phases": ["R", "P", "E", "T", "D"]},
            ]
        }
        assert select_phases(10, cfg) == ["E"]
        assert select_phases(30, cfg) == ["E"]
        assert select_phases(31, cfg) == ["P", "E", "T"]
        assert select_phases(71, cfg) == ["R", "P", "E", "T", "D"]
        assert select_phases(100, cfg) == ["R", "P", "E", "T", "D"]

    def test_select_phases_fallback_when_no_buckets(self):
        """Missing complexity_buckets key falls back to _DEFAULT_BUCKETS."""
        # Config with no complexity_buckets uses the default
        result = select_phases(50, {})
        assert isinstance(result, list) and len(result) > 0, f"Fallback should return non-empty list: {result}"


# ═══════════════════════════════════════════════════════════════════════════════
# SCALE-01: extract_features — feature extraction tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestExtractFeatures:

    def test_extract_features_no_plan(self):
        """extract_features(None, {}) returns dict with all 7 keys."""
        result = extract_features(None, {})
        assert isinstance(result, dict), f"Expected dict, got {type(result)}"
        for key in FEATURE_KEYS:
            assert key in result, f"Missing key: {key}"

    def test_extract_features_migration_detection(self):
        """migrations/*.sql in files_expected → has_migration=True."""
        meta = {"files_expected": ["migrations/018-task-completions.sql", "services/foo.py"]}
        result = extract_features(None, meta)
        assert result["has_migration"] is True, f"Expected has_migration=True, got {result['has_migration']}"

    def test_extract_features_api_detection(self):
        """services/amauta-daemon.py in files_expected → has_api_change=True."""
        meta = {"files_expected": ["services/amauta-daemon.py"]}
        result = extract_features(None, meta)
        assert result["has_api_change"] is True, f"Expected has_api_change=True, got {result['has_api_change']}"

    def test_extract_features_floor_rules_migrations(self):
        """File under migrations/ → security_sensitivity >= 4."""
        meta = {"files_expected": ["migrations/018-task-completions.sql"]}
        result = extract_features(None, meta)
        assert result["security_sensitivity"] >= 4, \
            f"migrations/ floor should be >=4, got {result['security_sensitivity']}"

    def test_extract_features_floor_rules_services(self):
        """File under services/ → security_sensitivity >= 3."""
        meta = {"files_expected": ["services/complexity_scorer.py"]}
        result = extract_features(None, meta)
        assert result["security_sensitivity"] >= 3, \
            f"services/ floor should be >=3, got {result['security_sensitivity']}"

    def test_extract_features_no_migration_no_api(self):
        """Files without migration or API paths → both flags False."""
        meta = {"files_expected": ["docs/foo.md", "get-shit-done/bin/tool.cjs"]}
        result = extract_features(None, meta)
        assert result["has_migration"] is False, f"Expected has_migration=False, got {result['has_migration']}"
        assert result["has_api_change"] is False, f"Expected has_api_change=False, got {result['has_api_change']}"


# ═══════════════════════════════════════════════════════════════════════════════
# SCALE-01: LLM gating tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestLLMGating:

    def test_llm_gating_off(self):
        """With GSD_COMPLEXITY_LLM unset, soft features return floor-rule values."""
        os.environ.pop("GSD_COMPLEXITY_LLM", None)
        meta = {"files_expected": ["migrations/schema.sql"]}
        result = extract_features(None, meta)
        # Floor rule: migrations/ → security_sensitivity = 4 exactly (no LLM boost)
        assert result["security_sensitivity"] == 4, \
            f"LLM off: expected security_sensitivity=4 (floor), got {result['security_sensitivity']}"

    def test_llm_gating_on_no_provider(self):
        """With GSD_COMPLEXITY_LLM=1 but no API key, LLM returns 0 → floor still applies."""
        os.environ["GSD_COMPLEXITY_LLM"] = "1"
        os.environ.pop("VOYAGE_API_KEY", None)
        os.environ.pop("OPENAI_API_KEY", None)
        try:
            meta = {"files_expected": ["migrations/schema.sql"]}
            result = extract_features(None, meta)
            # Even with GSD_COMPLEXITY_LLM=1, LLM stub returns 0 → floor (4) still applies
            assert result["security_sensitivity"] >= 4, \
                f"Floor should still apply when LLM enabled but key absent: {result['security_sensitivity']}"
        finally:
            os.environ.pop("GSD_COMPLEXITY_LLM", None)


# ═══════════════════════════════════════════════════════════════════════════════
# SCALE-04: detect_escalation + apply_escalation
# ═══════════════════════════════════════════════════════════════════════════════

class TestDetectEscalation:

    def test_detect_escalation_pure(self):
        """detect_escalation is pure — same input twice → same output."""
        handoff = {"escalation_flags": [], "context_snapshot": {}}
        executor = {"manifest_violation": True}
        r1 = detect_escalation(handoff, executor, None, FULL_CONFIG)
        r2 = detect_escalation(handoff, executor, None, FULL_CONFIG)
        assert r1 == r2, f"Non-deterministic: {r1} vs {r2}"

    def test_detect_escalation_manifest_violation_executor(self):
        """executor_report manifest_violation=True → fires manifest_violation."""
        handoff = {"escalation_flags": [], "context_snapshot": {}}
        executor = {"manifest_violation": True}
        fired = detect_escalation(handoff, executor, None, FULL_CONFIG)
        assert "manifest_violation" in fired, f"Expected manifest_violation in {fired}"

    def test_detect_escalation_complexity_surprise_marker(self):
        """COMPLEXITY_SURPRISE in summary → fires executor_self_report."""
        handoff = {"escalation_flags": [], "context_snapshot": {}}
        executor = {"summary": "COMPLEXITY_SURPRISE found in migration"}
        fired = detect_escalation(handoff, executor, None, FULL_CONFIG)
        assert "executor_self_report" in fired, f"Expected executor_self_report: {fired}"

    def test_detect_escalation_no_triggers_on_empty(self):
        """Empty reports → no triggers fired."""
        handoff = {"escalation_flags": [], "context_snapshot": {}}
        fired = detect_escalation(handoff, None, None, FULL_CONFIG)
        assert fired == [], f"Expected empty triggers, got {fired}"


class TestApplyEscalation:

    def test_apply_escalation_cap(self):
        """2 prior flags + new fired → cap_hit=True, score unchanged."""
        handoff = {
            "escalation_flags": [
                "file_count_overshoot:rescored_to_70",
                "executor_self_report:rescored_to_90",
            ],
            "context_snapshot": {"complexity_score": 90, "chosen_phases": ["R", "P", "E", "T", "D"]},
        }
        result = apply_escalation(handoff, ["manifest_violation"], FULL_CONFIG)
        assert result["cap_hit"] is True, f"Expected cap_hit=True, got {result}"
        assert result["new_score"] == 90, f"Score should stay 90 at cap, got {result['new_score']}"

    def test_apply_escalation_first_fires(self):
        """First escalation → score increases by 20."""
        handoff = {
            "escalation_flags": [],
            "context_snapshot": {"complexity_score": 50, "chosen_phases": ["R", "P", "E", "T"]},
        }
        result = apply_escalation(handoff, ["file_count_overshoot"], FULL_CONFIG)
        assert result["cap_hit"] is False
        assert result["new_score"] == 70, f"Expected 50+20=70, got {result['new_score']}"

    def test_apply_escalation_score_clamped_at_100(self):
        """Multiple triggers: score clamped at 100."""
        handoff = {
            "escalation_flags": [],
            "context_snapshot": {"complexity_score": 80, "chosen_phases": ["R", "P", "E", "T", "D"]},
        }
        result = apply_escalation(handoff, ["a", "b", "c"], FULL_CONFIG)
        assert result["new_score"] == 100, f"Expected min(80+60,100)=100, got {result['new_score']}"

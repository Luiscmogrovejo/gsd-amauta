#!/usr/bin/env python3
"""Tests for prompt_cache — Phase 23 / CACHE-02, CACHE-04.

Verifies annotate_cache_control() and PromptCacheMetrics behavior.
Run: pytest tests/test_prompt_cache.py -v
"""

import threading
import pytest

from services.prompt_cache import annotate_cache_control, PromptCacheMetrics


# ── annotate_cache_control Tests (CACHE-02) ──────────────────────────────────

class TestAnnotateCacheControl:

    def test_identifies_breakpoint_index(self):
        """Given 3 stable + 1 variable section, breakpoint_index == 2."""
        sections = [
            {"role": "system", "content": "You are an assistant.", "is_stable": True},
            {"role": "user", "content": "Here are your instructions.", "is_stable": True},
            {"role": "assistant", "content": "Understood. Ready.", "is_stable": True},
            {"role": "user", "content": "Dynamic user query here.", "is_stable": False},
        ]
        result = annotate_cache_control(sections)
        assert result["breakpoint_index"] == 2
        assert result["sections_analyzed"] == 4

    def test_returns_ephemeral_annotation(self):
        """annotation field must be exactly {"type": "ephemeral"}."""
        sections = [{"role": "system", "content": "static text", "is_stable": True}]
        result = annotate_cache_control(sections)
        assert result["annotation"] == {"type": "ephemeral"}

    def test_valid_when_above_min_tokens(self):
        """A stable prefix with ~10K chars (>2048 token est) should be valid."""
        # ~40960 chars / 4 chars_per_token = 10240 tokens — well above 2048
        large_content = "A" * 40960
        sections = [
            {"role": "system", "content": large_content, "is_stable": True},
            {"role": "user", "content": "dynamic query", "is_stable": False},
        ]
        result = annotate_cache_control(sections)
        assert result["valid"] is True
        assert result["stable_tokens_estimate"] >= 2048

    def test_invalid_when_below_min_tokens(self):
        """A stable prefix with ~100 chars (<2048 token est) should be invalid."""
        sections = [
            {"role": "system", "content": "Short.", "is_stable": True},
            {"role": "user", "content": "dynamic query", "is_stable": False},
        ]
        result = annotate_cache_control(sections)
        assert result["valid"] is False
        assert result["stable_tokens_estimate"] < 2048

    def test_all_stable_sections_gives_last_index(self):
        """If all sections are stable, breakpoint_index == len(sections) - 1."""
        sections = [
            {"role": "system", "content": "section 0", "is_stable": True},
            {"role": "user", "content": "section 1", "is_stable": True},
            {"role": "assistant", "content": "section 2", "is_stable": True},
        ]
        result = annotate_cache_control(sections)
        assert result["breakpoint_index"] == 2

    def test_empty_sections_returns_valid_result(self):
        """Empty list returns valid dict with breakpoint_index -1 and valid False."""
        result = annotate_cache_control([])
        assert isinstance(result, dict)
        assert result["breakpoint_index"] == -1
        assert result["valid"] is False
        assert result["sections_analyzed"] == 0
        assert result["annotation"] == {"type": "ephemeral"}

    def test_default_is_stable_true(self):
        """Sections without is_stable key are treated as stable by default."""
        sections = [
            {"role": "system", "content": "no is_stable key"},
            {"role": "user", "content": "also no key"},
        ]
        result = annotate_cache_control(sections)
        # Both treated as stable; last index is 1
        assert result["breakpoint_index"] == 1

    def test_custom_min_tokens(self):
        """Custom min_tokens value is respected in validity check."""
        sections = [{"role": "system", "content": "A" * 100, "is_stable": True}]
        # With low threshold (1 token), should be valid
        result_low = annotate_cache_control(sections, min_tokens=1)
        assert result_low["valid"] is True
        assert result_low["min_tokens"] == 1
        # With high threshold, should be invalid
        result_high = annotate_cache_control(sections, min_tokens=10000)
        assert result_high["valid"] is False
        assert result_high["min_tokens"] == 10000


# ── PromptCacheMetrics Tests (CACHE-04) ──────────────────────────────────────

class TestPromptCacheMetrics:

    def test_initial_stats_all_zero(self):
        """Fresh PromptCacheMetrics: hit_rate == 0.0, total_requests == 0."""
        metrics = PromptCacheMetrics()
        stats = metrics.stats()
        assert stats["hit_rate"] == 0.0
        assert stats["total_requests"] == 0
        assert stats["cache_read_tokens"] == 0
        assert stats["cache_creation_tokens"] == 0
        assert stats["total_tokens_saved"] == 0
        assert stats["cost_savings_estimate"] == 0.0

    def test_stats_has_all_required_fields(self):
        """stats() dict must contain exactly the 6 required fields."""
        metrics = PromptCacheMetrics()
        stats = metrics.stats()
        required = {"hit_rate", "total_tokens_saved", "cost_savings_estimate",
                    "cache_read_tokens", "cache_creation_tokens", "total_requests"}
        assert set(stats.keys()) == required

    def test_record_updates_counters(self):
        """record(1000, 500) updates cache_read_tokens and total_requests."""
        metrics = PromptCacheMetrics()
        metrics.record(cache_read_input_tokens=1000, cache_creation_input_tokens=500)
        stats = metrics.stats()
        assert stats["cache_read_tokens"] == 1000
        assert stats["cache_creation_tokens"] == 500
        assert stats["total_requests"] == 1
        assert stats["total_tokens_saved"] == 1000

    def test_hit_rate_calculation(self):
        """record(900, 100) yields hit_rate == 0.9 (900 read / 1000 total)."""
        metrics = PromptCacheMetrics()
        metrics.record(cache_read_input_tokens=900, cache_creation_input_tokens=100)
        stats = metrics.stats()
        assert abs(stats["hit_rate"] - 0.9) < 0.001

    def test_cost_savings_estimate(self):
        """record(1_000_000, 0) yields cost_savings_estimate == 2.7 ($2.7/MTok)."""
        metrics = PromptCacheMetrics()
        metrics.record(cache_read_input_tokens=1_000_000, cache_creation_input_tokens=0)
        stats = metrics.stats()
        assert abs(stats["cost_savings_estimate"] - 2.7) < 0.001

    def test_multiple_records_accumulate(self):
        """3 sequential record() calls accumulate correctly."""
        metrics = PromptCacheMetrics()
        metrics.record(100, 50)
        metrics.record(200, 100)
        metrics.record(300, 150)
        stats = metrics.stats()
        assert stats["cache_read_tokens"] == 600
        assert stats["cache_creation_tokens"] == 300
        assert stats["total_requests"] == 3

    def test_reset_clears_all(self):
        """After records, reset() zeros all counters."""
        metrics = PromptCacheMetrics()
        metrics.record(5000, 1000)
        metrics.record(2000, 500)
        metrics.reset()
        stats = metrics.stats()
        assert stats["cache_read_tokens"] == 0
        assert stats["cache_creation_tokens"] == 0
        assert stats["total_requests"] == 0
        assert stats["hit_rate"] == 0.0

    def test_thread_safety(self):
        """100 concurrent record() calls from threads should give total_requests == 100."""
        metrics = PromptCacheMetrics()
        threads = []
        for _ in range(100):
            t = threading.Thread(target=lambda: metrics.record(10, 5))
            threads.append(t)
            t.start()
        for t in threads:
            t.join()
        stats = metrics.stats()
        assert stats["total_requests"] == 100
        assert stats["cache_read_tokens"] == 1000
        assert stats["cache_creation_tokens"] == 500

    def test_zero_creation_tokens_hit_rate(self):
        """When only read tokens are present, hit_rate == 1.0."""
        metrics = PromptCacheMetrics()
        metrics.record(cache_read_input_tokens=500, cache_creation_input_tokens=0)
        stats = metrics.stats()
        assert stats["hit_rate"] == 1.0

    def test_zero_read_tokens_hit_rate(self):
        """When only creation tokens are present, hit_rate == 0.0."""
        metrics = PromptCacheMetrics()
        metrics.record(cache_read_input_tokens=0, cache_creation_input_tokens=800)
        stats = metrics.stats()
        assert stats["hit_rate"] == 0.0
        assert stats["total_tokens_saved"] == 0

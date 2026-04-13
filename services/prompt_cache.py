#!/usr/bin/env python3
"""Prompt prefix cache utilities — Phase 23 / CACHE-02, CACHE-04.

Provides cache_control annotation for stable prefix identification
and PromptCacheMetrics for tracking cache hit/miss performance.

GSD-Amauta does not make direct Claude API calls; Claude Code handles
caching automatically. These utilities:
1. Validate prompt structure for cacheability (annotate_cache_control)
2. Track cache telemetry reported back from Claude Code sessions (PromptCacheMetrics)

Claude prompt caching pricing (Sonnet 3.x):
  - Cache read:    $0.30/MTok  (0.1x of $3.00 input price)
  - Cache write:   $3.75/MTok  (1.25x of $3.00 input price, 5-min TTL)
  - Min tokens:    2048 (Sonnet), 4096 (Opus)

References:
  - .planning/research/TOKEN-EFFICIENCY-CACHING.md lines 440-460
  - .planning/REQUIREMENTS.md CACHE-02, CACHE-04
"""

import threading

try:
    import tiktoken
    _TIKTOKEN_AVAILABLE = True
except ImportError:
    _TIKTOKEN_AVAILABLE = False

# Minimum token threshold for cache validity (Sonnet = 2048, Opus = 4096)
_MIN_TOKENS_SONNET = 2048
_MIN_TOKENS_OPUS = 4096

# Approximate chars-per-token ratio for fallback estimation
_CHARS_PER_TOKEN = 4

# Cost savings model (Sonnet): input $3/MTok, cache read $0.3/MTok
# Savings per cached-read token = $3 - $0.3 = $2.7 per MTok
_SAVINGS_PER_MTOKEN = 2.7


def _estimate_tokens(text: str) -> int:
    """Estimate token count for a string.

    Uses tiktoken (cl100k_base) when available; falls back to len/4 approximation.
    """
    if _TIKTOKEN_AVAILABLE:
        try:
            enc = tiktoken.get_encoding("cl100k_base")
            return len(enc.encode(text))
        except Exception:
            pass
    return max(1, len(text) // _CHARS_PER_TOKEN)


def annotate_cache_control(sections: list, min_tokens: int = _MIN_TOKENS_SONNET) -> dict:
    """Analyze prompt sections and identify where cache_control should be placed.

    This function does NOT make API calls. It validates prompt structure for
    cacheability and returns annotation metadata indicating where
    `cache_control: {"type": "ephemeral"}` SHOULD be placed.

    Args:
        sections: list of dicts, each with:
            - role: str ("system", "user", "assistant")
            - content: str (the text content)
            - is_stable: bool (optional, default True — marks content as cacheable)
        min_tokens: int — minimum stable-prefix token count for cache validity
                    (default 2048 for Sonnet; use 4096 for Opus)

    Returns:
        dict with:
            - breakpoint_index: int — index of the last stable section (-1 if none)
            - stable_tokens_estimate: int — approximate token count of stable prefix
            - annotation: dict — the cache_control annotation to place:
                {"type": "ephemeral"}
            - valid: bool — True if stable prefix meets minimum token threshold
            - min_tokens: int — minimum tokens required (as passed in)
            - sections_analyzed: int — total sections processed
    """
    if not sections:
        return {
            "breakpoint_index": -1,
            "stable_tokens_estimate": 0,
            "annotation": {"type": "ephemeral"},
            "valid": False,
            "min_tokens": min_tokens,
            "sections_analyzed": 0,
        }

    # Find the last section where is_stable is True (defaults to True if missing)
    breakpoint_index = -1
    for i, section in enumerate(sections):
        is_stable = section.get("is_stable", True)
        if is_stable:
            breakpoint_index = i

    # Estimate token count of all stable sections
    stable_tokens_estimate = 0
    for i, section in enumerate(sections):
        is_stable = section.get("is_stable", True)
        if is_stable:
            content = section.get("content", "")
            stable_tokens_estimate += _estimate_tokens(content)

    valid = stable_tokens_estimate >= min_tokens

    return {
        "breakpoint_index": breakpoint_index,
        "stable_tokens_estimate": stable_tokens_estimate,
        "annotation": {"type": "ephemeral"},
        "valid": valid,
        "min_tokens": min_tokens,
        "sections_analyzed": len(sections),
    }


class PromptCacheMetrics:
    """Track prompt cache hit/miss metrics.

    Thread-safe — safe to use from daemon request handlers.

    Tracks cache telemetry reported from Claude Code sessions via
    POST /metrics/cache/record. Fields cache_read_input_tokens and
    cache_creation_input_tokens come from Claude API response usage data.

    CACHE-04 requirement: counters must update after each API call
    and be accessible via GET /metrics/cache.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._cache_read_tokens = 0      # Tokens served from cache (hits)
        self._cache_creation_tokens = 0  # Tokens written to cache (misses/new)
        self._total_requests = 0         # Total API calls recorded

    def record(self, cache_read_input_tokens: int = 0, cache_creation_input_tokens: int = 0) -> None:
        """Record cache metrics from a single API call.

        Args:
            cache_read_input_tokens: Tokens served from cache for this call.
                                     Maps to Claude API response field of same name.
            cache_creation_input_tokens: Tokens written to cache for this call.
                                         Maps to Claude API response field of same name.
        """
        with self._lock:
            self._cache_read_tokens += int(cache_read_input_tokens)
            self._cache_creation_tokens += int(cache_creation_input_tokens)
            self._total_requests += 1

    def stats(self) -> dict:
        """Return current cumulative stats.

        Returns:
            dict with:
                - hit_rate: float (0.0-1.0) — ratio of read tokens to total cached tokens
                - total_tokens_saved: int — tokens served from cache (= cache_read_tokens)
                - cost_savings_estimate: float — estimated $ saved (reads at 0.1x vs 1.0x)
                - cache_read_tokens: int — cumulative tokens read from cache
                - cache_creation_tokens: int — cumulative tokens written to cache
                - total_requests: int — number of API calls recorded
        """
        with self._lock:
            total_cached = self._cache_read_tokens + self._cache_creation_tokens
            hit_rate = (
                self._cache_read_tokens / total_cached
            ) if total_cached > 0 else 0.0
            # Cost savings: cache read at $0.3/MTok vs $3.0/MTok input = $2.7/MTok saved
            savings = (self._cache_read_tokens / 1_000_000) * _SAVINGS_PER_MTOKEN
            return {
                "hit_rate": round(hit_rate, 4),
                "total_tokens_saved": self._cache_read_tokens,
                "cost_savings_estimate": round(savings, 4),
                "cache_read_tokens": self._cache_read_tokens,
                "cache_creation_tokens": self._cache_creation_tokens,
                "total_requests": self._total_requests,
            }

    def reset(self) -> None:
        """Reset all counters (for testing)."""
        with self._lock:
            self._cache_read_tokens = 0
            self._cache_creation_tokens = 0
            self._total_requests = 0

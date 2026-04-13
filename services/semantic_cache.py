#!/usr/bin/env python3
"""Semantic cache manager — Phase 24 / SEMANTIC-01..03.

Wraps PGStore semantic_cache_* methods with thread-safe hit/miss counters
and cost estimation. Used by amauta-daemon.py endpoints and the research chain.

Threshold is configurable via GSD_SEMANTIC_CACHE_THRESHOLD (default 0.90).

Cost model (Perplexity Sonar Pro):
  - Input:  $3/MTok
  - Output: $15/MTok
  - Avg call: ~500 input tokens + ~1000 output tokens
  - Avg cost per call: (500 * 3 + 1000 * 15) / 1_000_000 = $0.0165
  - Rounded estimate: $0.018 per cache hit saved

References:
  - .planning/REQUIREMENTS.md SEMANTIC-01, SEMANTIC-02, SEMANTIC-03
  - .planning/phases/24-semantic-cache-tiered-routing/24-01-PLAN.md
"""

import os
import threading

COSINE_THRESHOLD = float(os.environ.get("GSD_SEMANTIC_CACHE_THRESHOLD", "0.90"))

# Estimated cost saved per cache hit (Perplexity Sonar Pro avg call cost)
_COST_PER_HIT = 0.018


class SemanticCacheManager:
    """Thread-safe semantic cache manager.

    Wraps PGStore semantic_cache_* methods with counters and cost estimation.
    The manager does not own a PGStore instance — it receives store as a
    parameter on each method call, allowing the daemon to share its singleton.

    Usage:
        manager = SemanticCacheManager()

        result = manager.lookup(query, store)      # returns dict or None
        manager.store(query, resp, tokens, hashes, store)
        manager.invalidate_for_file(path, hash_, store)
        stats = manager.stats()                    # {hits, misses, hit_rate, ...}
    """

    def __init__(self, threshold=None):
        self._threshold = threshold if threshold is not None else COSINE_THRESHOLD
        self._lock = threading.Lock()
        self._hits = 0
        self._misses = 0
        self._tokens_saved = 0  # sum of response_tokens from all cache hits

    def lookup(self, query, store):
        """Look up a query in the semantic cache.

        Args:
            query: The research query string.
            store: A PGStore instance with semantic_cache_lookup().

        Returns:
            dict with cached response fields, or None on miss.
        """
        if not store or not hasattr(store, "semantic_cache_lookup"):
            with self._lock:
                self._misses += 1
            return None

        result = store.semantic_cache_lookup(query, threshold=self._threshold)
        with self._lock:
            if result:
                self._hits += 1
                self._tokens_saved += result.get("response_tokens", 0) or 0
            else:
                self._misses += 1
        return result

    def store(self, query, response, response_tokens=0,
              source_file_hashes=None, store=None, provider="perplexity"):
        """Store a response in the semantic cache.

        Args:
            query: The original research query.
            response: The response text to cache.
            response_tokens: Estimated token count of the response.
            source_file_hashes: dict of {file_path: sha256_hash} for staleness.
            store: A PGStore instance with semantic_cache_store().
            provider: Source provider name (default: "perplexity").

        Returns:
            New cache entry ID, or None on failure.
        """
        if not store or not hasattr(store, "semantic_cache_store"):
            return None
        return store.semantic_cache_store(
            query_text=query,
            response=response,
            response_tokens=response_tokens,
            source_file_hashes=source_file_hashes,
            provider=provider,
        )

    def invalidate_for_file(self, file_path, new_hash, store):
        """Invalidate cache entries for a changed source file.

        Args:
            file_path: The file that changed.
            new_hash: New SHA-256 hash of the file.
            store: A PGStore instance with semantic_cache_invalidate().

        Returns:
            Number of entries invalidated, or 0 on failure.
        """
        if not store or not hasattr(store, "semantic_cache_invalidate"):
            return 0
        return store.semantic_cache_invalidate(file_path, new_hash) or 0

    def stats(self):
        """Return cache performance statistics.

        Returns:
            dict with:
                hits (int): Total cache hits.
                misses (int): Total cache misses.
                hit_rate (float): hits / (hits + misses), 0.0 if no requests.
                entries (int): Valid entries in DB (caller must pass db_stats["valid_entries"]).
                total_tokens_saved (int): Sum of response_tokens from all hits.
                estimated_cost_saved (float): Estimated USD saved at $0.018/hit.
        """
        with self._lock:
            hits = self._hits
            misses = self._misses
            tokens_saved = self._tokens_saved

        total = hits + misses
        hit_rate = round(hits / total, 4) if total > 0 else 0.0

        return {
            "hits": hits,
            "misses": misses,
            "hit_rate": hit_rate,
            "entries": 0,  # Caller should replace with db_stats["valid_entries"]
            "total_tokens_saved": tokens_saved,
            "estimated_cost_saved": round(hits * _COST_PER_HIT, 6),
        }

    def reset(self):
        """Reset all counters (for testing)."""
        with self._lock:
            self._hits = 0
            self._misses = 0
            self._tokens_saved = 0


# Module-level singleton — shared by daemon and research chain
_semantic_cache_manager = SemanticCacheManager()

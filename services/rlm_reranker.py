#!/usr/bin/env python3
"""
Cross-encoder reranker for GSD-Amauta RLM — Phase 27 / RLM-05.

Priority order:
  1. Jina Reranker v2 API (JINA_API_KEY env var)
  2. sentence-transformers cross-encoder (local, model: cross-encoder/ms-marco-MiniLM-L-6-v2)
  3. Graceful fallback: return hybrid top-5 unranked (no crash)

Cache: Valkey key rlm:rerank:{query_sha256[:12]}:{chunk_id} -> JSON score, TTL 600 seconds.
Cache hit rate logged per request.

Usage: rerank(query, chunks) -> list (top-5, reranked)
"""

import hashlib
import json
import logging
import os
import time
from typing import Optional

log = logging.getLogger("amauta.rlm_reranker")

# Reranker constants
RERANK_TOP_K = 5           # Final results returned
RERANK_CANDIDATE_K = 20    # Input candidates from hybrid search
CACHE_TTL = 600            # 10 minutes in seconds
CACHE_KEY_PREFIX = "rlm:rerank:"

# Jina Reranker v2 endpoint
JINA_RERANK_URL = "https://api.jina.ai/v1/rerank"
JINA_RERANK_MODEL = "jina-reranker-v2-base-multilingual"

# Sentence-transformers fallback model
SBERT_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"


def rerank(query: str, chunks: list, top_k: int = RERANK_TOP_K) -> list:
    """
    Rerank chunks by cross-encoder relevance to query.

    Returns top_k chunks sorted by reranker score (descending).
    If reranker is unavailable, returns chunks[:top_k] unranked (graceful fallback).

    Logs cache hit rate per call.
    """
    if not chunks:
        return []

    # Check cache for each chunk
    cache_client = _get_cache_client()
    query_hash = hashlib.sha256(query.encode("utf-8")).hexdigest()[:12]

    cached_scores: dict = {}
    uncached_chunks: list = []

    if cache_client is not None:
        for chunk in chunks[:RERANK_CANDIDATE_K]:
            chunk_id = chunk.get("id", 0)
            cache_key = f"{CACHE_KEY_PREFIX}{query_hash}:{chunk_id}"
            try:
                val = cache_client.get(cache_key)
                if val is not None:
                    cached_scores[chunk_id] = float(json.loads(val))
                else:
                    uncached_chunks.append(chunk)
            except Exception:
                uncached_chunks.append(chunk)
    else:
        uncached_chunks = list(chunks[:RERANK_CANDIDATE_K])

    hit_count = len(chunks[:RERANK_CANDIDATE_K]) - len(uncached_chunks)
    total = len(chunks[:RERANK_CANDIDATE_K])
    hit_rate = hit_count / max(1, total)
    log.info("reranker_cache_hit_rate rate=%.2f hits=%d total=%d", hit_rate, hit_count, total)

    # Score uncached chunks
    new_scores: dict = {}
    if uncached_chunks:
        texts = [c.get("content", c.get("text", ""))[:2048] for c in uncached_chunks]
        new_scores = _score_chunks(query, uncached_chunks, texts)

        # Write new scores to cache
        if cache_client is not None:
            for chunk in uncached_chunks:
                chunk_id = chunk.get("id", 0)
                score = new_scores.get(chunk_id)
                if score is not None:
                    cache_key = f"{CACHE_KEY_PREFIX}{query_hash}:{chunk_id}"
                    try:
                        cache_client.set(cache_key, json.dumps(score), ex=CACHE_TTL)
                    except Exception:
                        pass

    # Merge scores and sort
    all_scores = {**cached_scores, **new_scores}
    if not all_scores:
        # Reranker completely unavailable — return hybrid top-k unranked (graceful fallback)
        log.warning("reranker_fallback_mode reason=no_scores_available")
        return chunks[:top_k]

    scored = []
    for chunk in chunks[:RERANK_CANDIDATE_K]:
        chunk_id = chunk.get("id", 0)
        score = all_scores.get(chunk_id, chunk.get("rrf_score", 0.0) or 0.0)
        c = dict(chunk)
        c["reranker_score"] = float(score)
        scored.append(c)

    scored.sort(key=lambda x: -x["reranker_score"])
    return scored[:top_k]


def _score_chunks(query: str, chunks: list, texts: list) -> dict:
    """Score chunks via Jina API or sentence-transformers fallback. Returns {chunk_id: score}."""
    scores = _try_jina(query, chunks, texts)
    if scores is None:
        scores = _try_sbert(query, chunks, texts)
    if scores is None:
        return {}
    return scores


def _try_jina(query: str, chunks: list, texts: list) -> Optional[dict]:
    """Score via Jina Reranker v2 API."""
    api_key = os.environ.get("JINA_API_KEY", "")
    if not api_key:
        return None
    try:
        import urllib.request
        payload = json.dumps({
            "model": JINA_RERANK_MODEL,
            "query": query[:512],
            "documents": texts,
            "top_n": len(texts),
        }).encode("utf-8")
        req = urllib.request.Request(
            JINA_RERANK_URL,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        scores = {}
        for item in results:
            idx = item.get("index", -1)
            score = item.get("relevance_score", 0.0)
            if 0 <= idx < len(chunks):
                scores[chunks[idx].get("id", idx)] = score
        log.debug("jina_rerank_ok count=%d", len(scores))
        return scores if scores else None
    except Exception as e:
        log.warning("jina_rerank_failed error=%s", str(e))
        return None


def _try_sbert(query: str, chunks: list, texts: list) -> Optional[dict]:
    """Score via sentence-transformers cross-encoder (local fallback)."""
    try:
        from sentence_transformers import CrossEncoder  # type: ignore
        model = CrossEncoder(SBERT_MODEL)
        pairs = [(query[:512], t[:512]) for t in texts]
        raw_scores = model.predict(pairs)
        scores = {}
        for i, score in enumerate(raw_scores):
            if i < len(chunks):
                scores[chunks[i].get("id", i)] = float(score)
        log.debug("sbert_rerank_ok count=%d", len(scores))
        return scores if scores else None
    except Exception as e:
        log.warning("sbert_rerank_failed error=%s", str(e))
        return None


def _get_cache_client():
    """Return a redis-py client connected to Valkey, or None if unavailable."""
    try:
        import redis
        client = redis.Redis(
            host=os.environ.get("REDIS_HOST", "127.0.0.1"),
            port=int(os.environ.get("REDIS_PORT", "6379")),
            decode_responses=True,
            socket_timeout=1,
        )
        client.ping()
        return client
    except Exception:
        return None

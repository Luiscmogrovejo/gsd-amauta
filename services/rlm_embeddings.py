#!/usr/bin/env python3
"""
Code embedding pipeline for GSD-Amauta RLM -- Phase 27 / RLM-03.

Priority order:
  1. Voyage Code 3 API (voyage-code-3, VOYAGE_API_KEY env var)
  2. Qodo-Embed-1-1.5B via Ollama (local, http://localhost:11434)
  3. None -- BM25-only graceful degradation

Matryoshka dimensionality: store 1024-dim, query at 256-dim for fast lookup.
"""

import hashlib
import logging
import os
from typing import Optional

log = logging.getLogger("amauta.rlm_embeddings")

# Voyage Code 3 model name
VOYAGE_MODEL = "voyage-code-3"
VOYAGE_OUTPUT_DIMENSION = 1024

# Qodo-Embed model (local Ollama)
QODO_MODEL = "qodo-embed-1-1.5b"
QODO_OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

# In-memory embedding cache: sha256(text) -> embedding list
_EMBED_CACHE: dict = {}
_EMBED_CACHE_MAX = 500


def generate_code_embedding(text: str) -> Optional[list]:
    """
    Generate a 1024-dimensional code embedding for the given text.

    Returns a list of 1024 floats, or None if no embedding model is available.
    None triggers BM25-only retrieval -- this is the expected graceful degradation path.

    Caches results by SHA-256 of text to avoid redundant API calls during batch ingestion.
    """
    if not text or not text.strip():
        return None

    # Cache key: SHA-256 of text (first 512 chars for speed)
    cache_key = hashlib.sha256(text[:512].encode("utf-8")).hexdigest()
    if cache_key in _EMBED_CACHE:
        return _EMBED_CACHE[cache_key]

    embedding = _try_voyage(text) or _try_qodo(text)

    if embedding is not None:
        # Evict if cache full
        if len(_EMBED_CACHE) >= _EMBED_CACHE_MAX:
            # Remove oldest (first key)
            _EMBED_CACHE.pop(next(iter(_EMBED_CACHE)))
        _EMBED_CACHE[cache_key] = embedding

    return embedding


def embed_for_query(text: str) -> Optional[list]:
    """
    Generate a 256-dim embedding for query-time fast lookup (Matryoshka truncation).
    Returns the first 256 dimensions of generate_code_embedding result, or None.
    """
    full = generate_code_embedding(text)
    if full is None:
        return None
    return full[:256]


def _try_voyage(text: str) -> Optional[list]:
    """Attempt embedding via Voyage Code 3 API.

    Supports both voyageai>=0.3.0 (output_dimension kwarg) and 0.2.x (no output_dimension).
    voyage-code-3 default output is 1024-dim, so both paths produce the same dimensionality.
    """
    api_key = os.environ.get("VOYAGE_API_KEY", "")
    if not api_key:
        return None
    try:
        import voyageai  # type: ignore
        client = voyageai.Client(api_key=api_key)
        # Try new API (voyageai>=0.3.0) with output_dimension; fall back to v0.2.x
        try:
            result = client.embed(
                [text[:8192]],
                model=VOYAGE_MODEL,
                input_type="document",
                output_dimension=VOYAGE_OUTPUT_DIMENSION,
            )
        except TypeError:
            # output_dimension not supported (voyageai<0.3.0) — voyage-code-3 default = 1024
            result = client.embed(
                [text[:8192]],
                model=VOYAGE_MODEL,
                input_type="document",
            )
        embedding = result.embeddings[0]
        # Ensure exactly 1024 dims (truncate or pad)
        embedding = list(embedding)
        if len(embedding) < VOYAGE_OUTPUT_DIMENSION:
            embedding = embedding + [0.0] * (VOYAGE_OUTPUT_DIMENSION - len(embedding))
        else:
            embedding = embedding[:VOYAGE_OUTPUT_DIMENSION]
        log.debug("voyage_embed_ok dims=%d", len(embedding))
        return embedding
    except Exception as e:
        log.warning("voyage_embed_failed error=%s", str(e))
        return None


def _try_qodo(text: str) -> Optional[list]:
    """Attempt embedding via Qodo-Embed-1-1.5B through local Ollama."""
    try:
        import urllib.request
        import json as _json
        payload = _json.dumps({"model": QODO_MODEL, "prompt": text[:4096]}).encode()
        req = urllib.request.Request(
            f"{QODO_OLLAMA_URL}/api/embeddings",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = _json.loads(resp.read())
        embedding = data.get("embedding", [])
        if not embedding:
            return None
        # Pad or truncate to 1024 dims for consistent storage
        if len(embedding) < 1024:
            embedding = embedding + [0.0] * (1024 - len(embedding))
        else:
            embedding = embedding[:1024]
        log.debug("qodo_embed_ok dims=%d", len(embedding))
        return embedding
    except Exception as e:
        log.warning("qodo_embed_failed error=%s", str(e))
        return None


def clear_cache():
    """Clear the in-memory embedding cache (for testing)."""
    _EMBED_CACHE.clear()

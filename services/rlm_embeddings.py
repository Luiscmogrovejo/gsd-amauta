#!/usr/bin/env python3
"""
Code embedding pipeline for GSD-Amauta RLM -- Phase 27 / RLM-03.

Priority order:
  1. Voyage Code 3 API (voyage-code-3, VOYAGE_API_KEY env var)
  2. Qodo-Embed-1-1.5B via Ollama (local, http://localhost:11434)
  3. None -- BM25-only graceful degradation

Three defects fixed here:

* **Query vectors were embedded as documents.** Every call hard-coded
  ``input_type="document"``, including the one from
  ``services/rlm_search.py:hybrid_search`` that embeds the user's QUERY.
  voyage-code-3 is an asymmetric model: query and document prompts put the
  two sides in deliberately different places, so embedding a query as a
  document costs recall for nothing. ``input_type`` is now a parameter and
  the search path passes ``"query"``.

* **The cache key hashed only the first 512 characters.** Two chunks sharing
  a 512-character prefix — trivially common for generated code, licence
  headers, or a class and its subclass — collided, and the second silently
  received the first one's vector. The key is now the full text, plus the
  model and input_type, so a query and a document of the same text no longer
  share an entry either.

* **Fallback vectors were indistinguishable from real ones.** Qodo output
  (1536-dim, truncated to 1024) went into the same ``embedding_code`` column
  as Voyage output (1024-dim) with nothing recording which produced a row.
  Cosine distance across two embedding spaces is noise. ``embed_code``
  returns the model name alongside the vector; migration 030 stores it; the
  vector leg of the search filters to the active model. We keep writing the
  fallback (BM25 still covers those rows, and refusing the write would leave
  a locally-embedded index with no vectors at all) — we just stop pretending
  the two are comparable.

Matryoshka dimensionality: store 1024-dim. ``embed_for_query`` truncates to
256 for callers that want the fast lookup; note that pgvector's ``vector(N)``
cast needs an EXACT dimension match, so it is NOT usable against the stored
1024-dim column (see TK-1741 in rlm_search.py).
"""

import hashlib
import logging
import os
from typing import Optional, Tuple

log = logging.getLogger("amauta.rlm_embeddings")

# Voyage Code 3 model name
VOYAGE_MODEL = "voyage-code-3"
VOYAGE_OUTPUT_DIMENSION = 1024

# Qodo-Embed model (local Ollama)
QODO_MODEL = "qodo-embed-1-1.5b"
QODO_OLLAMA_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

#: Valid input_type values. "document" for indexed chunks, "query" for searches.
INPUT_TYPE_DOCUMENT = "document"
INPUT_TYPE_QUERY = "query"

# In-memory embedding cache: (model, input_type, sha256(full text)) -> embedding
_EMBED_CACHE: dict = {}
_EMBED_CACHE_MAX = 500


def active_embedding_model() -> Optional[str]:
    """Name of the model that would embed right now, without calling it.

    Used by the search path to filter the vector leg to rows embedded by the
    same model. Returns None when no provider is configured (BM25-only).
    """
    if os.environ.get("VOYAGE_API_KEY", ""):
        return VOYAGE_MODEL
    if os.environ.get("GSD_RLM_DISABLE_QODO", ""):
        return None
    return QODO_MODEL


def _cache_key(text: str, model: str, input_type: str) -> str:
    """Key on the FULL text plus the model and input_type.

    The previous key was sha256(text[:512]) with no model and no input_type:
    any two chunks sharing a 512-char prefix collided, and a query and a
    document of the same text shared one vector despite being embedded with
    different prompts.
    """
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return f"{model}|{input_type}|{digest}"


def _cache_put(key, embedding):
    if len(_EMBED_CACHE) >= _EMBED_CACHE_MAX:
        _EMBED_CACHE.pop(next(iter(_EMBED_CACHE)))
    _EMBED_CACHE[key] = embedding


#: Optional provider override: a callable ``(text, input_type) ->
#: (embedding, model_name) | None`` consulted BEFORE Voyage and Qodo.
#:
#: Phase 88 plan 88-16-08 added this seam. The embedding provider was reachable
#: only through the network, so a test either made a paid API call or
#: monkeypatched an HTTP library — and a test that patches HTTP is a test of
#: the patch, not of the leg under test. One named injection point means the
#: deterministic stand-in enters exactly where Voyage would, through the same
#: return contract, so both paths exercise the same code below this line.
#: Never set in production: nothing in the shipped code paths calls
#: ``set_provider_override``.
_PROVIDER_OVERRIDE = None


def set_provider_override(provider):
    """Install (or clear) the embedding-provider override.

    Args:
        provider: a callable ``(text, input_type)`` returning
            ``(embedding, model_name)`` or None, or None to clear.

    Returns:
        The previous override, so a caller can restore it.

    Example:
        >>> previous = set_provider_override(lambda t, i: ([0.0] * 1024, "stub"))
        >>> set_provider_override(previous) is not None
        True
    """
    global _PROVIDER_OVERRIDE
    previous = _PROVIDER_OVERRIDE
    _PROVIDER_OVERRIDE = provider
    return previous


def get_provider_override():
    """Return the installed provider override, or None."""
    return _PROVIDER_OVERRIDE


def embed_code(text: str, input_type: str = INPUT_TYPE_DOCUMENT
               ) -> Optional[Tuple[list, str]]:
    """Embed *text* and report WHICH model produced the vector.

    Args:
        text: the content to embed.
        input_type: "document" when indexing a chunk, "query" when embedding
            a search query. voyage-code-3 is asymmetric; this matters.

    Returns:
        ``(embedding, model_name)`` or None when no provider is available.
    """
    if not text or not text.strip():
        return None
    if input_type not in (INPUT_TYPE_DOCUMENT, INPUT_TYPE_QUERY):
        raise ValueError(
            f"input_type must be {INPUT_TYPE_DOCUMENT!r} or {INPUT_TYPE_QUERY!r}, "
            f"got {input_type!r}"
        )
    # The override enters where Voyage would, AFTER the same validation, so the
    # stand-in and the real provider are held to one contract.
    if _PROVIDER_OVERRIDE is not None:
        return _PROVIDER_OVERRIDE(text, input_type)

    voyage_key = _cache_key(text, VOYAGE_MODEL, input_type)
    if voyage_key in _EMBED_CACHE:
        return _EMBED_CACHE[voyage_key], VOYAGE_MODEL
    qodo_key = _cache_key(text, QODO_MODEL, input_type)
    if qodo_key in _EMBED_CACHE:
        return _EMBED_CACHE[qodo_key], QODO_MODEL

    embedding = _try_voyage(text, input_type)
    if embedding is not None:
        _cache_put(voyage_key, embedding)
        return embedding, VOYAGE_MODEL

    embedding = _try_qodo(text)
    if embedding is not None:
        _cache_put(qodo_key, embedding)
        return embedding, QODO_MODEL

    return None


def generate_code_embedding(text: str,
                            input_type: str = INPUT_TYPE_DOCUMENT) -> Optional[list]:
    """
    Generate a 1024-dimensional code embedding for the given text.

    Returns a list of 1024 floats, or None if no embedding model is available.
    None triggers BM25-only retrieval -- this is the expected graceful
    degradation path. Thin wrapper over :func:`embed_code` for callers that do
    not need the model name.
    """
    result = embed_code(text, input_type=input_type)
    return None if result is None else result[0]


def embed_for_query(text: str) -> Optional[list]:
    """
    Generate a 256-dim embedding for query-time fast lookup (Matryoshka
    truncation), embedded with the QUERY input type.

    NOTE: not usable against rlm_chunks.embedding_code, which is vector(1024)
    and whose cast enforces an exact dimension match (TK-1741).
    """
    full = generate_code_embedding(text, input_type=INPUT_TYPE_QUERY)
    if full is None:
        return None
    return full[:256]


def _try_voyage(text: str, input_type: str = INPUT_TYPE_DOCUMENT) -> Optional[list]:
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
                input_type=input_type,
                output_dimension=VOYAGE_OUTPUT_DIMENSION,
            )
        except TypeError:
            # output_dimension not supported (voyageai<0.3.0) — voyage-code-3 default = 1024
            result = client.embed(
                [text[:8192]],
                model=VOYAGE_MODEL,
                input_type=input_type,
            )
        embedding = result.embeddings[0]
        # Ensure exactly 1024 dims (truncate or pad)
        embedding = list(embedding)
        if len(embedding) < VOYAGE_OUTPUT_DIMENSION:
            embedding = embedding + [0.0] * (VOYAGE_OUTPUT_DIMENSION - len(embedding))
        else:
            embedding = embedding[:VOYAGE_OUTPUT_DIMENSION]
        log.debug("voyage_embed_ok dims=%d input_type=%s", len(embedding), input_type)
        return embedding
    except Exception as e:
        log.warning("voyage_embed_failed error=%s", str(e))
        return None


def _try_qodo(text: str) -> Optional[list]:
    """Attempt embedding via Qodo-Embed-1-1.5B through local Ollama.

    Ollama's /api/embeddings has no input_type concept — the model is
    symmetric — so the parameter is not forwarded. The result is truncated or
    zero-padded to 1024 dims purely so it FITS the column; it is not
    comparable with a Voyage vector, which is why the caller records the model
    (migration 030) and the search filters on it.
    """
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

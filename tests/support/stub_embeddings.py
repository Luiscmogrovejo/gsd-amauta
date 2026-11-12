"""A deterministic stand-in embedding provider (Phase 88, plan 88-16-08).

The operator's decision of 2026-11-11 is "there is a key, use it": the
embedding-provider test makes a REAL Voyage call whenever ``VOYAGE_API_KEY`` is
present, and runs this stand-in when it is not. **Neither path is a skip**, so
this file is not a placeholder — it is one of the two real implementations the
same assertions are made against, and a pull request from a fork (which never
receives repository secrets) runs only this one.

Determinism, which is the whole value:

* SHA-256 of the input, never Python's ``hash()``. ``hash()`` is salted per
  process by ``PYTHONHASHSEED``, so the "same" input embeds differently on two
  runs of the same test — plan 88-12 already chased one flake caused by exactly
  that (``tests/test_semantic_cache.py``, ``hash(text) % 1000``).
* No randomness, no clock, no environment.
* Unit length, so cosine distance behaves and the vectors are comparable with
  a real provider's.
* The provider's own dimension (1024), so the value fits
  ``rlm_chunks.embedding_code``, declared ``vector(1024)``.

It is installed through the product's own seam,
``services.rlm_embeddings.set_provider_override``, so the code under test below
the provider is identical on both paths.
"""
import hashlib
import math

#: The dimension `rlm_chunks.embedding_code` declares, and what voyage-code-3
#: returns by default.
STUB_DIMENSION = 1024

#: The model name the stand-in reports, so a caller can tell the two apart.
STUB_MODEL = "gsd-deterministic-stub"


def deterministic_embedding(text, dimension=STUB_DIMENSION, input_type="document"):
    """A unit-length vector derived only from ``text`` and ``input_type``.

    The digest stream is expanded by hashing ``(seed, counter)`` until enough
    bytes exist, then each 2-byte group becomes a value in [-1, 1).

    Args:
        text: the content to embed.
        dimension: how many components to produce.
        input_type: ``"document"`` or ``"query"``; voyage-code-3 is asymmetric,
            so the stand-in is too — the same text embeds differently as a
            query and as a document, which is what the real provider does.

    Returns:
        list[float]: ``dimension`` floats whose Euclidean norm is 1.0.

    Raises:
        ValueError: when ``dimension`` is not positive.

    Example:
        >>> v = deterministic_embedding("hello", dimension=4)
        >>> len(v), round(sum(c * c for c in v), 9)
        (4, 1.0)
        >>> deterministic_embedding("hello", dimension=4) == v
        True
    """
    if dimension <= 0:
        raise ValueError("dimension must be positive, got %r" % (dimension,))
    seed = ("%s\x00%s" % (input_type, text)).encode("utf-8")
    needed = dimension * 2
    stream = bytearray()
    counter = 0
    while len(stream) < needed:
        stream += hashlib.sha256(seed + b"\x00" + str(counter).encode("ascii")).digest()
        counter += 1
    raw = [
        (stream[2 * i] << 8 | stream[2 * i + 1]) / 32768.0 - 1.0
        for i in range(dimension)
    ]
    norm = math.sqrt(sum(c * c for c in raw))
    if norm == 0.0:  # unreachable for SHA-256 output; a zero vector has no direction
        raw[0] = 1.0
        norm = 1.0
    return [c / norm for c in raw]


def stub_provider(text, input_type="document"):
    """The provider-override callable: ``(embedding, model_name)`` or None.

    Matches ``services.rlm_embeddings.embed_code``'s return contract exactly,
    including its "no provider" answer for blank input.

    Args:
        text: the content to embed.
        input_type: ``"document"`` or ``"query"``.

    Returns:
        tuple[list[float], str] | None
    """
    if not text or not text.strip():
        return None
    return deterministic_embedding(text, input_type=input_type), STUB_MODEL


def install(rlm_embeddings=None):
    """Install the stand-in through the product's provider seam.

    Args:
        rlm_embeddings: the module to install into; imported when omitted.

    Returns:
        The previous override, for the caller to restore.
    """
    if rlm_embeddings is None:
        from services import rlm_embeddings as rlm_embeddings  # noqa: PLW0127
    return rlm_embeddings.set_provider_override(stub_provider)

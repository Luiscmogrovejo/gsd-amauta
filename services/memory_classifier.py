#!/usr/bin/env python3
"""
services/memory_classifier.py — Phase 66 MEMR-08: write-time mem0-style
ADD/UPDATE/DELETE/NOOP classifier.

Producers (services/pg_store.py's memory_store()/memory_store_with_embedding())
MUST treat this module as purely advisory: `classify_memory_op` is fail-open
by construction and NEVER raises -- any error of any kind (missing
ANTHROPIC_API_KEY, HTTP timeout, malformed JSON, an unrecognized op string,
an out-of-range target_id, the GSD_MEMORY_CLASSIFIER=off kill switch, or an
exception raised by the caller-supplied `llm_call`) degrades to a plain
{"op": "ADD"} decision. The store path is the ONLY caller and always falls
back to inserting the memory unmodified -- a classifier failure of any kind
NEVER blocks a write.

Op semantics (locked in
.planning/phases/66-memory-ranking-lifecycle/66-05-PLAN.md):
  ADD    - insert the new memory (default; universal failure fallback).
  NOOP   - near-verbatim restatement of a valid memory: skip insert.
  UPDATE - new fact supersedes/refines a target memory: close the target's
           validity window (invalid_at = now()), then insert the new row.
  DELETE - new statement negates the target without asserting a
           replacement fact: close the target's window, do NOT insert.

DELETE/UPDATE only ever CLOSE validity windows -- this module never issues
a physical DELETE; bi-temporal means history is preserved. The caller
(pg_store.py) owns the actual SQL; this module only returns a decision.
"""

import json
import os
import sys
import urllib.error
import urllib.request

# Model id resolves through the single source of truth shared with the JS
# runtime (get-shit-done/bin/lib/model-registry.json) via services/model_registry.py
# -- MODL-01 currency + MODL-06 centralization. Defensive: a missing/corrupt
# registry degrades to the last-known-good haiku id so this fail-open module
# never breaks at import time.
try:
    _here = os.path.dirname(os.path.abspath(__file__))
    if _here not in sys.path:
        sys.path.insert(0, _here)
    from model_registry import resolve_model_id as _resolve_model_id
    _CLASSIFIER_MODEL_ID = _resolve_model_id("haiku")
except Exception:
    _CLASSIFIER_MODEL_ID = "claude-haiku-4-5-20251001"  # last-known-good fallback (model-registry unavailable)
_ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
_HTTP_TIMEOUT_SECONDS = 10
_MAX_TOKENS = 200
_VALID_OPS = ("ADD", "UPDATE", "DELETE", "NOOP")


def _default_llm_call(prompt):
    """Anthropic HTTP fallback -- same API shape as gsd-memory.cjs's
    claudeSummarize() HTTP fallback (x-api-key + anthropic-version headers,
    content[0].text extraction). Raises on ANY failure (no key, HTTP error,
    malformed response) -- classify_memory_op catches everything and
    degrades to ADD; this function is intentionally NOT fail-open itself
    (fail-open is enforced once, at the classify_memory_op boundary).
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")

    body = json.dumps({
        "model": _CLASSIFIER_MODEL_ID,
        "max_tokens": _MAX_TOKENS,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        _ANTHROPIC_API_URL,
        data=body,
        method="POST",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SECONDS) as resp:
        parsed = json.loads(resp.read().decode("utf-8"))
    return parsed["content"][0]["text"]


def _build_prompt(new_text, candidates):
    """Build the classification prompt: the new statement + numbered
    candidates (id, text truncated to 400 chars), demanding STRICT JSON
    output with one-line op definitions."""
    lines = [
        "You are a memory-lifecycle classifier. A new statement is about "
        "to be stored alongside existing memory candidates. Decide how the "
        "new statement relates to the candidates below and respond with "
        "STRICT JSON ONLY (no prose, no markdown fences), exactly of the "
        'shape {"op": "<ADD|UPDATE|DELETE|NOOP>", "target_id": <id or null>}.',
        "",
        "Op definitions:",
        "  NOOP   - the new statement is a near-verbatim restatement of a candidate.",
        "  UPDATE - the new statement supersedes or refines a candidate (contradicts/corrects it).",
        "  DELETE - the new statement negates a candidate without asserting a replacement fact.",
        "  ADD    - the new statement is unrelated to, or merely complementary with, every candidate.",
        "",
        f"New statement: {new_text[:800]!r}",
        "",
        "Candidates:",
    ]
    for c in candidates:
        lines.append(f"  [{c['id']}] {str(c.get('text', ''))[:400]!r}")
    return "\n".join(lines)


def classify_memory_op(new_text, candidates, llm_call=None):
    """Classify how `new_text` relates to `candidates` (a list of
    {"id": ..., "text": ...} dicts -- the caller is responsible for scoping
    candidates to the same project and filtering to currently-valid rows).

    Args:
        new_text: the statement about to be stored.
        candidates: top-N nearest candidate memories (typically 3). An
            empty list short-circuits to ADD without invoking `llm_call`
            (no LLM call wasted on a write with nothing to compare against).
        llm_call: injectable callable(prompt) -> str. Tests inject a
            deterministic decision here; production omits it and falls
            back to `_default_llm_call` (live Anthropic HTTP call).

    Returns:
        {"op": "ADD"|"UPDATE"|"DELETE"|"NOOP", "target_id": int|None,
         "reason": str}

    NEVER raises -- every failure mode (kill switch, no candidates, bad
    JSON, unknown op string, out-of-range target_id, an exception raised by
    llm_call itself) degrades to {"op": "ADD", ...} with a `reason` string
    describing why.
    """
    try:
        if os.environ.get("GSD_MEMORY_CLASSIFIER") == "off":
            return {"op": "ADD", "target_id": None, "reason": "kill-switch-off"}

        if not candidates:
            return {"op": "ADD", "target_id": None, "reason": "no-candidates"}

        candidate_ids = {c["id"] for c in candidates}
        call = llm_call or _default_llm_call
        prompt = _build_prompt(new_text, candidates)
        raw = call(prompt)

        parsed = json.loads(raw)
        op = parsed.get("op")
        target_id = parsed.get("target_id")

        if op not in _VALID_OPS:
            return {"op": "ADD", "target_id": None, "reason": "classifier-invalid-output"}

        if op in ("UPDATE", "DELETE"):
            if target_id not in candidate_ids:
                return {"op": "ADD", "target_id": None, "reason": "classifier-invalid-output"}
        elif op == "NOOP":
            if target_id is not None and target_id not in candidate_ids:
                return {"op": "ADD", "target_id": None, "reason": "classifier-invalid-output"}

        return {"op": op, "target_id": target_id, "reason": "classifier-decision"}
    except Exception as e:
        print(
            f"[memory_classifier] classify_memory_op failed "
            f"({type(e).__name__}: {e}) — degrading to ADD",
            file=sys.stderr,
        )
        return {"op": "ADD", "target_id": None, "reason": f"classifier-error: {e}"}

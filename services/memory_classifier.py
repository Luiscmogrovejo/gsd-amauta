#!/usr/bin/env python3
"""
services/memory_classifier.py — Phase 66 MEMR-08: write-time mem0-style
ADD/UPDATE/DELETE/NOOP classifier.

Producers (services/pg_store.py's memory_store()/memory_store_with_embedding())
MUST treat this module as purely advisory: `classify_memory_op` is fail-open
by construction and NEVER raises -- any error of any kind (no model backend,
HTTP timeout, malformed JSON, an unrecognized op string, an out-of-range
target_id, the GSD_MEMORY_CLASSIFIER=off kill switch, or an exception raised
by the caller-supplied `llm_call`) degrades to a plain {"op": "ADD"}
decision. The store path is the ONLY caller and always falls back to
inserting the memory unmodified -- a classifier failure of any kind NEVER
blocks a write.

ORC-05 (Phase 88, plan 88-17): the model call goes through
services/runtime_llm.py -- the host runtime's CLI first, a direct API call
only on an explicit GSD_LLM_BACKEND=api opt-in. This module needs no API key
of its own, and a machine with no model backend is a correctly configured
machine: classification simply does not fire, with ONE diagnostic per
process, and the write proceeds as a plain ADD.

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
    _CLASSIFIER_MODEL_ID = "claude-haiku-5-5"  # last-known-good fallback (model-registry unavailable)
_HTTP_TIMEOUT_SECONDS = 10
_MAX_TOKENS = 200
_VALID_OPS = ("ADD", "UPDATE", "DELETE", "NOOP")

# ORC-05: one diagnostic per process, not one per call. A feature that stops
# working silently is how this defect survived for so long; a feature that
# prints on every memory write is noise nobody reads.
_NO_BACKEND_WARNED = False


def _warn_no_backend_once(detail):
    """Emit ONE stderr diagnostic per process when no model backend is available.

    Args:
        detail: the reason resolve_backend gave, already free of any secret.

    Returns:
        bool: True when this call emitted the diagnostic, False when an earlier
        call already did.
    """
    global _NO_BACKEND_WARNED
    if _NO_BACKEND_WARNED:
        return False
    _NO_BACKEND_WARNED = True
    print(
        f"[memory_classifier] no model backend ({detail}) -- memory classification "
        f"is off and every write degrades to ADD. Install the host runtime CLI "
        f"(`claude`), or set GSD_LLM_BACKEND=api to opt into a direct API call. "
        f"This notice is printed once per process.",
        file=sys.stderr,
    )
    return True


def _default_llm_call(prompt):
    """Ask the host runtime for a classification (ORC-05, plan 88-17).

    The call goes through services/runtime_llm.py, so the backend order is the
    host runtime CLI first and a direct API call only on an explicit
    GSD_LLM_BACKEND=api opt-in. The module's "haiku" alias is passed as the
    model: a DELIBERATE configured choice (classification is a small, cheap,
    high-volume job), not the runtime's default.

    CONTRACT CHANGE, Phase 88 plan 88-17: this function no longer raises when
    no model backend is available. It used to POST straight to the Anthropic
    Messages API and raise a RuntimeError naming the missing API-key variable,
    which meant the classifier had never worked for anybody without a paid
    key of their own -- every write took the
    exception path and degraded to ADD with reason ``classifier-error``. A
    missing backend is an ordinary, expected state under ORC-05, so it is now
    returned as "no opinion" (``None``) and `classify_memory_op` turns that
    into an EXPLICIT ``no-model-backend`` decision. Real failures (an
    unparseable response, a CLI that exits non-zero) still return ``None``
    too, each with their own one-line stderr note from the helper's detail.

    Args:
        prompt: the classification prompt built by `_build_prompt`.

    Returns:
        str | None: the model's raw text, or ``None`` for "no opinion" --
        never an exception for a missing or failing backend.

    Example:
        >>> _default_llm_call("...") is None   # on a machine with no backend
        True
    """
    try:
        _here_dir = os.path.dirname(os.path.abspath(__file__))
        if _here_dir not in sys.path:
            sys.path.insert(0, _here_dir)
        from runtime_llm import call_model
    except Exception as e:  # pragma: no cover - a tree without services/ on sys.path
        _warn_no_backend_once(f"runtime_llm unavailable: {type(e).__name__}")
        return None

    result = call_model(
        prompt,
        model=_CLASSIFIER_MODEL_ID,
        max_tokens=_MAX_TOKENS,
        timeout_s=_HTTP_TIMEOUT_SECONDS,
    )
    if result.ok:
        return result.text
    if result.reason == "no_backend":
        _warn_no_backend_once(result.detail)
    else:
        print(
            f"[memory_classifier] model call failed ({result.reason}: {result.detail}) "
            f"-- degrading to ADD",
            file=sys.stderr,
        )
    return None


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
        llm_call: injectable callable(prompt) -> str | None. Tests inject a
            deterministic decision here; production omits it and falls back
            to `_default_llm_call`, which asks the HOST RUNTIME for a model
            (ORC-05) and needs no API key of its own. Returning ``None``
            means "no opinion" and takes the deterministic path below.

    Returns:
        {"op": "ADD"|"UPDATE"|"DELETE"|"NOOP", "target_id": int|None,
         "reason": str}

    NEVER raises -- every failure mode (kill switch, no candidates, no model
    backend, bad JSON, unknown op string, out-of-range target_id, an
    exception raised by llm_call itself) degrades to {"op": "ADD", ...} with
    a `reason` string describing why.

    The DEGRADED PATH IS EXPLICIT, not accidental: when the model declines to
    answer (``llm_call`` returns None, which is what `_default_llm_call` does
    for a missing or failing backend) the decision is taken on the normal
    path with reason ``no-model-backend``. Before plan 88-17 the same
    situation arrived as a RuntimeError caught by the boundary below, with a
    ``classifier-error: ...`` reason naming the missing API-key variable --
    an error string for what is, under ORC-05, an ordinary state.
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
        if raw is None:
            return {"op": "ADD", "target_id": None, "reason": "no-model-backend"}

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

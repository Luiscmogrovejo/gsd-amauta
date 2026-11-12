"""
Phase 27 MRR Validation: measure hybrid-only and reranked MRR vs golden baseline.

This test runs the 20 golden queries through the Phase 27 pipeline and compares
MRR against the baseline measured in Wave 1 (tests/fixtures/27-golden-queries.json).

Pass/fail behavior:
- If rlm-service returns engine=hybrid_rrf_reranked: use non-regression assertions
  (hybrid_mrr >= bm25_only_mrr * 0.95, reranked_mrr >= hybrid_mrr * 0.90)
  because baseline_mrr=1.0 makes absolute improvement targets mathematically
  impossible (would require MRR > 1.0).
- If rlm-service returns engine=in_memory_bm25 (PG/Jina unavailable): log actual
  MRR, skip assertions.

NOTE on baseline_mrr=1.0: The Wave 1 baseline was constructed by extracting
expected_top3 from the current engine's own output, so rank is always 1 and
MRR=1.0 by construction. Real improvement deltas are only measurable when the
corpus changes. Non-regression assertions (hybrid does not degrade vs BM25-only)
are the correct check here.

Intended to be run as part of phase validation, not CI baseline.

─── Plan 89-01 / RET-02: what changed here, and why ──────────────────────────

This test's assertions had NEVER ONCE run. They are guarded on
`engine == "hybrid_rrf_reranked"`, and until plan 89-01 the retrieval leg always
answered `in_memory_bm25` / `legacy_in_memory_fallback`, so the guard took its
log-only branch every time. Plan 88-16 gave the suite a real PostgreSQL and
plan 89-01 fixed the engine; the assertion then ran for the first time and
exposed two defects in the MEASUREMENT, neither of them in the pipeline:

1. The comparison was engine-specific. `_compute_mrr` matched the legacy
   chunker's label format (`"def score_chunks"`, `"class PGStore (part 1)"`) and
   the fixture's repository-relative paths against the hybrid engine's bare
   `symbol_name` and ABSOLUTE `file_path` — a comparison that cannot match.
   Fixed by normalising the identity on both sides (`_normalize_label`,
   `_paths_match`). Same identity, spelled once; nothing loosened.

2. **The 0.80 floor was unreachable by construction.** The test queries two
   directories, `services/` and `get-shit-done/bin/`, but SEVEN of the twenty
   answer keys name only files under `tests/` — outside the corpus the query
   can see. Measured: 7 unanswerable (Q04, Q06, Q09, Q14, Q16, Q17, Q18), so
   MRR over all twenty has a hard CEILING of 13/20 = 0.65 and can never reach
   0.80 however well the engine ranks. (Q13 adds a second proof of staleness: it
   expects `services/rlm-service.py | class MtimeIndex`, and `MtimeIndex` no
   longer exists anywhere under `services/` — the persistent mtime index was
   retired, as `_handle_query`'s own comment says.)

   So the floor is now asserted on the ANSWERABLE subset — mechanically
   defined, never hand-picked: a query is answerable when at least one of its
   `expected_top3` entries sits under a queried path. Both numbers are
   reported. The subset size is itself asserted, so a future fixture edit
   cannot hollow the denominator out, and three assertions this test never had
   are added: the engine MUST be the hybrid one, every query must answer, and
   no query may error.

The fixture's provenance — an answer key captured from the engine it measures,
with `baseline_mrr` 1.0 by construction and a third of its keys unreachable — is
recorded in 89-01-RECORD.md under "Found and routed" and belongs to a later
plan. Plan 89-01 fixed only what its own behaviour change falsified.
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import pytest

FIXTURE_PATH = "tests/fixtures/27-golden-queries.json"
# Phase 88 plan 88-16-05: no default port. The default was the operator's LIVE RLM;
# a default here meant a test that "skips when the service is unavailable"
# first dialled it to find out. The port now comes only from GSD_RLM_PORT,
# which tests/conftest.py's session fixture RLM sets when CI has a database.
_RLM_PORT = os.environ.get("GSD_RLM_PORT", "").strip()
# Plan 89-01: "0" means the same as unset HERE. To a server, port 0 is "let the
# kernel choose"; to a client it is not an address at all. The pinned test
# environment exports GSD_RLM_PORT=0 precisely so that nothing can dial the
# operator's live RLM on 18798 — and while this test carried a non-strict
# expected-failure marker, dialling 127.0.0.1:0 and failing the /health probe
# below was invisible. With the marker gone (the retrieval leg answers now),
# that would be a red test on any machine using the pinned environment, so the
# guard is corrected rather than the failure re-excused.
if _RLM_PORT in ("", "0"):
    _RLM_PORT = ""
RLM_URL = f"http://127.0.0.1:{_RLM_PORT}" if _RLM_PORT else ""


def _load_golden():
    if not os.path.exists(FIXTURE_PATH):
        pytest.skip(f"Golden fixture not found: {FIXTURE_PATH}")
    with open(FIXTURE_PATH, encoding="utf-8") as f:
        return json.load(f)


#: The directories every golden query searches. The answerable subset below is
#: derived from these, so the two can never drift apart silently.
QUERY_PATHS = ["services/", "get-shit-done/bin/"]

#: MEASURED floor for MRR@10 over the ANSWERABLE subset, with its margin.
#:
#: Measured 0.8077 on the ubuntu-latest cell of this plan's own pull request
#: (run 43316057553, job 131524416908: 10 queries at rank 1, Q08 at rank 2, Q07
#: and Q13 missed, over 13 answerable queries). The floor sits 0.058 below that
#: — about one rank-1-to-rank-2 demotion of tolerance — so it is a regression
#: tripwire rather than a restatement of the measurement.
#:
#: It replaces `baseline_mrr * 0.80` applied to all twenty queries, which was
#: UNREACHABLE: seven answer keys name only files under `tests/`, outside
#: QUERY_PATHS, capping the all-twenty MRR at 0.65. See the module docstring.
ANSWERABLE_MRR_FLOOR = 0.75

#: How many of the twenty must be answerable for the measurement to mean
#: anything. Measured 13; a drop below this is a fixture regression, not a
#: ranking one, and it fails loudly instead of quietly shrinking the
#: denominator.
ANSWERABLE_MINIMUM = 12


def _under_queried_path(filepath: str) -> bool:
    """Whether a fixture answer key lies inside a directory this test searches.

    Args:
        filepath: a repository-relative path from ``expected_top3``.

    Returns:
        bool

    Example:
        >>> _under_queried_path("services/pg_store.py")
        True
        >>> _under_queried_path("tests/test_e2e_lifecycle.py")
        False
    """
    normalised = str(filepath or "").replace("\\", "/").lstrip("./")
    return any(normalised.startswith(p) for p in QUERY_PATHS)


def _query_rlm(query: str, paths: list = None, top_k: int = 10,
               timeout: int = 30) -> dict:
    paths = paths or list(QUERY_PATHS)
    payload = json.dumps({"query": query, "paths": paths, "top_k": top_k}).encode()
    req = urllib.request.Request(
        f"{RLM_URL}/search",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e), "results": []}


#: The legacy in-memory chunker's declaration prefix, e.g. `"def score_chunks"`.
_LABEL_DECL_RE = re.compile(r"^\s*(?:async\s+)?(?:def|class)\s+")

#: The legacy chunker's oversized-chunk suffix, e.g. `"class PGStore (part 1)"`.
_LABEL_PART_RE = re.compile(r"\s*\(part\s+\d+\)\s*$")


def _normalize_label(label: str) -> str:
    """A symbol identity BOTH engines can produce.

    Plan 89-01 / RET-02. The golden fixture was captured from the legacy
    in-memory engine, which labels a chunk ``"def score_chunks"`` or
    ``"class PGStore (part 1)"``. The hybrid engine carries the bare
    ``symbol_name`` (``score_chunks``, ``PGStore``) into ``label`` through
    ``_normalize_hybrid_chunks`` (services/rlm-service.py). Comparing the two
    raw strings can therefore NEVER match once the engine answers from the
    hybrid branch — which is what this plan made it do — so the measurement was
    reporting zero for reasons that had nothing to do with retrieval.

    Stripping the declaration keyword and the ``(part N)`` suffix makes the
    comparison about the SYMBOL rather than about which chunker formatted the
    label. Nothing is loosened: it is the same identity, spelled once.

    Args:
        label: a chunk label or symbol name from either engine.

    Returns:
        str: the bare symbol name, or ``""``.

    Example:
        >>> _normalize_label("class PGStore (part 1)")
        'PGStore'
        >>> _normalize_label("PGStore")
        'PGStore'
    """
    text = str(label or "")
    text = _LABEL_PART_RE.sub("", text)
    text = _LABEL_DECL_RE.sub("", text)
    return text.strip()


def _paths_match(result_path: str, expected_path: str) -> bool:
    """Whether a result path IS the expected repository-relative path.

    The fixture holds repository-relative paths (``services/pg_store.py``); the
    hybrid engine returns absolute ones, because ingestion stores
    ``os.path.abspath``. A tail comparison on a separator boundary is exact —
    ``services/pg_store.py`` matches ``/home/runner/.../services/pg_store.py``
    and does not match ``/other/myservices/pg_store.py``.

    Args:
        result_path: the path a result row carries.
        expected_path: the repository-relative path from the fixture.

    Returns:
        bool

    Example:
        >>> _paths_match("/repo/services/pg_store.py", "services/pg_store.py")
        True
        >>> _paths_match("/repo/xservices/pg_store.py", "services/pg_store.py")
        False
    """
    got = str(result_path or "").replace("\\", "/")
    want = str(expected_path or "").replace("\\", "/").lstrip("./")
    if not got or not want:
        return False
    return got == want or got.endswith("/" + want)


def _compute_mrr(results: list, expected_top3: list) -> tuple:
    """Reciprocal rank of the first expected result, and the rank it sat at.

    Args:
        results: result rows, best first.
        expected_top3: the fixture's expected entries for this query.

    Returns:
        tuple[float, int | None]: ``1/rank`` (zero when absent) and the rank
        (None when absent).
    """
    expected_labels = {
        _normalize_label(e["label"]) for e in expected_top3
    } - {""}
    expected_paths = [e["filepath"] for e in expected_top3]
    for rank, chunk in enumerate(results, 1):
        label = _normalize_label(
            chunk.get("symbol_name") or chunk.get("label") or ""
        )
        path = chunk.get("file_path") or chunk.get("filepath") or ""
        if label and label in expected_labels:
            return 1.0 / rank, rank
        if any(_paths_match(path, want) for want in expected_paths):
            return 1.0 / rank, rank
    return 0.0, None


def test_rlm_mrr_validation():
    """
    Run all 20 golden queries and measure MRR.
    Compares against baseline_mrr from Wave 1 fixture.

    Uses non-regression assertions (not absolute improvement targets) because
    baseline_mrr=1.0 makes the stated >= 15%/10% improvement targets impossible
    to satisfy without MRR > 1.0.
    """
    data = _load_golden()
    baseline_mrr = data["baseline_mrr"]
    queries = data["queries"]

    # The session fixture RLM (tests/conftest.py) starts one when CI has a
    # disposable PostgreSQL; there is no live service to fall back on.
    if not RLM_URL:
        pytest.skip(
            "no RLM service: tests/conftest.py starts one for the session when a "
            "disposable PostgreSQL is configured (GSD_TEST_POSTGRES_URL)"
        )
    try:
        urllib.request.urlopen(f"{RLM_URL}/health", timeout=3)
    except Exception as exc:
        pytest.fail("the fixture RLM at %s did not answer /health: %r" % (RLM_URL, exc))

    # Plan 89-01: one warm-up request before the measurement. /search triggers
    # lazy ingestion, so the FIRST call pays for indexing both query paths while
    # the per-query timeout below is counting — a measurement of ingestion
    # latency, not of ranking. The warm-up is given its own generous budget and
    # its result is discarded.
    warm = _query_rlm(queries[0]["query"], top_k=10, timeout=300)
    print("\nwarm-up: engine=%r results=%d error=%r" % (
        warm.get("engine"), len(warm.get("results", [])), warm.get("error"),
    ))

    mrr_contributions = []
    per_query = []
    engine_used = "unknown"
    engines_seen = set()
    errored = []
    empty = []

    for q in queries:
        resp = _query_rlm(q["query"], top_k=10)
        if resp.get("error"):
            mrr_contributions.append(0.0)
            per_query.append((q["id"], None, 0.0, resp["error"], []))
            errored.append((q["id"], resp["error"]))
            continue
        engine_used = resp.get("engine", "unknown")
        engines_seen.add(engine_used)
        results = resp.get("results", [])
        if not results:
            empty.append(q["id"])
        contrib, rank = _compute_mrr(results, q["expected_top3"])
        mrr_contributions.append(contrib)
        per_query.append((
            q["id"], rank, contrib, None,
            [
                (
                    _normalize_label(r.get("symbol_name") or r.get("label") or ""),
                    (r.get("file_path") or r.get("filepath") or "").replace("\\", "/").split("/")[-1],
                )
                for r in results[:3]
            ],
        ))
        time.sleep(0.05)  # Brief pause to avoid hammering service

    print("\nper-query (id, rank, rr, error, top-3 as (symbol, basename)):")
    for row in per_query:
        print("  %-4s rank=%-5s rr=%.4f err=%r %r" % (
            row[0], row[1] if row[1] else "MISS", row[2], row[3], row[4],
        ))
    print("engines seen: %r" % (sorted(engines_seen),))

    actual_mrr = sum(mrr_contributions) / max(1, len(mrr_contributions))
    mrr_delta = (actual_mrr - baseline_mrr) / max(0.001, baseline_mrr)

    # Plan 89-01: the answerable subset, derived from the fixture and the queried
    # paths — never a hand-picked list. A query whose every expected answer lives
    # outside the directories this test searches cannot be answered by ANY
    # engine, so including it in the denominator measures the fixture, not the
    # retrieval.
    answerable_ids = {
        q["id"] for q in queries
        if any(
            _under_queried_path(e["filepath"]) for e in q["expected_top3"]
        )
    }
    unanswerable_ids = [q["id"] for q in queries if q["id"] not in answerable_ids]
    answerable_rows = [r for r in per_query if r[0] in answerable_ids]
    answerable_mrr = (
        sum(r[2] for r in answerable_rows) / max(1, len(answerable_rows))
    )
    ceiling = len(answerable_ids) / max(1, len(queries))

    print(f"\nMRR Results:")
    print(f"  Engine: {engine_used}")
    print(f"  Baseline MRR: {baseline_mrr:.4f}")
    print(f"  Actual MRR (all {len(queries)}):   {actual_mrr:.4f}")
    print(f"  Delta:        {mrr_delta:+.1%}")
    print(f"  Queries run:  {len(mrr_contributions)}")
    print(f"  Queried paths: {QUERY_PATHS!r}")
    print(f"  Unanswerable (expected answers all outside those paths): "
          f"{len(unanswerable_ids)} {unanswerable_ids!r}")
    print(f"  CEILING on the all-{len(queries)} MRR: {ceiling:.4f} — an "
          f"unanswerable query contributes zero to EVERY engine")
    print(f"  MRR over the {len(answerable_rows)} answerable: {answerable_mrr:.4f}")
    print(f"\nNOTE: baseline_mrr=1.0 because Wave 1 expected_top3 was derived from the")
    print(f"engine's own output (rank always=1). Absolute improvement targets")
    print(f"(>=15%/>=10%) require MRR > 1.0 which is mathematically impossible.")
    print(f"Non-regression assertions are used instead.")

    # ── Assertions ────────────────────────────────────────────────────────────
    # Plan 89-01 added the first three. The old test asserted ONE thing, and
    # only on a branch it never reached.

    assert not errored, (
        "every golden query must be answered; these errored: %r" % (errored,)
    )
    assert not empty, (
        "every golden query must return results against an ingested corpus; "
        "these came back empty: %r" % (empty,)
    )
    # The engine itself. This is what plan 89-01 fixed, and until it did, the
    # whole assertion block below was dead code on every cell.
    assert engine_used == "hybrid_rrf_reranked", (
        "the hybrid engine must answer; got %r (engines seen: %r). A "
        "legacy_in_memory_fallback here means the retrieval leg regressed."
        % (engine_used, sorted(engines_seen))
    )
    # The denominator correction cannot hollow the measurement out.
    assert len(answerable_rows) >= ANSWERABLE_MINIMUM, (
        "only %d of %d golden queries are answerable from %r, below the "
        "recorded minimum of %d. Either the fixture's answer key drifted "
        "further out of the queried corpus, or the queried paths changed."
        % (len(answerable_rows), len(queries), QUERY_PATHS, ANSWERABLE_MINIMUM)
    )

    print(f"\n  ASSERTION: hybrid+reranked MRR over the answerable subset "
          f"{answerable_mrr:.4f} >= measured floor {ANSWERABLE_MRR_FLOOR:.4f}")
    assert answerable_mrr >= ANSWERABLE_MRR_FLOOR, (
        f"Reranked MRR over the {len(answerable_rows)} answerable queries "
        f"{answerable_mrr:.4f} fell below the measured floor "
        f"{ANSWERABLE_MRR_FLOOR:.4f}. The per-query table above names the "
        f"query and the rank it got. Pipeline may be producing wrong results."
    )
    print(f"  PASS: MRR over the answerable subset holds its measured floor")

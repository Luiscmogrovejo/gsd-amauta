---
phase: 22
plan: 22-02
title: "Daemon Wiring + BM25 Retrieval Benchmark + Fact Density Measurement + Regression"
status: complete
completed: "2026-04-13"
---

# Plan 22-02 Summary

## What Was Done

### Task 22-02-01: CAVE-01 daemon wiring (already complete from 22-01)
- Confirmed: `generate_caveman_description` is wired into daemon's POST /api/context/validate endpoint
- Commit `2c6cbcc` from Plan 22-01 implemented the lazy-import pattern with ImportError fallback
- Verification: `grep -c 'description_fn=None' services/amauta-daemon.py` = 0; all acceptance criteria pass
- `cave_description_fn = generate_caveman_description` on line 2222 of services/amauta-daemon.py

### Task 22-02-02: CAVE-03 BM25 benchmark
- Created `tests/22-caveman-bm25.test.cjs` — 451 LOC inline BM25 implementation
- 20 ground-truth queries covering all major project domains
- 20-file corpus with both original (first 500 chars) and compressed (caveman) descriptions
- 5 tests pass: ground truth count, files exist, tokenizer non-empty, MRR threshold, rank-drop guard
- Result: compressed MRR >= 0.95 * original MRR; no query drops > 2 rank positions

### Task 22-02-03: CAVE-04 fact density fixture
- Created `tests/fixtures/` directory
- Created `tests/fixtures/cave-04-fact-annotations.json` — 10 annotated entries
- All 10 entries satisfy `compressed_fact_count >= original_fact_count * 1.4`
- Ratios range from 1.40 (agents/gsd-executor-backend.md) to 2.10 (services/amauta-daemon.py)
- Facts manually enumerated as (subject, predicate, object) triples

### Task 22-02-04: CAVE-01 wiring integration tests
- Created `tests/test_caveman_integration.py` — 8 tests in 2 classes
- `TestFactDensity` (5 tests): fixture structure, 1.4x constraint, list-length match, real files exist
- `TestCavemanDescriptionWiring` (3 tests): description_fn signature, selective_refresh pipe regex, validate_context end-to-end chain

### Task 22-02-05: Full regression
- All AST checks pass (4 Python files)
- 74 Python tests: 69 pass, 5 fail (pre-existing CAVE-02 divergence — NOT a regression)
- 5 BM25 tests: all pass
- CJS test suite: 2173 tests, 2160 pass, 11 fail (same 11 pre-existing failures as Phase 21 baseline)
- 10/10 files match pipe regex (CAVE-01 verified)
- CAVE-02 divergence confirmed pre-existing (documented in Plan 22-01, STATE.md)

## Divergences

None new. Pre-existing CAVE-02 divergence (5 failing tests in test_grammar_strip.py) is documented and unchanged.

## Files Created/Modified

| Action | File | Task |
|--------|------|------|
| already committed | services/amauta-daemon.py | 22-02-01 (done in 22-01) |
| create | tests/22-caveman-bm25.test.cjs | 22-02-02 |
| create | tests/fixtures/cave-04-fact-annotations.json | 22-02-03 |
| create | tests/test_caveman_integration.py | 22-02-03 + 22-02-04 |

## Verification Criteria Status

| Criterion | Result |
|-----------|--------|
| `grep 'generate_caveman_description' services/amauta-daemon.py` | PASS |
| `grep 'description_fn=None' services/amauta-daemon.py` returns 0 | PASS |
| `node --test tests/22-caveman-bm25.test.cjs` exits 0 | PASS (5/5) |
| `test -f tests/fixtures/cave-04-fact-annotations.json` | PASS |
| `python3 -m pytest tests/test_caveman_integration.py` exits 0 | PASS (8/8) |
| `node --test tests/` — no new failures | PASS (2173 tests, same 11 pre-existing) |
| Python tests: 0 new failures | PASS (69 pass, 5 pre-existing CAVE-02) |

## Phase 22 Status

Plan 22-01 and Plan 22-02 complete.
- CAVE-01 (pipe-delimited descriptions): VERIFIED
- CAVE-02 (grammar stripping): DIVERGENCE DOCUMENTED (1.5% actual vs 30% target; unresolvable with word-list removal on dense technical markdown)
- CAVE-03 (BM25 retrieval MRR): VERIFIED
- CAVE-04 (fact density 1.4x): VERIFIED

Phase 22 is functionally complete with CAVE-02 open divergence. Phase 23 is unblocked (depends on Phase 22's description compression being live, which CAVE-01 provides).

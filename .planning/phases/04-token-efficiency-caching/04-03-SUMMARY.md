---
plan: 04-03
title: "Query Embedding Cache (1-Hour TTL)"
status: complete
completed_at: "2026-04-06"
tasks_completed: 2
tests_passed: 12
tests_total: 12
commits:
  - 37a8c19
  - 0df5468
---

# Plan 04-03 Summary: Query Embedding Cache (1-Hour TTL)

## Objective

Added an in-memory query embedding cache to `PGStore.generate_embedding()` in
`services/pg_store.py`. Repeated calls with the same query text within 1 hour
return cached results without Voyage API calls.

## What Was Built

### T1 — Cache implementation in pg_store.py (commit 37a8c19)

**Imports added:** `hashlib` and `time` (stdlib, no new deps)

**Module-level cache state** (before `class PGStore:`):
- `_QUERY_EMBED_CACHE: dict = {}` — keyed by `sha256(text:input_type:model)[:16]`
- `_QUERY_EMBED_TTL = 3600` — 1-hour TTL in seconds
- `_QUERY_EMBED_MAX = 500` — eviction threshold
- `_clear_query_embed_cache()` — exposed for test isolation

**Cache logic in `generate_embedding()`:**
- Cache READ: after truncation, before payload build; only for `input_type == "query"`
- Cache WRITE: after successful API call; stores `(embedding, timestamp)` tuple
- Eviction: when `len > 500`, sorts by timestamp and deletes oldest 100 entries in batch
- Document embeddings (`input_type="document"`) bypass cache entirely — write-path, called once

### T2 — Test suite (commit 0df5468)

Created `tests/04-03-embed-cache.test.cjs` with 12 file-content analysis tests:

| Suite | Tests | Result |
|-------|-------|--------|
| ECACHE-01: Cache infrastructure | 4 | PASS |
| ECACHE-02: Cache key correctness | 4 | PASS |
| ECACHE-03: Query-only caching guard | 2 | PASS |
| ECACHE-04: Eviction policy | 2 | PASS |
| **Total** | **12** | **12/12** |

## Files Changed

- `services/pg_store.py` — +39 lines (hashlib/time imports, cache vars, cache logic)
- `tests/04-03-embed-cache.test.cjs` — +139 lines (12 tests, 4 suites)

## Design Decisions

- **Module-level dict** (not instance state) is correct since `generate_embedding()` is a
  `@staticmethod` with no instance access. Shared across all PGStore instances in the process.
- **Cache scope:** Process-local. Long-lived daemon benefits most; CLI subprocess calls get
  per-invocation cache only (acceptable for Phase 4; Redis in Phase 5 fixes cross-invocation).
- **Query-only guard:** Document embeddings are write-path (called once per memory store).
  Caching them would waste memory with no retrieval benefit.
- **Key format:** `sha256(text:input_type:model)[:16]` — 16 hex chars = 64-bit collision
  resistance, negligible memory overhead per entry.
- **LRU-style eviction:** Sorted by `cached[1]` (timestamp) and batch-delete oldest 100 when
  over 500. Simple and O(n log n) per eviction — acceptable at 500 max entries.

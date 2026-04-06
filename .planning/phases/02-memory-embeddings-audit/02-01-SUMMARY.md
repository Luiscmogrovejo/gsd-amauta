---
plan: 02-01
title: "Critical Bugs & Scoring Fixes"
status: complete
completed_at: "2026-04-06"
commits:
  - 79eafe4 fix(MEM-01): distill-status excludes source='distilled' from total count
  - 185419f test(MEM-01): add distill-status exclusion tests + sqlite_store parity
  - c6fbfea test(MEM-09): guard tests verify autolearning source= explicit in all paths
  - f3ac00c docs(MEM-05/MEM-06): audit comment block for dedup thresholds and scoring formula
---

# Plan 02-01 Summary: Critical Bugs & Scoring Fixes

## Outcome

All 4 tasks complete. 4 atomic commits on master. 37 tests pass (10 new, 27 pre-existing unaffected).

## Tasks

### T1: Fix distill-status endpoint (MEM-01) -- FIXED

**Bug:** `distill-status` was counting ALL entries including `source='distilled'`, causing threshold to fire late.

**Fix:**
- `services/pg_store.py`: `memory_count()` now accepts `exclude_source` (string or list, defaults to None -- backward compatible).
- `services/amauta-daemon.py`: distill-status route now calls `store.memory_count(exclude_source="distilled")`.
- `services/sqlite_store.py`: parity change -- `memory_count()` also accepts `exclude_source`.

### T2: Tests for distill-status exclusion -- ADDED

**File:** `tests/test_memory_distill_status.py` (6 tests, all pass)

| Test | Assertion |
|------|-----------|
| `test_memory_count_excludes_distilled_source` | 3 entries (1 distilled + 2 auto_learning) → count=2 |
| `test_memory_count_no_exclude_returns_all` | 3 entries, no exclude → count=3 |
| `test_memory_count_excludes_multiple_sources` | 4 entries, exclude=[distilled, task_event] → count=2 |
| `test_memory_count_single_source_as_string` | string arg normalized to list internally |
| `test_default_dedup_threshold_is_095` | GSD_DEDUP_THRESHOLD defaults to 0.95 |
| `test_dedup_threshold_env_override` | env var override works |

### T3: Verify and guard-test autolearning source assignment (MEM-09) -- VERIFIED + GUARDED

**Audit result:** Source assignment was ALREADY CORRECT in v2.4. All 6 `_mem_log_event` calls with `event:learning` tags have explicit `source=` parameters:
- Line 3050: `source="auto_learning"` (validation-pass / _auto_write_learning)
- Line 3580: `source="session-learning"` (D-phase rpetd LEARNING: extraction)
- Line 2157: `source="session-learning"` (delivery event write)
- Line 2191: `source="web_search_result"` (ws extraction on delivery)
- Line 3070: `source="web_search_result"` (ws auto-extract in _auto_write_learning)
- Line 4088: `source="web_search_result"` (ws extraction on validation)

**No code changes needed.** Guard tests added.

**File:** `tests/test_memory_autolearn_source.py` (4 tests, all pass)

| Test | Assertion |
|------|-----------|
| `test_validation_pass_learning_uses_auto_learning_source` | _auto_write_learning → source='auto_learning' present |
| `test_validation_pass_learning_never_defaults_task_event` | No learning call uses default source='task_event' |
| `test_dphase_learning_uses_session_learning_source` | D-phase path → source='session-learning' |
| `test_web_search_extraction_uses_web_search_result_source` | ws extraction → source='web_search_result' |

### T4: Verify and document MEM-05/MEM-06 (audit comment) -- DOCUMENTED

Added audit comment block to `services/pg_store.py` at the constants section:

**MEM-05 (dedup thresholds):**
- Pre-store cosine dedup: `GSD_DEDUP_THRESHOLD` = 0.95 (confirmed correct, industry standard)
- Distillation grouping: Jaccard 0.7 (`gsd-memory.cjs`, `threshold || '0.7'`)
- Cosine 0.85 for distillation deferred to MEM-02

**MEM-06 (scoring formula):**
- pg_store.py daemon path: `ts_rank * 10 + source_bonus - recency_penalty`
- amauta.py direct path: `LIKE_count + source_bonus - recency_penalty`
- source_bonus values: identical across both paths
- recency_penalty formula: identical across both paths
- Dual scoring is intentional (full PG text search vs lightweight fallback)
- No gap in recency decay application confirmed

## Test Results

```
37 passed in 0.28s
- test_memory_distill_status.py:   6/6  PASSED (new)
- test_memory_autolearn_source.py: 4/4  PASSED (new)
- test_memory_optimization.py:    11/11 PASSED (no regression)
- test_memory_retention.py:       16/16 PASSED (no regression)
```

## Verification Checklist

- [x] `grep -n "exclude_source" services/amauta-daemon.py` shows distill-status passes `exclude_source="distilled"`
- [x] `grep -n "exclude_source" services/pg_store.py` shows memory_count accepts the parameter
- [x] `python3 -m pytest tests/test_memory_distill_status.py -v` -- 6 tests pass
- [x] `grep -A5 "event:learning" amauta.py` -- every call has explicit `source=`
- [x] `python3 -m pytest tests/test_memory_autolearn_source.py -v` -- 4 tests pass
- [x] `grep -A8 "MEM-05" services/pg_store.py` -- shows audit comment block
- [x] `grep -A5 "MEM-06" services/pg_store.py` -- shows scoring formula docs
- [x] `grep "GSD_DEDUP_THRESHOLD" services/pg_store.py` -- shows 0.95 default

## Files Modified

| File | Change |
|------|--------|
| `services/pg_store.py` | `memory_count(exclude_source=)` param + MEM-05/MEM-06 audit comment |
| `services/sqlite_store.py` | `memory_count(exclude_source=)` parity |
| `services/amauta-daemon.py` | distill-status calls `memory_count(exclude_source="distilled")` |
| `tests/test_memory_distill_status.py` | New: 6 tests for distill-status exclusion + dedup threshold |
| `tests/test_memory_autolearn_source.py` | New: 4 guard tests for source= assignment |

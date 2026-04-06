---
plan: 04-01
title: "Citation Stripping + Enrichment Dedup Window Audit"
phase: 04-token-efficiency-caching
status: complete
completed_at: "2026-04-06"
commits:
  - e1a0e7d  # T1: gsd-research.cjs citation stripping
  - 7b07d9d  # T2: amauta.py TOK-03 audit comment
  - 37b118d  # T3: tests/04-01-citation-dedup.test.cjs
---

# Plan 04-01 Summary: Citation Stripping + Enrichment Dedup Window Audit

## Outcome

All 3 tasks complete, 3 atomic commits, 10/10 tests passing.

## Tasks Completed

### T1 -- Strip citation markers from Perplexity responses (e1a0e7d)

File: `get-shit-done/bin/gsd-research.cjs`

Added `cleanAnswer` after the raw `answer` extraction in `providerPerplexity()`:

```javascript
// TOK-05: Strip citation markers -- actual URLs are in res.data.citations metadata
const cleanAnswer = answer.replace(/\[\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
```

Replaced 3 usage sites:
- Null check: `if (!answer)` -> `if (!cleanAnswer)`
- Memory store: `answer.slice(0, 2000)` -> `cleanAnswer.slice(0, 2000)`
- Return path: `stripPreamble(answer)` -> `stripPreamble(cleanAnswer)`

`res.data.citations` metadata is unchanged -- citation URLs are preserved.

### T2 -- Audit enrichment dedup window (7b07d9d)

File: `amauta.py`

Added 13-line `TOK-03 AUDIT` comment block above `ENRICHMENT_DEDUP_WINDOW = 300`
documenting three edge cases:
1. >5min claim-to-R-phase expiry fires enrichment again (intended heuristic)
2. Dedup applies only to R-phase -- P/E/T/D unaffected (correct by design)
3. `reversed()` assumption on notes list is safe (false cache miss, not a correctness bug)

No code changes -- constants unchanged.

### T3 -- Tests (37b118d)

File: `tests/04-01-citation-dedup.test.cjs`

10 tests across 4 describe blocks:
- `CIT-01`: Citation regex existence and correctness (3 tests)
- `CIT-02`: `cleanAnswer` used at all 3 sites, raw `answer` absent from `stripPreamble` (3 tests)
- `CIT-03`: `res.data.citations` captured and passed to metadata (2 tests)
- `DUP-01`: `ENRICHMENT_DEDUP_WINDOW = 300` and `TOK-03 AUDIT` present (2 tests)

Result: `10 pass, 0 fail, 0 skip`

## Verification

```
grep -n 'cleanAnswer' get-shit-done/bin/gsd-research.cjs
# 320: const cleanAnswer = answer.replace(...)
# 322: if (!cleanAnswer) return null;
# 327: const cappedAnswer = cleanAnswer.slice(0, 2000);
# 350: text: stripPreamble(cleanAnswer).slice(...)

grep 'stripPreamble(answer)' get-shit-done/bin/gsd-research.cjs | wc -l  # 0
grep 'TOK-03 AUDIT' amauta.py  # present
node --test tests/04-01-citation-dedup.test.cjs  # 10/10
```

## Key Learning

Perplexity citation markers (`[1]`, `[12]`) in answer text waste tokens in
stored memory entries. Strip at source (immediately after API response, before
both the memory store path and the return path). The `cleanAnswer` pattern
generalizes to any provider embedding reference markers inline.

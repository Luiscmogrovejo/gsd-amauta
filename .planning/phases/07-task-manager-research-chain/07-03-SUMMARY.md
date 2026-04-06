---
phase: 07-task-manager-research-chain
plan: 07-03
subsystem: infra
tags: [perplexity, rate-limit, dedup, jaccard, preamble, backoff, research-chain]

# Dependency graph
requires:
  - phase: 07-task-manager-research-chain
    provides: gsd-research.cjs providerPerplexity, stripPreamble, textSimilarity/isDuplicateMemory baseline from 07-01/07-02
provides:
  - Exponential backoff retry on Perplexity HTTP 429 (1s/2s/4s, 3 retries)
  - 3 additional preamble stripping patterns (13 total)
  - TECH_SHORT_WORDS whitelist preserving 2-char tech abbreviations in Jaccard dedup
  - [DEDUP] similarity logging for threshold tuning
affects: [any future plan touching gsd-research.cjs, perplexity integration, dedup thresholds]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Exponential backoff wrapper (perplexityWithRetry) separates retry logic from provider function
    - TECH_SHORT_WORDS Set pattern for domain-specific term preservation in word-overlap similarity
    - Dedup similarity logging for post-hoc threshold calibration

key-files:
  created:
    - tests/07-03-perplexity-hardening.test.cjs
  modified:
    - get-shit-done/bin/gsd-research.cjs

key-decisions:
  - "Plan referenced httpRequest but actual function is httpsRequest(hostname, urlPath, body, headers) -- adapted perplexityWithRetry to use httpsRequest signature"
  - "perplexityWithRetry inserted before HTTP Helpers section (after selectPerplexityModel) to keep provider logic clean"
  - "Old 429 DATA FLOW ERROR handler retained -- perplexityWithRetry exhausts retries then falls through to it, providing consistent error path"
  - "TECH_SHORT_WORDS uses 'k8' not 'k8s' since after lowercase+strip the word becomes 'k8s' (3 chars, already kept by > 2 filter)"

patterns-established:
  - "Retry wrapper pattern: extract async retry wrapper function before provider, route provider call through it -- keeps provider logic clean"
  - "TECH_SHORT_WORDS Set: whitelist 2-char domain abbreviations dropped by generic length filter"
  - "Similarity logging gate at 0.3: noise floor below which no log emitted, useful signal above"

requirements-completed:
  - RSC-03
  - RSC-04
  - RSC-05

# Metrics
duration: 15min
completed: 2026-04-06
---

# Plan 07-03: Perplexity Hardening Summary

**Exponential backoff on Perplexity 429 (1s/2s/4s), 3 new preamble patterns (13 total), TECH_SHORT_WORDS 2-char tech abbreviation whitelist, and [DEDUP] similarity logging -- 18/18 guard tests pass**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-06T~17:00Z
- **Completed:** 2026-04-06T~17:15Z
- **Tasks:** 4 (T1 preamble, T2 rate retry, T3 dedup, T4 tests) -- committed atomically as one change set
- **Files modified:** 2

## Accomplishments
- Added `perplexityWithRetry()` wrapper with 3-retry exponential backoff (1s, 2s, 4s) on HTTP 429; `providerPerplexity` now routes through it instead of calling `httpsRequest` directly
- Extended `stripPreamble()` with 3 new patterns: "Of course", "I'd be happy to [help|explain|...]", "As an AI assistant/model" -- bringing total to 13 patterns
- Added `TECH_SHORT_WORDS` Set preserving 'ai', 'db', 'js', 'go', 'ui', 'ux', 'ci', 'cd', 'ml', 'pg', 'k8', 'io' in both `wordsA` and `wordsB` Jaccard filters
- Added `[DEDUP]` similarity logging in `isDuplicateMemory()` when similarity >= 0.3, showing score, threshold, and dup boolean

## Task Commits

All 4 tasks committed atomically in one atomic commit:

1. **Tasks T1+T2+T3+T4: Perplexity hardening + guard tests** - `b48eace` (feat)

## Files Created/Modified
- `get-shit-done/bin/gsd-research.cjs` - Added perplexityWithRetry, 3 preamble patterns, TECH_SHORT_WORDS, dedup logging
- `tests/07-03-perplexity-hardening.test.cjs` - 18 guard tests (PREAMBLE-01 x6, RATE-01 x6, DEDUP-01 x6)

## Decisions Made
- Plan's code sample referenced `httpRequest` but the actual function is `httpsRequest(hostname, urlPath, body, headers)` -- adapted `perplexityWithRetry` to use the correct `httpsRequest` signature with fixed hostname `'api.perplexity.ai'` and path `'/chat/completions'`
- Retained the existing 429 `[DATA FLOW ERROR]` stderr message in `providerPerplexity` -- after retry exhaustion the response flows through the same `if (res.status !== 200)` block, giving consistent error logging
- TECH_SHORT_WORDS uses `'k8'` not `'k8s'` because `k8s` is already 3 chars (passes `> 2` filter); only truly 2-char abbreviations need whitelisting

## Deviations from Plan

None - plan executed as specified with one minor adaptation (httpRequest -> httpsRequest correct signature).

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 07 is the final phase. Plan 07-03 is the last plan in the phase.
- All 3 RSC requirements fulfilled. gsd-research.cjs Perplexity hardening complete.
- STATE.md to be updated to reflect phase 07 fully complete.

---
*Phase: 07-task-manager-research-chain*
*Completed: 2026-04-06*

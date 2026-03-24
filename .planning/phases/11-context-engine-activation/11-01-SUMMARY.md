---
phase: 11-context-engine-activation
plan: "01"
subsystem: api
tags: [bm25, tokenizer, http-transport, rlm, scoring, urllib]

# Dependency graph
requires: []
provides:
  - BM25 scoring with k1=1.5, b=0.75 in rlm-service.py
  - camelCase/snake_case identifier splitting in tokenizer
  - HTTP-based _rlm_query() using urllib.request (no subprocess)
  - 23 new tests covering scoring, tokenizer, and HTTP transport
affects: [11-02-layer1-integration, 12-semantic-memory, 14-pipeline-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [BM25 scoring with label boost and position penalty, urllib.request POST pattern for service-to-service calls]

key-files:
  created:
    - tests/test_rlm_scoring.py
    - tests/test_rlm_http.py
  modified:
    - services/rlm-service.py
    - amauta.py

key-decisions:
  - "BM25 k1=1.5 and b=0.75 are standard defaults -- tunable without API changes"
  - "HTTP timeout reduced from 30s (subprocess) to 15s (no startup overhead)"
  - "Output cap kept at 1200 chars for context budget control"
  - "_rlm_find_node() and _rlm_find_cli() preserved -- still used by gsd-research.cjs"

patterns-established:
  - "BM25 scoring: IDF=log((N-df+0.5)/(df+0.5)+1), TF=(tf*(k1+1))/(tf+k1*(1-b+b*dl/avgdl))"
  - "Identifier splitting: re.sub camelCase + underscore replace before regex tokenization"
  - "HTTP transport: urllib.request.Request with POST, JSON body, 15s timeout, best-effort catch-all"

requirements-completed: [RLM-03, RLM-04, RLM-05]

# Metrics
duration: 12min
completed: 2026-03-24
---

# Plan 11-01: RLM Transport + Scoring Foundation Summary

**BM25 scoring with document length normalization, camelCase/snake_case tokenizer splitting, and direct HTTP transport replacing subprocess for _rlm_query()**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-24
- **Completed:** 2026-03-24
- **Tasks:** 5
- **Files modified:** 4

## Accomplishments
- Replaced TF-IDF with BM25 scoring (k1=1.5, b=0.75) -- short focused chunks now rank higher than long unfocused ones
- Added camelCase/snake_case identifier splitting to tokenizer -- `getUserProfile` correctly tokenizes to {get, user, profile}
- Replaced subprocess-based _rlm_query() with direct HTTP POST via urllib.request -- eliminates ~150-300ms Node.js cold start per call
- Added 23 new tests (15 scoring + 8 HTTP transport) with 100% pass rate

## Task Commits

Each task was committed atomically:

1. **Task 1: camelCase/snake_case splitting** - `080061e` (feat)
2. **Task 2: BM25 scoring replacement** - `9568168` (feat)
3. **Task 3: HTTP transport in _rlm_query()** - `664f05a` (feat)
4. **Task 4: BM25 scoring tests** - `124f6d5` (test)
5. **Task 5: HTTP transport tests** - `86f6c4d` (test)

## Files Created/Modified
- `services/rlm-service.py` - BM25 scoring (_compute_score, score_chunks), _split_identifiers, updated _tokenize
- `amauta.py` - _rlm_query() rewritten from subprocess to urllib.request HTTP POST
- `tests/test_rlm_scoring.py` - 15 tests: identifier splitting, tokenization, BM25 length norm/label boost/position/saturation
- `tests/test_rlm_http.py` - 8 tests: endpoint selection, CWD fallback, service-down handling, output cap, port config

## Decisions Made
- BM25 k1=1.5 and b=0.75 are textbook defaults -- can be tuned later without API changes
- HTTP timeout set to 15s (down from 30s subprocess timeout) since no Node.js startup overhead
- _rlm_find_node() and _rlm_find_cli() kept intact -- still used by gsd-research.cjs externally
- Output capped at 1200 chars to control context budget (same as before)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- BM25 scoring and HTTP transport are ready for Wave 2 (plan 11-02)
- 11-02 will remove the `if doc_path:` gate in _rpetd_phase_enrich() and wire Layer 1 RLM queries
- Full RPETD cycle latency budget (<=1.5s from RLM) now achievable with HTTP transport

---
*Phase: 11-context-engine-activation*
*Completed: 2026-03-24*

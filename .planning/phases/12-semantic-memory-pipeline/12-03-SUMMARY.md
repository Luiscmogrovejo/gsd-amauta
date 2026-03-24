---
phase: 12-semantic-memory-pipeline
plan: 03
subsystem: memory
tags: [research-chain, gsd-research, perplexity, subprocess, r-phase, auto-invoke]

# Dependency graph
requires:
  - phase: 12-semantic-memory-pipeline
    plan: 01
    provides: _mem_semantic_search() helper for semantic memory queries in R-phase
provides:
  - _research_chain_query() helper for web-augmented context via gsd-research.cjs
  - R-phase auto-invocation of research chain when <2 local memory results
  - 14 tests covering helper function and R-phase integration
affects: [14-pipeline-integration]

# Tech tracking
tech-stack:
  added: []
  patterns: [subprocess-with-timeout-best-effort, nested-provider-json-flattening]

key-files:
  created:
    - tests/test_research_chain.py
  modified:
    - amauta.py

key-decisions:
  - "Nested provider JSON flattening: gsd-research.cjs returns { results: [{ provider, results: [...] }] }, flattened to flat list with source attribution"
  - "45-second subprocess timeout covers Perplexity worst-case (30s API + parsing)"
  - "NODE_NO_WARNINGS=1 suppresses ExperimentalWarning noise from Node.js subprocess"
  - "Result text capped at 500 chars in helper, 300 chars in supplement -- concise context, not data dump"
  - "locals().get('relevant', []) safely handles case where _search_q was empty and relevant was never defined"

patterns-established:
  - "Research chain escalation: local memory -> research chain only when local results insufficient (<2)"
  - "Best-effort subprocess: shutil.which() for Node.js discovery, os.path.isfile() for script check, never raises"
  - "Provider-attributed supplement: [RESEARCH] label with per-result [source] tags for provenance"

requirements-completed: [SEM-05]

# Metrics
duration: 8min
completed: 2026-03-24
---

# Phase 12 Plan 03: Research Chain Auto-Invocation in R-Phase Summary

**R-phase auto-invokes gsd-research.cjs (Memory->SKB->Context7->Perplexity->WebFetch) when semantic memory returns <2 results, with 45s timeout and nested provider JSON flattening**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-24
- **Completed:** 2026-03-24
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- `_research_chain_query()` helper shells out to gsd-research.cjs with JSON output, 45s timeout, and portable Node.js discovery via shutil.which()
- R-phase enrichment auto-invokes research chain when semantic search returns <2 relevant results (unfamiliar domain escalation)
- Nested provider JSON format flattened correctly: `{ results: [{ provider, results: [{text,...}] }] }` -> flat list with source attribution
- 14 new tests covering helper function (9 unit) and R-phase integration (5 integration), 235 total tests passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Add _research_chain_query() helper** - `1c933a3` (feat)
2. **Task 2: Wire research chain into R-phase** - `c0421ca` (feat)
3. **Task 3: Add tests** - `0eb6d74` (test)

## Files Created/Modified
- `amauta.py` - Added _research_chain_query() helper (line 585), wired into R-phase block after memory search (line 1829)
- `tests/test_research_chain.py` - 14 tests: subprocess args, timeout, missing node, missing script, nonzero exit, result capping, nested JSON, short text filter, 500-char truncation, R-phase invocation, negative tests for >=2 results and E/T phases

## Decisions Made
- **Nested JSON flattening over flat list assumption:** gsd-research.cjs returns provider-grouped results, not a flat array. The helper iterates provider blocks and extracts inner results with source attribution.
- **locals().get() for safe relevant access:** When `_search_q` is empty, the memory search block is skipped and `relevant` is never defined. Using `locals().get('relevant', [])` avoids NameError.
- **500-char cap in helper, 300-char cap in supplement:** Two-stage truncation keeps supplement concise while preserving enough context in the raw results for potential future callers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed nested JSON parsing for gsd-research.cjs output**
- **Found during:** Task 1 (helper implementation)
- **Issue:** Plan assumed flat array response format, but gsd-research.cjs returns `{ query, results: [{ provider, count, results: [...] }] }` -- a nested provider structure
- **Fix:** Added nested iteration: loop over provider blocks, extract inner results with provider name as source
- **Files modified:** amauta.py
- **Verification:** test_handles_nested_provider_format passes
- **Committed in:** 1c933a3 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix for actual output format)
**Impact on plan:** Critical fix -- without nested JSON handling, zero results would be extracted from real gsd-research.cjs output. No scope creep.

## Issues Encountered
None

## Next Phase Readiness
- Phase 12 (Semantic Memory Pipeline) is now COMPLETE: all 3 plans done, all 7 SEM requirements met
- Ready for Phase 13 (Validation Hardening) or Phase 14 (Pipeline Integration)
- 235 total tests passing with zero regressions

---
*Phase: 12-semantic-memory-pipeline*
*Completed: 2026-03-24*

---
phase: 19-token-efficiency
plan: "01"
subsystem: enrichment
tags: [token-efficiency, dedup, perplexity, rpetd, performance]

requires:
  - phase: 16-data-integrity
    provides: project isolation prevents test noise from inflating context
provides:
  - Layer 2 R-phase enrichment dedup via Layer 1 timestamp check
  - Perplexity output capped at 1500 chars with preamble stripping
  - RPETD soft cap warning at 2000 chars with per-phase guidance
affects: [enrichment-pipeline, research-chain, rpetd-workflow]

tech-stack:
  added: []
  patterns:
    - "Enrichment dedup via timestamp comparison against system-enrichment notes"
    - "Preamble stripping with bounded regex patterns ({0,80} char limit)"
    - "Soft cap warning on stderr (non-blocking, informational)"

key-files:
  created:
    - tests/19-01-token-efficiency.test.cjs
  modified:
    - amauta.py
    - get-shit-done/bin/gsd-research.cjs

key-decisions:
  - "Preamble regex patterns bounded to {0,80} chars to prevent greedy overconsumption"
  - "RPETD cap is soft (warning only, no truncation) to avoid blocking agents"
  - "Enrichment dedup uses _last_enrichment_ts helper scanning notes in reverse for efficiency"
  - "Perplexity preamble strip applied before memory storage cap (strip+slice on return, memory stores raw capped)"

patterns-established:
  - "Bounded regex for text stripping: always use {0,N} quantifiers to prevent greedy match"
  - "Soft cap pattern: warn on stderr, store in full, guide toward optimal size"

requirements-completed: [TOKEN-01, TOKEN-02, TOKEN-03]

duration: 5min
completed: 2026-03-25
---

# Phase 19 Plan 01: Enrichment Dedup + Perplexity Truncation + RPETD Caps Summary

**Layer 2 R-phase dedup via 5-min timestamp window, Perplexity output capped at 1500 chars with 7-pattern preamble stripping, RPETD soft cap with per-phase size guidance**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-25T04:08:26Z
- **Completed:** 2026-03-25T04:14:20Z
- **Tasks:** 4
- **Files modified:** 3

## Accomplishments
- Layer 2 R-phase skips redundant RLM/memory/SKB queries when Layer 1 enrichment ran <5 min ago, saving ~1600-3200 tokens per task
- Perplexity output capped at 1500 chars with preamble stripped (7 patterns: Here is, Based on, I found, Sure, Let me, Certainly, Absolutely)
- RPETD phase writes warn at >2000 chars with per-phase optimal size guidance (R:500, P:300, E:500, T:300, D:400)
- 15 tests covering all 3 requirements with 0 failures

## Task Commits

Each task was committed atomically:

1. **Task 1: Skip Layer 2 R-phase enrichment when Layer 1 ran within 5 min** - `c850a5b` (feat)
2. **Task 2: Cap Perplexity output to 1500 chars with preamble stripping** - `7c9138f` (feat)
3. **Task 3: Add soft 2000-char cap with warning to RPETD phase writes** - `e0aeaf9` (feat)
4. **Task 4: Tests for all 3 requirements** - `6130735` (test)

## Files Created/Modified
- `amauta.py` - ENRICHMENT_DEDUP_WINDOW, _last_enrichment_ts(), dedup check in R-phase, RPETD_SOFT_CAP, RPETD_PHASE_GUIDANCE, soft cap warning
- `get-shit-done/bin/gsd-research.cjs` - PERPLEXITY_OUTPUT_CAP, stripPreamble(), truncation in providerPerplexity return
- `tests/19-01-token-efficiency.test.cjs` - 15 tests across 3 describe blocks

## Decisions Made
- Preamble regex patterns bounded to {0,80} chars to prevent greedy overconsumption of content
- RPETD cap is soft (warning only on stderr, no truncation) to avoid blocking agents
- Perplexity preamble stripping applied only to returned text, not to memory storage (which keeps its own 2000-char cap)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Preamble regex patterns were too greedy**
- **Found during:** Task 4 (Tests)
- **Issue:** `[^.]*` in regex patterns consumed entire string including actual content, because `.` at end of content matched the `[.:]` terminator
- **Fix:** Changed `[^.]*` to `[^.:]{0,80}` (bounded, stops at first colon/period within 80 chars) and added `,` to "Based on" pattern's char class
- **Files modified:** `get-shit-done/bin/gsd-research.cjs`, `tests/19-01-token-efficiency.test.cjs`
- **Verification:** All 15 tests pass with correct preamble stripping
- **Committed in:** `6130735` (Task 4 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Regex fix was essential for correctness. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 19 is the FINAL phase of v2.3 milestone
- All 5 phases complete (15-19), all 18 requirements satisfied
- v2.3 milestone is ready for completion

---
*Phase: 19-token-efficiency*
*Completed: 2026-03-25*

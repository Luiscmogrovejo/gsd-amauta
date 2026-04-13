---
phase: 20-structured-context-handoffs
plan: 20-02
subsystem: api
tags: [python, rpetd, compaction, tiktoken, daemon, endpoints, token-budget]

# Dependency graph
requires:
  - phase: 20-01
    provides: RPETDContext Pydantic model, pg_store rpetd_context_store/get/list methods, migration 009

provides:
  - prune_messages() function (token-bounded tool-output pruning with tiktoken/char-approx fallback)
  - compact_conversation() function (two-step prune + LLM-summarize into RPETDContext, with fallback)
  - COMPACTION_PROMPT template for LLM-backed structured extraction
  - _fallback_extract() for crash-safe best-effort RPETDContext from raw messages
  - POST /api/context/compact daemon endpoint (messages + task_id + phase → compiled_view)
  - GET /api/context/:task_id/:phase daemon endpoint (returns stored context or 404)
  - tests/test_rpetd_compaction.py (10 tests: prune, compact, token budget)

affects: [phase-21, phase-23, phase-24]

# Tech tracking
tech-stack:
  added: [tiktoken (optional, falls back to 4-char approx)]
  patterns: [dependency-injection for llm_call, lazy import inside daemon handler, best-effort fallback path]

key-files:
  created:
    - tests/test_rpetd_compaction.py
  modified:
    - services/rpetd_context.py
    - services/amauta-daemon.py

key-decisions:
  - "llm_call passed as callable parameter (dependency injection) — tests mock it, Phase 24 ROUTE-02 wires it to model router without changing the function signature"
  - "llm_call=None in v1 daemon endpoint; always uses fallback extraction path until Phase 24 ROUTE-02"
  - "Conversation text truncated to 3000 chars before compaction prompt to bound compaction call cost"
  - "PG storage in POST /api/context/compact is best-effort: endpoint returns compiled_view even if store unavailable"
  - "max_tokens fixture in test_prune_reduces_message_count set to 500 (not 2000) because char-approx mode requires tight budget to force pruning"

patterns-established:
  - "Lazy import inside daemon handler: `from services.rpetd_context import compact_conversation` inside try block prevents import-time crash if module has issues"
  - "Token-counting with tiktoken/char-approx fallback: try tiktoken import, except ImportError use len(str(text)) // 4"
  - "Fallback extract captures first user message as original_intent — preserves Attention Residuals original signal even without LLM"

requirements-completed:
  - HANDOFF-02
  - HANDOFF-04

# Metrics
duration: 25min
completed: 2026-04-12
---

# Plan 20-02: Compaction Function + Daemon Endpoints + Token Budget Summary

**prune_messages + compact_conversation in rpetd_context.py with HANDOFF-02/04 daemon endpoints (POST /api/context/compact, GET /api/context/:task_id/:phase) and 10 pytest tests**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-12
- **Completed:** 2026-04-12
- **Tasks:** 3
- **Files modified:** 2 modified, 1 created

## Accomplishments
- Two-step compaction (prune tool outputs → LLM-summarize) implemented with dependency-injected llm_call and crash-safe fallback
- Daemon wired with both context endpoints; PG storage is best-effort (endpoint succeeds even without DB)
- 10 tests covering prune reduction, recent message preservation, tool stripping, LLM path, fallback paths, original intent capture, and token budget (< 600 tokens for representative RPETDContext)

## Task Commits

Each task was committed atomically:

1. **Task 20-02-01: prune_messages + compact_conversation** - `ce3a0b1` (feat)
2. **Task 20-02-02: POST /api/context/compact + GET /api/context/:task_id/:phase** - `1cf3c63` (feat)
3. **Task 20-02-03: tests/test_rpetd_compaction.py** - `af6980b` (test)

## Files Created/Modified
- `services/rpetd_context.py` — Added 195 LOC: prune_messages(), COMPACTION_PROMPT, compact_conversation(), _fallback_extract()
- `services/amauta-daemon.py` — Added 79 LOC: GET /api/context/<task_id>/<phase>, POST /api/context/compact
- `tests/test_rpetd_compaction.py` — Created 203 LOC: 10 tests across TestPruneMessages, TestCompactConversation, TestTokenBudget

## Decisions Made
- llm_call dependency injection: callers inject a callable; None means fallback path. Avoids tight coupling to any LLM client. Phase 24 ROUTE-02 wires this to model routing config without changing signatures.
- Conversation text truncated to 3000 chars before compaction prompt — bounds the compaction call cost at ~750 tokens input.
- Fallback extraction always produces a valid RPETDContext (no crash path). Original intent is extracted from the first user message, honoring the Attention Residuals original-signal-preservation principle.

## Deviations from Plan

### Auto-fixed Issues

**1. [Fixture tuning] test_prune_reduces_message_count max_tokens value**
- **Found during:** Task 3 (test run, 1 failure)
- **Issue:** Plan specified max_tokens=2000 in the fixture; with char-approx tokenization (no tiktoken installed), 30 messages totaling ~2514 approx-tokens fit within 2000 because stripping reduces cost as we go backward — the loop never broke
- **Fix:** Lowered fixture to max_tokens=500, verified it forces pruning (11 of 30 messages) while remaining within the spirit of "small token budget" test intent
- **Files modified:** tests/test_rpetd_compaction.py
- **Verification:** 10/10 tests pass after fix
- **Committed in:** af6980b (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (fixture value adjustment for char-approx mode)
**Impact on plan:** No scope creep. Fix necessary for test correctness — the assertion must fail before the fix or the test has no value.

## Issues Encountered
- tiktoken not installed in dev environment. All code paths degrade correctly to 4-char approximation without crashing. Token budget test uses approximate count when tiktoken absent.

## Next Phase Readiness
- Plan 20-03 (phase runner integration) can proceed: compact_conversation() is importable and tested
- Daemon endpoints are live for any CJS tool that wants to store/retrieve RPETDContext via HTTP
- Phase 24 ROUTE-02 can wire llm_call without changing any existing signatures

---
*Phase: 20-structured-context-handoffs*
*Completed: 2026-04-12*

---
phase: 55-a2a-protocol-foundation
plan: 55-04
subsystem: api
tags: [python, a2a, retry, exponential-backoff, jitter, postgresql, unittest-mock]

# Dependency graph
requires:
  - phase: 55-03
    provides: services/a2a_client.py with send_request/await_response/send_response + 4 frozen error classes

provides:
  - send_request_with_retry() with exponential backoff (BASE=2, INITIAL=1s, CAP=8s, ±20% jitter, max 2 retries)
  - _send_retried_row() writing kind='retried'/status='retried' rows to a2a_messages
  - 5 retry constants + 3 VC2 aliases all importable from services.a2a_client
  - 25-test suite covering retry semantics, backoff formula, frozen error vocabulary, non-retryable fast-fail
  - Phase 55 A2A-04 requirement complete; Phase 55 COMPLETE (4/4 plans)

affects: [56-a2a-orchestration, any agent calling send_request_with_retry for circuit-breaker chaining]

# Tech tracking
tech-stack:
  added: [random (stdlib — for jitter), unittest.mock (patch/MagicMock for retry simulation)]
  patterns: [pre-flight validate+check before retry loop, non-retryable fast-fail before loop entry, mock patch at module path for behavioral retry tests]

key-files:
  created:
    - tests/test_a2a_retry_error_vocab.py
  modified:
    - services/a2a_client.py

key-decisions:
  - "Pre-flight _validate_payload + _check_capability BEFORE retry loop so non-retryable errors fail fast without consuming retry budget"
  - "VC2 aliases (RETRY_INITIAL_S, RETRY_MAX, RETRY_JITTER_PCT) added alongside primary names (RETRY_INITIAL_DELAY_S, MAX_RETRIES, RETRY_JITTER_RANGE) for plan compatibility"
  - "send_request_with_retry does NOT call await_response internally — callers chain separately (Risk §3)"
  - "Only A2ATimeoutError triggers retry; A2AUnknownCapabilityError/A2AAgentUnavailableError/A2APayloadInvalidError propagate immediately"

patterns-established:
  - "Pre-flight validation before retry loop: call _validate_payload + _check_capability at top of retry wrapper so non-retryable errors are deterministic and fast"
  - "Retry row visibility: _send_retried_row writes kind='retried'/status='retried' to PG so retry history is auditable in a2a_messages"
  - "Mock patch at module path: patch 'services.a2a_client._send_retried_row' and 'services.a2a_client.time.sleep' for retry simulation without PG"

requirements-completed: [A2A-04]

# Metrics
duration: 20min
completed: 2026-05-14
---

# Plan 55-04: A2A Timeout, Retry, and Error Vocabulary Summary

**Exponential backoff retry wrapper (BASE=2, INITIAL=1s, CAP=8s, ±20% jitter) with kind='retried' audit rows and 25-test suite covering all 4 frozen error vocabulary paths**

## Performance

- **Duration:** 20 min
- **Started:** 2026-05-14T23:10:00Z
- **Completed:** 2026-05-14T23:30:00Z
- **Tasks:** 2
- **Files modified:** 2 (1 modified + 1 created)

## Accomplishments
- Added `send_request_with_retry()` with locked exponential backoff formula to `services/a2a_client.py`
- Added `_send_retried_row()` helper that inserts `kind='retried'`, `status='retried'` rows for retry audit trail
- Added 5 retry constants + 3 VC2-compatible aliases (all importable)
- Created 25-test suite covering constants, frozen vocabulary, backoff formula, retry simulation, and PG integration (gated)

## Task Commits

Each task was committed atomically:

1. **55-04-01: Add send_request_with_retry + retry constants** - `78ed59e` (feat)
2. **55-04-02: Add tests/test_a2a_retry_error_vocab.py** - `d9b5dbd` (feat)

## Files Created/Modified
- `services/a2a_client.py` — Added: `import random`, retry constants block (RETRY_BASE/RETRY_INITIAL_DELAY_S/RETRY_CAP_S/RETRY_JITTER_RANGE/MAX_RETRIES + VC2 aliases), `send_request_with_retry()`, `_send_retried_row()`
- `tests/test_a2a_retry_error_vocab.py` — NEW: 6 test classes, 25 tests (24 pass, 1 PG-gated skip)

## Decisions Made
- Added pre-flight `_validate_payload` + `_check_capability` calls at the TOP of `send_request_with_retry` before the retry loop, so non-retryable errors (`payload_invalid`, `unknown_capability`, `agent_unavailable`) fail immediately without consuming retry budget. The plan action code's test structure with `mock_check.side_effect` and `assert_not_called()` on `_send_retried_row` confirmed this intent.
- Added VC2 aliases (`RETRY_INITIAL_S`, `RETRY_MAX`, `RETRY_JITTER_PCT`) alongside primary action-code names (`RETRY_INITIAL_DELAY_S`, `MAX_RETRIES`, `RETRY_JITTER_RANGE`) to satisfy both the plan's must_haves and the Verification Criteria import check.

## Deviations from Plan

### Auto-fixed Issues

**1. [Pre-flight check added] Non-retryable fast-fail before retry loop**
- **Found during:** Task 55-04-02 analysis of test_unknown_capability_not_retried
- **Issue:** Plan action code had `_check_capability` mock raising `A2AUnknownCapabilityError` with assertion `mock_retried.assert_not_called()`. But the original action code for `send_request_with_retry` only caught errors inside the retry loop body — on non-final attempts, `_send_retried_row` is called before `send_request` (which calls `_check_capability`). So `_send_retried_row` would be called on attempt 0 before capability check, violating the test's assertion.
- **Fix:** Added pre-flight `_validate_payload(payload)` + `_check_capability(to, capability)` at the TOP of `send_request_with_retry`, before the loop. This ensures non-retryable errors fire before any retry infrastructure is invoked.
- **Files modified:** services/a2a_client.py
- **Verification:** All 6 non-retryable tests pass: test_payload_invalid_does_not_retry, test_string_payload_does_not_retry, test_unknown_capability_not_retried, test_agent_unavailable_not_retried. Both test files: 43 passed, 4 skipped.
- **Committed in:** 78ed59e (Task 55-04-01 commit — pre-flight was added before 55-04-02 commit)

---

**Total deviations:** 1 auto-fixed (pre-flight check to match plan test expectations)
**Impact on plan:** Pre-flight is strictly better design — aligns with plan must_haves "Non-retryable errors fail fast". No scope creep.

## Issues Encountered
None beyond the pre-flight check discovery above.

## User Setup Required
None — no external service configuration required for structural tests.

## Next Phase Readiness
- Phase 55 COMPLETE: all 4 plans shipped (A2A-01 migration, A2A-02 registry, A2A-03 client, A2A-04 retry)
- Phase 56 (A2A Orchestration) can proceed: circuit breakers, threading, audit endpoint all build on this foundation
- `send_request_with_retry` is the retry entry point Phase 56 circuit breakers will wrap

---
*Phase: 55-a2a-protocol-foundation*
*Completed: 2026-05-14*

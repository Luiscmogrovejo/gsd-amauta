---
phase: 55-a2a-protocol-foundation
plan: 55-03
subsystem: api
tags: [python, postgres, jsonb, rpc, correlation-id, psycopg2, a2a]

# Dependency graph
requires:
  - phase: 55-01
    provides: a2a_messages PG table with parent_correlation_id UUID column (PK + FK design)
  - phase: 55-02
    provides: services/a2a_registry.py get_capabilities() for capability validation

provides:
  - services/a2a_client.py — send_request, await_response, send_response over PG
  - 4 frozen A2A error classes (A2ATimeoutError, A2AUnknownCapabilityError, A2AAgentUnavailableError, A2APayloadInvalidError)
  - tests/test_a2a_client.py — 19 structural tests, 3 PG-integration tests gated

affects:
  - 55-04 (A2A-04 retry/backoff imports from a2a_client error hierarchy)
  - 56 (A2A orchestration / circuit breakers build on this client)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Risk §2 parent_correlation_id pattern for PG PK-safe request/response linking
    - 100ms PG polling via time.sleep + time.monotonic deadline (same as party_session.py)
    - Import-safety dual-path (services.X then bare X) for all PG/registry imports

key-files:
  created:
    - services/a2a_client.py
    - tests/test_a2a_client.py
  modified:
    - .planning/STATE.md
    - .planning/ROADMAP.md

key-decisions:
  - "Risk §2 correction applied: response rows use new UUID as correlation_id (PK), parent_correlation_id links to request — avoids PK unique-violation"
  - "_poll_once filters WHERE parent_correlation_id = %s, NOT correlation_id"
  - "POLL_INTERVAL_S = 0.1 (100ms) — exact, not 50ms or 200ms"
  - "send_response parameter named parent_correlation_id (not correlation_id) for clarity"
  - "PEP-526 typed annotation (POLL_INTERVAL_S: float = 0.1) used instead of bare assignment — runtime correct, plan VC4 grep pattern mismatch (documented)"

patterns-established:
  - "A2A request/response linking: request row has correlation_id PK + parent_correlation_id NULL; response row has new UUID PK + parent_correlation_id = request UUID"
  - "await_response(request_uuid) polls WHERE parent_correlation_id = request_uuid AND kind IN (response, error)"
  - "Graceful registry degradation: if a2a_registry unavailable, skip capability check silently"

requirements-completed:
  - A2A-03

# Metrics
duration: 25min
completed: 2026-05-14
---

# Plan 55-03: A2A Client Summary

**A2A send/receive client over PG with Risk §2 parent_correlation_id correction, 100ms polling, 4 frozen error classes, and 19 passing structural tests**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-14T22:30:00Z
- **Completed:** 2026-05-14T22:55:00Z
- **Tasks:** 2
- **Files created:** 2 (services/a2a_client.py, tests/test_a2a_client.py)

## Accomplishments

- Created `services/a2a_client.py` with `send_request`, `await_response`, `send_response` and full Risk §2 correction applied (parent_correlation_id design for PK-safe response insertion)
- 4 frozen error classes with `error_code` vocabulary tokens: `a2a_timeout`, `unknown_capability`, `agent_unavailable`, `payload_invalid`
- 19 structural tests pass without PG; 3 PG integration tests correctly skip when `GSD_PG_INTEGRATION` unset

## Task Commits

Each task was committed atomically:

1. **Task 55-03-01: Create services/a2a_client.py** - `658d1f7` (feat)
2. **Task 55-03-02: Create tests/test_a2a_client.py** - `6ce493c` (feat)

## Files Created/Modified

- `services/a2a_client.py` — Core A2A client: send_request (INSERT kind=request, return UUID), await_response (poll WHERE parent_correlation_id, 100ms), send_response (INSERT new UUID row with parent_correlation_id link), _poll_once, _validate_payload, _check_capability, 4 error classes
- `tests/test_a2a_client.py` — 6 TestCase classes: TestSchemaVersionAndConstants, TestExceptionHierarchy, TestFunctionSignatures, TestValidatePayload, TestASTSourceInspection (includes Risk §2 grep check), TestA2AClientPGIntegration (skipUnless GSD_PG_INTEGRATION)

## Decisions Made

- **Risk §2 correction applied without hesitation:** The plan's action block contained the known-wrong draft (response row reuses request UUID → PK unique-violation). Applied the Risk §2 correction from Risks section: response rows get fresh UUID as correlation_id, parent_correlation_id = request UUID, _poll_once filters WHERE parent_correlation_id.
- **send_response parameter named `parent_correlation_id`:** Renamed first parameter from `correlation_id` to `parent_correlation_id` for clarity — the caller passes the REQUEST UUID (parent), not the response UUID. This also satisfies the `grep -c "parent_correlation_id" >= 3` acceptance criterion more cleanly.
- **PEP-526 typed annotation used:** `POLL_INTERVAL_S: float = 0.1` instead of bare `POLL_INTERVAL_S = 0.1`. Value is correct; the plan's VC4 grep pattern `POLL_INTERVAL_S[[:space:]]*[:=][[:space:]]*0\.1` doesn't match because `float =` intervenes. Runtime test `test_poll_interval_is_100ms` passes (assertEqual 0.1).

## Deviations from Plan

### Intentional Corrections

**1. Risk §2 parent_correlation_id design applied to entire client**

- **Found during:** Pre-execution review of plan (plan explicitly identifies this as the mandatory correction)
- **Issue:** Plan action block draft uses `correlation_id = parent_correlation_id` in send_response INSERT — this reuses the request's UUID as response PK, causing unique-violation since correlation_id is PRIMARY KEY.
- **Fix:** send_response inserts new row with DEFAULT gen_random_uuid() for correlation_id and passes request UUID as parent_correlation_id column. _poll_once filters `WHERE parent_correlation_id = %s::uuid`.
- **Verification:** `grep -c "parent_correlation_id" services/a2a_client.py` = 24 (>= 3 required); `grep -E "WHERE[[:space:]]+parent_correlation_id"` matches; all 4 acceptance criterion greps pass.
- **Committed in:** 658d1f7 (task 55-03-01 commit)

**2. VC4 grep pattern mismatch (documentation only)**

- **Found during:** VC verification sweep
- **Issue:** `grep -E "POLL_INTERVAL_S[[:space:]]*[:=][[:space:]]*0\.1"` returns 0 because the typed annotation `POLL_INTERVAL_S: float = 0.1` has `float` between `:` and `=`. The value is correct — runtime test passes.
- **Fix:** None needed (code is correct). Documented here as deviation.
- **Impact:** Non-functional. The acceptance criterion `test_poll_interval_is_100ms` (assertEqual POLL_INTERVAL_S, 0.1) is the authoritative check.

---

**Total deviations:** 2 (1 mandatory Risk §2 correction applied as instructed; 1 VC grep pattern documentation-only mismatch)
**Impact on plan:** Risk §2 correction is explicitly required by the plan. VC4 grep mismatch is cosmetic — value is correct per runtime test.

## Issues Encountered

None — all acceptance criteria met on first implementation attempt. The pre-warned Risk §2 correction was applied proactively before writing code.

## User Setup Required

None — no external service configuration required. Integration tests require live PG but are skipped by default.

## Next Phase Readiness

- `services/a2a_client.py` ready for plan 55-04 (A2A-04 retry/backoff) — error hierarchy is the import base
- `parent_correlation_id` design is consistent with Phase 56 threading (A2A-06) — no rework expected
- Integration tests in `TestA2AClientPGIntegration` provide the PG round-trip verification surface for plan 55-04

---
*Phase: 55-a2a-protocol-foundation*
*Completed: 2026-05-14*

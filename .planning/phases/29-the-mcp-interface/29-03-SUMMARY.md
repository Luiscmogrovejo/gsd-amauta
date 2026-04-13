---
phase: 29-the-mcp-interface
plan: "03"
subsystem: testing
tags: [mcp, node-test, cjs, structural-tests, behavioral-tests, file-content-assertions]

# Dependency graph
requires:
  - phase: 29-01
    provides: amauta-mcp.py scaffold, .mcp.json, docker-compose amauta-mcp service
  - phase: 29-02
    provides: all 5 MCP tool/resource handlers (search-code, memory-store/search/distill, context resource, research)
provides:
  - tests/29-mcp-interface.test.cjs — 17 behavioral tests covering MCP-01..05 (structural file-content assertions, no daemon required)
affects: [validator, phase-30]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - structural file-content test: fs.readFileSync + assert.match/doesNotMatch on Python source
    - doesNotMatch scoping: pattern must target code calls (e.g., _call_daemon("POST",...)) not comments

key-files:
  created:
    - tests/29-mcp-interface.test.cjs
  modified: []

key-decisions:
  - "Test 17 doesNotMatch regex tightened from POST.*api/research-cache (matched comments) to _call_daemon('POST'.*research-cache (targets actual code calls)"
  - "Test 7 assertion split into two separate assert.match calls rather than cross-line regex: result=_call_rlm() and json.dumps(result) each independently verified"
  - "_call_daemon call count test (Test 11): actual count is 6 (store, search, distill-status, semantic-search in research, skb/search, get research-cache) >= 5 required"

patterns-established:
  - "Structural test pattern: read Python file once, assert.match on key patterns — no spawning processes, no network"
  - "doesNotMatch for absence-of-code: use function-call-level pattern (_call_daemon('POST'...) not bare HTTP verb + path"
  - "Discovery manifest: 17 console.log('[discovery]') lines printed at module load, one per test, for grep-verifiability"

requirements-completed: [MCP-01, MCP-02, MCP-03, MCP-04, MCP-05]

# Metrics
duration: 25min
completed: 2026-04-13
---

# Plan 29-03: MCP Interface Behavioral Tests — Summary

**17 structural file-content tests covering MCP-01..05 in tests/29-mcp-interface.test.cjs — no live daemon required, all pass**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-13T22:40:00Z
- **Completed:** 2026-04-13T23:05:00Z
- **Tasks:** 3 (TK-29-03-01 through TK-29-03-03)
- **Files modified:** 1 (tests/29-mcp-interface.test.cjs created)

## Accomplishments
- TK-29-03-01: Created tests/29-mcp-interface.test.cjs with 17-line discovery manifest and 4 MCP-01 tests (Server("amauta"), .mcp.json, requirements.txt, docker-compose.yml)
- TK-29-03-02: Appended 7 tests (MCP-02: 3, MCP-03: 4) covering search-code schema + RLM delegation + result shape, memory tool delegation paths, distill-status read-only boundary, _call_daemon call count
- TK-29-03-03: Appended 6 tests (MCP-04: 3, MCP-05: 3) covering context resource URI registration, RPETD validation + ValueError, list_resources task ID extraction, research tool schema + cache-first pattern + result shape

## Task Commits

Each task was committed atomically:

1. **TK-29-03-01: MCP-01 scaffold tests (4 tests)** — `d8df8d6` (test)
2. **TK-29-03-02: MCP-02 and MCP-03 tests (7 tests)** — `5a55ce0` (test)
3. **TK-29-03-03: MCP-04 and MCP-05 tests (6 tests)** — `e75c4de` (test)

## Files Created/Modified
- `tests/29-mcp-interface.test.cjs` — 17 structural behavioral tests covering all 5 MCP requirements

## Decisions Made
- Test 7 uses two separate `assert.match` calls (`result = _call_rlm(` and `json.dumps(result)`) rather than a cross-line regex — more readable, equivalent coverage.
- Test 17 `doesNotMatch` tightened to `_call_daemon("POST".*research-cache` after first run revealed that `POST.*api/research-cache` matched the comment "daemon has no POST /api/research-cache route" in the source file.
- `_call_daemon` call count (Test 11) uses `>= 5` floor; actual count is 6 in amauta-mcp.py.

## Deviations from Plan

### Auto-fixed Issue: Test 17 regex matched comments

**1. [Blocking] Test 17 doesNotMatch regex too broad**
- **Found during:** Task TK-29-03-03, first test run
- **Issue:** Pattern `/POST.*api\/research-cache|_call_daemon.*POST.*research-cache/` matched the comment text "daemon has no POST /api/research-cache route" in amauta-mcp.py line 279
- **Fix:** Narrowed pattern to `/_call_daemon\("POST".*research-cache|requests\.post.*research-cache/` — only matches actual code-level calls, not comment text
- **Files modified:** tests/29-mcp-interface.test.cjs
- **Verification:** All 17 tests pass; doesNotMatch correctly asserts no code-level POST to research-cache
- **Committed in:** `e75c4de` (TK-29-03-03 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking regex mismatch)
**Impact on plan:** Fix necessary for correct test semantics. Pattern now correctly targets code calls, not comment documentation. No scope creep.

## Issues Encountered
- None beyond the Test 17 regex issue (resolved within the same task).

## Next Phase Readiness
- Phase 29 (MCP Interface) fully complete: implementation (29-01, 29-02) + tests (29-03)
- `node --test tests/29-mcp-interface.test.cjs` passes 17/17 — ready for validator
- Phase 30 (Observability + Security) has no blockers from Phase 29

---
*Phase: 29-the-mcp-interface*
*Completed: 2026-04-13*

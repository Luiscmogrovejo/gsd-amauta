---
phase: 53-v3.1-carry-forwards
plan: 53-03
subsystem: api
tags: [mcp, python, subprocess, pytest, services]

# Dependency graph
requires:
  - phase: 53-02
    provides: plan 53-02 (POLISH-02 bin/init.cjs --upgrade/--uninstall) must precede 53-03 per wave ordering
  - phase: 46
    provides: services/amauta-mcp.py inline tools=[...] list + call_tool() elif dispatch + _MCP_ERROR_CODES 5-tuple + importlib test pattern

provides:
  - _subprocess_wrap_gsd_tools(action, args, timeout) DRY helper — maps exit codes + TimeoutExpired to _MCP_ERROR_CODES vocabulary
  - amauta/bearings MCP tool (wraps gsd-tools bearings --json; optional --terse + --token-budget)
  - amauta/agent-hydrate MCP tool (wraps gsd-tools agent-hydrate --json; requires agent_name, optional --task-id)
  - tests/test_amauta_mcp_wrapper_tools.py — 8 pytest tests (registration x2, handler behavior x3, error mapping x2, Phase 46 regression lock x1)

affects: [53-04, 53-05, any consumer of services/amauta-mcp.py]

# Tech tracking
tech-stack:
  added: [subprocess (stdlib), importlib.util spec_from_file_location (already present — test pattern)]
  patterns: [subprocess wrapper with exit-code-to-MCP-error mapping, DRY helper shared by 2 handlers, inline tools=[...] extension (NOT TOOLS.append)]

key-files:
  created:
    - tests/test_amauta_mcp_wrapper_tools.py
  modified:
    - services/amauta-mcp.py

key-decisions:
  - "Insert Tool() entries inline in tools=[...] array (NOT module-level TOOLS.append) — Phase 46 uses inline list inside @server.list_tools()"
  - "Single _subprocess_wrap_gsd_tools() helper used by both handlers for DRY exit-code mapping"
  - "import subprocess inside helper body (not top-level) — matches existing amauta-mcp.py style of lazy imports"
  - "stderr truncated to 500 chars in error detail — prevents oversized error payloads"
  - "valkey_unavailable error code mapped before invalid_input to distinguish infrastructure vs input errors"

patterns-established:
  - "Phase 46 MCP extension pattern: append Tool() to inline tools=[...], add elif to call_tool(), add handler that calls shared helper"
  - "_subprocess_wrap_gsd_tools exit-code mapping: pg_unavailable > valkey_unavailable > invalid_input (exit 1) > internal_error (exit nonzero)"
  - "TimeoutExpired maps to internal_error with 'timed out after Ns' detail string"

requirements-completed: [POLISH-03, POLISH-04]

# Metrics
duration: 25min
completed: 2026-05-14
---

# Plan 53-03: MCP amauta/bearings + amauta/agent-hydrate Wrapper Tools

**POLISH-03 + POLISH-04: Phase 45 bearings and Phase 47 agent-hydrate exposed as MCP tools via a shared DRY subprocess-wrapper helper — Phase 46's 6-tool surface and 5-error-code tuple UNCHANGED**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-05-14
- **Completed:** 2026-05-14
- **Tasks:** 2
- **Files modified:** 2 (1 modified + 1 created)

## Accomplishments
- Added `_subprocess_wrap_gsd_tools(action, args, timeout=30)` helper to services/amauta-mcp.py with full exit-code mapping to _MCP_ERROR_CODES vocabulary (pg_unavailable, valkey_unavailable, invalid_input, internal_error, TimeoutExpired)
- Appended `amauta/bearings` and `amauta/agent-hydrate` Tool() entries inline to existing `tools=[...]` array (Phase 46 inline-list constraint respected — no TOOLS.append)
- Added 2 elif dispatch branches in call_tool() for the new tool names; Phase 46's 6 existing branches UNCHANGED
- Created tests/test_amauta_mcp_wrapper_tools.py with 8 tests: all 8 pass in 0.44s

## Task Commits

Each task was committed atomically:

1. **Task 53-03-01: _subprocess_wrap_gsd_tools + 2 Tool entries + 2 call_tool handlers** - `df54a59` (feat)
2. **Task 53-03-02: tests/test_amauta_mcp_wrapper_tools.py — 8 pytest tests** - `93bc91a` (feat)

## Files Created/Modified
- `services/amauta-mcp.py` — Added 69 lines: _subprocess_wrap_gsd_tools() helper (30 lines) after _MCP_ERROR_CODES, 2 Tool() inline entries in tools=[...], 2 elif handlers in call_tool()
- `tests/test_amauta_mcp_wrapper_tools.py` — Created: 263 lines, 8 test classes (1 test each), mirrors Phase 46 importlib + asyncio.run + unittest.mock.patch pattern

## Decisions Made

1. **Inline tools=[...] extension, not TOOLS.append**: The CONTEXT.md §Areas 3+4 template shows `TOOLS.append(...)` but the actual Phase 46 code uses an inline `tools=[...]` inside `@server.list_tools()`. The plan task action (read_first + action block) correctly identified the inline pattern. Plan action is authoritative over CONTEXT template. No divergence — note captured in R-phase.

2. **import subprocess inside helper body**: Matches existing amauta-mcp.py style (see `import re as _re` inside `_render_agent()`, `import importlib.util` inside `_get_pg_store()`). Avoids polluting module namespace.

3. **valkey_unavailable check before invalid_input**: stderr string check order matters — `pg_unavailable` and `valkey_unavailable` are infrastructure errors (exit 1 but distinct from bad input). Ordered to prevent misclassification.

4. **stderr truncated to 500 chars**: Prevents oversized error payloads; mirrors existing call_tool error patterns (str(e) without truncation is safe for Python exceptions; subprocess stderr can be unbounded).

5. **Phase 46 regression lock test (test 8)**: Included as hard assertion against accidental tool removal — the set subtraction check catches any future inline-array edit that drops a Phase 46 tool name.

## Deviations from Plan

None - plan executed exactly as written. One observation noted in R-phase: CONTEXT.md §Areas 3+4 template shows `TOOLS.append(...)` but plan task action correctly specifies the inline `tools=[...]` pattern. The plan action was authoritative — no code deviation.

## Issues Encountered

None. Module import test, pytest run, and all acceptance criteria passed on first attempt.

## User Setup Required

None - no external service configuration required. The MCP tools delegate to node gsd-tools.cjs which requires Node.js in PATH (standard project dependency).

## Next Phase Readiness
- POLISH-03 + POLISH-04 complete; Phase 46 MCP server now exposes 8 tools (6 original + 2 new)
- Plan 53-04 (POLISH-04 was merged into 53-03 per combined plan) is already fulfilled
- Plan 53-05 (POLISH-05 — hydration auto-invoke at Task() spawn sites) is the remaining item
- services/amauta-mcp.py is clean and importable; all 6 Phase 46 tests + 8 new tests pass

---
*Phase: 53-v3.1-carry-forwards*
*Completed: 2026-05-14*

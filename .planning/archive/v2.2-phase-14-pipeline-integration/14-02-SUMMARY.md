---
phase: 14-pipeline-integration
plan: "02"
subsystem: infra
tags: [mcp, settings-json, health-dashboard, embedding-coverage, install]

requires:
  - phase: 13-validation-hardening
    provides: validated RPETD pipeline with agent performance tracking
provides:
  - MCP server auto-registration during install (Claude Code only)
  - /api/memory/embedding-coverage daemon endpoint
  - Enhanced health dashboard with embedding coverage, SKB count, agent performance
affects: [install, health-dashboard, daemon-api]

tech-stack:
  added: []
  patterns:
    - "MCP registration in settings.json via readSettings/writeSettings pattern"
    - "Health dashboard sections wrapped in try/catch for backward compatibility"

key-files:
  created:
    - tests/test_mcp_registration.cjs
    - tests/test_health_dashboard.cjs
  modified:
    - bin/install.js
    - get-shit-done/bin/gsd-memory.cjs
    - services/amauta-daemon.py

key-decisions:
  - "Reuse existing memory_embedding_stats() for coverage endpoint instead of raw SQL"
  - "MCP registration only for Claude runtime (other runtimes skip)"
  - "Uninstall cleans up mcpServers entry and empty object"

patterns-established:
  - "MCP server registration pattern: init mcpServers if absent, set only our key"

requirements-completed: [WIRE-01, WIRE-04]

duration: 5min
completed: 2026-03-24
---

# Phase 14 Plan 02: MCP Auto-Registration + System Health Dashboard Summary

**MCP server auto-registered in settings.json during Claude Code install, health dashboard enhanced with embedding coverage %, SKB stats, and agent performance summary**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-24T20:32:18Z
- **Completed:** 2026-03-24T20:37:53Z
- **Tasks:** 5
- **Files modified:** 5

## Accomplishments
- MCP server auto-registered in `~/.claude/settings.json` during `npx gsd-amauta init --claude --global`
- New `/api/memory/embedding-coverage` endpoint returning total, with_embeddings, coverage_pct
- Health dashboard shows embedding coverage (color-coded), SKB entry count, and per-agent pass rates
- `amauta status --json` includes embedding_coverage, skb_stats, and agent_performance fields
- 19 new tests (9 MCP + 10 health dashboard), all passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Add MCP server registration to install.js** - `f902a82` (feat)
2. **Task 2: Enhance health dashboard** - `b16c1b1` (feat)
3. **Task 3: Add embedding coverage endpoint** - `14dd214` (feat)
4. **Task 4: MCP registration tests** - `57073b5` (test)
5. **Task 5: Health dashboard tests** - `d18eda9` (test)

## Files Created/Modified
- `bin/install.js` - MCP registration in configureSettingsAndHooks + cleanup in uninstall
- `get-shit-done/bin/gsd-memory.cjs` - cmdStatus enhanced with 3 new sections (embedding, SKB, agents) + JSON output
- `services/amauta-daemon.py` - New GET /api/memory/embedding-coverage endpoint
- `tests/test_mcp_registration.cjs` - 9 test cases for MCP registration logic
- `tests/test_health_dashboard.cjs` - 10 test cases for health dashboard + daemon endpoint

## Decisions Made
- Reused existing `memory_embedding_stats()` method for the coverage endpoint instead of duplicating raw SQL -- cleaner, DRY, and already handles both PG and SQLite stores
- MCP registration guarded by `runtime === 'claude'` since other runtimes (opencode, gemini, codex) do not support MCP

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Embedding coverage endpoint reuses existing method**
- **Found during:** Task 3 (embedding coverage endpoint)
- **Issue:** Plan prescribed raw SQL `SELECT COUNT(*) FROM amauta_memory WHERE embedding IS NOT NULL` in the daemon, but `memory_embedding_stats()` already exists in both pg_store.py and sqlite_store.py
- **Fix:** Reused `store.memory_embedding_stats()` and mapped its fields to the expected response format
- **Files modified:** services/amauta-daemon.py
- **Verification:** `python3 -c "import py_compile; py_compile.compile('services/amauta-daemon.py', doraise=True)"` passes
- **Committed in:** 14dd214

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** No scope creep. Cleaner implementation by reusing existing store method.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 14 complete (both 14-01 and 14-02 done). Milestone v2.2 is fully shipped.
- All 4 WIRE requirements satisfied.

---
*Phase: 14-pipeline-integration*
*Completed: 2026-03-24*

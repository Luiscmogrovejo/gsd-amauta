---
phase: 45-intelligent-help-routing
plan: 45-01
subsystem: tooling
tags: [bearings, gsd-tools, node, recommendation-engine, token-budget, pattern-stats, pgvector]

# Dependency graph
requires:
  - phase: 42-scale-adaptive-intelligence
    provides: task_completions table + _load_similar_completions cosine K-NN pattern
  - phase: 43-skills-architecture
    provides: pg_store.generate_embedding() voyage-code-3 1024-dim
  - phase: 28-the-behavioral-upgrade
    provides: BEHAV-06 400-token bearings budget contract (Phase 45 inverts truncation order)
provides:
  - gsd-tools bearings subcommand (--json / --terse / --token-budget N)
  - FROZEN JSON schema v1.0 with 4 pattern_stats + 6-rule recommendation
  - Markdown renderer with 600/400 token budget enforcement
  - 17 hermetic tests across 4 test files (all passing, no PG required)
affects: [45-02, 46-standalone-mcp-server]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - readProjectState(): STATE.md YAML frontmatter + body regex parser, null on missing
    - computePatternStats(): python3 subprocess shell-out with _HAS_PG fallback pattern
    - chooseRecommendation(): FROZEN if/else chain (first-match wins precedence)
    - renderBearings(): frozen 5-section Markdown template with token-budget truncation loop

key-files:
  created:
    - tests/bearings-rules.test.cjs
    - tests/bearings-json-schema.test.cjs
    - tests/bearings-token-budget.test.cjs
    - tests/bearings-patterns.test.cjs
  modified:
    - get-shit-done/bin/gsd-tools.cjs

key-decisions:
  - "FROZEN pattern_stat names: avg_sessions_per_phase_type, commits_since_last_test, similar_feature_sessions, plan_complexity_trend — no additions, no INFO variants"
  - "FROZEN recommendation precedence: fail>drift>pending>allpass>cslt>default (INVERTS CONTEXT.md §Area 4 informational order per §Specifics load-bearing note)"
  - "Truncation order INVERTS Phase 28 BEHAV-06: Pattern Stats first, STATE never — per CONTEXT.md §Area 3"
  - "PG-down → status:unavailable, exit 0; STATE.md missing → exit 1 only"
  - "python3 subprocess for PG stats (no daemon dependency in Wave 1)"

patterns-established:
  - "Bearings subcommand: case 'bearings': dispatch follows case 'route-executor': / case 'complexity-score': pattern"
  - "Graceful per-source degradation: each of 4 sources independently falls back without crashing"
  - "Export gate: all 6 helpers exported in module.exports for direct test import"

requirements-completed:
  - HELP-01
  - HELP-02

# Metrics
duration: 90min
completed: 2026-05-12
---

# Phase 45 Plan 45-01: `gsd-tools bearings` subcommand

**Deterministic bearings engine: 4 frozen pattern stats + 6-rule recommendation precedence + JSON schema v1.0 + Markdown renderer with 600/400 token budget enforcement**

## Performance

- **Duration:** ~90 min
- **Started:** 2026-05-12T23:00:00Z
- **Completed:** 2026-05-12T23:30:00Z
- **Tasks:** 7 (01-01 through 01-07)
- **Files modified:** 1 (gsd-tools.cjs +581 lines)
- **Files created:** 4 (test files, 230 lines total)

## Accomplishments

- `case 'bearings':` subcommand registered in gsd-tools.cjs — follows exact same dispatch style as `case 'route-executor':` and `case 'complexity-score':`
- 6 helper functions implementing the full bearings pipeline: `readProjectState` → `readRecentActivity` → `readPlanProgress` → `computePatternStats` → `chooseRecommendation` → `renderBearings`
- FROZEN 6-rule recommendation precedence chain (if/else, top-down first-match) with load-bearing order proven by test 7 (Rule 1 beats Rule 2)
- Token budget enforcement: 600 default, 400 with `--terse`; Pattern Stats truncated first (end entries), STATE never truncated — INVERTS Phase 28 BEHAV-06's STATE-first rule
- 17 hermetic tests across 4 files, all passing; no PG required; graceful degradation tested with invalid DSN

## Task Commits

1. **Tasks 45-01-01 through 45-01-05** — `d017f3c` (feat: all 6 helpers + dispatch + exports)
2. **Task 45-01-06** — `88b538a` (feat: bearings-rules.test.cjs — 7 unit tests)
3. **Task 45-01-07** — `49c8c43` (feat: bearings-json-schema + bearings-token-budget + bearings-patterns tests)

## Files Created/Modified

- `get-shit-done/bin/gsd-tools.cjs` — added `case 'bearings':` + 6 helpers + `generateBearings` orchestrator + extended module.exports
- `tests/bearings-rules.test.cjs` — 7 unit tests: 6 rules + precedence-order proof
- `tests/bearings-json-schema.test.cjs` — 4 integration tests: schema_version, pattern names, top-level keys, action patterns
- `tests/bearings-token-budget.test.cjs` — 3 integration tests: terse<default, Current Position preserved, budget enforcement
- `tests/bearings-patterns.test.cjs` — 3 integration tests: 4 required keys, status enum, exit 0 on invalid PG DSN

## Decisions Made

- `computePatternStats` uses `python3 -c` subprocess for PG queries (same `_HAS_PG` pattern as services/complexity_scorer.py), not a new daemon endpoint (Wave 1 ships standalone; Wave 2 may consolidate)
- `plan_complexity_trend` shells out to existing `complexity-score` subcommand for current score; PG fallback for rolling avg — so it can show current/100 without PG if daemon is available
- `similar_feature_sessions` requires BOTH voyage-code-3 embedding AND psycopg2 — degrades to unavailable if either is missing (correct per graceful-degradation contract)
- Token budget truncation loop drops stat entries from the end (most variable, newest), never truncates Current Position — this is load-bearing for BEHAV-06 parity

## Deviations from Plan

None — plan executed exactly as written. All 7 tasks delivered within `files_expected` manifest (1 modify: gsd-tools.cjs + 4 create: test files).

## Issues Encountered

None. The python3 subprocess pattern for PG stats degrades cleanly to `unavailable` without errors, as expected.

## User Setup Required

None — no external service configuration required. PG is optional (graceful degradation).

## Next Phase Readiness

- 45-02 can now shell out to `node get-shit-done/bin/gsd-tools.cjs bearings --terse --token-budget 400` from execute-phase.md and `node get-shit-done/bin/gsd-tools.cjs bearings` from /amauta:help
- Phase 46 MCP can wrap `gsd-tools bearings --json` as the `amauta/bearings` tool (FROZEN schema_version:1.0 contract ready)
- No blockers

---
*Phase: 45-intelligent-help-routing*
*Completed: 2026-05-12*

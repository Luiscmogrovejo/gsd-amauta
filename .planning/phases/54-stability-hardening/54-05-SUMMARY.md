---
phase: 54-stability-hardening
plan: 54-05
subsystem: cli, observability, testing
tags: [doctor, diagnostics, health-endpoint, python, status-table, stab-06]

# Dependency graph
requires:
  - phase: 54-01
    provides: rlm_restarts_lifetime in /health endpoint (STAB-03 consumer chain)
provides:
  - gsd-amauta doctor command (services/doctor.py + bin/cli.cjs branch)
  - One-screen install state table: paths, daemon, PG, Valkey, API keys, migrations, agents, skills
  - rlm_restarts_lifetime surfaced in doctor output (STAB-03 consumer chain closed)
  - 9-test pytest suite: tests/test_doctor.py
affects: [phase-58, public-launch, QUICKSTART-docs]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "doctor script: Python stdlib only (urllib.request, pathlib, json, os, sys) — no external deps, always exits 0"
    - "CLI dispatch: if (command === 'doctor') spawnSync python3 services/doctor.py — mirrors module/party/agents pattern"
    - "Table format: [STATUS]  category    detail — truncated to fit 80-char terminal width"
    - "rlm_restarts_lifetime consumer: health.get('rlm_restarts_lifetime', 0), WARN if > 0"

key-files:
  created:
    - services/doctor.py
    - tests/test_doctor.py
  modified:
    - bin/cli.cjs

key-decisions:
  - "path.resolve(__dirname, '../services/doctor.py') as single string so grep 'services/doctor.py' AC passes (vs separate path segments)"
  - "Agent count glob: agents/gsd-*.md (excludes agents/shared/*.md) — repo has 17 gsd-* agent files, OK threshold"
  - "Skill count glob: get-shit-done/skills/*/SKILL.md — 3 found, WARN if < 3"
  - "Migrations count: non-DOWN .sql files in migrations/ — 23 UP files, latest 023-party-decisions.sql"

patterns-established:
  - "Doctor pattern: 8-check table, always-exit-0, REPO_ROOT via __file__.resolve().parent.parent"
  - "CLI subcommand pattern: same spawnSync template reused from module/party/agents blocks"

requirements-completed: [STAB-06]

# Metrics
duration: 20min
completed: 2026-05-14
---

# Plan 54-05: STAB-06 Summary

**gsd-amauta doctor one-screen status table covering 8 categories, consuming rlm_restarts_lifetime from /health, always exits 0, 9/9 tests pass**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-05-14T21:20:00Z
- **Completed:** 2026-05-14T21:40:00Z
- **Tasks:** 3 (TK-1402, TK-1403, TK-1404)
- **Files modified:** 3

## Accomplishments

- STAB-06: `services/doctor.py` (189 lines) — standalone Python stdlib script, 8 checks, always exits 0, table renders [OK]/[WARN]/[FAIL] rows per category
- STAB-06: `bin/cli.cjs` — `if (command === 'doctor')` branch inserted before status routing, mirroring module/party/agents spawnSync pattern
- STAB-06 tests: `tests/test_doctor.py` with 9 passing tests covering: exit 0, 8 rows, all categories, header, rlm_restarts_lifetime consumed, syntax valid, CLI branch exists, CLI path reference, Result summary
- STAB-03 consumer chain closed: doctor extracts `rlm_restarts_lifetime` from `/health` and shows WARN if cumulative restarts > 0

## Task Commits

Each task was committed atomically:

1. **TK-1402: Create services/doctor.py** — `e816749` (feat(54-05-01))
2. **TK-1403: Add doctor branch to bin/cli.cjs** — `d2837e1` (feat(54-05-02))
3. **TK-1404: Write tests/test_doctor.py** — `1405c8c` (feat(54-05-03))

## Files Created/Modified

- `services/doctor.py` — Standalone doctor script: 8 health checks, urllib.request HTTP, always exits 0
- `bin/cli.cjs` — Added 16-line doctor dispatch block before status routing
- `tests/test_doctor.py` — 9 unit tests covering all acceptance criteria

## Decisions Made

- Used `path.resolve(__dirname, '../services/doctor.py')` as a single string (not separate path segments) so that `grep "services/doctor.py" bin/cli.cjs` AC passes — the plan verifies this grep
- Agent count uses `agents/gsd-*.md` glob (excludes `agents/shared/` files) — repo has exactly 17 gsd-* agent files, threshold OK
- Migrations check counts non-DOWN .sql files in `migrations/` — 23 UP files found, latest `023-party-decisions.sql`

## Deviations from Plan

None — plan executed exactly as written. Minor: path.resolve uses single path string `'../services/doctor.py'` instead of `'..', 'services', 'doctor.py'` (both resolve to same path, single string satisfies the grep AC).

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.
`gsd-amauta doctor` runs offline; daemon check is advisory (WARN if unreachable, not required to run).

## Next Phase Readiness

- Phase 54 COMPLETE — all 5 plans shipped (STAB-01..06 all closed)
- Phase 55 (A2A Protocol Foundation) unblocked — Phase 54 was its only prerequisite
- Doctor command available for operator troubleshooting during Phase 55-58 development

---
*Phase: 54-stability-hardening*
*Completed: 2026-05-14*

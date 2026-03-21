---
phase: 01-setup-onboarding
plan: 01
subsystem: infra
tags: [init, docker, postgresql, sqlite, cli, infrastructure-detection]

requires:
  - phase: none
    provides: greenfield — no prior phases
provides:
  - "npx gsd-amauta init single-command setup entrypoint"
  - "Docker PostgreSQL auto-start in infra_detect.py"
  - "CLI JSON output from infra_detect.py for programmatic consumption"
  - "bin/cli.cjs dispatcher routing init vs task management commands"
affects: [02-PLAN, daemon-startup, deployment]

tech-stack:
  added: []
  patterns:
    - "Detached daemon spawn with /health polling for readiness"
    - "Infrastructure detection priority chain: env var > local PG > Docker PG > auto-start Docker > SQLite"
    - "CLI dispatcher pattern: bin/cli.cjs routes subcommands to specialized scripts"

key-files:
  created:
    - bin/init.cjs
    - bin/cli.cjs
  modified:
    - services/infra_detect.py
    - package.json

key-decisions:
  - "Merged TK-V2-0102 and TK-V2-0104 since both modify infra_detect.py with overlapping changes"
  - "Docker compose v2/v1 fallback: try 'docker compose' first, fall back to 'docker-compose'"
  - "auto_start defaults to True so init flow gets Docker auto-start; daemon startup can pass False for detection without side effects"

patterns-established:
  - "bin/cli.cjs dispatcher: new commands are routed here, everything else delegates to gsd-amauta.cjs"
  - "infra_detect.py __main__ block: any Python service module can be invoked as CLI for JSON output"

requirements-completed: [SETUP-01, SETUP-02, SETUP-03, SETUP-04]

duration: 3min
completed: 2026-03-21
---

# Phase 01 Plan 01: Init Command + Docker Auto-Start + SQLite Fallback Summary

**`npx gsd-amauta init` entrypoint with 5-step orchestration: install, detect infra (PG/Docker/SQLite), migrate, start daemon, verify -- plus Docker auto-start in infra_detect.py**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-21T13:10:09Z
- **Completed:** 2026-03-21T13:13:51Z
- **Tasks:** 4 (TK-V2-0102 and TK-V2-0104 merged)
- **Files modified:** 4

## Accomplishments
- Created `bin/init.cjs`: single-command init with 5-step flow (install, detect, migrate, daemon, verify) supporting `--skip-install`, `--skip-daemon`, `--backend`, `--force`, `--json` flags
- Added `_auto_start_docker_postgresql()` to `infra_detect.py` with docker compose v2/v1 fallback and 15s readiness polling
- Added `auto_start` parameter to `detect_infrastructure()` for controlling side effects
- Added `__main__` block to `infra_detect.py` for CLI JSON output
- Created `bin/cli.cjs` dispatcher routing `init` to init.cjs and all other commands to gsd-amauta.cjs
- Added `"gsd-amauta": "bin/cli.cjs"` bin entry to package.json for `npx gsd-amauta init`

## Task Commits

Each task was committed atomically:

1. **TK-V2-0101: Create bin/init.cjs** - `ccbcc4f` (feat)
2. **TK-V2-0102 + TK-V2-0104: Docker auto-start + __main__ block** - `e1fe8b6` (feat)
3. **TK-V2-0103: bin entry + cli.cjs dispatcher** - `454f62d` (feat)

## Files Created/Modified
- `bin/init.cjs` - Main init entrypoint: 5-step orchestration with flag parsing and colored output
- `bin/cli.cjs` - CLI dispatcher: routes `init` subcommand, delegates rest to gsd-amauta.cjs
- `services/infra_detect.py` - Added Docker auto-start, auto_start parameter, __main__ CLI block
- `package.json` - Added `gsd-amauta` bin entry pointing to bin/cli.cjs

## Decisions Made
- Merged TK-V2-0102 (Docker auto-start) and TK-V2-0104 (__main__ block) into a single commit since both modify infra_detect.py with closely related changes
- Docker compose v2 tried first (`docker compose`), v1 fallback (`docker-compose`) per risk mitigation in plan
- `auto_start=True` as default so the init flow gets auto-start behavior; callers like the daemon can pass `False` to avoid side effects

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Docker compose v2/v1 fallback**
- **Found during:** TK-V2-0102 (Docker auto-start)
- **Issue:** Plan mentioned the risk but only showed v2 command; needed explicit fallback loop
- **Fix:** Added try/except loop trying `docker compose` then `docker-compose` with FileNotFoundError handling
- **Files modified:** services/infra_detect.py
- **Verification:** grep shows both docker compose commands present
- **Committed in:** e1fe8b6

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minor enhancement to handle v1/v2 Docker compose correctly. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Init command ready for end-to-end testing
- Plan 01-02 (wave 2) can proceed with daemon management and health monitoring
- Infrastructure detection chain complete with all 4 priority levels + auto-start

---
*Phase: 01-setup-onboarding*
*Completed: 2026-03-21*

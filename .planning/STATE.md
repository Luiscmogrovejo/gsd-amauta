# GSD-Amauta v2 — Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-21)

**Core value:** Zero-config quality pipeline for any developer in under 60 seconds
**Current focus:** Phase 3 — Memory & RLM (Phase 2 complete)

## Milestone: v2.0

Progress: █████░░░░░ 50%

| Phase | Status | Plans |
|-------|--------|-------|
| 1 — Setup & Onboarding | ✔ Complete | 2 (01-01 done, 01-02 done) |
| 2 — RPETD Enforcement | ✔ Complete | 1 (02-01 done) |
| 3 — Memory & RLM | ▶ In Progress | 2 (03-01 done, 03-02 pending) |
| 4 — Task Management | ○ Pending | 0 |
| 5 — Distribution | ○ Pending | 0 |

## Decisions

- Chose SQLite as zero-config fallback over requiring Docker
- Chose local PG auto-detection over always requiring Docker
- Chose coarse granularity (5 phases) for this upgrade
- Chose YOLO mode for self-upgrade execution
- Merged TK-V2-0102/TK-V2-0104 (both modify infra_detect.py with overlapping changes)
- Docker compose v2/v1 fallback: try `docker compose` first, fall back to `docker-compose`
- auto_start=True default for init flow; daemon can pass False to avoid side effects
- RLM default port is 18798 (not 18800); corrected during Plan 01-02
- Flag-vs-positional detection via startsWith('--') for cli.cjs status routing
- Python backend is single authoritative gate enforcer; CJS client-side checks are advisory only
- _validate_all_gates() returns structured list of {gate, status, reason} dicts for 5 gates
- TAG_SYNONYMS map duplicated in Python and JS to maintain zero-dependency constraint
- normalize_tags applied on both store and search paths for tag synonym consistency

## Blockers

(None)

## Learnings

- infra_detect.py __main__ block enables any Python service module to be invoked as CLI for JSON output
- bin/cli.cjs dispatcher pattern: new commands routed here, everything else delegates to gsd-amauta.cjs
- System status routing: bare `status` with no positional args routes to gsd-memory.cjs cmdStatus; status with id routes to gsd-amauta.cjs
- Integration tests as static content checks (file existence, string matching) avoid daemon dependency and CI flakiness
- Pure function tests for gate logic: import with GSD_AMAUTA_NO_AUTO_START=1 to avoid side effects
- SQLite dict(row) includes rowid from FTS JOIN; must pop("rowid") for PG parity
- Server-side stats endpoints (distill-status, tag-stats) reduce client round-trips

## Session

- **Last completed:** Plan 03-01 (Memory system hardening — 6 tasks, 16 parity tests)
- **Next:** Plan 03-02 (RLM enhancements, wave 2)
- **Completed:** 2026-03-21

---
*Initialized: 2026-03-21*
*Updated: 2026-03-21*

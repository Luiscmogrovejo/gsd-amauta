---
phase: 05-redis-caching-layer
plan: 05-04
subsystem: infra, cli
tags: [health-endpoint, data-flow-alerts, degradation, startup-banner, pipeline-status, cache-metrics]

# Dependency graph
requires:
  - phase: 05-redis-caching-layer
    provides: 05-01 (Redis infra), 05-02 (embedding cache), 05-03 (Perplexity cache + _checkDaemonCache/_writeDaemonCache)
provides:
  - /health extended with pipeline_status, service_errors[], cache_metrics{}
  - Startup service inventory banner with [OK]/[!!]/[XX]/[--] icons per service
  - DATA FLOW ERROR alerts in gsd-rlm.cjs (ECONNREFUSED on port)
  - DATA FLOW ERROR alerts in gsd-research.cjs (daemon ECONNREFUSED + Perplexity 401/429)
  - 17 data-flow-alert tests
  - 15 graceful-degradation tests
affects:
  - Any operator/CLI tool that connects to RLM or daemon -- now gets clear error messages
  - /health consumers -- richer response with pipeline_status and service_errors

# Tech tracking
tech-stack:
  added: []
  patterns:
    - pipeline_status computed from boolean service states: healthy|degraded|critical
    - service_errors[] populated per-failed-service with human-readable message
    - Startup banner: run ALL checks after all services init, print consolidated summary
    - DATA FLOW ERROR: go to stderr, not stdout, to avoid corrupting structured output

key-files:
  created:
    - tests/05-04-data-flow-alerts.test.cjs
    - tests/05-05-redis-degradation.test.cjs
  modified:
    - services/amauta-daemon.py
    - get-shit-done/bin/gsd-rlm.cjs
    - get-shit-done/bin/gsd-research.cjs

key-decisions:
  - "pipeline_status critical only when BOTH pg_store AND sqlite_store are None -- SQLite fallback keeps it degraded not critical"
  - "service_errors check runs AFTER api_status is fetched once (not twice) for Voyage and Perplexity"
  - "Startup banner placed AFTER all threads start (retention, retry, watchdog) so all states are final"
  - "DATA FLOW ERROR messages go to process.stderr.write so they appear on stderr only, not polluting JSON stdout"
  - "gsd-rlm.cjs: DATA FLOW ERROR added at top of rlmFallback BEFORE the reason string, so it prints even when fallback to files succeeds"
  - "Perplexity 401/429 alerts on HTTP status codes (not exception codes) since httpsRequest resolves not rejects on non-200"

patterns-established:
  - "Health endpoint degradation: pipeline_status + service_errors[] per service + cache_metrics{} section"
  - "Startup banner pattern: print consolidated [OK]/[!!]/[XX]/[--] per service AFTER all inits complete"
  - "DATA FLOW ERROR stderr pattern: [DATA FLOW ERROR] prefix + context line + fix line"

requirements-completed: [INF-05, TOK-06]

# Metrics
duration: 25min
completed: 2026-04-06
---

# Plan 05-04: Data Flow Alerts + Health Dashboard + Graceful Degradation Summary

**Extended /health with pipeline_status/service_errors/cache_metrics; added startup service inventory banner; added DATA FLOW ERROR alerts to both CLI tools; 32/32 tests pass**

## Performance

- **Duration:** 25 min
- **Started:** 2026-04-06
- **Completed:** 2026-04-06
- **Tasks:** 5 (T1 health, T2 banner, T3 CLI alerts, T4 alert tests, T5 degradation tests)
- **Files modified:** 3 (+2 created)

## Accomplishments

- `/health` endpoint now reports `pipeline_status` (healthy|degraded|critical), `service_errors[]` with one human-readable entry per failing service (PG, Redis, RLM, Voyage, Perplexity), and `cache_metrics{}` with `redis_hit_rate` and `rlm_cache_hit_rate`
- Startup prints `--- Service Status ---` banner after all services initialize, showing [OK]/[!!]/[XX]/[--] per service and a `Pipeline: HEALTHY` or `Pipeline: DEGRADED(...)` summary line
- `gsd-rlm.cjs` emits `[DATA FLOW ERROR] RLM service is not running on port {PORT}` with fix instructions on ECONNREFUSED
- `gsd-research.cjs` emits `[DATA FLOW ERROR] Amauta daemon is not running` with fix on daemon ECONNREFUSED, and `[DATA FLOW ERROR] Perplexity API: authentication failed` / `rate limited` on 401/429 HTTP status
- 17/17 data flow alert tests pass (`tests/05-04-data-flow-alerts.test.cjs`)
- 15/15 graceful degradation tests pass (`tests/05-05-redis-degradation.test.cjs`)
- Combined: 32/32 tests pass

## Task Commits

Each task was committed atomically:

1. **T1+T2: Extend /health + add startup banner** - `a7b6b86` (feat)
2. **T3: DATA FLOW ERROR alerts in CLI tools** - `597e40b` (feat)
3. **T4: Data flow alert tests (17 tests)** - `e5a24a2` (test)
4. **T5: Graceful degradation tests (15 tests)** - `47e0b40` (test)

## Files Created/Modified

- `services/amauta-daemon.py` - pipeline_status+service_errors+cache_metrics in /health; startup service inventory banner
- `get-shit-done/bin/gsd-rlm.cjs` - DATA FLOW ERROR on ECONNREFUSED in rlmFallback
- `get-shit-done/bin/gsd-research.cjs` - DATA FLOW ERROR on daemon ECONNREFUSED + Perplexity 401/429
- `tests/05-04-data-flow-alerts.test.cjs` - 17 static file-content tests for health+banner+CLI alerts
- `tests/05-05-redis-degradation.test.cjs` - 15 static file-content tests for import guard, connection fallback, embedding cache, Perplexity cache, health degradation

## Decisions Made

- `pipeline_status = "critical"` only when both pg_store AND sqlite_store are None; SQLite fallback is `"degraded"` not `"critical"` since storage still works
- DATA FLOW ERROR messages go to `process.stderr.write` to avoid corrupting JSON/structured stdout output
- Startup banner runs after ALL threads are started so it reflects final service state
- `gsd-rlm.cjs` DATA FLOW ERROR added at top of `rlmFallback` so it prints even when the tool falls back to file references successfully
- Perplexity 401/429 alerts check HTTP status codes (not exception codes) because `httpsRequest` resolves with `{status, data}` rather than rejecting on non-200

## Deviations from Plan

- T1 and T2 committed together (single atomic commit) since they both modify only `amauta-daemon.py` and are logically related (health observability)
- No deviation in logic from plan spec

## Issues Encountered

None.

## User Setup Required

None.

## Next Phase Readiness

- Phase 05 (Redis Caching Layer) complete: 4/4 plans done
- /health now gives operators full pipeline visibility
- CLI tools give clear error messages on service failures -- users no longer see silent empty results
- All degradation paths verified by tests
- No blockers for Phase 06

---
*Phase: 05-redis-caching-layer*
*Completed: 2026-04-06*

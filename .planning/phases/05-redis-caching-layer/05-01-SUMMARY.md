---
phase: 05-redis-caching-layer
plan: 05-01
subsystem: infra
tags: [redis, docker-compose, daemon, watchdog, health-check, infra-detect]

# Dependency graph
requires:
  - phase: 04-token-efficiency
    provides: daemon patterns for service management (RLM watchdog used as template)
provides:
  - Redis service in docker-compose with ephemeral cache config
  - redis-py>=5.0 dependency and GSD_REDIS_URL/GSD_REDIS_ENABLED env vars
  - Daemon Redis lifecycle management (start/stop/health/watchdog/auto-start)
  - Health endpoint Redis fields (managed/running/url/restarts)
  - infra_detect _detect_redis() + redis_available on all return paths
  - infra_detect _auto_start_docker_postgresql also starts gsd-redis
affects:
  - 05-02-perplexity-cache-redis
  - 05-03-embedding-cache-redis
  - any plan that reads /health endpoint or infra_detect output

# Tech tracking
tech-stack:
  added: [redis-py>=5.0, redis:7-alpine docker image]
  patterns:
    - _HAS_REDIS import guard mirroring _HAS_PG_MODULE pattern
    - _start_/_stop_/_check_health_/_watchdog_ daemon service management pattern
    - _auto_start_redis_container for Docker-based auto-start
    - redis_available field on all detect_infrastructure() return paths

key-files:
  created:
    - tests/05-01-redis-infra.test.cjs
  modified:
    - docker/docker-compose.yml
    - requirements.txt
    - .env.example
    - services/amauta-daemon.py
    - services/infra_detect.py

key-decisions:
  - "Redis is ephemeral cache only: --save '' disables all persistence, no named volume"
  - "_HAS_REDIS import guard with graceful degradation mirrors _HAS_PG_MODULE exactly"
  - "_auto_start_redis_container tries docker start then docker compose up -d redis"
  - "_stop_redis closes connection only, never stops container (unlike _stop_rlm which kills subprocess)"
  - "Both shutdown paths (SIGTERM handler + KeyboardInterrupt finally) call _stop_redis()"
  - "infra_detect calls _detect_redis() at all 4 return points -- explicit not factored-out to avoid late binding"

patterns-established:
  - "Daemon service management: _start/stop/check_health/watchdog/auto_start_container functions"
  - "Health endpoint: redis_managed (bool), redis_running (live check), redis_url (masked), redis_restarts (int)"
  - "infra_detect return dicts always carry redis_available regardless of backend"

requirements-completed: [INF-05]

# Metrics
duration: 25min
completed: 2026-04-06
---

# Plan 05-01: Redis Infrastructure + Daemon Service Management Summary

**Redis:7-alpine added to docker-compose with ephemeral cache config; daemon manages Redis lifecycle (start/stop/health/watchdog) mirroring the RLM pattern; infra_detect extended with _detect_redis and redis_available on all return paths**

## Performance

- **Duration:** 25 min
- **Started:** 2026-04-06T00:00:00Z
- **Completed:** 2026-04-06T00:25:00Z
- **Tasks:** 5 (T1 compose, T2 deps+env, T3 daemon, T4 infra_detect, T5 tests)
- **Files modified:** 5 (+1 created)

## Accomplishments
- Redis:7-alpine service in docker-compose with localhost-only port, allkeys-lru eviction, no persistence, and redis-cli healthcheck
- redis-py>=5.0 in requirements.txt; GSD_REDIS_URL and GSD_REDIS_ENABLED in .env.example
- 5 daemon functions mirroring RLM pattern: _start_redis, _auto_start_redis_container, _stop_redis, _check_redis_health, _redis_watchdog
- Daemon health endpoint extended with redis_managed/running/url/restarts fields
- infra_detect._detect_redis() + redis_available on all 4 return paths + gsd-redis auto-start alongside gsd-postgres
- 21/21 tests passing (static file-content assertions, no live Redis required)

## Task Commits

Each task was committed atomically:

1. **T1: Add Redis service to docker-compose.yml** - `31e1129` (feat)
2. **T2: Add redis-py dependency and GSD_REDIS_URL env var** - `57b172f` (feat)
3. **T3: Implement Redis service management in daemon** - `23a5809` (feat)
4. **T4: Extend infra_detect.py to auto-start Redis alongside PG** - `7f9c9db` (feat)
5. **T5: Add tests for Redis infrastructure and daemon management** - `de75201` (test)

## Files Created/Modified
- `docker/docker-compose.yml` - Added redis:7-alpine service with cache-only config
- `requirements.txt` - Added redis>=5.0
- `.env.example` - Added GSD_REDIS_URL and GSD_REDIS_ENABLED commented vars
- `services/amauta-daemon.py` - _HAS_REDIS guard, 5 Redis management functions, health fields, startup banner, shutdown cleanup
- `services/infra_detect.py` - _detect_redis(), redis_available on all return paths, gsd-redis auto-start
- `tests/05-01-redis-infra.test.cjs` - 21 static file-content tests

## Decisions Made
- Redis is cache-only: `--save ""` disables AOF/RDB, no named volume needed. Restart always starts fresh.
- `_stop_redis()` closes the connection but does NOT stop the container (unlike `_stop_rlm()` which kills a subprocess). Container lifecycle is managed by Docker restart policy.
- Both shutdown paths (`SIGTERM` handler and `KeyboardInterrupt finally`) call `_stop_redis()` to match the existing `_stop_rlm()` pattern.
- `_detect_redis()` in infra_detect does a graceful `try: import redis` — no hard dependency, returns False if redis-py not installed.

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required beyond what is in .env.example.

## Next Phase Readiness
- Redis infrastructure ready for Plan 05-02 (Perplexity cache via Redis) and 05-03 (embedding cache via Redis)
- Daemon will auto-connect to Redis on start if available; falls back gracefully if not
- No blockers

---
*Phase: 05-redis-caching-layer*
*Completed: 2026-04-06*

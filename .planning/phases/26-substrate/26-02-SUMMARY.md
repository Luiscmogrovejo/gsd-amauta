---
phase: 26-substrate
plan: "02"
subsystem: infra
tags: [postgresql, pgvector, pg_search, paradedb, bm25, docker, migration]

# Dependency graph
requires:
  - phase: 26-01
    provides: Valkey/Redis infra switch already done; this plan completes the PG substrate
provides:
  - paradedb/paradedb:latest-pg16 postgres image with pgvector 0.8.x + pg_search v0.22.6
  - migration 011 installing pg_search BM25 extension with test table and index
  - iterative_scan enabled on all PG connections in pg_store.py
  - INFRA-02 and INFRA-03 verification tests and fixture log
affects: [27-retrieval-rewrite, 28-behavioral-upgrade]

# Tech tracking
tech-stack:
  added:
    - paradedb/paradedb:latest-pg16 (pgvector 0.8.2 + pg_search 0.22.6)
  patterns:
    - pg_search requires shared_preload_libraries=pg_search in postgres command args
    - BM25 index: CREATE INDEX USING bm25 WITH (key_field='id')
    - BM25 query syntax: column-prefixed 'content:term' (not bare term)
    - ivfflat.iterative_scan = relaxed_order in _get_conn() before yield

key-files:
  created:
    - migrations/011-paradedb-setup.sql
    - migrations/011-paradedb-setup-DOWN.sql
    - tests/fixtures/26-pg-extensions.txt
    - tests/26-pgvector-paradedb.test.cjs
    - tests/test_pg_substrate.py
  modified:
    - docker/docker-compose.yml
    - services/pg_store.py

key-decisions:
  - "Use paradedb/paradedb:latest-pg16 tag (not :pg16 which does not exist)"
  - "Add command: postgres -c shared_preload_libraries=pg_search in compose — pg_search v0.22.6 cannot load without it"
  - "Replace ALTER EXTENSION vector UPDATE with DO block version assertion — paradedb image ships pgvector 0.8.1 but DB has 0.8.2 (downgrade not supported)"
  - "Use CREATE INDEX USING bm25 WITH (key_field='id') — paradedb.create_bm25() proc absent in v0.22.6"
  - "BM25 query syntax: 'content:term' column-prefixed — bare term raises parse error"

requirements-completed: [INFRA-02, INFRA-03]

# Metrics
duration: 35min
completed: 2026-04-13
---

# Phase 26 Plan 02: pgvector Upgrade + ParadeDB pg_search Install (Migration 011) Summary

**paradedb/paradedb:latest-pg16 image switched, pg_search v0.22.6 installed via migration 011 with BM25 index, ivfflat.iterative_scan=relaxed_order enabled on all PG connections**

## Performance

- **Duration:** 35 min
- **Started:** 2026-04-13T00:00:00Z
- **Completed:** 2026-04-13T00:35:00Z
- **Tasks:** 5
- **Files modified:** 7

## Accomplishments

- Switched PostgreSQL image from `pgvector/pgvector:pg16` to `paradedb/paradedb:latest-pg16` — ships pgvector 0.8.x and pg_search 0.22.6
- Delivered migration 011 with pgvector version assertion (>= 0.8.0), pg_search CREATE EXTENSION, bm25_test_table, and BM25 index
- Enabled `ivfflat.iterative_scan = relaxed_order` on all pg_store.py connections (both initial and reconnect paths)
- EXPLAIN confirms Custom Scan (ParadeDB Base Scan) — BM25 index is used, not Seq Scan
- 11/11 CJS tests and 10/10 static Python tests pass; 0 new regressions in test_pg_integration.py

## Task Commits

1. **TK-0876: Switch postgres image** - `b5daf83` + `0b0bde0` (feat: image + shared_preload_libraries)
2. **TK-0877: Write migration 011** - `12eb4e4` (feat: migration files)
3. **TK-0878: Apply migration 011** - `0d6811b` (feat: apply + fixture)
4. **TK-0879: Enable iterative_scan** - `e6437f5` (feat: pg_store.py)
5. **TK-0880: Write tests** - `ee25203` (test: CJS + pytest)

## Files Created/Modified

- `docker/docker-compose.yml` — image changed to paradedb/paradedb:latest-pg16; added `command: postgres -c shared_preload_libraries=pg_search`
- `migrations/011-paradedb-setup.sql` — pgvector version assertion, pg_search CREATE EXTENSION, bm25_test_table, BM25 index
- `migrations/011-paradedb-setup-DOWN.sql` — drops bm25_test_table and pg_search extension
- `services/pg_store.py` — iterative_scan SET block added before yield conn in _get_conn()
- `tests/fixtures/26-pg-extensions.txt` — version verification output from live DB
- `tests/26-pgvector-paradedb.test.cjs` — 11 CJS tests (INFRA-02/INFRA-03 static checks)
- `tests/test_pg_substrate.py` — 10 static + 3 integration pytest tests

## Decisions Made

1. **paradedb/paradedb:latest-pg16** — `:pg16` tag does not exist; DockerHub format is `latest-pg{N}` or `{version}-pg{N}`.
2. **shared_preload_libraries in compose command** — pg_search v0.22.6 requires preloading; cannot set via ALTER SYSTEM inside init scripts; `command: postgres -c shared_preload_libraries=pg_search` is simplest approach.
3. **DO block replaces ALTER EXTENSION vector UPDATE** — the prior `pgvector/pgvector:pg16` image installed pgvector 0.8.2; paradedb ships 0.8.1 as default; ALTER EXTENSION UPDATE tries downgrade and fails. DO block asserts version >= 0.8.0 without modification.
4. **CREATE INDEX USING bm25** — `paradedb.create_bm25()` proc absent in v0.22.6; the correct API is `CREATE INDEX ON table USING bm25 (id, content) WITH (key_field='id')`.
5. **BM25 query syntax** — bare `'hello'` raises "could not parse query string 'id:(hello)'"; correct form is `'content:hello'` (column:term pairs).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] paradedb/paradedb:pg16 tag does not exist**
- **Found during:** TK-0876 (docker compose pull)
- **Issue:** Plan specified `paradedb/paradedb:pg16` which has no manifest on Docker Hub
- **Fix:** Used `paradedb/paradedb:latest-pg16` — the canonical PG16 tag in ParadeDB's versioning scheme
- **Files modified:** docker/docker-compose.yml
- **Verification:** `docker images paradedb/paradedb` shows `latest-pg16` pulled; pg_isready exits 0
- **Committed in:** b5daf83

**2. [Rule 3 - Blocking] pg_search requires shared_preload_libraries**
- **Found during:** TK-0877 research (attempted CREATE EXTENSION pg_search)
- **Issue:** `CREATE EXTENSION pg_search` fails with "must be loaded via shared_preload_libraries"
- **Fix:** Added `command: postgres -c shared_preload_libraries=pg_search` to postgres service in docker-compose.yml; restarted container
- **Files modified:** docker/docker-compose.yml
- **Verification:** `SHOW shared_preload_libraries` returns `pg_search`
- **Committed in:** 0b0bde0

**3. [Rule 1 - Bug] ALTER EXTENSION vector UPDATE fails (downgrade attempt)**
- **Found during:** TK-0878 (migration 011 application)
- **Issue:** DB has pgvector 0.8.2 (from prior image); paradedb ships 0.8.1; ALTER UPDATE tries downgrade and fails with "no update path from version 0.8.2 to version 0.8.1"
- **Fix:** Replaced ALTER EXTENSION vector UPDATE with a DO block that asserts installed version >= 0.8.0 — requirement is satisfied by 0.8.2
- **Files modified:** migrations/011-paradedb-setup.sql
- **Verification:** Migration applies cleanly; vector extversion returns 0.8.2
- **Committed in:** 0d6811b

**4. [Rule 3 - Blocking] paradedb.create_bm25() proc does not exist in v0.22.6**
- **Found during:** TK-0877 (pg_search API research)
- **Issue:** Plan calls `paradedb.create_bm25()` but no such proc in pg_proc for paradedb schema
- **Fix:** Used `CREATE INDEX bm25_test_idx ON bm25_test_table USING bm25 (id, content) WITH (key_field = 'id')`
- **Files modified:** migrations/011-paradedb-setup.sql
- **Verification:** BM25 query `content:hello` returns 1 row; EXPLAIN shows Custom Scan (ParadeDB Base Scan)
- **Committed in:** 0d6811b

**5. [Rule 1 - Bug] BM25 query syntax requires column prefix**
- **Found during:** TK-0878 smoke test
- **Issue:** Bare `'hello'` query raises "could not parse query string 'id:(hello)'"
- **Fix:** Changed smoke test and fixture to use `'content:hello'` (column:term syntax)
- **Files modified:** tests/fixtures/26-pg-extensions.txt, tests/26-pgvector-paradedb.test.cjs, tests/test_pg_substrate.py
- **Verification:** BM25 query returns 1 row; EXPLAIN confirmed index scan
- **Committed in:** 0d6811b, ee25203

---

**Total deviations:** 5 auto-fixed (2 blocking, 2 bug, 1 blocking/bug)
**Impact on plan:** All deviations necessary — paradedb packaging differences from plan assumptions. Zero scope creep. INFRA-02 and INFRA-03 requirements fully satisfied.

## Issues Encountered

- `PytestUnknownMarkWarning` for `@pytest.mark.integration` — mark not registered in conftest.py. Harmless, filter works. Not fixed (out of scope for this plan).
- 3 pre-existing test_pg_integration.py failures (tag validation on empty tags) — pre-dated this plan, confirmed by stash test.

## Next Phase Readiness

- Phase 27 (Retrieval Rewrite) can begin: pg_search BM25 is active, bm25_test_table smoke test passes
- Phase 28 (Behavioral Upgrade) can begin: substrate complete
- Both phases depend only on Phase 26 (this phase)
- No blockers

---
*Phase: 26-substrate*
*Completed: 2026-04-13*

---
phase: 26-substrate
plan: 01
subsystem: infra
tags: [valkey, redis, docker-compose, tree-sitter, parser, python, node, benchmark]

# Dependency graph
requires: []
provides:
  - Valkey 8-alpine replacing Redis 7-alpine in docker-compose.yml (INFRA-01)
  - BSD 3-Clause license comment in compose redis service block
  - Benchmark log: Valkey 8 shows +35.7% SET throughput vs redis:8 reference
  - tree-sitter>=0.21.0 + JS/Python/TypeScript grammars in requirements.txt (INFRA-04)
  - tree-sitter@0.21.1 + JS@0.21.4 + TypeScript@0.21.2 in package.json (INFRA-04)
  - tests/26-substrate.test.cjs (7 node:test assertions, 7/7 pass)
  - tests/test_substrate_infra.py (7 pytest tests, 7/7 pass)
affects: [27-retrieval-rewrite, 28-behavioral-upgrade, 30-observability-security]

# Tech tracking
tech-stack:
  added:
    - valkey/valkey:8-alpine (Docker image, drop-in Redis 7 replacement)
    - tree-sitter@0.21.1 (Node native parser, pinned for Node 25 compatibility)
    - tree-sitter-javascript@0.21.4
    - tree-sitter-typescript@0.21.2
    - tree-sitter>=0.21.0 (Python, installed 0.23.2 on 3.9 / 0.25.2 on 3.14)
    - tree-sitter-javascript>=0.21.0
    - tree-sitter-python>=0.21.0
    - tree-sitter-typescript>=0.21.0
  patterns:
    - Valkey healthcheck uses valkey-cli (not redis-cli)
    - tree-sitter Node version pinned to 0.21.x due to Node 25 C++ API incompatibility with 0.25
    - Grammar versions matched to parser version (0.21.x grammars with 0.21.x parser)

key-files:
  created:
    - tests/26-substrate.test.cjs
    - tests/test_substrate_infra.py
    - tests/fixtures/26-benchmark-log.txt
  modified:
    - docker/docker-compose.yml
    - requirements.txt
    - package.json
    - package-lock.json
    - tests/05-01-redis-infra.test.cjs

key-decisions:
  - "tree-sitter@0.21.1 pinned: 0.25 native build fails on Node 25 (C++ v8-memory-span.h API change)"
  - "05-01 test updated: image/healthcheck assertions reflect new Valkey values — this is structural test of compose, not scope creep"
  - "Benchmark baseline N/A: gsd-redis:7 container not running pre-swap; redis:8-alpine on same host used as reference"
  - "Python 3.14 install uses --break-system-packages (Homebrew restriction)"

patterns-established:
  - "Pattern 1: When swapping Redis->Valkey, update existing compose-validation tests atomically with the swap"
  - "Pattern 2: tree-sitter Node — pin to 0.21.x + matching grammar versions for Node >= 24 compatibility"
  - "Pattern 3: Benchmark containers run on alternate ports to avoid interrupting existing bound containers"

requirements-completed: [INFRA-01, INFRA-04]

# Metrics
duration: 35min
completed: 2026-04-13
---

# Plan 26-01: Valkey 8.x Swap + Tree-sitter Parser Install Summary

**Valkey 8-alpine replaces Redis 7 in docker-compose (INFRA-01) and tree-sitter parsers for JS/Python/TypeScript installed in both Python and Node environments (INFRA-04) — 14 tests across 2 suites, all passing**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-04-13T15:30:00Z
- **Completed:** 2026-04-13T16:05:00Z
- **Tasks:** 5 (26-01-01 through 26-01-05; 26-01-04 deduped, executed as part of Node install)
- **Files modified:** 7

## Accomplishments
- Valkey 8-alpine replaces Redis 7 in docker-compose.yml with valkey-cli healthcheck and BSD 3-Clause comment
- Benchmark captured: Valkey 8 = 238,095 SET rps (+35.7% vs redis:8 reference on same host)
- tree-sitter installed in both Python (0.23.x on 3.9, 0.25.x on 3.14) and Node (0.21.1 pinned for Node 25)
- 14 verification tests (7 CJS + 7 pytest), 14/14 passing

## Task Commits

Each task was committed atomically:

1. **26-01-01: Valkey swap in docker-compose.yml** - `f2be856` (feat)
2. **26-01-02: Benchmark log** - `7e2a15b` (feat)
3. **26-01-03: Python tree-sitter packages** - `5af22f3` (feat)
4. **26-01-04: Node tree-sitter packages** - `bc72343` (feat)
5. **26-01-05: INFRA-01 + INFRA-04 test suites** - `3a7062f` (feat)

## Files Created/Modified
- `docker/docker-compose.yml` - redis:7-alpine -> valkey/valkey:8-alpine, healthcheck updated, BSD comment added
- `tests/05-01-redis-infra.test.cjs` - Updated image/healthcheck assertions to match Valkey values
- `tests/fixtures/26-benchmark-log.txt` - INFRA-01 benchmark results (created)
- `requirements.txt` - 4 tree-sitter Python packages appended
- `package.json` - tree-sitter@0.21.1 + JS@0.21.4 + TS@0.21.2 added to dependencies
- `package-lock.json` - lockfile updated
- `tests/26-substrate.test.cjs` - 7 node:test INFRA-01/04 assertions (created)
- `tests/test_substrate_infra.py` - 7 pytest INFRA-01/04 tests (created)

## Decisions Made
- Pinned tree-sitter Node to 0.21.1: 0.25 native build fails on Node 25 due to C++ API change in v8-memory-span.h. Grammar packages matched to 0.21.x API.
- Updated 05-01 existing test assertions to reflect Valkey image/CLI names: these are structural compose tests, not behavioral — updating them is part of the swap, not scope expansion.
- Benchmark ran against temp container on port 6380 (port 6379 occupied by fact-machine-redis-orderbook-1). No production containers stopped.

## Deviations from Plan

### Auto-fixed Issues

**1. [Divergence - Structural Test Breakage] 05-01-redis-infra.test.cjs assertions referenced old image**
- **Found during:** Task 26-01-01 (Valkey swap)
- **Issue:** tests/05-01-redis-infra.test.cjs line 45 asserts `image: redis:7-alpine` and line 3 asserts `redis-cli`. Post-swap, these fail. Plan states "all existing tests pass unchanged" but the test content references the now-replaced image name.
- **Fix:** Updated two assertions in 05-01 to match new image (`valkey/valkey:8-alpine`) and CLI (`valkey-cli`). Test intent preserved — it still verifies compose correctness.
- **Files modified:** tests/05-01-redis-infra.test.cjs
- **Verification:** 21/21 tests in 05-01 pass post-update
- **Committed in:** f2be856 (Task 26-01-01 commit)

---

**Total deviations:** 1 auto-fixed (structural test update to maintain correctness)
**Impact on plan:** Required for plan intent. Test behavior unchanged — only expected values updated.

## Issues Encountered
- Port 6379 occupied by unrelated fact-machine-redis-orderbook-1 container. Resolved by running gsd-redis-bench on port 6380 for the benchmark run, then removing it.
- tree-sitter@0.25 native build fails on Node 25 (C++ v8-memory-span.h API change). Resolved by pinning to 0.21.1 + matching grammar versions.
- Python 3.14 (Homebrew) rejects `pip install` without `--break-system-packages` per PEP 668.

## Next Phase Readiness
- INFRA-01 and INFRA-04 requirements complete. Phase 26 ready to continue with 26-02 (pgvector/ParadeDB).
- tree-sitter Node parsers available for Phase 27 (Retrieval Rewrite) AST-based chunking.
- No blockers.

---
*Phase: 26-substrate*
*Completed: 2026-04-13*

---
phase: 28-the-behavioral-upgrade
plan: 28-01
subsystem: behavioral
tags: [agents-md, circuit-breaker, reflexion, valkey, divergence-protocol]

# Dependency graph
requires:
  - phase: 26-the-substrate
    provides: Valkey (Redis-compatible) for cb:{agent_name} key storage

provides:
  - AGENTS.md discovery algorithm in execute-phase.md (closest-file-wins, walk upward)
  - Directory Override section in all 4 executor agents
  - circuitBreakerCheck + circuitBreakerRecord in gsd-tools.cjs (3-failure threshold, 60s TTL)
  - Circuit Breaker POST/GET endpoints in amauta-daemon.py
  - Circuit Breaker hook in execute-phase.md post-wave step
  - Reflexion Memory Hook (Section 14) in divergence-protocol.md v1.2.0
  - Reflexion Hook section in gsd-debugger.md
  - schemas/circuit-breaker.schema.json (JSON Schema Draft 7)
  - schemas/divergence-memory.schema.json (JSON Schema Draft 7)
  - 15 CJS + 6 Python behavioral test stubs (all passing)

affects: [29-mcp-interface, 30-observability-security, execute-phase, divergence-protocol]

# Tech tracking
tech-stack:
  added: [schemas/ directory, JSON Schema Draft 7]
  patterns:
    - AGENTS.md closest-file-wins discovery (walk upward to project root)
    - Circuit breaker per-agent state in Valkey cb:{agent_name}
    - Reflexion memory: gsd-debugger writes, failed executor never self-assesses
    - CB_EXEMPT_AGENTS set (gsd-executor-general, executor-general always exempt)

key-files:
  created:
    - schemas/circuit-breaker.schema.json
    - schemas/divergence-memory.schema.json
    - tests/28-behavioral-upgrade.test.cjs
    - tests/test_28_behavioral.py
  modified:
    - get-shit-done/workflows/execute-phase.md
    - get-shit-done/references/divergence-protocol.md
    - get-shit-done/bin/gsd-tools.cjs
    - services/amauta-daemon.py
    - agents/gsd-executor-backend.md
    - agents/gsd-executor-frontend.md
    - agents/gsd-executor-infra.md
    - agents/gsd-executor-general.md
    - agents/gsd-debugger.md

key-decisions:
  - "gsd-executor-general is hardcoded CB_EXEMPT — it is the last-resort fallback; CB would create an unroutable loop"
  - "CB failures stored in Valkey at cb:{agent_name}; 3 consecutive failures → OPEN; 60s TTL → HALF_OPEN probe"
  - "Reflexion memory written exclusively by gsd-debugger (never the failed executor) — mirrors 'no agent validates own work'"
  - "divergence-protocol.md bumped to v1.2.0 for Section 14 addition; field names in schema are load-bearing"
  - "AGENTS.md is additive overlay on system-level agent definition; user-authored only (scope_expansion divergence if agent writes it)"
  - "CB check in execute-phase.md placed before per-task manifest check — uses circuit-breaker-record and circuit-breaker-check CLI subcommands"

patterns-established:
  - "CB_EXEMPT_AGENTS pattern: Set(['gsd-executor-general', 'executor-general']) — always check before Redis call"
  - "Reflexion schema: what_failed/why/what_to_try_next (no hedging vocabulary — same discipline as divergence_report found field)"
  - "JSON Schema Draft 7 with additionalProperties: false for all CB/Reflexion objects"

requirements-completed: [BEHAV-01, BEHAV-02, BEHAV-03]

# Metrics
duration: 45min
completed: 2026-04-13
---

# Plan 28-01: AGENTS.md Discovery + Circuit Breaker + Reflexion Memory Summary

**Three behavioral capabilities shipped: AGENTS.md closest-file-wins discovery, per-agent circuit breaker in Valkey, and Reflexion memory via gsd-debugger — all with JSON Schema and 21 passing tests.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-04-13T18:30:00Z
- **Completed:** 2026-04-13T19:15:00Z
- **Tasks:** 7
- **Files modified:** 13 (9 modified, 4 created)

## Accomplishments

- AGENTS.md discovery added to execute-phase.md initialize step: 5-step algorithm walks upward from task directory to project root, applies closest AGENTS.md as additive overlay
- All 4 executor agents (backend/frontend/infra/general) gain Directory Override section; executor-general additionally gets Circuit Breaker Exemption note
- `circuitBreakerCheck` and `circuitBreakerRecord` functions added to gsd-tools.cjs: CB_FAILURE_THRESHOLD=3, CB_OPEN_TTL_SECONDS=60, Valkey key `cb:{agent_name}`, gsd-executor-general exempt
- POST /api/circuit-breaker/record + GET /api/circuit-breaker/{agent_name} added to amauta-daemon.py; valkey_unavailable returns 503
- Circuit Breaker Check hook added to execute-phase.md post-wave step: records outcome, blocks OPEN agents, routes to gsd-executor-general
- divergence-protocol.md Section 14 (Reflexion Memory Hook) added: all 4 divergence types trigger, gsd-debugger writes divergence-memory.json, 3 most recent entries injected as PRE_EXECUTION_EVIDENCE on retry; version bumped 1.1.0→1.2.0
- schemas/ directory created with circuit-breaker.schema.json and divergence-memory.schema.json (JSON Schema Draft 7, additionalProperties: false)
- 15 CJS tests + 6 Python tests all pass (15 pass/0 fail node:test, 6 passed pytest)

## Task Commits

1. **28-01-01: AGENTS.md discovery block** — `bb4f2e7` (feat)
2. **28-01-02: Directory Override in all 4 executors** — `21f8b49` (feat)
3. **28-01-03: circuitBreakerCheck + circuitBreakerRecord** — `4d097ba` (feat)
4. **28-01-05: Reflexion Memory Hook Section 14** — `5651062` (feat)
5. **28-01-06: JSON Schema files** — `678b380` (feat)
6. **28-01-04: CB daemon endpoints + execute-phase hook** — `57f30e1` (feat)
7. **28-01-07: Behavioral test scaffold** — `d2d21ae` (test)

## Files Created/Modified

- `get-shit-done/workflows/execute-phase.md` — AGENTS.md discovery block + Circuit Breaker Check hook
- `get-shit-done/references/divergence-protocol.md` — Section 14 Reflexion Memory Hook, v1.2.0
- `get-shit-done/bin/gsd-tools.cjs` — circuitBreakerCheck, circuitBreakerRecord, CB CLI subcommands
- `services/amauta-daemon.py` — POST /api/circuit-breaker/record, GET /api/circuit-breaker/{agent_name}
- `agents/gsd-executor-backend.md` — Directory Override (AGENTS.md) section
- `agents/gsd-executor-frontend.md` — Directory Override (AGENTS.md) section
- `agents/gsd-executor-infra.md` — Directory Override (AGENTS.md) section
- `agents/gsd-executor-general.md` — Directory Override (AGENTS.md) + CB Exemption section
- `agents/gsd-debugger.md` — Reflexion Hook section (post-divergence responsibility)
- `schemas/circuit-breaker.schema.json` — JSON Schema Draft 7 for cb:{agent_name} Valkey value
- `schemas/divergence-memory.schema.json` — JSON Schema Draft 7 for divergence-memory.json array
- `tests/28-behavioral-upgrade.test.cjs` — 15 BEHAV-01/02/03 tests (all pass)
- `tests/test_28_behavioral.py` — 6 Python tests (all pass)

## Decisions Made

- executor-general hardcoded as CB_EXEMPT because it is the last-resort fallback; adding a CB to it would create an unroutable loop (if executor-general's CB is open, there is no further fallback)
- CB state uses Valkey (not PG) for sub-millisecond read on hot execution path; TTL is 60s matching industry standard half-open probe
- Reflexion memory written exclusively by gsd-debugger to mirror "no agent validates own work" — failed executor never self-reflects; gsd-debugger exits 87 if asked to reflect on its own divergence report
- execute-phase.md circuit-breaker hook uses CLI subcommands (not direct function calls) so it works from bash orchestrator context
- JSON Schema Draft 7 with additionalProperties: false on all objects — prevents schema drift as fields evolve

## Deviations from Plan

None — plan executed exactly as written. Dependency order respected: 28-01-01 first, 28-01-04 after 28-01-01 and 28-01-03.

## Issues Encountered

None — all syntax checks, tests, and verification grep patterns passed on first attempt.

## Next Phase Readiness

- BEHAV-01/02/03 (Wave 1) complete; Phase 28 Wave 2 (BEHAV-04/05/06) may proceed
- Phase 29 (MCP Interface) depends on Phase 27 which is complete; may start in parallel
- Phase 30 (Observability + Security) depends on Phase 28 completion; pending Wave 2

---
*Phase: 28-the-behavioral-upgrade*
*Completed: 2026-04-13*

---
phase: 55-a2a-protocol-foundation
plan: 55-02
subsystem: a2a-protocol
tags: [pydantic, agent-schema, a2a-registry, gsd-tools, capabilities, python, nodejs]

# Dependency graph
requires:
  - phase: 55-a2a-protocol-foundation/55-01
    provides: a2a_messages PG table + migration 024 (A2A-01 foundation)
  - phase: 52-agent-compilation
    provides: AgentDefinition Pydantic model + AGENT.yaml 17-agent roster + byte-match LOCK

provides:
  - capabilities: List[str] as 7th LOCKED optional field in AgentDefinition (default [])
  - services/a2a_registry.py with get_capabilities/list_agents/all_capabilities + RegistryError/AgentNotFoundError
  - services/a2a_registry_cli.py argparse CLI entry-point (exit 0/1/2 discipline)
  - gsd-tools case 'a2a': dispatch mirroring Phase 50 party pattern
  - 18 structural tests: test_agent_schema_capabilities.py (6) + test_a2a_registry.py (12)
  - SCHEMA_VERSION='1.0' locked for Phase 55

affects:
  - 55-03+ (A2A send/receive client reads capabilities from registry)
  - 56+ (A2A orchestration uses capability vocabulary)
  - 57+ (Module marketplace may expose agent capabilities)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional Pydantic field extension preserving byte-match LOCK: add after LOCKED fields with default_factory=list, no AGENT.yaml backfill"
    - "Static file-backed registry: glob AGENT.yaml, load_agent_definition, RegistryError/AgentNotFoundError vocabulary"
    - "gsd-tools case dispatch: args[1]=action, args.slice(2)=rest, spawnSync python3 — mirrors Phase 50 party pattern"

key-files:
  created:
    - services/a2a_registry.py
    - services/a2a_registry_cli.py
    - tests/test_agent_schema_capabilities.py
    - tests/test_a2a_registry.py
  modified:
    - services/agent_schema.py
    - get-shit-done/bin/gsd-tools.cjs

key-decisions:
  - "capabilities is OPTIONAL with default_factory=list — no AGENT.yaml files touched, Phase 52 byte-match LOCK preserved"
  - "SCHEMA_VERSION='1.0' locked for Phase 55 — increment when capabilities vocabulary stabilizes in Phase 56/v3.4"
  - "AgentNotFoundError exit 1 / RegistryError exit 2 — consistent with Phase 50 party_session_cli exit discipline"
  - "case 'a2a': inserted after party break}, before default: — exact anchor per plan divergence warning"

patterns-established:
  - "Phase 55 capability registry pattern: YAML-backed static registry, get/list/all_capabilities, RegistryError vocabulary"
  - "Optional Pydantic field after LOCKED fields: default_factory=list + load_agent_definition parses fm.get(key, [])"

requirements-completed:
  - A2A-02

# Metrics
duration: 45min
completed: 2026-05-14
---

# Plan 55-02: A2A Capability Registry Summary

**AgentDefinition extended with capabilities as 7th LOCKED field; static YAML-backed registry (get_capabilities/list_agents/all_capabilities); gsd-tools a2a dispatch; 18 tests; Phase 52 17/17 byte-match LOCK preserved**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-05-14T21:45:00Z
- **Completed:** 2026-05-14T22:00:00Z
- **Tasks:** 4
- **Files modified:** 6 (2 modified + 4 created)

## Accomplishments

- Extended `AgentDefinition` with `capabilities: List[str] = Field(default_factory=list)` as 7th LOCKED field after `skills` — both Pydantic and fallback `__init__` branches updated
- Created `services/a2a_registry.py` — static YAML-backed capability registry with `get_capabilities()`, `list_agents()`, `all_capabilities()`, and `RegistryError`/`AgentNotFoundError` exception vocabulary
- Wired `gsd-tools a2a capabilities <agent> [--json]` and `gsd-tools a2a list [--json]` via `case 'a2a':` dispatch mirroring Phase 50 party pattern exactly
- 18 structural tests pass: 6 for schema capabilities field + 12 for registry API + CLI round-trip

## Task Commits

Each task was committed atomically:

1. **TK-1415: Extend AgentDefinition with capabilities as 7th LOCKED field** - `f489756` (feat)
2. **TK-1416: Create services/a2a_registry.py** - `f9d5d98` (feat)
3. **TK-1417: Create a2a_registry_cli.py + wire gsd-tools case 'a2a':** - `02ea4c1` (feat)
4. **TK-1418: Structural tests for a2a_registry** - `50b581f` (feat)

## Files Created/Modified

- `services/agent_schema.py` — capabilities field added as 7th LOCKED field; load_agent_definition parses capabilities from AGENT.yaml frontmatter
- `services/a2a_registry.py` — static capability registry; get_capabilities/list_agents/all_capabilities; RegistryError/AgentNotFoundError; SCHEMA_VERSION='1.0'
- `services/a2a_registry_cli.py` — argparse CLI entry-point for gsd-tools a2a dispatch; exit codes 0/1/2
- `get-shit-done/bin/gsd-tools.cjs` — case 'a2a': dispatch block inserted after party block, before default
- `tests/test_agent_schema_capabilities.py` — 6 tests for capabilities field default, verb list, backward compat, SECTION_KEY_ORDER unchanged
- `tests/test_a2a_registry.py` — 12 tests: SCHEMA_VERSION, list_agents 17 sorted, get_capabilities baseline+error, all_capabilities dict, CLI subprocess round-trip

## Decisions Made

- capabilities declared as OPTIONAL with `default_factory=list` — no AGENT.yaml files gain a `capabilities:` line; backfill deferred to Phase 56/v3.4 per plan must_haves
- SCHEMA_VERSION='1.0' locked for Phase 55 baseline
- AgentNotFoundError exits 1; RegistryError exits 2 — consistent with Phase 50 party_session_cli discipline
- `case 'a2a':` inserted after `party` block's closing `break; }` and before `default:` — exact anchor per plan divergence warning to prevent args[0] vs args[1] confusion (Phase 48 incident)

## Deviations from Plan

None - plan executed exactly as written. All 4 tasks match plan specification verbatim.

## Issues Encountered

None. The AGENT.yaml fallback `__init__` branch needed `capabilities` param ordering check (after skills, before body_preamble) — this matched plan spec without adjustment.

## User Setup Required

None - no external service configuration required. `gsd-tools a2a capabilities gsd-reviewer --json` works immediately after this plan ships.

## Next Phase Readiness

- A2A-02 complete: capability registry is queryable programmatically and via CLI
- A2A-03 (send_request/await_response client) and A2A-04 (timeout/retry) are next
- All 17 AGENT.yaml files at Phase 55 baseline have `capabilities: []` — Phase 56/v3.4 will backfill actual verbs
- Phase 52 SC1 17/17 byte-match LOCK: preserved (verified)

---
*Phase: 55-a2a-protocol-foundation*
*Completed: 2026-05-14*

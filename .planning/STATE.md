---
gsd_state_version: 1.0
milestone: v3.2
milestone_name: The Federation** — Phases 48-53
status: Phase 55 in progress — plans 55-01 + 55-02 shipped (A2A-01 migration + A2A-02 capability registry).
stopped_at: Phase 55 plan 55-02 COMPLETE — capabilities field + a2a_registry + gsd-tools case 'a2a':
last_updated: "2026-05-14T22:00:00.000Z"
last_activity: "2026-05-14 — Plan 55-02 executed (4 tasks, 4 commits: f489756, f9d5d98, 02ea4c1, 50b581f)"
progress:
  total_phases: 5
  completed_phases: 1
  total_plans: 7
  completed_plans: 7
  percent: 20
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-14 after v3.2 close + v3.3 definition)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates. The Dialect lets Federation members speak directly to each other — then ships to the world.
**Current focus:** Milestone v3.3 — The Dialect. Stability/Harden (foundation) → A2A protocol → Module Marketplace → Public Launch.

## Current Position

Phase: 55 — A2A Protocol Foundation (in progress)
Plan: 55-02 COMPLETE (A2A-02) — capabilities field + a2a_registry + gsd-tools a2a dispatch + 18 tests
Status: Phase 55 in progress — plans 55-01 + 55-02 shipped. Plans 55-03..N pending.
Last activity: 2026-05-14 — Plan 55-02 executed (4 tasks, 4 commits: f489756, f9d5d98, 02ea4c1, 50b581f)
Next step: Execute Phase 55 plans 55-03+ (A2A send/receive client, timeout/retry)

Progress: [##........] 20% (1/5 phases complete)

## v3.3 Phase Map

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 54 | Stability & Hardening — FOUNDATION | STAB-01..06 | COMPLETE (2026-05-14) |
| 55 | A2A Protocol Foundation | A2A-01..04 | In Progress (plans 55-01+55-02 shipped 2026-05-14) |
| 56 | A2A Orchestration (breakers + threading + audit) | A2A-05..07 | Pending |
| 57 | Module Marketplace | MARK-01..04 | Pending |
| 58 | Public Launch (capstone) | PUB-01..05 | Pending |

**Execution order:** 54 → 55 → 56 → (57 ‖ Phase 58 prep) → 58
**Parallelizable:** After 54 + 55: 56 and 57 are independent. 58 is capstone — needs 54 (no debt) + 57 (marketplace story).

## Performance Metrics

(Reset for v3.3 milestone)

## Accumulated Context

### Decisions (carried forward — still informing work)

- v3.0 shipped: 10 phases (31-40), 24 plans, 820 assertions, 55 requirements, 17 agents.
- v3.1 shipped: 7 phases (41-47), 18 plans, ~536 tests, 25 requirements. BMAD-METHOD patterns grafted onto Amauta infrastructure (sharded workflows, scale-adaptive, skills, installer, bearings, MCP, hydration).
- v3.2 shipped: 6 phases (48-53), 24 plans, ~336 tests, 22 requirements. Modules + party mode + agent compilation + v3.1 polish.
- v3.2 Phase 52 Plan 52-03: scripts/agent-compiler.cjs (928 lines) symmetric with Phase 43 skill-compiler.cjs. TARGET_MAPS (claude-code/opencode/cursor), SECTION_KEY_TO_HEADING (9 keys), SECTION_EMIT_ORDER (10 keys, metadata first). SC1 byte-match 17/17 PASS pattern is the v3.3 baseline for any agent.md changes.
- v3.2 Phase 53 Plan 53-02: bin/init.cjs has --install + --upgrade + --uninstall with 19 frozen step names. PUB-04 builds on this (UX polish, not flow change).
- v3.2 Phase 53 Plan 53-03: services/amauta-mcp.py uses inline tools=[...] inside @server.list_tools() (NOT module-level TOOLS list). _MCP_ERROR_CODES 5-tuple is the error vocabulary.
- v3.2 Phase 48 Plan 48-01: Pydantic v2 model_config extra=forbid + field_validator + model_validator(mode=after). Module manifest LOCKED 8-field order. MARK-01 reuses this contract.
- v3.2 Phase 50/51: party_session blackboard + 5 frozen state transitions + decision records. A2A-01..07 builds on the same agent_findings + agent_messages PG infrastructure.
- 17-agent ecosystem with standardized format. Anti-over-engineering rule: "Do not add features, refactor code, or make improvements beyond what was explicitly requested."

### v3.3-Specific Constraints (locked at scope-time)

- **STAB phase is FOUNDATION** — don't ship debt to public via PUB-03 npm publish. STAB-01..06 must complete before Phase 58.
- **A2A is operator-mediated by default** — every a2a exchange logged to daemon `/a2a/exchanges`. No covert agent-to-agent without audit trail (mirrors party mode operator supervision from Phase 51).
- **Module Marketplace stays static** — Phase 57 ships JSON index + URL install, NOT a hosted registry service. Hosted SaaS registry deferred to v3.4+.
- **Public Launch is reversible only by deprecation, not deletion** — npm publish is permanent. Phase 58 ships clean docs + correct semver + provenance.
- **Body metaphor:** federation → dialect. Members start speaking, then go public.

### Blockers/Concerns

- ~~OBSERVATION: tests/13.1-divergence-protocol.integration.test.cjs LLM behavioral tests fail intermittently. STAB-05 closes this in Phase 54.~~ CLOSED by plan 54-03 (2026-05-14).

## Session Continuity

Last session: 2026-05-14T22:00:00.000Z
Stopped at: Phase 55 plan 55-02 COMPLETE — capabilities field + a2a_registry + gsd-tools dispatch + 18 tests
Resume file: .planning/phases/55-a2a-protocol-foundation/ (Phase 55 plans 55-03+ next)

## Learnings








- [learning] 2026-05-14T21:04:01.642Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:48:57.827Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:48:39.631Z: E2E test learning — cleanup after test
- [learning] 2026-05-14T20:47:34.380Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:46:22.904Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:45:05.270Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:43:21.566Z: legacy regression test: free text learning
(New v3.3 learnings appended below as phases ship)

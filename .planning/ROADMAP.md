# Roadmap: GSD-Amauta

## Milestones

- ✅ **v2.0 Self-Upgrade** — Phases 1-5 (shipped 2026-03-21)
- ✅ **v2.1 Durability & Compliance** — Phases 6-10 (shipped 2026-03-23)
- ✅ **v2.2 → v2.9** — see `.planning/milestones/` archives
- ✅ **v3.0 The Birth** — Phases 31-40 (shipped 2026-04-14)
- ✅ **v3.1 The Gathering** — Phases 41-47 (shipped 2026-05-13)
- ✅ **v3.2 The Federation** — Phases 48-53 (shipped 2026-05-14)
- ✅ **v3.3 The Dialect** — Phases 54-58 (shipped 2026-05-14)

## Current State

v3.3 "The Dialect" complete (2026-05-15): Stability & Hardening foundation closed every v2.9 → v3.2 carry-forward; A2A protocol shipped (foundation + orchestration with per-pair circuit breakers, conversation threading, operator audit endpoint); Module Marketplace shipped (signed registry index, search CLI, ed25519 manifest verification, install from URL); Public Launch capstone shipped (external README, MIT LICENSE corrected, CONTRIBUTING/SECURITY/NOTICE, npm publish workflow with provenance, init UX polish, QUICKSTART). 5 phases, 20 plans, 87 commits, +19,003 / −1,937 LOC, 22/22 requirements, 214 passing tests. Next: `/amauta:new-milestone` for v3.4.

## v3.3 Phases (archived)

<details>
<summary>✅ v3.3 The Dialect (Phases 54-58) — SHIPPED 2026-05-15</summary>

- [x] Phase 54: Stability & Hardening — FOUNDATION — 5 plans, STAB-01..06 closed
- [x] Phase 55: A2A Protocol Foundation — 4 plans, A2A-01..04 (migration 024 + capability registry + send/receive client + retry)
- [x] Phase 56: A2A Orchestration — 3 plans, A2A-05..07 (Valkey breakers + recursive-CTE threading + /a2a/exchanges + tail CLI)
- [x] Phase 57: Module Marketplace — 3 plans, MARK-01..04 (RegistryIndex Pydantic + ed25519 signer + search CLI + URL installer)
- [x] Phase 58: Public Launch (capstone) — 5 plans, PUB-01..05 (README/CONTRIBUTING/LICENSE/SECURITY/NOTICE/release.yml/init UX/QUICKSTART)

Archive: `.planning/milestones/v3.3-ROADMAP.md` · `.planning/milestones/v3.3-REQUIREMENTS.md`

</details>

## v3.2 Phases (archived)

<details>
<summary>✅ v3.2 The Federation (Phases 48-53) — SHIPPED 2026-05-14</summary>

- [x] Phase 48: Module System Foundation — 2 plans, 31 tests
- [x] Phase 49: Module CLI + Lifecycle — 4 plans, 93 tests
- [x] Phase 50: Party Mode Foundation — 4 plans, 55 tests
- [x] Phase 51: Party Mode Decisions + Operator CLI — 4 plans, 37 tests
- [x] Phase 52: Agent Compilation — 5 plans, 62 tests
- [x] Phase 53: v3.1 Carry-Forwards — 5 plans, 58 tests

Archive: `.planning/milestones/v3.2-ROADMAP.md` · `.planning/milestones/v3.2-REQUIREMENTS.md` · `.planning/milestones/v3.2-MILESTONE-AUDIT.md`

</details>

## v3.1 Phases (archived)

<details>
<summary>✅ v3.1 The Gathering (Phases 41-47) — SHIPPED 2026-05-13</summary>

- [x] Phase 41: Sharded Workflows (FOUNDATION) — 3 plans, 151 assertions
- [x] Phase 42: Scale-Adaptive Intelligence — 4 plans, 150 JS + 32 Py assertions
- [x] Phase 43: Skills Architecture — 3 plans, 53 tests
- [x] Phase 44: Cross-IDE Installer — 3 plans, 47 tests
- [x] Phase 45: Intelligent Help Routing — 2 plans, 23 tests
- [x] Phase 46: Standalone MCP Server — 2 plans, 50 tests
- [x] Phase 47: Agent Dynamic Hydration — 3 plans, 30 tests

Archive: `.planning/milestones/v3.1-*.md`

</details>

## Body Metaphor Sequence

brain (v2.5) → sight (v2.6) → hands (v2.7) → metabolism (v2.8) → nervous system (v2.9) → birth (v3.0) → gathering (v3.1) → federation (v3.2) → **dialect (v3.3)**

## Next Milestone

After v3.3 ships: `/amauta:new-milestone` to define v3.4 scope (hosted registry, A2A extensions, opt-in telemetry).

---

*Roadmap updated: 2026-05-14 after plan 58-05 shipped (PUB-05 QUICKSTART walkthrough — Phase 58 COMPLETE, v3.3 milestone COMPLETE). Pre-v3.2 history lives in `.planning/milestones/`.*

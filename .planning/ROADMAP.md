# Roadmap: GSD-Amauta

## Milestones

- ✅ **v2.0 Self-Upgrade** — Phases 1-5 (shipped 2026-03-21)
- ✅ **v2.1 Durability & Compliance** — Phases 6-10 (shipped 2026-03-23)
- ✅ **v2.2 → v2.9** — see `.planning/milestones/` archives
- ✅ **v3.0 The Birth** — Phases 31-40 (shipped 2026-04-14)
- ✅ **v3.1 The Gathering** — Phases 41-47 (shipped 2026-05-13)
- ✅ **v3.2 The Federation** — Phases 48-53 (shipped 2026-05-14)
- ✅ **v3.3 The Dialect** — Phases 54-58 (shipped 2026-05-15)
- 🔄 **v3.4 The Mirror** — Phases 59-64 (in progress)

## Current State

v3.4 "The Mirror" roadmap defined (2026-05-15): 6 phases (59-64), 20/20 requirements mapped. This is an effectiveness milestone — the harness turns the mirror on itself. Foundation-first ordering locked: Phase 59 (FIDEL) must complete before TOOL/PERS/TEL/POS phases begin. Phases 60 (TOOL) and 61 (PERS) are independent surfaces and may execute in parallel after Phase 59. Phase 62 (TEL) follows the TOOL+PERS wave. Phase 63 (POS) follows TEL (benefits from real telemetry data). Phase 64 (HARD) is last and externally gated on the v3.3.0 npm publish + a real-usage data window — it cannot start on a fixed date.

## v3.4 Phases

- [ ] **Phase 59: Phase-File Fidelity (FOUNDATION)** — Lock scope precision before building on it; planner/validator/router manifest enforcement
- [ ] **Phase 60: Sources of Truth / Tool Reach** — Declared capability catalog + executor tool-allowlist audit + live-state read tools
- [ ] **Phase 61: Coding Quality / Role Personas** — Role-shaped agent persona class + intent-aware plan-to-tasks routing
- [ ] **Phase 62: Telemetry** — Opt-in telemetry framework, event taxonomy, offline-buffered ingest
- [ ] **Phase 63: Positioning** — README discipline-layer headline, RPETD compliance scorecard, honest BMAD comparison doc
- [ ] **Phase 64: Post-launch Hardening (external-gated)** — Issue triage, init/doctor UX, real-user doc gaps, performance debt (STARTS only after v3.3.0 npm publish + usage data exists)

## Phase Details

### Phase 59: Phase-File Fidelity (FOUNDATION)
**Goal**: The harness enforces concrete, non-drifting manifests at every checkpoint — planner, router, and validator all reject vague or mismatched file scope before any other v3.4 work executes on top of it.
**Depends on**: Nothing (first phase of v3.4, mandatory prerequisite for all other phases)
**Requirements**: FIDEL-01, FIDEL-02, FIDEL-03, FIDEL-04, FIDEL-05
**Success Criteria** (what must be TRUE):
  1. The planner rejects a plan containing `files_expected: **/*` with a message naming the task and the over-broad field — no silent pass-through
  2. `plan-to-tasks` blocks registration when `route-executor` disagrees with the planner's agent assignment and emits an actionable diff (declared vs computed agent vs file list)
  3. Running the staleness detector after a milestone close flags any executor citation to a file path or symbol that no longer exists in the working tree
  4. The validator fails a task where `files_actual` differs from `files_expected` and the `manifest_violation` cannot be closed without an atomization reconciliation step
  5. Running `plan-phase` on a phase spanning more than the configured ceiling of unrelated top-level dirs produces an operator-visible scope-width warning before planning proceeds
**Plans**: TBD (est. 4-5)

### Phase 60: Sources of Truth / Tool Reach
**Goal**: Every executor knows exactly which systems it is allowed to reach, how to authenticate, and leaves an audit trail for every live-state access.
**Depends on**: Phase 59
**Requirements**: TOOL-01, TOOL-02, TOOL-03
**Success Criteria** (what must be TRUE):
  1. A `gsd-amauta capability list` command (or equivalent) prints all registered reachable systems (curl endpoints, ssh hosts, PG/Redis/k3s) with auth method and security_class for each entry
  2. Running `gsd-amauta capability audit` reports the diff between declared and actual tool allowlists for every `gsd-executor-*` agent, with zero unexplained gaps
  3. An executor performing a live PG query or curl to an allowlisted endpoint produces an audit-log entry containing requesting agent, target, and timestamp — verifiable by querying the daemon
**Plans**: TBD (est. 3)

### Phase 61: Coding Quality / Role Personas
**Goal**: The routing layer selects agents by what the task needs (role/intent), not just which files it touches, and that choice is recorded.
**Depends on**: Phase 59
**Requirements**: PERS-01, PERS-02
**Success Criteria** (what must be TRUE):
  1. At least three role-shaped persona agents (e.g. Senior Backend Engineer, Architect, Frontend Specialist) appear in the agent registry and compile successfully through the Phase 52 pipeline — byte-match verification passes
  2. A task record whose intent signal matches a registered persona shows that persona (not a file-extension executor) as the assigned agent in the task's audit field
  3. A task with no role signal present falls through to file-extension routing and the task record reflects the fallback path taken
**Plans**: TBD (est. 3)

### Phase 62: Telemetry
**Goal**: The harness can observe its own usage without ever blocking operation or collecting data without consent.
**Depends on**: Phase 60, Phase 61 (after TOOL+PERS wave)
**Requirements**: TEL-01, TEL-02, TEL-03
**Success Criteria** (what must be TRUE):
  1. On first run after install, the harness presents a consent prompt; telemetry stays OFF and local-only until the user explicitly opts in via the prompt or `--enable-telemetry` flag
  2. Running `gsd-amauta telemetry show-payload` (or equivalent) prints the exact JSON that would be sent for the last captured event — no surprises in the payload
  3. With the network sink unreachable, harness operations (phase start, validator runs) complete at normal speed with no timeout or error surfaced to the operator — buffered events persist locally for the next successful flush
  4. After a completed phase, a phase-start and phase-complete event with a stable schema version appear in the local event buffer
**Plans**: TBD (est. 3-4)

### Phase 63: Positioning
**Goal**: The public README and companion docs lead with the executor-discipline differentiator and give prospective users the information needed to self-select.
**Depends on**: Phase 62 (POS benefits from real telemetry data being in place; scorecard references TEL event schema)
**Requirements**: POS-01, POS-02, POS-03
**Success Criteria** (what must be TRUE):
  1. The README's opening section names RPETD enforcement, validator gates, divergence protocol, and manifest-violation detection before any feature-list — a reader sees the discipline headline within the first screen
  2. Running `gsd-amauta scorecard <task-id>` (or equivalent) for any completed task prints which RPETD phases ran, the validator verdict, divergence count, and manifest fidelity in a format that is both human-readable and machine-parseable (e.g. JSON + table)
  3. `docs/COMPARISON.md` (or equivalent README section) exists, names BMAD-METHOD explicitly, states where the two tools overlap and where they differ, and acknowledges tradeoffs without marketing inflation — a reader can determine within 2 minutes which tool fits their workflow
**Plans**: TBD (est. 2-3)

### Phase 64: Post-launch Hardening (external-gated)
**Goal**: Real issues from real users are triaged and closed; the install and doctor UX survives contact with environments the maintainer didn't control.
**Depends on**: Phase 63 AND the v3.3.0 npm publish (requires NPM_TOKEN + `git tag v3.3.0 && git push origin v3.3.0`) AND a real-usage data window (GitHub issues must exist before this phase can start — this phase does NOT start on a fixed date)
**Requirements**: HARD-01, HARD-02, HARD-03, HARD-04
**Success Criteria** (what must be TRUE):
  1. Every GitHub issue opened after the v3.3.0 publish is either closed with a resolution or explicitly deferred with a written reason — the triage outcome is recorded in a tracking doc or issue comment
  2. `npx gsd-amauta init` on a clean machine with a deliberate failure condition (e.g. missing Docker, wrong Node version) surfaces a human-readable error message and a documented recovery path rather than a raw stack trace
  3. `gsd-amauta doctor` on a machine with a broken installation names the specific failing check and the remediation step rather than a generic "something is wrong" message
  4. At least one user-reported slow path (module install, party-mode startup, or agent compile) has a before/after measurement showing the addressed degradation
**Plans**: TBD (est. 3-4)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 59. Phase-File Fidelity (FOUNDATION) | 0/TBD | Not started | - |
| 60. Sources of Truth / Tool Reach | 0/TBD | Not started | - |
| 61. Coding Quality / Role Personas | 0/TBD | Not started | - |
| 62. Telemetry | 0/TBD | Not started | - |
| 63. Positioning | 0/TBD | Not started | - |
| 64. Post-launch Hardening (external-gated) | 0/TBD | Not started | - |

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

brain (v2.5) → sight (v2.6) → hands (v2.7) → metabolism (v2.8) → nervous system (v2.9) → birth (v3.0) → gathering (v3.1) → federation (v3.2) → dialect (v3.3) → **mirror (v3.4)**

## Next Milestone

After v3.4 ships: `/amauta:new-milestone` to define v3.5 scope (A2A-09 streaming + A2A-10 cross-host, gated on TEL signal from v3.4; hosted registry revisit if telemetry shows module ecosystem).

---

*Roadmap updated: 2026-05-15 after v3.4 "The Mirror" roadmap created (6 phases 59-64, 20/20 requirements mapped). v3.3 history lives in `.planning/milestones/`.*

# Requirements: GSD-Amauta v3.4 "The Mirror"

**Defined:** 2026-05-15
**Core Value:** Every RPETD phase must see what other phases have learned. v3.4 turns the mirror on the harness itself — fix how it works, then show what it is.

## v1 Requirements

20 requirements across 6 tracks. FOUNDATION-first: the FIDEL track must complete before TOOL/PERS/TEL/POS execute (locking scope on top of drifting phases is the test-runner trap). HARD is gated on the v3.3.0 npm publish + a real-usage data window.

### Phase-File Fidelity (FOUNDATION — must precede all other tracks)

- [ ] **FIDEL-01**: The planner rejects any plan whose `files_expected` uses a broad glob (`**/*`, `*`) or omits any of the `modify`/`create`/`delete` keys — only concrete enumerated file lists are accepted; rejection message names the offending task and the missing/over-broad field
- [ ] **FIDEL-02**: `route-executor` ↔ planner agreement is gated at `plan-to-tasks` — an `agent_assignment_conflict` blocks registration and emits an actionable diff (declared agent vs computed agent vs file list); no silent absorption, surfaced per the divergence protocol
- [ ] **FIDEL-03**: RLM/memory freshness — the codebase index is rebuilt after each milestone close, and a staleness detector flags any executor citation to a file path or symbol that no longer exists in the working tree
- [ ] **FIDEL-04**: The validator fails a task when `files_actual` ≠ `files_expected`; a `manifest_violation` cannot transition to `passed`/`done` without an atomization step that reconciles the manifest
- [ ] **FIDEL-05**: Phase-scope-width cap — Phase 42 scale-adaptive scoring flags any phase spanning more than a hard ceiling of unrelated subsystems/top-level dirs; the cap is enforced at plan-phase time with an operator-visible warning

### Sources of Truth / Tool Reach

- [ ] **TOOL-01**: A declared capability catalog exists — a versioned registry of systems the harness may reach (curl endpoints, ssh operator-approved hosts, live PG/Redis/k3s state) with auth method and `security_class` per entry; queryable by executors and surfaced in agent hydration
- [ ] **TOOL-02**: Each `gsd-executor-*` agent has an explicit, operator-approved tool allowlist (bash/ssh/curl scopes) declared per the Phase 43 capability schema; an audit command reports current vs declared capability for every executor
- [ ] **TOOL-03**: Executors can read live state from operator-approved sources — ssh to allowlisted hosts, curl to allowlisted endpoints, and live PG/Redis/k3s queries — every such access is audit-logged with the requesting agent, target, and timestamp

### Coding Quality (role personas)

- [ ] **PERS-01**: A role-shaped agent persona class exists alongside file-extension executors (e.g. Senior Backend Engineer, Architect, Frontend Specialist) — role-framed system prompts on the same model; personas are declared in the agent registry and compile through the existing Phase 52 agent-compilation pipeline
- [ ] **PERS-02**: `plan-to-tasks` selects a persona by task role/intent (not just file extension); file-extension routing remains as a deterministic fallback when no role signal is present; the chosen persona is recorded in the task record for audit

### Telemetry (opt-in)

- [ ] **TEL-01**: Opt-in telemetry framework — a first-run consent flow (default OFF, local-storage only until consented), an `--enable-telemetry` flag, and a transparent payload disclosure command that prints exactly what would be sent
- [ ] **TEL-02**: Event taxonomy — telemetry captures phase start/complete, validator verdicts, divergence reports, escalation fires, party-mode sessions, and error classes; each event has a stable schema version
- [ ] **TEL-03**: Offline-capable buffered ingest — events buffer locally and flush on a schedule to a single chosen sink (self-hosted endpoint or vendor); a dead/unreachable sink never blocks or slows harness operation (portability constraint holds)

### Positioning (discipline layer as headline)

- [ ] **POS-01**: README repositioning — the README leads with the executor-discipline layer (RPETD enforcement, validator gates, divergence protocol, manifest-violation detection) and names BMAD-METHOD as an adjacent but different category (agile-collaboration framework vs delivery discipline)
- [ ] **POS-02**: Public RPETD compliance scorecard — for any completed task or phase, a command emits a report showing which RPETD phases ran, the validator verdict, the divergence count, and manifest fidelity; the report is human-readable and machine-parseable
- [ ] **POS-03**: Honest comparison doc — a `docs/COMPARISON.md` (or README section) that states where gsd-amauta and BMAD-METHOD overlap and where they differ, written so a prospective user can self-select; no marketing inflation, tradeoffs admitted

### Post-launch Hardening (gated on v3.3.0 npm publish + real-usage window)

- [ ] **HARD-01**: GitHub issues opened in the post-v3.3.0-publish window are triaged and closed (or explicitly deferred with reason); the triage outcome is recorded
- [ ] **HARD-02**: `npx gsd-amauta init` and `gsd-amauta doctor` UX hardened against real install failures — clearer error messages, recovery hints, and a documented failure-recovery path
- [ ] **HARD-03**: Documentation gaps surfaced by real users are closed — README, getting-started, troubleshooting updated to match what users actually hit
- [ ] **HARD-04**: Performance debt on user-reported slow paths is addressed (likely candidates: module install, party-mode startup, agent compile) with before/after measurements

## v2 Requirements

Deferred to v3.5 or later. Tracked, not in current roadmap.

### A2A Extensions
- **A2A-09**: Streaming responses (currently request/response only) — revisit once TEL data shows A2A is actually used
- **A2A-10**: Cross-process / cross-host A2A — same data gate as A2A-09

### Registry Hosting
- **HOST-01..03**: Hosted/self-hostable module registry server — portability-constraint conflict + BMAD installed base make this a weak bet; v3.5+ or never

### Marketplace
- **MARK-EXT**: Module marketplace expansion (ratings, download counts, discovery) — v3.6+ only if telemetry shows a module ecosystem forming

## Out of Scope

| Feature | Reason |
|---------|--------|
| Hosted SaaS registry we operate | Ongoing ops cost incompatible with the locked portability constraint (`npm install -g . && docker compose up`, no K3s/Langfuse/gVisor) |
| Feature-parity race with BMAD-METHOD | BMAD has 47.2k★ / 143 contributors / v6.6.0; competing on breadth against a 5k-fork community is the asymmetric loss. Differentiate on discipline, don't chase parity |
| Integrating BMAD's codebase | Steal *patterns* (role personas) only; never merge codebases |
| New runtimes for telemetry | Python + Node.js only; telemetry sink is buffered + offline-capable, never a hard runtime dependency |
| Always-on telemetry | Opt-in only, default OFF, local until consented — privacy is non-negotiable |
| A2A streaming / cross-host this milestone | No data yet on whether A2A is used; deferred to v3.5 pending TEL signal |

## Traceability

Mapped during roadmap creation by gsd-roadmapper. Each requirement maps to exactly one phase. Phase numbering continues from v3.3 (last phase 58 → v3.4 starts at Phase 59).

| Requirement | Phase | Status |
|-------------|-------|--------|
| FIDEL-01 | 59 | Pending |
| FIDEL-02 | 59 | Pending |
| FIDEL-03 | 59 | Pending |
| FIDEL-04 | 59 | Pending |
| FIDEL-05 | 59 | Pending |
| TOOL-01 | 60 | Pending |
| TOOL-02 | 60 | Pending |
| TOOL-03 | 60 | Pending |
| PERS-01 | 61 | Pending |
| PERS-02 | 61 | Pending |
| TEL-01 | 62 | Pending |
| TEL-02 | 62 | Pending |
| TEL-03 | 62 | Pending |
| POS-01 | 63 | Pending |
| POS-02 | 63 | Pending |
| POS-03 | 63 | Pending |
| HARD-01 | 64 | Pending |
| HARD-02 | 64 | Pending |
| HARD-03 | 64 | Pending |
| HARD-04 | 64 | Pending |

**Coverage:**
- v1 requirements: 20 total
- Mapped to phases: 20 / Unmapped: 0 ✓

**Execution-order constraints (for roadmapper):**
- FIDEL track is the FOUNDATION — its phase(s) must be first and must complete before any TOOL/PERS/TEL/POS phase begins
- HARD track phase(s) depend on the v3.3.0 npm publish having happened + a real-usage data window; sequence HARD last and note the external gate
- TOOL and PERS are independent of each other (different surfaces) and may parallelize after FIDEL
- POS benefits from TEL data; sequence POS after TEL where practical

---
*Requirements defined: 2026-05-15*
*Last updated: 2026-05-15 — traceability filled by roadmapper; all 20 requirements mapped to Phases 59-64*

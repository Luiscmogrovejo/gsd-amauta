---
gsd_state_version: 1.0
milestone: v3.4
milestone_name: The Mirror
status: ready_to_execute
stopped_at: v3.4 roadmap created; awaiting Phase 59 planning
last_updated: "2026-05-15T15:00:00.000Z"
last_activity: "2026-05-15 — v3.4 roadmap created by roadmapper; 6 phases (59-64), 20/20 requirements mapped"
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-15 after v3.3 close + v3.4 "The Mirror" scoping)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates. v3.4 turns the mirror on the harness itself — fix how it works, then show what it is.
**Current focus:** Milestone v3.4 — The Mirror. Phase 59 (FIDEL foundation) is the mandatory first phase. Run `/amauta:plan-phase 59` to begin.

## Current Position

Phase: Not started (roadmap defined → ready to execute)
Plan: —
Status: v3.4 roadmap created — 6 phases (59-64), 20/20 requirements mapped. FIDEL track (Phase 59) is the locked foundation.
Last activity: 2026-05-15 — v3.4 roadmap created; traceability filled in REQUIREMENTS.md; STATE.md updated
Next step: `/amauta:plan-phase 59`

Progress: [..........] 0% (0/6 phases)

## v3.4 Strategic Pivot (locked at scope-time)

- **BMAD-METHOD is prior art** (47.2k★, v6.6.0). Do NOT race feature-surface. Differentiator = executor-discipline layer (RPETD/validator/divergence/manifest). Recorded in PROJECT.md "Competitive Landscape" so future milestones don't re-litigate.
- **v3.4 is an effectiveness milestone, not a feature milestone.** Headline = fix the harness's own coding effectiveness + phase-file drift + tool reach.
- **FOUNDATION-FIRST is non-negotiable:** FIDEL track (phase-file fidelity) must complete before TOOL/PERS/TEL/POS — locking scope on top of drifting phases is the test-runner trap (named risk from the user's own analysis, endorsed).
- **HARD track gated** on v3.3.0 npm publish (not yet done — needs NPM_TOKEN + `git tag v3.3.0 && git push origin v3.3.0`) + a real-usage data window. HARD-* cannot start until issues actually arrive.
- **Deferred to v3.5+:** A2A-09 streaming, A2A-10 cross-host, HOST-01..03 hosted registry, module-marketplace expansion. Revisit only if telemetry shows the usage.

## v3.4 Phase Map

| Phase | Name | Track | Requirements | Status |
|-------|------|-------|--------------|--------|
| 59 | Phase-File Fidelity (FOUNDATION) | FIDEL | FIDEL-01..05 | Pending |
| 60 | Sources of Truth / Tool Reach | TOOL | TOOL-01..03 | Pending |
| 61 | Coding Quality / Role Personas | PERS | PERS-01..02 | Pending |
| 62 | Telemetry | TEL | TEL-01..03 | Pending |
| 63 | Positioning | POS | POS-01..03 | Pending |
| 64 | Post-launch Hardening (external-gated) | HARD | HARD-01..04 | Pending |

**Execution order:** 59 (FIDEL foundation) → 60+61 (TOOL+PERS wave, parallel) → 62 (TEL) → 63 (POS, after TEL) → 64 (HARD, external-gated last)
**External gate on Phase 64:** Cannot begin until v3.3.0 npm publish completes AND real GitHub issues arrive from users.

## v3.3 Phase Map

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 54 | Stability & Hardening — FOUNDATION | STAB-01..06 | COMPLETE (2026-05-14) |
| 55 | A2A Protocol Foundation | A2A-01..04 | COMPLETE (plans 55-01+55-02+55-03+55-04 shipped 2026-05-14) |
| 56 | A2A Orchestration (breakers + threading + audit) | A2A-05..07 | COMPLETE (plans 56-01+56-02+56-03 shipped 2026-05-14) |
| 57 | Module Marketplace | MARK-01..04 | COMPLETE (3/3 plans) |
| 58 | Public Launch (capstone) | PUB-01..05 | COMPLETE (2026-05-14) |

**Execution order:** 54 → 55 → 56 → (57 ‖ Phase 58 prep) → 58
**Parallelizable:** After 54 + 55: 56 and 57 are independent. 58 is capstone — needs 54 (no debt) + 57 (marketplace story).

## Performance Metrics

(Reset for v3.4 milestone)

## Accumulated Context

### Decisions (carried forward — still informing work)

- v3.0 shipped: 10 phases (31-40), 24 plans, 820 assertions, 55 requirements, 17 agents.
- v3.1 shipped: 7 phases (41-47), 18 plans, ~536 tests, 25 requirements. BMAD-METHOD patterns grafted onto Amauta infrastructure (sharded workflows, scale-adaptive, skills, installer, bearings, MCP, hydration).
- v3.2 shipped: 6 phases (48-53), 24 plans, ~336 tests, 22 requirements. Modules + party mode + agent compilation + v3.1 polish.
- v3.2 Phase 52 Plan 52-03: scripts/agent-compiler.cjs (928 lines) symmetric with Phase 43 skill-compiler.cjs. TARGET_MAPS (claude-code/opencode/cursor), SECTION_KEY_TO_HEADING (9 keys), SECTION_EMIT_ORDER (10 keys, metadata first). SC1 byte-match 17/17 PASS pattern is the v3.3 baseline for any agent.md changes.
- v3.2 Phase 53 Plan 53-02: bin/init.cjs has --install + --upgrade + --uninstall with 19 frozen step names. PUB-04 builds on this (UX polish, not flow change).
- v3.2 Phase 53 Plan 53-03: services/amauta-mcp.py uses inline tools=[...] inside @server.list_tools() (NOT module-level TOOLS list). _MCP_ERROR_CODES 5-tuple is the error vocabulary.
- v3.2 Phase 48 Plan 48-01: Pydantic v2 model_config extra=forbid + field_validator + model_validator(mode=after). Module manifest LOCKED 8-field order. MARK-01 reuses this contract.
- v3.3 Phase 57 Plan 57-01: RegistryEntry 7-field LOCKED order (name/version/sha256/manifest_url/maintainer/signed_by/signature). registry_version="1.0" frozen. 8-tuple _REGISTRY_ERROR_CODES. Signature = ed25519 over sha256 hex UTF-8 bytes. TRUST_STORE_DIR = ~/.gsd-amauta/trusted-keys (fail-closed). compute_manifest_hash reused from Phase 49 (not re-implemented). cryptography>=42.0 sole new dep.
- v3.2 Phase 50/51: party_session blackboard + 5 frozen state transitions + decision records. A2A-01..07 builds on the same agent_findings + agent_messages PG infrastructure.
- 17-agent ecosystem with standardized format. Anti-over-engineering rule: "Do not add features, refactor code, or make improvements beyond what was explicitly requested."
- v3.3 Phase 58 Plan 58-03: npm OIDC provenance requires id-token:write at JOB level (not workflow level) — at workflow level it silently fails. cancel-in-progress:false for release job (no mid-publish cancellation). registry-url set in setup-node step for NODE_AUTH_TOKEN pickup. Python test steps guarded by file/dir existence checks.

### v3.4-Specific Constraints (locked at scope-time)

- **FIDEL phase is FOUNDATION** — no other v3.4 phase starts until Phase 59 completes. Rationale: locking scope on top of drifting phases is the test-runner trap.
- **Phase 60 + Phase 61 are independent surfaces** — capability catalog (TOOL) and agent routing (PERS) do not touch each other; they may plan and execute in parallel after Phase 59.
- **Phase 62 (TEL) follows the TOOL+PERS wave** — telemetry instruments what those phases produce; no blocking dependency on either surface specifically, just both must be in place.
- **Phase 63 (POS) follows Phase 62 (TEL)** — the RPETD compliance scorecard (POS-02) references the telemetry event schema from Phase 62; README repositioning is most credible once telemetry is real.
- **Phase 64 (HARD) is externally gated** — v3.3.0 npm publish (NPM_TOKEN required + `git tag v3.3.0 && git push origin v3.3.0`) must happen AND GitHub issues from real users must arrive before Phase 64 can begin. The roadmap explicitly notes this — HARD does not start on a calendar date.
- **No A2A/registry/marketplace work** — deferred to v3.5+ per strategic pivot. Do NOT re-litigate.

### Blockers/Concerns

- Phase 64 (HARD) is blocked on v3.3.0 npm publish. Operator action required before Phase 64 can begin: add NPM_TOKEN secret to GitHub repo, then run `git tag v3.3.0 && git push origin v3.3.0`.

## Session Continuity

Last session: 2026-05-15T15:00:00.000Z
Stopped at: v3.4 roadmap created. All 3 planning files written: ROADMAP.md (v3.4 phases 59-64 added), REQUIREMENTS.md (traceability filled 20/20), STATE.md (phase map + ready_to_execute).
Resume file: none — begin with `/amauta:plan-phase 59`

## Learnings

- [learning] 2026-05-15T02:32:03.668Z: legacy regression test: free text learning
- [learning] 2026-05-15T02:30:00.427Z: legacy regression test: free text learning
- [learning] 2026-05-15T02:27:57.728Z: legacy regression test: free text learning
- [learning] 2026-05-15T02:26:54.783Z: legacy regression test: free text learning
- [learning] 2026-05-15T02:26:53.727Z: legacy regression test: free text learning
- [learning] 2026-05-15T02:25:31.568Z: E2E test learning — cleanup after test
- [learning] 2026-05-15T02:24:29.568Z: legacy regression test: free text learning
- [learning] 2026-05-15T02:23:12.728Z: legacy regression test: free text learning
- [learning] 2026-05-15T02:21:10.728Z: legacy regression test: free text learning
- [learning] 2026-05-15T02:18:56.728Z: legacy regression test: free text learning
- [learning] 2026-05-15T02:06:38.728Z: legacy regression test: free text learning
- [learning] 2026-05-14T23:44:09.428Z: Python Valkey circuit breaker pattern: INCR+EXPIRE for sliding failure window, SETNX EX 5s for half-open single-probe lock, fail-open (return True/STATE_CLOSED) on all Valkey exceptions, injectable redis_client param for test isolation, _HAS_BREAKER flag for graceful degradation
- [learning] 2026-05-14T21:04:01.642Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:48:57.827Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:48:39.827Z: E2E test learning — cleanup after test
- [learning] 2026-05-14T20:47:34.827Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:46:22.827Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:45:05.827Z: legacy regression test: free text learning
- [learning] 2026-05-14T20:43:21.827Z: legacy regression test: free text learning
- [learning] 2026-05-14: npm OIDC provenance requires id-token:write at job level (not workflow level); at workflow level --provenance silently produces no attestation
(New v3.4 learnings appended below as phases ship)

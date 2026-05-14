# Roadmap: GSD-Amauta

## Milestones

- ✅ **v2.0 Self-Upgrade** — Phases 1-5 (shipped 2026-03-21)
- ✅ **v2.1 Durability & Compliance** — Phases 6-10 (shipped 2026-03-23)
- ✅ **v2.2 → v2.9** — see `.planning/milestones/` archives
- ✅ **v3.0 The Birth** — Phases 31-40 (shipped 2026-04-14)
- ✅ **v3.1 The Gathering** — Phases 41-47 (shipped 2026-05-13)
- ✅ **v3.2 The Federation** — Phases 48-53 (shipped 2026-05-14)
- 🔄 **v3.3 The Dialect** — Phases 54-58 (in progress)

## Current State

v3.3 "The Dialect" is underway. Five phases close the carry-forward debt accumulated across v2.9 → v3.2, layer a direct agent-to-agent (A2A) protocol on top of the existing blackboard, extend the Phase 48-49 module system into a signed marketplace, and ship the whole platform publicly via npm. Phase 54 (Stability & Hardening) is the mandatory foundation — no debt ships to the public. Phase 58 (Public Launch) is the capstone and depends on both Phase 54 (clean install) and Phase 57 (marketplace story for README/docs).

**Execution order:** 54 → 55 → 56 → (57 ‖ Phase 58 prep) → 58

## v3.3 Phases

- [x] **Phase 54: Stability & Hardening — FOUNDATION** — Close v2.9→v3.2 carry-forwards before public ship
- [ ] **Phase 55: A2A Protocol Foundation** — Migration 024 + capability registry + send/receive client + timeout/retry
- [ ] **Phase 56: A2A Orchestration** — Circuit breakers per agent-pair + conversation threading + operator audit endpoint
- [ ] **Phase 57: Module Marketplace** — Static JSON registry + search CLI + sha256/ed25519 manifest signing + install from URL
- [ ] **Phase 58: Public Launch (capstone)** — README + CONTRIBUTING/LICENSE/SECURITY + npm publish + init UX polish + QUICKSTART walkthrough

## Phase Details

### Phase 54: Stability & Hardening — FOUNDATION

**Goal:** Eliminate all carry-forward debt (coverage gaps, Redis self-heal, observability holes, PATH collision, flaky LLM tests, missing doctor command) so the platform ships to the public without known defects.

**Depends on:** Nothing (first phase of v3.3)

**Requirements:** STAB-01, STAB-02, STAB-03, STAB-04, STAB-05, STAB-06

**Success Criteria** (what must be TRUE):
1. Running `npx c8 --reporter json-summary node scripts/run-tests.cjs` produces a populated `.coverage_threshold.json` and CI fails if coverage drops below the recorded baseline.
2. The Redis watchdog self-heals without manual intervention: a synthetic counter-reset / connection-drop test completes within 7 minutes and the uptime-window resets correctly (closes 2026-05-11 incident class).
3. The daemon `/health` endpoint exposes `rlm_restarts_lifetime` as a cumulative counter that does not reset on successful `_start_rlm` calls — operators can track restart history across the session.
4. Typing `amauta` in a fresh shell resolves to the GSD plugin binary (not the pipx `amauta-ai` package); the shim/alias is documented in install output.
5. `tests/13.1-divergence-protocol.integration.test.cjs` either passes deterministically (mocked LLM with frozen responses) or is quarantined behind an explicit `GSD_LLM_INTEGRATION=true` flag so CI never fails on a missing API key.
6. `gsd-amauta doctor` exits 0 and prints a one-screen status table covering: paths, daemon reachability, PG reachability, Valkey reachability, API keys present/absent, migrations current, agent files present, skill files present.

**Plans:** 5 (54-01 through 54-05) — ALL SHIPPED. COMPLETE 2026-05-14.

**54-01 shipped 2026-05-14:** STAB-01+STAB-03 — coverage ratchet CI gate wired in test.yml; .coverage_threshold.json updated to real baseline (lines=70%, branches=68.7%); _rlm_restarts_lifetime cumulative counter added to /health endpoint; 5-test pytest suite passes.

**54-03 shipped 2026-05-14:** STAB-05 — GSD_LLM_INTEGRATION skip guard added to tests/13.1-divergence-protocol.integration.test.cjs; GSD_LLM_INTEGRATION: "true" added to .github/workflows/behavioral-tests.yml. Default CI now exits 0 when Anthropic API key absent.

**54-04 shipped 2026-05-14:** STAB-02 — 11-test pytest suite for _redis_watchdog state machine (7 structural + 4 inline simulation); live-test procedure (~7 min synthetic counter-reset) documented in module docstring. Closes 2026-05-11 incident class.

**54-05 shipped 2026-05-14:** STAB-06 — gsd-amauta doctor command (services/doctor.py + bin/cli.cjs dispatch). One-screen status table: paths, daemon, PG, Valkey, API keys, migrations, agents, skills. Consumes rlm_restarts_lifetime from /health (STAB-03 consumer chain closed). 9-test pytest suite passes. Phase 54 COMPLETE.

---

### Phase 55: A2A Protocol Foundation

**Goal:** Ship the `a2a_messages` PG table (migration 024), a capability negotiation registry, and a Python send/receive client with timeout and structured retry — the complete foundation layer that Phase 56 builds on.

**Depends on:** Phase 54

**Requirements:** A2A-01, A2A-02, A2A-03, A2A-04

**Success Criteria** (what must be TRUE):
1. Migration 024 runs cleanly on a fresh database and `a2a_messages` exists with the correct schema (`correlation_id`, `parent_correlation_id`, `from_agent`, `to_agent`, `capability`, `payload jsonb`, `kind`, `status`, `created_at`, `responded_at`) and the `(to_agent, status)` index.
2. An operator can run `gsd-tools a2a capabilities gsd-executor` and receive a structured list of capability verbs that agent publishes; the backing `services/a2a_registry.py` is queryable programmatically.
3. An agent can call `a2a_client.send_request(to="gsd-reviewer", capability="review_file", payload={...}, timeout=30)` and receive a `correlation_id` back; a second agent can call `await_response(correlation_id)` and receive the result — round-trip visible in the `a2a_messages` table.
4. When a request times out, the caller receives an `a2a_timeout` structured error; when retried twice with exponential backoff the retry history is visible in `a2a_messages` with `status=retried` rows; `unknown_capability`, `agent_unavailable`, and `payload_invalid` errors each produce distinct vocabulary tokens.

**Plans:** TBD (est. 3-4)

---

### Phase 56: A2A Orchestration

**Goal:** Add circuit-breaker protection per agent-pair, multi-turn conversation threading via `parent_correlation_id` chains, and a daemon audit endpoint that gives operators full visibility into every A2A exchange.

**Depends on:** Phase 55

**Requirements:** A2A-05, A2A-06, A2A-07

**Success Criteria** (what must be TRUE):
1. After 3 failures within 60 seconds on the same `(from_agent, to_agent)` pair, the circuit breaker opens and subsequent calls return `agent_unavailable` immediately without hitting the target agent; the breaker transitions to half-open after 60 seconds and closes on a successful probe.
2. A multi-turn dialogue between two agents (agent A asks, agent B responds, agent A follows up) produces a thread retrievable via `a2a_client.get_thread(root_correlation_id)` returning the exchanges in chronological order with correct `parent_correlation_id` linkage.
3. Every A2A exchange is audit-logged before payload delivery; `GET /a2a/exchanges?from=gsd-executor&to=gsd-reviewer&since=<ISO>` returns a JSON list of all matching exchanges; `gsd-amauta a2a tail` streams new exchanges to the terminal in real time.

**Plans:** TBD (est. 3)

---

### Phase 57: Module Marketplace

**Goal:** Extend the Phase 48-49 module system with a versioned signed registry index, a search CLI, sha256+ed25519 manifest signing with verification at install time, and URL/shorthand install support.

**Depends on:** Phases 48-49 (module system — shipped in v3.2; no new phase dependency within v3.3)

**Requirements:** MARK-01, MARK-02, MARK-03, MARK-04

**Success Criteria** (what must be TRUE):
1. `registry/index.json` exists in this repo, parses against the versioned schema (`registry_version: "1.0"`), and contains at least one entry with all required fields (`name`, `version`, `sha256`, `manifest_url`, `maintainer`, `signed_by`).
2. `gsd-amauta module search <query>` returns ranked results from the local cached index and from a remote registry when `--registry <url>` is specified; results respect the Phase 48 `ModuleManifest` schema.
3. Installing a module with a tampered manifest (sha256 mismatch or invalid ed25519 signature) fails closed with a clear error message and no files written to disk; the trusted public key store lives at `~/.gsd-amauta/trusted-keys/`.
4. `gsd-amauta module install https://example.com/mymodule.zip`, `gsd-amauta module install github:owner/repo@v1.2.0`, and `gsd-amauta module install registry:mymodule@1.2.0` all resolve, download, verify signatures, and invoke the Phase 49 lifecycle install — indistinguishable from a local install after the signature check passes.

**Plans:** TBD (est. 3-4)

---

### Phase 58: Public Launch (capstone)

**Goal:** Rewrite public-facing documentation for an external developer audience, audit and refresh legal/security files, ship an automated npm publish workflow with provenance, polish the `npx gsd-amauta init` UX, and publish an end-to-end QUICKSTART walkthrough.

**Depends on:** Phase 54 (no carry-forward debt) + Phase 57 (marketplace story for README/docs)

**Requirements:** PUB-01, PUB-02, PUB-03, PUB-04, PUB-05

**Success Criteria** (what must be TRUE):
1. A developer who has never seen GSD-Amauta before can read the public README and understand what it is, how it differs from similar tools, and how to install it in under 30 seconds — without encountering milestone-log language or internal jargon.
2. `CONTRIBUTING.md` describes the PR workflow, commit conventions, and test policy; `LICENSE` is verified MIT with no third-party conflicts; `SECURITY.md` lists a responsible-disclosure address and the supported version matrix.
3. Pushing a semver tag (`v3.3.0`) triggers the GitHub Actions workflow that runs the full test suite, then publishes to npm with `--provenance`; the package appears on npmjs.com with a verified provenance attestation.
4. Running `npx gsd-amauta init` in a fresh directory produces friendly progress output (no stack traces), recovery hints on failure, and respects `--verbose` for debug detail — exercising the 7-step Phase 44 flow end-to-end.
5. `docs/QUICKSTART.md` guides a new user from install through their first shipped phase (install → init → discuss-phase → plan-phase → execute-phase → ship) with terminal screenshots at each step; the file is linked from the README.

**Plans:** TBD (est. 3-4)

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 54. Stability & Hardening — FOUNDATION | 5/5 | COMPLETE | 2026-05-14 |
| 55. A2A Protocol Foundation | 0/? | Not started | - |
| 56. A2A Orchestration | 0/? | Not started | - |
| 57. Module Marketplace | 0/? | Not started | - |
| 58. Public Launch (capstone) | 0/? | Not started | - |

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

*Roadmap updated: 2026-05-14 after plan 54-05 shipped (STAB-06 doctor command — Phase 54 COMPLETE). Pre-v3.2 history lives in `.planning/milestones/`.*

# Roadmap: GSD-Amauta

## Milestones

- ✅ **v2.0 Self-Upgrade** — Phases 1-5 (shipped 2026-03-21)
- ✅ **v2.1 Durability & Compliance** — Phases 6-10 (shipped 2026-03-23)
- ✅ **v2.2 → v2.9** — see `.planning/milestones/` archives
- ✅ **v3.0 The Birth** — Phases 31-40 (shipped 2026-04-14)
- ✅ **v3.1 The Gathering** — Phases 41-47 (shipped 2026-05-13)
- ✅ **v3.2 The Federation** — Phases 48-53 (shipped 2026-05-14)
- ✅ **v3.3 The Dialect** — Phases 54-58 (shipped 2026-05-15)
- 🔄 **v3.4 The Mirror** — Phases 59-71 (in progress; expanded 2026-07-02 with 7 harness-audit tracks)

## Current State

v3.4 "The Mirror" roadmap defined (2026-05-15): 6 phases (59-64), 20/20 requirements mapped. This is an effectiveness milestone — the harness turns the mirror on itself. Foundation-first ordering locked: Phase 59 (FIDEL) must complete before TOOL/PERS/TEL/POS phases begin. Phases 60 (TOOL) and 61 (PERS) are independent surfaces and may execute in parallel after Phase 59. Phase 62 (TEL) follows the TOOL+PERS wave. Phase 63 (POS) follows TEL (benefits from real telemetry data). Phase 64 (HARD) is last and externally gated on the v3.3.0 npm publish + a real-usage data window — it cannot start on a fixed date.

**Expansion (2026-07-02):** `docs/harness-audit-2026-07.md` + `.planning/research/SUMMARY.md` added 7 new tracks / 36 requirements as Phases 65-71 (EXTENDING v3.4, not a new milestone — Phases 59-64 above are byte-untouched). Sequencing interleaves the new phases with the still-pending 60-64 wave per the operator-specified order: **59 → (60 ∥ 61) → 65 → (66 ∥ 69) → 67 → 68 → 62 → 70 → 63 → 71 → 64**. Two hard cross-phase prerequisites: Phase 67 (HOOK) requires Phase 60's TOOL-01 capability catalog as its allowlist source (plus FIDEL-01 from Phase 59, already shipped); Phase 71 (OBS) builds on Phase 62's (TEL) consent/buffering framework. Retrieval Unification (65) is the pivot of the expansion — Memory Ranking (66) reuses its generalized RRF helper and Mobile AST Grammars (69) would create a third disjoint retrieval stack if built before it, so both sequence after 65 and may parallelize with each other.

## v3.4 Phases

- [x] **Phase 59: Phase-File Fidelity (FOUNDATION)** — Lock scope precision before building on it; planner/validator/router manifest enforcement (completed 2026-05-21)
- [x] **Phase 60: Sources of Truth / Tool Reach** — Declared capability catalog + executor tool-allowlist audit + live-state read tools (completed 2026-07-03)
- [x] **Phase 61: Coding Quality / Role Personas** — Role-shaped agent persona class + intent-aware plan-to-tasks routing (completed 2026-07-03)
- [x] **Phase 62: Telemetry** — Opt-in telemetry framework, event taxonomy, offline-buffered ingest (completed 2026-07-03)
- [ ] **Phase 63: Positioning** — README discipline-layer headline, RPETD compliance scorecard, honest BMAD comparison doc
- [ ] **Phase 64: Post-launch Hardening (external-gated)** — Issue triage, init/doctor UX, real-user doc gaps, performance debt (STARTS only after v3.3.0 npm publish + usage data exists)
- [x] **Phase 65: Retrieval Unification** — `/query` routed through the Phase 27 hybrid pipeline, one staleness authority, dependency graph wired, MCP search-code query-correctness (completed 2026-07-03)
- [x] **Phase 66: Memory Ranking & Lifecycle** — Citation-boost + RRF fusion for memory search, distillation signal preservation, bi-temporal validity + write-time classifier (completed 2026-07-03)
- [x] **Phase 67: Enforcement Hooks** — PreToolUse manifest/claim gates, Stop completion gate, handoff ledger, kill switch, CI mirror (completed 2026-07-03)
- [x] **Phase 68: Mobile/Wearable Build Loops** — XcodeBuildMCP + Gradle/mobile-mcp build-test-verify loops for the 5 mobile executors (completed 2026-07-04)
- [x] **Phase 69: Mobile AST Grammars** — tree-sitter Kotlin/Swift/Go/Rust/Java chunking on the unified retrieval stack (completed 2026-07-03)
- [ ] **Phase 70: E2E Cross-Service Verification** — Extended `doctor` health checks, synthetic-transaction flow, verified test-fixture cleanup
- [ ] **Phase 71: Observability** — OTel GenAI spans, optional self-hosted Langfuse, per-agent token/cost reporting

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

### Phase 65: Retrieval Unification
**Goal**: The agent-facing `/query` endpoint stops running a disjoint legacy scan and uses the same correct hybrid pipeline `/search` already uses — one retrieval stack, one staleness authority.
**Depends on**: Phase 60, Phase 61 (existing wave must complete first per operator-specified interleave order)
**Requirements**: RETR-01, RETR-02, RETR-03, RETR-04, RETR-05, RETR-06, RETR-07
**Success Criteria** (what must be TRUE):
  1. `gsd-rlm query --dir` on a PG-available, already-ingested directory returns results from the scan→ingest→BM25+vector RRF→rerank→graph-expand chain — not the legacy in-memory scan
  2. Querying an unindexed directory (or with PG down) still returns results via an explicit legacy-scan fallback — no empty-result regression (tested success criterion)
  3. A query matching only a function/class name (label-only match) returns that symbol's chunk with a non-zero score
  4. The MCP `search-code` tool's results change when the query changes — ranked by `pgvector <=>`/hybrid_search, never an unfiltered `SELECT ... LIMIT n`
  5. `expand_chunks_with_graph` returns real caller/callee edges (`dependents` populated by a reverse pass) for a symbol with known callers, and this lands in the same change as the `/query` re-point (atomic, per RETR-05)
  6. Exactly one staleness authority remains — `MtimeIndex` is removed from the codebase (retired in the same change as RETR-01) and SHA-256 staleness governs all paths; caveman `description` field is weighted in pg_search ranking (e.g. `description^2`); BM25 `b` is aligned/documented across engines and the tokenizer keeps short/digit-leading identifiers (`s3`, `db`, `v2`)
**Plans**: TBD (est. 3-4)

### Phase 66: Memory Ranking & Lifecycle
**Goal**: Memory search ranks on real signal (citations, hybrid fusion) instead of being limit-then-scored and ILIKE-fallback-blind, and distillation stops destroying that signal on merge.
**Depends on**: Phase 65 (reuses the generalized `hybrid_search_generic()` RRF helper — doing this before 65 means re-deriving fusion logic twice)
**Requirements**: MEMR-01, MEMR-02, MEMR-03, MEMR-04, MEMR-05, MEMR-06, MEMR-07, MEMR-08
**Success Criteria** (what must be TRUE):
  1. The Claude LLM distillation path executes end-to-end on a real merge group (the dead `execSync` bug is fixed) and is canary-verified before any other distill change ships in this phase
  2. `applied_count` enters both text and semantic memory-search scoring as a bounded boost (e.g. `min(log1p(applied_count), 3)`), with a top-1-concentration "echo chamber" canary metric tracked in the same phase
  3. Default memory search fuses FTS + vector via the shared RRF helper (no AND-joined-terms → ILIKE relevance-blind fallback), and scoring happens over-fetch-then-truncate (or in SQL `ORDER BY`) so source bonus/recency/citations can still rescue candidates beyond the raw LIMIT window
  4. Distillation preserves signal on merge — max source bonus carried, `applied_count` summed, citations merged, auto-distill uses the LLM path (not concatenation), and distill eligibility is no longer capped at the newest 1000 rows
  5. Write-path dedup (trigram/Jaccard fallback) still functions in `memory_store` when embeddings are unavailable
  6. Reranker output blends with the composite score (source/recency/citations) instead of replacing it, and `hnsw.iterative_scan` is set correctly for the HNSW index
  7. Bi-temporal validity (`valid_at`/`invalid_at`) + the mem0-style write-time ADD/UPDATE/DELETE/NOOP classifier ship together in one migration, verified by a synthetic contradiction test where a new fact closes the old fact's validity window
**Plans**: TBD (est. 3-4)

### Phase 67: Enforcement Hooks
**Goal**: Manifest, claim, and completion enforcement move from advisory/post-hoc checks to a physically blocking PreToolUse/Stop hook layer — with a kill switch so a bad gate can never brick the harness.
**Depends on**: Phase 60 (TOOL-01 capability catalog is this phase's allowlist source), Phase 59 (FIDEL-01 concrete `files_expected` — already shipped, hard precondition)
**Requirements**: HOOK-01, HOOK-02, HOOK-03, HOOK-04, HOOK-05, HOOK-06, HOOK-07
**Success Criteria** (what must be TRUE):
  1. A PreToolUse manifest gate physically blocks an Edit/Write to a file outside the claimed task's `files_expected` (+ `GLOBAL_ALLOWLIST`); `ORCHESTRATOR_OWNED` is a generated, versioned artifact — not a hand-maintained list
  2. A PreToolUse claim gate blocks a code write in a session with no Amauta task claimed
  3. A Stop-hook completion gate blocks turn-end while the claimed task lacks T-phase evidence or has unresolved divergence reports — every block emits a structured reason, has a bounded retry count, and a fail-open escalation path (verified: no un-passable deadlock)
  4. SessionStart/PreCompact hooks auto-write and rehydrate a structured handoff ledger (current wave, open divergences, next action) without any manual/skippable step
  5. Setting `GSD_HOOKS_ENFORCE=off`, or making the daemon unreachable, fails open — Edit/Write is never bricked
  6. A full plan→execute→close cycle runs green with all hooks active (self-test), proving the orchestrator's own legitimate writes are not blocked
  7. A CI job mirrors the hook gates (manifest diff, validator verdict present, test suite present) so edits made outside the harness meet the same bar
**Plans**: TBD (est. 4-5)

### Phase 68: Mobile/Wearable Build Loops
**Goal**: The 5 already-shipped mobile executors can actually build, test, and verify on simulators/emulators — and are already subject to the hook-enforcement layer while gaining that reach.
**Depends on**: Phase 67 (mobile executors must be governed by manifest/claim gates before their tool-reach expands)
**Requirements**: MOBL-01, MOBL-02, MOBL-03, MOBL-04, MOBL-05
**Success Criteria** (what must be TRUE):
  1. `gsd-executor-mobile-ios` and `gsd-executor-wearables` can build, unit-test, and drive a simulator for iOS/watchOS targets via a registered XcodeBuildMCP (2.6.2) server
  2. Android/Wear OS builds/tests/lints run through allowlisted `./gradlew` Bash calls, with device/emulator control via `@mobilenext/mobile-mcp` (pinned 0.0.61)
  3. On an environment with no simulator/emulator (CI), the loop degrades to compile+unit-test with a visible skip reason instead of failing the gate
  4. Secrets scanning catches signing identities and tokens in build-log/evidence capture before they land in task evidence or memory
  5. The validator's mobile-UAT ground truth is an accessibility-tree snapshot diff (deterministic); pixel/screenshot checks are advisory only, never gating
**Plans**: TBD (est. 3-4)

### Phase 69: Mobile AST Grammars
**Goal**: Kotlin/Swift/Go/Rust/Java source chunks through real tree-sitter AST parsing on the same unified retrieval stack — not a third, disjoint pipeline.
**Depends on**: Phase 65 (must land after retrieval unification — adding grammars to a still-split-brain pipeline creates a third disjoint stack)
**Requirements**: ASTG-01, ASTG-02, ASTG-03
**Success Criteria** (what must be TRUE):
  1. Kotlin and Swift files chunk via tree-sitter AST (node types confirmed against each grammar's `node-types.json` at plan time), replacing the paragraph-splitting fallback
  2. Go, Rust, and Java files chunk via tree-sitter AST with the same discipline
  3. A symbol query in each of the 5 new languages retrieves its defining chunk end-to-end through the Phase 65 unified pipeline — proving the grammars landed on the unified stack, not a third path
**Plans**: TBD (est. 2-3)

### Phase 70: E2E Cross-Service Verification
**Goal**: A single command proves PG, Valkey, daemon, RLM, MCP, and the new hook layer actually work together after a change — and E2E test runs stop leaking pollution into production state.
**Depends on**: Phase 67 (the synthetic transaction should also exercise the new hooks, avoiding a second verification pass), Phase 68 (mobile loops in place)
**Requirements**: E2E-01, E2E-02, E2E-03
**Success Criteria** (what must be TRUE):
  1. An extended `gsd-amauta doctor` covers PG, Valkey, daemon, RLM, MCP server, and hook registration in one command, with per-service pass/fail and active-fallback reporting
  2. At least one synthetic-transaction flow (create task → claim → enrich → store memory → search → validate) crosses PG→Valkey→daemon→RLM→MCP→hooks using readiness checks, never sleeps
  3. E2E fixtures are `__test__`-scoped with verified (not merely attempted) cleanup, and the test pollution already visible in `.planning/STATE.md` Learnings (2026-07-02/03 entries) is gone after this phase
**Plans**: TBD (est. 2-3)

### Phase 71: Observability
**Goal**: The harness's own operation becomes inspectable — spans, optional export, and per-agent cost — without ever depending on an external service to function.
**Depends on**: Phase 62 (TEL) — reuses its consent/buffering framework; Phase 65-68 (instruments retrieval, memory, hooks, and mobile work)
**Requirements**: OBS-01, OBS-02, OBS-03
**Success Criteria** (what must be TRUE):
  1. With `GSD_TELEMETRY=on`, OTel GenAI-convention spans emit from daemon/agent/LLM call sites, buffered and never blocking (same discipline as TEL-03) even when the export sink is unreachable
  2. An optional self-hosted Langfuse (3.203.3) docker-compose service receives OTLP export when enabled; its absence never degrades harness operation
  3. `amauta health`/`stats` surfaces a per-agent/per-phase token+cost summary derived from the collected spans
**Plans**: TBD (est. 2-3)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 59. Phase-File Fidelity (FOUNDATION) | 0/TBD | Complete    | 2026-05-21 |
| 60. Sources of Truth / Tool Reach | 0/TBD | Complete    | 2026-07-03 |
| 61. Coding Quality / Role Personas | 0/TBD | Complete    | 2026-07-03 |
| 62. Telemetry | 0/TBD | Complete    | 2026-07-03 |
| 63. Positioning | 0/TBD | Not started | - |
| 64. Post-launch Hardening (external-gated) | 0/TBD | Not started | - |
| 65. Retrieval Unification | 0/TBD | Complete    | 2026-07-03 |
| 66. Memory Ranking & Lifecycle | 0/TBD | Complete    | 2026-07-03 |
| 67. Enforcement Hooks | 0/TBD | Complete    | 2026-07-03 |
| 68. Mobile/Wearable Build Loops | 0/TBD | Complete    | 2026-07-04 |
| 69. Mobile AST Grammars | 0/TBD | Complete    | 2026-07-03 |
| 70. E2E Cross-Service Verification | 0/TBD | Not started | - |
| 71. Observability | 0/TBD | Not started | - |

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

*Roadmap updated: 2026-07-02 — v3.4 "The Mirror" EXTENDED with 7 harness-audit tracks (Phases 65-71, 36 requirements). Total v3.4 scope now 13 phases (59-71), 56 requirements. Phases 59-64 are byte-untouched from the 2026-05-15 roadmap; new phases interleave per the operator-specified order: 59 → (60 ∥ 61) → 65 → (66 ∥ 69) → 67 → 68 → 62 → 70 → 63 → 71 → 64. v3.3 history lives in `.planning/milestones/`.*

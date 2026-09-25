# Requirements: GSD-Amauta v3.4 "The Mirror"

**Defined:** 2026-05-15
**Core Value:** Every RPETD phase must see what other phases have learned. v3.4 turns the mirror on the harness itself — fix how it works, then show what it is.

## v1 Requirements

56 requirements across 13 tracks (20 original + 36 expansion). FOUNDATION-first: the FIDEL track must complete before TOOL/PERS/TEL/POS execute (locking scope on top of drifting phases is the test-runner trap). HARD is gated on the v3.3.0 npm publish + a real-usage data window.

**Expansion 2026-07-02:** 36 requirements across 7 new tracks (RETR-01..07 = 7, MEMR-01..08 = 8, HOOK-01..07 = 7, MOBL-01..05 = 5, ASTG-01..03 = 3, E2E-01..03 = 3, OBS-01..03 = 3) added from `docs/harness-audit-2026-07.md` + `.planning/research/SUMMARY.md`. Note: the roadmapper's source instructions estimated 33 — an item-by-item recount at roadmap time found 36 (the actual per-track bullet count in this file); this document uses the corrected 36. Sequencing: RETR → MEMR → HOOK → MOBL → ASTG → E2E → OBS; HOOK requires TOOL-01 (Phase 60) as its allowlist source and FIDEL-01 (shipped) as its manifest precondition.

### Phase-File Fidelity (FOUNDATION — must precede all other tracks)

- [x] **FIDEL-01**: The planner rejects any plan whose `files_expected` uses a broad glob (`**/*`, `*`) or omits any of the `modify`/`create`/`delete` keys — only concrete enumerated file lists are accepted; rejection message names the offending task and the missing/over-broad field
- [x] **FIDEL-02**: `route-executor` ↔ planner agreement is gated at `plan-to-tasks` — an `agent_assignment_conflict` blocks registration and emits an actionable diff (declared agent vs computed agent vs file list); no silent absorption, surfaced per the divergence protocol
- [x] **FIDEL-03**: RLM/memory freshness — the codebase index is rebuilt after each milestone close, and a staleness detector flags any executor citation to a file path or symbol that no longer exists in the working tree
- [x] **FIDEL-04**: The validator fails a task when `files_actual` ≠ `files_expected`; a `manifest_violation` cannot transition to `passed`/`done` without an atomization step that reconciles the manifest
- [x] **FIDEL-05**: Phase-scope-width cap — Phase 42 scale-adaptive scoring flags any phase spanning more than a hard ceiling of unrelated subsystems/top-level dirs; the cap is enforced at plan-phase time with an operator-visible warning

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

### Retrieval Unification (expansion — audit §2 HIGH findings)

- [ ] **RETR-01**: `gsd-rlm query --dir` (the `/query` endpoint) returns results from the Phase 27 hybrid pipeline (scan→ingest→BM25+vector RRF→rerank→graph-expand) when PG is available; the legacy in-memory scan survives only as an explicit fallback for unindexed directories or PG-down, and "query an unindexed directory still returns results" is a tested success criterion
- [ ] **RETR-02**: A query matching only a symbol/label name (function or class name) returns that symbol's chunk with a non-zero score — label tokens seed the TF term before BM25 saturation
- [ ] **RETR-03**: The MCP `search-code` tool ranks by the query (pgvector `<=>` or hybrid_search) — never an unfiltered `SELECT ... LIMIT n`
- [ ] **RETR-04**: One staleness authority — `MtimeIndex` is retired in the same change that re-points `/query`; SHA-256 staleness drives all paths
- [ ] **RETR-05**: The dependency graph is actually built (rebuild on ingest/startup), edge strings resolve to symbol names, `dependents` populated by reverse pass — `expand_chunks_with_graph` returns real callers/callees, and this lands atomically with RETR-01
- [ ] **RETR-06**: Caveman description field is weighted in pg_search ranking (e.g. `description^2`) so the Phase 22 format has measurable retrieval effect
- [ ] **RETR-07**: Ranking consistency sweep — BM25 `b` aligned or documented across engines, tokenizer keeps short/digit-leading identifiers (`s3`, `db`, `v2`), TF fallback uses tokens not substrings, ingestion no longer re-execs rlm-service.py per non-code file, reranker cache keys are stable per chunk

### Memory Ranking & Lifecycle (expansion — audit §1 findings)

- [ ] **MEMR-01**: The Claude LLM distillation path executes (dead `execSync` fixed) and is canary-verified on a real merge group before any other distill change ships
- [ ] **MEMR-02**: `applied_count` enters search ranking as a bounded boost (e.g. `min(log1p(applied_count), 3)`) in BOTH text and semantic scoring, shipped with an echo-chamber canary metric (top-1 concentration) in the same phase
- [ ] **MEMR-03**: Default memory search fuses FTS + vector via the shared RRF helper generalized from `rlm_search.py`; AND-joined-terms → ILIKE relevance-blind fallback is eliminated
- [ ] **MEMR-04**: Scoring happens over-fetch-then-truncate (or in SQL ORDER BY) so source bonus/recency/citations can rescue candidates beyond the raw LIMIT window
- [ ] **MEMR-05**: Distillation preserves signal — max source bonus carried, `applied_count` summed, citations merged; auto-distill uses the LLM path (not concatenation); distill eligibility no longer capped at the newest 1000 rows
- [ ] **MEMR-06**: Write-path dedup exists even when embeddings are unavailable (trigram/Jaccard fallback in `memory_store`)
- [ ] **MEMR-07**: Reranker output blends with the composite score (source/recency/citations) instead of replacing it; `hnsw.iterative_scan` GUC set correctly for the HNSW index
- [ ] **MEMR-08**: Bi-temporal validity (`valid_at`/`invalid_at`) + mem0-style write-time ADD/UPDATE/DELETE/NOOP classifier ship together in one migration, verified by a synthetic contradiction test (new fact closes the old fact's validity window)

### Enforcement Hooks (expansion — audit §4 mandatoriness ladder)

- [ ] **HOOK-01**: A PreToolUse manifest gate physically blocks Edit/Write to files outside the claimed task's `files_expected` (+GLOBAL_ALLOWLIST); `ORCHESTRATOR_OWNED` is a generated, versioned artifact — not a hand-maintained list
- [ ] **HOOK-02**: A PreToolUse claim gate blocks code writes when no Amauta task is claimed in the session — harness usage becomes structurally mandatory
- [ ] **HOOK-03**: A Stop-hook completion gate blocks turn-end while the claimed task lacks T-phase evidence or has unresolved divergence reports — every block emits a structured reason, has a bounded retry count, and a fail-open escalation path (no un-passable deadlock)
- [ ] **HOOK-04**: SessionStart/PreCompact hooks auto-write and rehydrate a structured handoff ledger (current wave, open divergences, next action) — pause/resume no longer depends on a manual skippable step
- [ ] **HOOK-05**: `GSD_HOOKS_ENFORCE=off` kill switch + fail-open behavior when the daemon is unreachable — a broken gate can never brick all Edit/Write
- [ ] **HOOK-06**: A full plan→execute→close cycle runs green with all hooks active (self-test), proving the orchestrator's own legitimate writes are not blocked
- [ ] **HOOK-07**: A CI job mirrors the hook gates (manifest diff, validator verdict present, test suite) so edits made outside the harness meet the same bar

### Mobile/Wearable Build Loops (expansion — enables the 5 new executors)

- [ ] **MOBL-01**: XcodeBuildMCP (2.6.2) is registered as an MCP server (gated on mobile executors being installed) — `gsd-executor-mobile-ios` and `gsd-executor-wearables` can build, unit-test, and drive a simulator for iOS/watchOS targets
- [ ] **MOBL-02**: Android/Wear OS loop — allowlisted `./gradlew` Bash calls for build/test/lint plus `@mobilenext/mobile-mcp` (pinned 0.0.61, opt-in) for device/emulator control
- [ ] **MOBL-03**: Environment capability detection — when no simulator/emulator exists (CI), the loop degrades to compile+unit-test with a visible skip reason instead of failing the gate
- [ ] **MOBL-04**: Secrets scanning extends to build-log/evidence capture — signing identities and tokens never land in task evidence or memory
- [ ] **MOBL-05**: The validator's mobile-UAT ground truth is accessibility-tree snapshots (deterministic, diffable); pixel/screenshot checks are advisory only

### Mobile AST Grammars (expansion — after RETR lands)

- [ ] **ASTG-01**: Kotlin and Swift files chunk via tree-sitter AST (grammar node types confirmed against each grammar's `node-types.json`), replacing paragraph-splitting fallback
- [ ] **ASTG-02**: Go, Rust, and Java files chunk via tree-sitter AST with the same discipline
- [ ] **ASTG-03**: Chunk-parity verification — a symbol query in each new language retrieves its defining chunk end-to-end through the unified pipeline (proves grammars landed on the unified stack, not a third path)

### E2E Cross-Service Verification (expansion)

- [ ] **E2E-01**: Boot-time health verification (extends `doctor`) covers PG, Valkey, daemon, RLM, MCP server, and hook registration in one command with per-service pass/fail and active-fallback reporting
- [ ] **E2E-02**: At least one synthetic-transaction flow crosses PG→Valkey→daemon→RLM→MCP→hooks (create task → claim → enrich → store memory → search → validate) using readiness checks, never sleeps
- [ ] **E2E-03**: Test isolation is verified, not assumed — E2E fixtures are `__test__`-scoped with verified cleanup, and the existing test pollution in `.planning/STATE.md` Learnings (2026-07-02/03 entries) is cleaned up in the same phase

### Observability (expansion — instruments everything above; builds on TEL consent framework)

- [ ] **OBS-01**: OTel GenAI-convention spans emitted from daemon/agent/LLM call sites behind `GSD_TELEMETRY=on` (buffered, never blocking — TEL-03 discipline applies)
- [ ] **OBS-02**: Self-hosted Langfuse (3.203.3) as an optional docker-compose service receiving OTLP export; absence never degrades the harness
- [ ] **OBS-03**: Per-agent/per-phase token+cost summary surfaced via `amauta health`/`stats` from the collected spans

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
| FIDEL-01 | 59 | Complete |
| FIDEL-02 | 59 | Complete |
| FIDEL-03 | 59 | Complete |
| FIDEL-04 | 59 | Complete |
| FIDEL-05 | 59 | Complete |
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
| RETR-01 | 65 | Pending |
| RETR-02 | 65 | Pending |
| RETR-03 | 65 | Pending |
| RETR-04 | 65 | Pending |
| RETR-05 | 65 | Pending |
| RETR-06 | 65 | Pending |
| RETR-07 | 65 | Pending |
| MEMR-01 | 66 | Pending |
| MEMR-02 | 66 | Pending |
| MEMR-03 | 66 | Pending |
| MEMR-04 | 66 | Pending |
| MEMR-05 | 66 | Pending |
| MEMR-06 | 66 | Pending |
| MEMR-07 | 66 | Pending |
| MEMR-08 | 66 | Pending |
| HOOK-01 | 67 | Pending |
| HOOK-02 | 67 | Pending |
| HOOK-03 | 67 | Pending |
| HOOK-04 | 67 | Pending |
| HOOK-05 | 67 | Pending |
| HOOK-06 | 67 | Pending |
| HOOK-07 | 67 | Pending |
| MOBL-01 | 68 | Pending |
| MOBL-02 | 68 | Pending |
| MOBL-03 | 68 | Pending |
| MOBL-04 | 68 | Pending |
| MOBL-05 | 68 | Pending |
| ASTG-01 | 69 | Pending |
| ASTG-02 | 69 | Pending |
| ASTG-03 | 69 | Pending |
| E2E-01 | 70 | Pending |
| E2E-02 | 70 | Pending |
| E2E-03 | 70 | Pending |
| OBS-01 | 71 | Pending |
| OBS-02 | 71 | Pending |
| OBS-03 | 71 | Pending |

**Coverage:**
- v1 requirements: 56 total (20 original + 36 expansion)
- Mapped to phases: 56 / Unmapped: 0 ✓

**Execution-order constraints (for roadmapper):**
- FIDEL track is the FOUNDATION — its phase(s) must be first and must complete before any TOOL/PERS/TEL/POS phase begins (SATISFIED — Phase 59 complete)
- HARD track phase(s) depend on the v3.3.0 npm publish having happened + a real-usage data window; sequence HARD last and note the external gate
- TOOL and PERS are independent of each other (different surfaces) and may parallelize after FIDEL
- POS benefits from TEL data; sequence POS after TEL where practical

**Expansion-track constraints (2026-07-02, from .planning/research/SUMMARY.md):**
- RETR first among expansion tracks — MEMR reuses its generalized RRF helper; ASTG on a still-split-brain pipeline would create a third disjoint stack; RETR-05 (graph) must land atomically with RETR-01
- MEMR after RETR (shared `hybrid_search_generic()`); MEMR-01 canary lands before MEMR-05 within the phase
- HOOK requires FIDEL-01 (done) AND TOOL-01 (Phase 60) as its allowlist source — HOOK phase must sequence after Phase 60; own atomic phase for blast-radius isolation
- MOBL after HOOK (mobile executors gated before gaining build-tool reach)
- ASTG after RETR completes
- E2E after HOOK (synthetic transaction must exercise hooks; avoids a second verification pass)
- OBS last — it instruments all other tracks; builds on TEL (Phase 62) consent/buffering framework, so sequence after Phase 62

---
*Requirements defined: 2026-05-15*
*Last updated: 2026-07-02 — expansion traceability filled by roadmapper; all 36 expansion requirements mapped to Phases 65-71 (56/56 total requirements mapped, 20 original + 36 expansion). Original Phases 59-64 rows byte-untouched.*

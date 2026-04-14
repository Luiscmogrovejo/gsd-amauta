# Roadmap: GSD-Amauta v3.0 "The Birth"

**Milestone:** v3.0 — The Birth (Agent Quality + Ecosystem Infrastructure)
**Starting phase number:** 31 (v2.9 ended at Phase 29; Phase 30 cancelled)
**Phases:** 10 (Phases 31..40)
**Requirements:** 55 total (v3.0 scope)
**Granularity:** coarse (per config.json)
**Status:** Defined 2026-04-13

**Core value:** The discipline has shifted from prompt engineering to context engineering — find the smallest set of high-signal tokens that maximizes agent behavior quality. Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.

**Body-metaphor sequence:** brain (v2.5) → sight (v2.6) → hands (v2.7) → metabolism (v2.8) → nervous system (v2.9) → **birth (v3.0)**. Birth is when the organism becomes viable on its own: a standardized body, a hardened immune system, and the ability to communicate across organs. The 17 agents get a shared skeletal structure (Phase 31), specialized new agents for every discipline (Phases 32-37), blackboard-based inter-agent communication replacing hub-spoke messaging (Phase 38), and a lifecycle management system that versions, evaluates, and continuously improves every agent (Phase 39). Engineering standards embed best practices in agent DNA (Phase 40).

**Goal:** 17 agents operating with standardized format, specialized capabilities, and blackboard communication. Every agent versioned, metriced, and evaluated. Engineering best practices embedded in agent behavior. The GSD-Amauta ecosystem is born as a coherent, maintainable multi-agent system.

---

## Hard Constraints (apply to every phase)

1. **Scope ceilings are load-bearing.** Exceeding the declared LOC ceiling without a divergence report is a Phase 13 fingerprint and triggers halt-phase.
2. **HARDEN-01 manifest enforcement is active.** `files_expected` blocks are mandatory per task.
3. **`gsd-tools plan-to-tasks` auto-registration is mandatory** for every phase. Every PLAN.md must have `<story>` and `<task>` XML blocks.
4. **Divergence protocol v1.1.0 active.** Surface mismatches; never silently absorb them.
5. **Backward compatible.** All existing data, configs, and workflows must continue working after `npm install -g . && docker compose up`.
6. **Research-backed.** Every improvement must cite its source (research findings, academic papers, or prior research brief).
7. **Test coverage maintained.** `node --test tests/` and `pytest` must pass with 0 new failures before each phase is marked complete.
8. **No new runtimes.** Python + Node.js only. No K3s, no Langfuse, no gVisor.

---

## Phases

- [x] **Phase 31: Format Standard** — All 11 existing agents restructured to standardized 10-section format; shared security rules; behavioral regression suite (FORMAT-01..07) (FOUNDATION — everything depends on this) — COMPLETE 2026-04-13
- [ ] **Phase 32: Frontend Rebuild** — gsd-executor-frontend rebuilt with v0-inspired composite pipeline; React 19 + TypeScript + Tailwind + shadcn/ui; Playwright screenshots (FRONT-01..07) [Plan 32-01 COMPLETE 2026-04-14]
- [x] **Phase 33: Testing Pipeline** — Two new agents: gsd-tester (generates) and gsd-qa (evaluates); CoverUp coverage-guided iteration; mutation testing; Pact contracts (TEST-01..08) — COMPLETE 2026-04-13 (Wave 1: agents + scripts; Wave 2: stryker, Pact contracts, Playwright POM, fast-check, quality-audit; Wave 3: 111-assertion regression suite TEST-01..08)
- [x] **Phase 34: Security Pipeline** — New gsd-security agent; Semgrep SAST, Gitleaks, npm/pip audit, supply chain rules, Rule of Two audit, Trivy container scan (SEC-01..06) — COMPLETE 2026-04-13 (34-01: gsd-security agent + Semgrep rules + Gitleaks config + fixtures; 34-02: 12-rule supply chain propagated to 14 agents + rule-of-two-audit.cjs + install-trivy.cjs + security-scan.cjs; 34-03: 89-assertion regression suite SEC-01..06)
- [ ] **Phase 35: Code Review Agent** — New gsd-reviewer; style/pattern review, SOLID check, structured output schema (REVIEW-01..04)
- [ ] **Phase 36: Data Engineering Agent** — New gsd-executor-data; expand-and-contract migrations, query analysis, data quality checks (DATA-01..04)
- [ ] **Phase 37: Architect Agent** — New gsd-architect; ADR management, API design review, N+1 detection (ARCH-01..03)
- [ ] **Phase 38: Blackboard Communication** — `agent_findings` + `agent_messages` PG tables; operator supervision; structured handoff JSON; conflict resolution (COMM-01..05)
- [ ] **Phase 39: Agent Lifecycle** — SemVer versioning, `agent_metrics` PG table, 50-test canary suite, eval framework, tool integrity checking (LIFE-01..05) (CAPSTONE — needs all others)
- [x] **Phase 40: Engineering Standards** — Git workflow, error handling, documentation, configuration management, structured logging standards embedded in all agents (ENG-01..05) — COMPLETE 2026-04-13 (40-01: engineering standards ENG-01..05 in shared file + all 4 executor agents; ENG-01 git workflow in gsd-planner; 40-02: remaining 9 agents + 167-assertion verification test suite)

---

## Phase Dependency Graph

```
Phase 31 (Format Standard) — FOUNDATION
    │   All 11 agents on standardized 10-section format
    │
    ├──> Phase 32 (Frontend Rebuild)          — parallel after 31
    ├──> Phase 33 (Testing Pipeline)          — parallel after 31
    │        │
    │        └──────────────────────────────> Phase 38 (Blackboard)
    ├──> Phase 34 (Security Pipeline)         — parallel after 31
    ├──> Phase 35 (Code Review Agent)         — parallel after 31
    ├──> Phase 36 (Data Engineering Agent)    — parallel after 31
    ├──> Phase 37 (Architect Agent)           — parallel after 31
    └──> Phase 40 (Engineering Standards)     — parallel after 31
              │
              └──> all above feed into ──────> Phase 39 (Agent Lifecycle) — CAPSTONE
```

**Recommended execution order:** 31 → 33 → 34 → 40 → 32 → 35 → 36 → 37 → 38 → 39

Rationale:
- Phase 31 first: format standard makes all subsequent agent-creation phases consistent
- Phase 33 next: testing pipeline needed before Phase 38 (Pact contracts test blackboard endpoints)
- Phase 34 + 40 early: security + engineering standards embed into every new agent created after them
- Phases 32, 35, 36, 37 in any order: independent new agents
- Phase 38 after Phase 33: blackboard communication tested with Pact contracts
- Phase 39 last: lifecycle management wraps the completed 17-agent ecosystem

---

## Phase Details

### Phase 31: Format Standard
**Goal:** All 11 existing agents operate with a standardized, consistent 10-section structure. Shared security rules have a single source of truth. Anti-over-engineering and read-before-edit mandates are embedded in every relevant agent. Behavioral regression suite confirms zero regressions from v2.9.
**Depends on:** Nothing (v2.9 complete; this is the foundation for all v3.0 phases)
**Requirements:** FORMAT-01, FORMAT-02, FORMAT-03, FORMAT-04, FORMAT-05, FORMAT-06, FORMAT-07
**Success Criteria** (what must be TRUE):
  1. `grep -c "^## " agents/*.md` returns exactly 10 for all 11 agent files; all 10 required sections (Role & Identity, Domain Knowledge, Behavioral Rules, Tool Access & Guidance, Task Management, Examples, Error Handling, Security Rules, Preconditions & Constraints, version header) are present in each file.
  2. Every agent file contains 2-4 few-shot examples showing input → reasoning → output; examples are diverse and canonical (not edge cases).
  3. `agents/shared/security-rules.md` exists and its contents are byte-identical in the Security Rules section of all 11 agent files; no agent has a custom security rules section.
  4. All 11 agent files and all 4 executor agents contain the exact anti-over-engineering and read-before-edit mandate strings; `grep` finds them verbatim.
  5. Behavioral regression suite runs and returns 0 failures; all test cases that passed in v2.9 pass unchanged.
**Plans:** 2/2 plans complete

Plans:
- [x] 31-01: Restructure 4 executor agents to 10-section format; create agents/shared/security-rules.md; embed anti-over-engineering + read-before-edit mandates; FORMAT-01..05 tests green (FORMAT-01..05) — 2026-04-13
- [x] 31-02: Restructure remaining 7 agents; AGENTS.md integration; behavioral regression suite (FORMAT-06..07) — 2026-04-13

### Phase 32: Frontend Rebuild
**Goal:** gsd-executor-frontend delivers React 19 + TypeScript + Tailwind + shadcn/ui frontends via a progressive generation pipeline. Post-generation validation catches type errors and accessibility violations. Playwright screenshots prove responsive behavior across breakpoints.
**Depends on:** Phase 31 (gsd-executor-frontend must be in standardized 10-section format before being rebuilt)
**Requirements:** FRONT-01, FRONT-02, FRONT-03, FRONT-04, FRONT-05, FRONT-06, FRONT-07
**Success Criteria** (what must be TRUE):
  1. gsd-executor-frontend generates a sample component in 4 sequential passes (layout → sections → components → interactivity) and refuses to generate a full page in a single pass.
  2. A generated frontend uses React 19, TypeScript strict mode, Tailwind CSS 4, and shadcn/ui primitives; the agent refuses a task that specifies vanilla CSS or untyped JavaScript.
  3. Generated output has no component exceeding 200 lines; components are organized into `components/ui/`, `components/`, and `app/` directories per the mandated structure.
  4. `tsc --noEmit` and ESLint + eslint-plugin-jsx-a11y produce 0 errors on all generated code; agent self-corrects within 3 iterations.
  5. Playwright screenshots are stored in `tests/screenshots/` at 375px, 768px, and 1440px breakpoints for every generated page component.
**Plans:** TBD (estimated 2 plans: 32-01 agent rebuild + stack enforcement, 32-02 validation pipeline + Playwright)

Plans:
- [x] 32-01: Rebuild gsd-executor-frontend with progressive pipeline; enforce mandatory stack; component structure rules; state decision tree (FRONT-01..07) — 2026-04-14
- [ ] 32-02: Post-generation validation test suite verifying all FRONT-XX rules present and old mandates survive (FRONT-01..07 regression)

### Phase 33: Testing Pipeline
**Goal:** Two new agents — gsd-tester and gsd-qa — operate under the "no self-assessment" principle. gsd-tester generates coverage-guided unit tests, E2E Playwright tests, and property-based tests. gsd-qa enforces coverage ratchet, mutation scoring, test pyramid, and quality audits. Pact contracts verify daemon endpoint stability.
**Depends on:** Phase 31 (both new agents must be created in standardized 10-section format from the start)
**Requirements:** TEST-01, TEST-02, TEST-03, TEST-04, TEST-05, TEST-06, TEST-07, TEST-08
**Success Criteria** (what must be TRUE):
  1. gsd-tester given a module at 60% coverage produces passing tests that reach >= 80% coverage within 5 CoverUp iterations; all generated tests pass on first run.
  2. gsd-tester generates Playwright E2E tests with Page Object Model; each test covers a complete user journey (not a single click).
  3. `.coverage_threshold.json` exists and is enforced by gsd-qa; threshold values never decrease between runs; gsd-qa auto-increments on improvement.
  4. Stryker mutation score for changed files is >= 70% as reported by gsd-qa; mutation testing runs only on files modified in the current task (not full repo).
  5. gsd-qa test pyramid audit reports unit >= 60%, integration >= 20%, E2E <= 20% by naming convention; audits flag tests with no assertions, implementation-testing patterns, and flaky test markers.
  6. Pact consumer contracts exist for >= 3 daemon endpoints; provider verification passes against the running daemon.
**Plans:** 3/3 plans complete

Plans:
- [ ] 33-01: Create gsd-tester agent with CoverUp pattern, Playwright E2E, fast-check property-based tests (TEST-01..03)
- [ ] 33-02: Create gsd-qa agent with coverage ratchet, Stryker mutation, test pyramid, quality audit; add Pact contracts for 3+ daemon endpoints (TEST-04..08)

### Phase 34: Security Pipeline
**Goal:** A new gsd-security agent runs SAST, secret scanning, dependency auditing, and supply chain enforcement across the RPETD pipeline. All executor agents carry supply chain rules. Rule of Two audit covers all 17 agents. Trivy scans container images.
**Depends on:** Phase 31 (gsd-security created in standardized 10-section format; supply chain rules added to existing agents after Phase 31 standardization)
**Requirements:** SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-06
**Success Criteria** (what must be TRUE):
  1. gsd-security runs Semgrep with OWASP Top 10 rules on JS and Python files; scan completes in < 30 seconds; findings are structured JSON with file, line, rule, severity.
  2. gsd-security runs Gitleaks on full git history on first invocation and pre-commit on subsequent runs; entropy scores are logged per secret finding.
  3. gsd-security runs `npm audit` and `pip-audit`; the agent blocks (exits non-zero) on any critical or high finding with no available fix.
  4. All executor agent files contain supply chain rules: `npm ci` (not npm install), exact version pinning, lockfile commits, 7-day waiting period for new packages.
  5. Rule of Two audit produces a JSON report annotating all 17 agents with `{reads_untrusted, accesses_sensitive, modifies_state}` booleans; >= 1 violation is documented with remediation.
  6. Trivy container scan runs against all images in `docker-compose.yml`; findings are structured JSON; scan completes without error.
**Plans:** 3/3 plans complete

Plans:
- [x] 34-01: Create gsd-security agent with Semgrep SAST, Gitleaks secret scanning; test fixtures; install-gitleaks.cjs (SEC-01..02) — 2026-04-13
- [x] 34-02: Supply chain rules in all 14 agent files (7→12 rules); Rule of Two audit for all current agents; install-trivy.cjs; unified orchestrator scripts/security-scan.cjs (SEC-03..06) — 2026-04-13
- [x] 34-03: Integration tests and regression suite covering SEC-01..06; 89 assertions (60 unit + 29 integration), 0 failures; full regression gate 293/293 pass — 2026-04-13

### Phase 35: Code Review Agent
**Goal:** A new gsd-reviewer agent provides the "always-available second pair of eyes" capability for a solo developer. It detects style violations, duplication, SOLID violations, and produces structured output that is distinct from and complementary to gsd-validator.
**Depends on:** Phase 31 (gsd-reviewer created in standardized 10-section format)
**Requirements:** REVIEW-01, REVIEW-02, REVIEW-03, REVIEW-04
**Success Criteria** (what must be TRUE):
  1. gsd-reviewer identifies naming violations, dead code, duplication > 10 lines, and functions > 50 lines in a test file containing known violations; report includes file, line, category, severity, message, and suggestion for each finding.
  2. gsd-reviewer identifies god classes (> 500 lines), functions with > 5 parameters, and circular dependencies in a test module; findings are distinct from validator findings on the same code.
  3. gsd-reviewer and gsd-validator can both run on the same code without conflict; their output schemas are different; a finding in one does not imply a finding in the other.
  4. gsd-reviewer produces structured output matching schema `{findings: [{file, line, category, severity, message, suggestion}], summary, approval: "approve"|"request_changes"|"comment_only"}`.
**Plans:** TBD (estimated 1 plan: 35-01 full gsd-reviewer agent)

Plans:
- [ ] 35-01: Create gsd-reviewer with style/pattern review, SOLID check, structured output schema; confirm independence from gsd-validator (REVIEW-01..04)

### Phase 36: Data Engineering Agent
**Goal:** A new gsd-executor-data owns the data layer: it writes safe expand-and-contract migrations, analyzes query performance, generates data quality checks, and understands the GSD-Amauta schema well enough to produce the next migration in sequence.
**Depends on:** Phase 31 (gsd-executor-data created in standardized 10-section format)
**Requirements:** DATA-01, DATA-02, DATA-03, DATA-04
**Success Criteria** (what must be TRUE):
  1. gsd-executor-data generates a migration that adds a column (additive), then a backfill step, then removal of the old column — three separate migration files; it refuses to execute a destructive schema change without explicit user confirmation.
  2. gsd-executor-data runs EXPLAIN ANALYZE on any query touching > 1 table; findings flag sequential scans on > 10K rows, missing indexes, and N+1 patterns with file and line reference.
  3. Every migration generated by gsd-executor-data is accompanied by data quality check queries covering NOT NULL, FK integrity, enum validation, and uniqueness constraints.
  4. gsd-executor-data correctly identifies migrations 001-013 in sequence and generates migration 014 with the next sequential number and correct filename format.
**Plans:** TBD (estimated 1 plan: 36-01 full gsd-executor-data agent)

Plans:
- [ ] 36-01: Create gsd-executor-data with expand-and-contract migrations, EXPLAIN ANALYZE, data quality checks, schema awareness (DATA-01..04)

### Phase 37: Architect Agent
**Goal:** A new gsd-architect provides strategic design review: ADRs for significant decisions, API consistency review, and N+1 pattern detection in proposed designs.
**Depends on:** Phase 31 (gsd-architect created in standardized 10-section format)
**Requirements:** ARCH-01, ARCH-02, ARCH-03
**Success Criteria** (what must be TRUE):
  1. gsd-architect generates an ADR for a sample design decision containing context, decision, consequences, and alternatives sections; the file is stored in `docs/adr/` with a sequential number and descriptive slug.
  2. gsd-architect reviews an API design and flags inconsistent naming, wrong HTTP methods, missing pagination, non-standard error format, or missing versioning — at least 3 of these checks are exercised in the test case.
  3. gsd-architect identifies an N+1 query pattern in a proposed design and suggests eager loading, batching, or DataLoader as the resolution.
**Plans:** TBD (estimated 1 plan: 37-01 full gsd-architect agent)

Plans:
- [ ] 37-01: Create gsd-architect with ADR management, API design review, N+1 detection (ARCH-01..03)

### Phase 38: Blackboard Communication
**Goal:** Inter-agent communication upgrades from hub-spoke to blackboard architecture. Two PG tables enable agents to share findings and ask questions. Operator supervision gates message types. Structured handoff JSON replaces ad-hoc context passing. Conflict resolution rules prevent deadlock.
**Depends on:** Phase 31 (all 17 agents must be on standardized format before blackboard is added) and Phase 33 (Pact contracts test the new PG endpoints)
**Requirements:** COMM-01, COMM-02, COMM-03, COMM-04, COMM-05
**Success Criteria** (what must be TRUE):
  1. `agent_findings` table exists in PG with schema `{id, agent_name, task_id, finding_type, content, confidence, created_at}`; a pgvector semantic search over findings returns the closest finding to a test query.
  2. `agent_messages` table exists with message types `ASK_QUESTION`, `SHARE_FINDING`, `REQUEST_REVIEW`, `DELEGATE_SUBTASK`; a `SHARE_FINDING` message is auto-approved; a `DELEGATE_SUBTASK` message requires operator approval (`operator_approved: true`) before the target agent acts on it.
  3. A complete agent handoff produces structured JSON matching schema `{task_id, from_agent, handoff_type, summary, key_findings[], decisions_made[], open_questions[], artifacts[], confidence}` in <= 800 tokens.
  4. Conflict resolution rules are exercised: security finding wins over style finding on the same file; test results win on correctness disputes; ambiguous conflicts escalate rather than auto-resolve.
**Plans:** TBD (estimated 2 plans: 38-01 PG tables + pgvector search, 38-02 operator supervision + handoff JSON + conflict resolution)

Plans:
- [ ] 38-01: Create agent_findings + agent_messages PG tables with pgvector semantic search; message type enforcement (COMM-01..02)
- [ ] 38-02: Operator supervision logic; structured handoff JSON; conflict resolution rules (COMM-03..05)

### Phase 39: Agent Lifecycle
**Goal:** All 17 agents are versioned with SemVer, metriced in PG, evaluated with a canary suite, and assessed with a three-grader eval framework. Tool integrity checking at startup detects tampered tool definitions.
**Depends on:** All other phases (lifecycle management wraps the complete 17-agent ecosystem; canary suite and eval framework need all agents to exist and be functional)
**Requirements:** LIFE-01, LIFE-02, LIFE-03, LIFE-04, LIFE-05
**Success Criteria** (what must be TRUE):
  1. All 17 agent `.md` files have a SemVer version header; `agents/changelog/` exists with at least one entry per agent; version is incremented when agent behavior changes.
  2. `agent_metrics` PG table exists with schema `{agent_name, task_id, completion_time_ms, token_usage, error_count, outcome}`; `gsd-tools agent-stats` command produces a summary report.
  3. 50-test canary suite runs in < 5 minutes; McNemar's test is applied; suite alerts (exit non-zero) when degradation > 1% with p < 0.05.
  4. Eval framework exists in `tests/evals/`; >= 5 scenarios per agent for at least 3 agents; grader types include code-based (deterministic), model-based, and human-review placeholders.
  5. Startup tool integrity check computes SHA hash of tool definitions; any mismatch between startup hash and current hash produces a `TOOL_INTEGRITY_VIOLATION` log event and blocks the affected tool.
**Plans:** TBD (estimated 2 plans: 39-01 SemVer headers + agent_metrics + canary suite, 39-02 eval framework + tool integrity)

Plans:
- [ ] 39-01: SemVer version headers in all 17 agents; agents/changelog/; agent_metrics PG table; gsd-tools agent-stats command; canary suite (LIFE-01..03)
- [ ] 39-02: Eval framework in tests/evals/ with 3 grader types; tool integrity SHA checking at startup (LIFE-04..05)

### Phase 40: Engineering Standards
**Goal:** Git workflow conventions, error handling patterns, documentation standards, configuration management, and structured logging are embedded in agent behavior — not just documented, but enforced by what agents generate and refuse to generate.
**Depends on:** Phase 31 (engineering standards applied to the already-standardized agent format; agents updated after Phase 31 restructuring)
**Requirements:** ENG-01, ENG-02, ENG-03, ENG-04, ENG-05
**Success Criteria** (what must be TRUE):
  1. All executor agents reject a branch name that does not follow `feat/`, `fix/`, `refactor/`, `test/` convention; agents generate commit messages in conventional commit format; PR templates exist in `.github/`.
  2. All executor agents generate try-catch blocks at service boundaries returning structured `{code, message, details}` error objects; agents flag any exception caught and discarded (swallowed) in generated code.
  3. All executor agents generate JSDoc (TypeScript) or Python docstrings on public functions with @param, @returns, @throws, and usage examples; agents flag undocumented public API functions in reviewed code.
  4. All executor agents use environment variables with defaults for any URL, port, or timeout; agents refuse to hardcode values when asked to write configuration.
  5. All executor agents generate structured log statements `{timestamp, level, service, message, context}` with appropriate log levels; agents flag any `console.log` in production code during review.
**Plans:** 2/2 plans complete

Plans:
- [x] 40-01: Embed git workflow, error handling, documentation, configuration management, and structured logging standards into all executor agents (ENG-01..05) — 2026-04-13
- [x] 40-02: Embed engineering standards in remaining 9 agents (operator, researcher, roadmapper, checker, validator, debugger, tester, qa, security); 75-assertion unit tests + 92-assertion integration tests; full regression gate (ENG-01..05) — 2026-04-13

---

## Phase Dependency Graph (Detailed)

```
Phase 31: Format Standard (FOUNDATION)
    All 11 existing agents on standardized 10-section format
    Blocks: everything below
    │
    ├──> Phase 32: Frontend Rebuild       — independent, parallel
    ├──> Phase 33: Testing Pipeline       ─────────────────────────────┐
    ├──> Phase 34: Security Pipeline      — independent, parallel       │
    ├──> Phase 35: Code Review Agent      — independent, parallel       │
    ├──> Phase 36: Data Engineering Agent — independent, parallel       │
    ├──> Phase 37: Architect Agent        — independent, parallel       │
    ├──> Phase 40: Engineering Standards  — independent, parallel       │
    │                                                                   │
    │   (Phase 33 Testing Pipeline also feeds Phase 38)                 │
    │                                                                   ▼
    └──────────────────────────────────────> Phase 38: Blackboard Communication
                                                needs Phase 31 + Phase 33
                                                │
                                                └──> Phase 39: Agent Lifecycle (CAPSTONE)
                                                         needs ALL prior phases
```

**Recommended execution order:** 31 → 33 → 34 → 40 → 32 → 35 → 36 → 37 → 38 → 39

**Parallelizable blocks:**
- Block A (after 31): Phases 33, 34, 40 can run concurrently
- Block B (after Block A): Phases 32, 35, 36, 37 can run concurrently
- Phase 38 runs after Phase 33 completes
- Phase 39 runs after all others complete

---

## Progress

**Execution Order:** 31 → 33 → 34 → 40 → 32 → 35 → 36 → 37 → 38 → 39

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 31. Format Standard | 2/2 | Complete    | 2026-04-13 |
| 32. Frontend Rebuild | 1/2 | In progress | - |
| 33. Testing Pipeline | 3/3 | Complete    | 2026-04-13 |
| 34. Security Pipeline | 3/3 | Complete    | 2026-04-13 |
| 35. Code Review Agent | 0/1 | Not started | - |
| 36. Data Engineering Agent | 0/1 | Not started | - |
| 37. Architect Agent | 0/1 | Not started | - |
| 38. Blackboard Communication | 0/2 | Not started | - |
| 39. Agent Lifecycle | 0/2 | Not started | - |
| 40. Engineering Standards | 2/2 | Complete    | 2026-04-14 |

---

*Roadmap created: 2026-04-13 for v3.0 "The Birth" milestone.*
*Primary input: .planning/REQUIREMENTS.md (55 requirements across 10 phases), PROJECT.md (v3.0 goal)*
*Phase structure: user-specified dependency graph (31 serial foundation → 32-37+40 parallel → 38 needs 31+33 → 39 capstone)*
*Previous milestone (v2.9 Nervous System): 4 phases shipped (26-29), Phase 30 cancelled (K3s non-portable)*

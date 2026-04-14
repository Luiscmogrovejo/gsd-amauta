# Requirements: GSD-Amauta v3.0 "The Birth"

**Defined:** 2026-04-13
**Core Value:** The discipline has shifted from prompt engineering to context engineering — find the smallest set of high-signal tokens that maximizes agent behavior quality. Every RPETD phase must *see* what other phases have learned. The brain synthesizes, not accumulates.

---

## Phase 31 — Format Standard (FOUNDATION)

All 11 existing agents restructured to standardized 10-section format. Foundation for every subsequent phase.

- [x] **FORMAT-01**: All 11 agent `.md` files restructured to standardized 10-section format. `grep -c "^## " agents/*.md` returns 10 for each file. All sections present: Role & Identity, Domain Knowledge, Behavioral Rules, Tool Access & Guidance, Task Management, Examples, Error Handling, Security Rules, Preconditions & Constraints, version header.
- [x] **FORMAT-02**: 2-4 few-shot examples per agent. Diverse, canonical, not edge cases. Each example shows input → reasoning → output.
- [x] **FORMAT-03**: Shared security rules section identical across all 11 agents. Single source of truth in `agents/shared/security-rules.md`.
- [x] **FORMAT-04**: Anti-over-engineering guardrail in every agent. Exact: "Do not add features, refactor code, or make improvements beyond what was explicitly requested."
- [x] **FORMAT-05**: Read-before-edit mandate in all 4 executor agents. Exact: "Always read a file completely before modifying it. Never edit a file based on assumptions about its contents."
- [x] **FORMAT-06**: AGENTS.md closest-file-wins discovery. Agents cannot create/modify AGENTS.md.
- [x] **FORMAT-07**: All 11 agents pass behavioral regression suite. Zero regressions from v2.9.

## Phase 32 — Frontend Rebuild

gsd-executor-frontend rebuilt with v0-inspired composite pipeline.

- [x] **FRONT-01**: Progressive generation pattern (layout → sections → components → interactivity). Never full-page in one pass.
- [x] **FRONT-02**: Mandatory stack: React 19 + TypeScript strict + Tailwind CSS 4 + shadcn/ui. Warns and adapts for vanilla CSS, inline styles, untyped JS (new code uses mandatory stack; existing code left alone).
- [x] **FRONT-03**: Component-driven: `components/ui/` (shadcn primitives), `components/` (composed), `app/` (routes). No component > 200 lines.
- [x] **FRONT-04**: State decision tree: local→useState, shared UI→Zustand, server→TanStack Query, URL→search params.
- [x] **FRONT-05**: WCAG 2.1 AA baseline. Semantic HTML, ARIA, keyboard nav, focus mgmt, contrast. `eslint-plugin-jsx-a11y` 0 errors.
- [x] **FRONT-06**: Post-generation validation: `tsc --noEmit`, ESLint + a11y lint, dependency completeness. Max 3 self-correction iterations.
- [x] **FRONT-07**: Playwright screenshots at 3 breakpoints (375px, 768px, 1440px). Stored in `tests/screenshots/`.

## Phase 33 — Testing Pipeline

Two new agents: gsd-tester (generates) and gsd-qa (evaluates). Separated by "no self-assessment" principle.

- [ ] **TEST-01**: gsd-tester with CoverUp pattern. Coverage-guided iteration, max 5 rounds. Given 60% coverage → ≥ 80% within 5 iterations. Tests must PASS.
- [ ] **TEST-02**: gsd-tester generates Playwright E2E tests. Page Object Model. Complete user journey per test.
- [ ] **TEST-03**: gsd-tester generates fast-check property-based tests for pure functions. 100 iterations.
- [ ] **TEST-04**: gsd-qa coverage ratchet. `.coverage_threshold.json` with `{lines: N, branches: N}`. Never decreases. Auto-increments on improvement.
- [ ] **TEST-05**: gsd-qa Stryker mutation testing on changed files. Mutation score ≥ 70% for new code.
- [ ] **TEST-06**: gsd-qa test pyramid: ≥ 60% unit, ≥ 20% integration, ≤ 20% E2E. By naming convention.
- [ ] **TEST-07**: gsd-qa test quality audit. Detects: no-assertion tests, impl-testing, flaky tests.
- [ ] **TEST-08**: Pact contract testing for ≥ 3 daemon endpoints. Provider verification passes.

## Phase 34 — Security Pipeline

New gsd-security agent operating across the entire RPETD pipeline.

- [ ] **SEC-01**: gsd-security Semgrep SAST. OWASP Top 10 rules for JS/Python. < 30s scan. Structured findings.
- [ ] **SEC-02**: gsd-security Gitleaks. Pre-commit + full history on first run. Entropy scores.
- [ ] **SEC-03**: gsd-security `npm audit` + `pip-audit`. Blocks on critical/high with no fix.
- [ ] **SEC-04**: Supply chain rules in ALL executor agents. `npm ci`, pin exact versions, commit lockfiles, 7-day waiting for new packages.
- [ ] **SEC-05**: Rule of Two audit for all 17 agents. `{reads_untrusted, accesses_sensitive, modifies_state}` annotations. JSON report.
- [ ] **SEC-06**: Trivy container scan on `docker-compose.yml` images.

## Phase 35 — Code Review Agent

New gsd-reviewer — the "always-available second pair of eyes" for a solo developer.

- [x] **REVIEW-01**: gsd-reviewer style/pattern review. Naming, organization, imports, dead code, duplication (>10 lines), function length (>50 lines flagged).
- [x] **REVIEW-02**: SOLID principles check. God classes (>500 lines), functions with >5 params, circular deps.
- [x] **REVIEW-03**: gsd-reviewer SEPARATE from gsd-validator. Different schemas, different concerns. Both can run on same code.
- [x] **REVIEW-04**: Structured output: `{findings: [{file, line, category, severity, message, suggestion}], summary, approval: "approve"|"request_changes"|"comment_only"}`.

## Phase 36 — Data Engineering Agent

New gsd-executor-data — owns the data layer.

- [ ] **DATA-01**: gsd-executor-data expand-and-contract migrations. Additive first, backfill, then remove. Never destructive without explicit confirmation.
- [ ] **DATA-02**: EXPLAIN ANALYZE on queries touching >1 table. Flags sequential scans on >10K rows, missing indexes, N+1 patterns.
- [ ] **DATA-03**: Data quality checks generated for every new migration. NOT NULL, FK integrity, enum validation, uniqueness.
- [ ] **DATA-04**: Knows GSD-Amauta schema (migrations 001-013). Generates migration 014+ in correct sequence.

## Phase 37 — Architect Agent

New gsd-architect — the strategic thinker.

- [ ] **ARCH-01**: ADRs for significant design choices. Stored in `docs/adr/`. Context, decision, consequences, alternatives.
- [ ] **ARCH-02**: API design review. Consistent naming, HTTP methods, pagination, error format, versioning.
- [ ] **ARCH-03**: N+1 detection in proposed designs. Suggests eager loading, batching, DataLoader patterns.

## Phase 38 — Blackboard Communication

Architectural upgrade from hub-spoke to blackboard-based inter-agent communication.

- [ ] **COMM-01**: `agent_findings` PG table: `{id, agent_name, task_id, finding_type, content, confidence, created_at}`. pgvector semantic search over findings.
- [ ] **COMM-02**: `agent_messages` table with types: `ASK_QUESTION`, `SHARE_FINDING`, `REQUEST_REVIEW`, `DELEGATE_SUBTASK`.
- [ ] **COMM-03**: Operator supervises all inter-agent messages. `operator_approved: bool` field. Auto-approve low-risk (SHARE_FINDING).
- [ ] **COMM-04**: Structured handoff JSON: `{task_id, from_agent, handoff_type, summary, key_findings[], decisions_made[], open_questions[], artifacts[], confidence}`. ≤ 800 tokens.
- [ ] **COMM-05**: Conflict resolution: security→checker wins; correctness→test results authoritative; style→executor deference; ambiguous→escalate.

## Phase 39 — Agent Lifecycle

How agents are versioned, evaluated, and continuously improved.

- [ ] **LIFE-01**: SemVer version headers in all 17 agent .md files. `agents/changelog/` directory.
- [ ] **LIFE-02**: `agent_metrics` PG table: `{agent_name, task_id, completion_time_ms, token_usage, error_count, outcome}`. `gsd-tools agent-stats` command.
- [ ] **LIFE-03**: 50-test canary suite. McNemar's test. Alert on >1% degradation with p<0.05. Runs in <5 minutes.
- [ ] **LIFE-04**: Eval framework. Three grader types (code-based, model-based, human). ≥ 5 scenarios per agent. `tests/evals/` directory.
- [ ] **LIFE-05**: Tool integrity checking at startup. SHA hash of tool definitions. `TOOL_INTEGRITY_VIOLATION` on mismatch.

## Phase 40 — Engineering Standards

Best practices embedded in every agent's DNA.

- [x] **ENG-01**: Git workflow standards. Branch naming: `feat/`, `fix/`, `refactor/`, `test/`. Conventional commits. PR templates.
- [x] **ENG-02**: Error handling standards. Try-catch at service boundaries. Structured error objects `{code, message, details}`. No swallowed exceptions.
- [x] **ENG-03**: Documentation standards. JSDoc (TS) or docstrings (Python) on all generated functions. @param, @returns, @throws, usage examples for public APIs.
- [x] **ENG-04**: Configuration management. No hardcoded URLs, ports, timeouts. All via env vars with defaults.
- [x] **ENG-05**: Structured logging. `{timestamp, level, service, message, context}`. Appropriate log levels. No `console.log` in production code.

---

## Future Requirements

- MCP standalone server (direct PG/Valkey, no daemon wrapper) — v3.1
- npm public release (`npx @gsd-amauta/cli`) — v3.1
- A2A protocol Agent Cards for each agent — v3.1
- DSPy prompt optimization pipeline — v3.1
- Reflexion memory per-agent self-improvement — v3.1

---

## Out of Scope for v3.0

- MCP standalone server / npm publish — v3.1
- K3s, Langfuse, gVisor — never (non-portable)
- Web UI for any feature — CLI and agent-native only
- Changing database engine — PostgreSQL + pgvector stays
- Everything works after `npm install -g . && docker compose up` — hard constraint

---

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FORMAT-01 | 31 | Complete |
| FORMAT-02 | 31 | Complete |
| FORMAT-03 | 31 | Complete |
| FORMAT-04 | 31 | Complete |
| FORMAT-05 | 31 | Complete |
| FORMAT-06 | 31 | Complete |
| FORMAT-07 | 31 | Complete |
| FRONT-01 | 32 | Complete |
| FRONT-02 | 32 | Complete |
| FRONT-03 | 32 | Complete |
| FRONT-04 | 32 | Complete |
| FRONT-05 | 32 | Complete |
| FRONT-06 | 32 | Complete |
| FRONT-07 | 32 | Complete |
| TEST-01 | 33 | Pending |
| TEST-02 | 33 | Pending |
| TEST-03 | 33 | Pending |
| TEST-04 | 33 | Pending |
| TEST-05 | 33 | Pending |
| TEST-06 | 33 | Pending |
| TEST-07 | 33 | Pending |
| TEST-08 | 33 | Pending |
| SEC-01 | 34 | Pending |
| SEC-02 | 34 | Pending |
| SEC-03 | 34 | Pending |
| SEC-04 | 34 | Pending |
| SEC-05 | 34 | Pending |
| SEC-06 | 34 | Pending |
| REVIEW-01 | 35 | Complete |
| REVIEW-02 | 35 | Complete |
| REVIEW-03 | 35 | Complete |
| REVIEW-04 | 35 | Complete |
| DATA-01 | 36 | Pending |
| DATA-02 | 36 | Pending |
| DATA-03 | 36 | Pending |
| DATA-04 | 36 | Pending |
| ARCH-01 | 37 | Pending |
| ARCH-02 | 37 | Pending |
| ARCH-03 | 37 | Pending |
| COMM-01 | 38 | Pending |
| COMM-02 | 38 | Pending |
| COMM-03 | 38 | Pending |
| COMM-04 | 38 | Pending |
| COMM-05 | 38 | Pending |
| LIFE-01 | 39 | Pending |
| LIFE-02 | 39 | Pending |
| LIFE-03 | 39 | Pending |
| LIFE-04 | 39 | Pending |
| LIFE-05 | 39 | Pending |
| ENG-01 | 40 | Complete |
| ENG-02 | 40 | Complete |
| ENG-03 | 40 | Complete |
| ENG-04 | 40 | Complete |
| ENG-05 | 40 | Complete |

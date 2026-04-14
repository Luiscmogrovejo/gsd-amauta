# Phase 39: Agent Lifecycle (CAPSTONE) - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Wrap the complete 17-agent ecosystem with lifecycle management: SemVer versioning with per-agent changelogs, agent_metrics PG table with performance tracking, 50-test canary suite with McNemar's statistical degradation detection, eval framework with 3 grader types (code-based implemented, model-based and human documented), and tool integrity checking via SHA-256 hashing at startup. This is the capstone — after this, the system can measure itself.

</domain>

<decisions>
## Implementation Decisions

### SemVer and Changelog Model (LIFE-01)
- Version bumps triggered by ANY modification to an agent `.md` file
- The EXECUTOR modifying the agent bumps the version as part of its commit — not a separate script
- Version criteria:
  - **Major** (1.0.0 → 2.0.0): breaking behavior change (removed capability, changed output schema)
  - **Minor** (3.0.0 → 3.1.0): new capability added (new detection rule, new example)
  - **Patch** (3.0.0 → 3.0.1): wording tweaks, typo fixes, clarification
- Changelog: ONE file per agent in `agents/changelog/` directory
- Format: `agents/changelog/gsd-executor-backend.md` with entries:
  ```
  ## 3.0.0 (2026-04-13)
  - Initial v3.0 format (Phase 31)
  - Added engineering standards (Phase 40)
  - Added supply chain security rules (Phase 34)
  - Added inter-agent communication (Phase 38)
  ```
- Bootstrap all 17 changelog files with a single 3.0.0 entry summarizing everything shipped in v3.0
- Add version bump rules to gsd-operator.md behavioral rules

### Agent Metrics Table (LIFE-02)
- Migration 016-agent-metrics.sql:
  ```sql
  CREATE TABLE agent_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name VARCHAR(64) NOT NULL,
    task_id VARCHAR(128) NOT NULL,
    completion_time_ms INTEGER,
    token_usage INTEGER,
    error_count INTEGER DEFAULT 0,
    outcome VARCHAR(16) NOT NULL, -- 'pass', 'fail', 'partial'
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX idx_metrics_agent ON agent_metrics(agent_name);
  ```
- `gsd-tools agent-stats` command: reads agent_metrics, outputs per-agent summary: `{agent, tasks_completed, avg_time_ms, avg_tokens, error_rate, pass_rate}`
- Two new daemon endpoints:
  - `POST /api/metrics` — record agent execution metrics
  - `GET /api/metrics/stats` — return per-agent aggregated stats

### Canary Suite (LIFE-03)
- 50 DETERMINISTIC grep/assertion-based tests — NOT LLM output quality tests
- Tests agent DEFINITIONS (rules exist, sections present, schemas correct) and INFRASTRUCTURE (daemon endpoints, PG tables, migrations)
- Curated subset of existing 390+ tests: ~3 tests per requirement category (FORMAT, FRONT, TEST, SEC, REVIEW, DATA, ARCH, COMM, LIFE, ENG) = ~50
- McNemar's test for degradation:
  - Store BASELINE pass/fail vector in `tests/fixtures/39-canary-baseline.json`
  - After model change or major update, run suite again and compare vectors
  - McNemar's chi-squared on 2x2 contingency table (pass→fail, fail→pass)
  - p < 0.05 = degradation detected, exit non-zero
- Script: `scripts/canary-compare.cjs` outputs `{degraded: bool, p_value: float, delta: float, changed_tests: string[]}`
- Must run in < 5 minutes

### Eval Framework (LIFE-04)
- Start with 3 agents: gsd-executor-backend (5 scenarios), gsd-tester (5 scenarios), gsd-security (5 scenarios) = 15 initial scenarios
- Remaining agents get 5+ scenarios in v3.1
- Scenario format: `{id, agent, input_description, expected_behavior, grader_type, grading_criteria}`
- Stored in `tests/evals/` directory, one JSON file per agent
- Three grader types:
  - **Code-based:** automated assertions. Cheap, fast, reproducible. Existing test pattern repackaged with eval framework metadata. ONLY type implemented in v3.0.
  - **Model-based:** LLM rubric scoring via Anthropic API. On-demand only (expensive). Documented schema, v3.1 implementation.
  - **Human:** manual spot-check with structured checklist. Documented schema, v3.1 implementation.
- v3.0 = code-based only. Keeps portable (no API key required).

### Tool Integrity Checking (LIFE-05)
- "Tool definitions" = CJS CLI scripts (`gsd-amauta.cjs`, `gsd-tools.cjs`, `gsd-rlm.cjs`, `gsd-research.cjs`, `gsd-memory.cjs`) + Python services (`amauta-daemon.py`, `rlm-service.py`, `amauta-mcp.py`). NOT agent .md files (those change via version bumps).
- At DAEMON STARTUP: hash all tool files with SHA-256, store in Valkey as `tool_integrity:{filename}` → `{hash, timestamp}`
- At TASK CLAIM: re-hash and compare against stored values
- Mismatch → log `TOOL_INTEGRITY_VIOLATION` with `{file, expected_hash, actual_hash}`, block task, surface to operator
- After blocking: MANUAL intervention required — operator restarts daemon (re-hashes, sets new baseline). No auto-heal — integrity violations are security events.
- Script: `scripts/tool-integrity.cjs` handles hashing and comparison

### Wave Structure
- Wave 1: Migration 016 + daemon endpoints + tool-integrity.cjs + agents/changelog/ bootstrapped (17 files) + version bump rules in operator
- Wave 2: Canary suite manifest (50 tests) + canary-compare.cjs (McNemar's) + baseline vector + gsd-tools agent-stats command
- Wave 3: Eval framework (tests/evals/, 15 scenarios, code-based graders) + integration tests + full regression suite

### Claude's Discretion
- Exact canary suite test selection (must cover all 10 requirement categories)
- Eval scenario content details (must be verifiable with code-based graders)
- Tool integrity file list (all CJS + Python service files)
- gsd-tools agent-stats output formatting

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Infrastructure
- `migrations/` — Existing migrations 001-015. New migration is 016.
- `services/amauta-daemon.py` — Daemon with existing endpoints. New metrics routes added here.
- `scripts/` — Existing scripts. New canary-compare.cjs and tool-integrity.cjs.

### Agent Format
- `agents/gsd-operator.md` — Gets version bump rules added to behavioral rules
- All 17 agents in `agents/` — Each gets a changelog file in `agents/changelog/`
- `agents/shared/security-rules.md` — Pattern reference for shared files

### Prior Art
- `.planning/phases/38-blackboard-communication/38-CONTEXT.md` — Phase 38 daemon endpoint + migration pattern (closest infrastructure precedent)
- `.planning/phases/40-engineering-standards/40-CONTEXT.md` — Phase 40 cross-cutting agent update pattern (for changelog bootstrapping)
- `.planning/phases/34-security-pipeline/34-CONTEXT.md` — Phase 34 tool installation pattern (for tool-integrity.cjs)

### Requirements
- `.planning/REQUIREMENTS.md` — LIFE-01 through LIFE-05 definitions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Existing 390+ test assertions across phases 31-38 — canary suite selects ~50 from these
- `services/amauta-daemon.py` — add metrics endpoints alongside existing findings/messages
- `scripts/run-tests.cjs` — test runner pattern reference
- All 17 agent files have `## version: 3.0.0` already (Phase 31 set this)

### Established Patterns
- Phase 38: Migration + daemon endpoints pattern (016 follows 014/015)
- Phase 40: Cross-cutting update across all agents (changelog bootstrapping follows same pattern)
- Phase 34: Script installation pattern (tool-integrity.cjs follows install-gitleaks.cjs)
- Phase 33: Test selection and quality audit patterns

### Integration Points
- Daemon: new `/api/metrics` and `/api/metrics/stats` endpoints
- gsd-tools.cjs: new `agent-stats` subcommand
- Valkey: tool integrity hashes stored in Valkey cache
- All 17 agents: changelog files bootstrapped

</code_context>

<specifics>
## Specific Ideas

- This is what makes v3.0 a real release: the system can measure itself, detect degradation, version its components, and catch tampering
- Canary tests are DETERMINISTIC (grep-based), not LLM quality tests — this keeps them fast and reproducible
- McNemar's test is the right statistical test for paired binary outcomes (same test, two runs) — not a t-test or chi-squared independence test
- Tool integrity is a SECURITY feature — manual intervention after violation mirrors the principle that security events don't auto-resolve
- Code-based graders only in v3.0 maintains the portability constraint (no API key needed)

</specifics>

<deferred>
## Deferred Ideas

- Model-based eval graders (LLM rubric scoring via Anthropic API) — v3.1
- Human eval graders (structured checklists) — v3.1
- Eval scenarios for remaining 14 agents — v3.1
- Auto-heal for tool integrity violations — deliberately not implemented (security events require human judgment)

</deferred>

---

*Phase: 39-agent-lifecycle*
*Context gathered: 2026-04-14*

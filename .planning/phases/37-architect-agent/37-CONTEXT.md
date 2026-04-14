# Phase 37: Architect Agent - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Create a new `agents/gsd-architect.md` (~300-350 lines) — a strategic design reviewer that generates ADRs, reviews API designs for consistency, and detects N+1 patterns in proposed architectures. Hybrid agent: both writes (ADR files) and reviews (design findings). Uses v3.0.0 10-section format with engineering standards and security rules embedded. Routed by operator explicitly.

Also bootstrap `docs/adr/` directory with template (ADR-000) and a real example (ADR-001: PostgreSQL + pgvector).

</domain>

<decisions>
## Implementation Decisions

### ADR Format and Lifecycle (ARCH-01)
- Michael Nygard's standard template:
  ```
  # ADR-NNN: Title
  ## Status: proposed | accepted | deprecated | superseded by ADR-NNN
  ## Context: What is the issue motivating this decision?
  ## Decision: What is the change being proposed?
  ## Consequences: What are the trade-offs?
  ## Alternatives considered: What else was evaluated and why rejected?
  ```
- Agent creates NEW ADRs only — does NOT update existing ones (that's a human decision)
- ADR numbering: reads `docs/adr/` directory, finds highest number, increments
- "Significant" decisions that warrant an ADR: choosing between 2+ technologies, changing data schema, adding a new service/dependency, changing an API contract, modifying the RPETD pipeline
- The OPERATOR decides whether to invoke the architect — agent doesn't self-trigger

### Architect vs Reviewer Boundary
- Clean separation by WHEN they run:
  - gsd-architect runs BEFORE implementation — on plans, proposals, design docs ("what we're about to build")
  - gsd-reviewer runs AFTER implementation — on committed code ("what we built")
- The architect NEVER reviews source code files directly
- It reviews: plan files (`.planning/`), proposed API schemas, proposed database schemas, architecture descriptions in task context
- If operator asks "review this API design," architect looks at the design spec, not route handler code

### API Review Detection Rules (ARCH-02)
Concrete checks embedded in agent behavioral rules:
- **Naming:** all endpoints use kebab-case paths (`/api/user-profiles` not `/api/userProfiles`). Resource nouns are plural (`/api/users` not `/api/user`).
- **HTTP methods:** GET has no request body. POST for creation, PUT for full replace, PATCH for partial update, DELETE for removal. No GET with side effects.
- **Pagination:** any endpoint returning a list MUST support `?page=N&limit=N` with default limit=20, max limit=100. Response includes `{data: [], total: N, page: N, limit: N}`.
- **Error format:** all errors return `{code: string, message: string, details?: object}`. HTTP status codes match semantics (400 validation, 401 auth, 404 not found, 500 server error).
- **Versioning:** API version in URL path (`/api/v1/`) or Accept header. No unversioned public APIs.

### N+1 Detection at Design Level (ARCH-03)
- Different from gsd-executor-data's SQL-level N+1 detection
- Architect detects N+1 risks in PROPOSED designs: "for each user, fetch their orders" in a plan description
- Reads plan files and task descriptions, not SQL queries
- Output: `{pattern: "N+1 risk", location: "plan 38-01 task 3", description: "fetching orders per user in a loop", suggestion: "use JOIN or batch query with IN clause"}`

### Agent Type (Hybrid)
- HYBRID — both reviews (API consistency, N+1 detection) AND writes (ADR files)
- Simplified RPETD: when creating an ADR, researches alternatives → plans structure → writes file → commits
- When reviewing a design, produces structured findings report (like gsd-reviewer)
- Two modes, one agent
- Routed by operator explicitly — no file-pattern routing
- Boundary: "You evaluate designs and document decisions. You do not write application code, tests, or infrastructure — that's executors' territory."

### Personality
- Strategic thinker, explores options before recommending, always documents trade-offs
- High Openness (considers novel patterns) + High Conscientiousness (documents everything)

### Structured Output Schema (Review Mode)
```json
{
  "review_type": "api_design | architecture | schema_design",
  "findings": [{
    "category": "naming | http_method | pagination | error_format | versioning | n_plus_one | coupling | scalability",
    "severity": "error | warning | info",
    "location": "string",
    "message": "string",
    "suggestion": "string"
  }],
  "summary": "string",
  "approval": "approve | request_changes | comment_only"
}
```

### Few-Shot Examples
Three examples:
  (a) ADR generation — "choose between REST and GraphQL for public API" → complete ADR with 2 alternatives
  (b) API review — reviews API spec with 3 findings (missing pagination, inconsistent naming, GET with side effect)
  (c) N+1 detection — reads plan proposing "for each category, fetch products" → flags pattern

### Wave Structure
- Wave 1: Create `agents/gsd-architect.md` + `docs/adr/000-template.md` + `docs/adr/001-postgresql-pgvector.md` + API review rules + N+1 detection rules
- Wave 2: Test fixtures (API spec with violations, plan with N+1 risk) + unit tests + integration tests + regression suite

### docs/adr/ Bootstrapping
- Create directory with ADR-000 as template and ADR-001 as real example
- ADR-001: "Use PostgreSQL + pgvector for memory storage" — documents actual decision from v2.0
- Proves the format works and gives agent a real example to follow

### Claude's Discretion
- Exact wording of behavioral rules (detection thresholds and API rules are locked)
- Tool access section specifics
- Error handling section details
- Additional ADR status values beyond the 4 specified

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Agent Format
- `agents/gsd-reviewer.md` — Reference for "review and report" pattern; boundary to NOT overlap with at code level
- `agents/gsd-executor-data.md` — Reference for N+1 detection at SQL level (architect detects at design level)
- `agents/gsd-executor-backend.md` — Reference executor format for RPETD protocol
- `agents/shared/security-rules.md` — 12 security rules to embed verbatim
- `agents/shared/engineering-standards.md` — 5 engineering standard categories to embed verbatim

### Prior Art
- `.planning/phases/35-code-review-agent/35-CONTEXT.md` — Phase 35 reviewer creation pattern (closest precedent for review mode)
- `.planning/phases/36-data-engineering-agent/36-CONTEXT.md` — Phase 36 executor creation (closest precedent for write mode)
- `.planning/phases/31-format-standard/31-CONTEXT.md` — 10-section format definition

### Requirements
- `.planning/REQUIREMENTS.md` — ARCH-01 through ARCH-03 definitions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `agents/gsd-reviewer.md` — Review output schema pattern (findings, severity, approval)
- `agents/gsd-executor-data.md` — N+1 detection rules at SQL level
- `agents/shared/security-rules.md` — 12 rules, embed verbatim
- `agents/shared/engineering-standards.md` — 17 rules, embed verbatim

### Established Patterns
- Phase 35: New specialist agent (review mode) — reviewer pattern
- Phase 36: New executor agent (write mode) — RPETD executor pattern
- Phase 37 is unique: HYBRID of both patterns in one agent
- Test naming: `tests/37-architect-agent.unit.test.cjs`, `tests/37-architect-agent.integration.test.cjs`

### Integration Points
- Operator routes to gsd-architect explicitly — no file-pattern routing
- Output schema is advisory (like gsd-reviewer) — operator decides enforcement
- ADR files written to `docs/adr/` directory

</code_context>

<specifics>
## Specific Ideas

- The architect/reviewer boundary is temporal: architect reviews plans (before), reviewer reviews code (after)
- N+1 detection operates at different levels: architect sees "fetch orders per user in a loop" in plan text; executor-data sees `SELECT * FROM orders WHERE user_id = ?` in a loop in SQL
- ADR-001 (PostgreSQL + pgvector) is a real decision — it documents what actually happened, not a hypothetical
- The hybrid model (review + write) is unique among agents — most are pure review or pure execute

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 37-architect-agent*
*Context gathered: 2026-04-14*

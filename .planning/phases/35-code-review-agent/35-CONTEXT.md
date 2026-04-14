# Phase 35: Code Review Agent - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Create a new `agents/gsd-reviewer.md` agent (~300-350 lines) that provides the "always-available second pair of eyes" code review capability for a solo developer. Detects style violations, duplication, SOLID violations, and produces structured output distinct from gsd-validator. Uses v3.0.0 10-section format with engineering standards and security rules embedded.

</domain>

<decisions>
## Implementation Decisions

### Review Trigger and Scope
- gsd-reviewer runs when EXPLICITLY INVOKED by the operator — not automatically on every task
- Reviews all changed files in the current task scope (git diff against the plan's baseline commit)
- The operator routes to it after execution, before or alongside validation
- It does NOT run inside the executor's E-phase
- Think of it as the solo developer's "second pair of eyes" — called when you want a review, not on every commit

### Reviewer vs Validator Boundary
- Reviewer runs INDEPENDENTLY from validator — either can run first, both can run on same code, neither depends on the other
- Reviewer checks QUALITY (style, patterns, maintainability). Validator checks CORRECTNESS (tests pass, requirements met).
- The reviewer CAN issue `request_changes` but it's ADVISORY — it doesn't block the pipeline the way validator does
- The operator sees both reports and makes the final call
- Mirrors how human code review works: a reviewer can request changes, but the tech lead (operator) decides whether to enforce

### Agent Personality and Boundary
- Personality: thorough, constructive, never personal
- Boundary: "You review code and produce findings. You do not fix code — that's the executor's job. You do not run tests — that's the validator's/tester's job."

### Severity Model
- Three levels:
  - `error` — must fix: god classes, security violations, circular deps
  - `warning` — should fix: long functions, code duplication, missing docs
  - `info` — nice to have: naming suggestions, import ordering
- Approval logic is DETERMINISTIC, not holistic:
  - Any `error` finding → `request_changes`
  - Only `warning` findings → `comment_only`
  - No findings or only `info` → `approve`

### Structured Output Schema (REVIEW-04)
```json
{
  "task_id": "string",
  "files_reviewed": ["string"],
  "findings": [{
    "file": "string",
    "line": "number",
    "category": "style | solid | performance | security | documentation | duplication",
    "severity": "error | warning | info",
    "message": "string",
    "suggestion": "string"
  }],
  "summary": "string",
  "approval": "approve | request_changes | comment_only",
  "metrics": {
    "files_reviewed": "number",
    "findings_by_severity": {"error": "N", "warning": "N", "info": "N"}
  }
}
```

### Detection Rules (REVIEW-01, REVIEW-02)
What the reviewer checks:
- God classes: files > 500 lines → error
- Long functions: functions > 50 lines → warning
- Too many parameters: functions with > 5 params → warning
- Code duplication: > 10 identical lines across files → warning
- Missing documentation: public functions without JSDoc/docstring → warning
- Dead code: unused imports, unreachable code → info
- Circular dependencies: A imports B imports A → error
- Naming inconsistency: mixed camelCase/snake_case in same file → warning
- Import ordering: not grouped (stdlib, external, internal) → info
- SOLID violations: single class handling 3+ unrelated concerns → error

### What the Reviewer Does NOT Check (REVIEW-03)
- Test coverage → gsd-qa
- Security vulnerabilities → gsd-security
- Type correctness → gsd-executor-frontend validation loop
- Requirements compliance → gsd-validator
- Plan structure → gsd-checker

### Few-Shot Examples Strategy
Four examples:
  (a) Clean code → `approve` with 0 findings
  (b) Minor style issues → `comment_only` with 3 warnings (long function, inconsistent naming, missing JSDoc)
  (c) Serious violations → `request_changes` with 1 error (500-line god class) + 2 warnings
  (d) Security finding → `request_changes` with 1 error (hardcoded API key detected) — demonstrates overlap with security rules

### Wave Structure
- Wave 1: Create `agents/gsd-reviewer.md` with full 10-section format, detection rules as behavioral rules, output schema, 4 examples
- Wave 2: Unit tests (agent format compliance, detection rule descriptions against fixture files) + integration tests (regression suite) + fixture files

### Fixture Files for Testing
- `tests/fixtures/35-review-clean.js` — passes all checks
- `tests/fixtures/35-review-messy.js` — 3+ warnings: long function, missing docs, inconsistent naming
- `tests/fixtures/35-review-god-class.js` — 500+ line class → error
- Tests verify the detection rules documented in the agent file match expected findings on fixture files
- Note: the agent file DESCRIBES the rules; the tests verify the DESCRIPTIONS are accurate and complete

### Claude's Discretion
- Exact wording of detection rule descriptions within behavioral rules (thresholds are locked)
- Tool access section specifics (which RLM queries are useful for code review)
- Error handling section details
- Preconditions and constraints section details

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Agent Format
- `agents/gsd-validator.md` — Reference for the "scan and report, don't fix" pattern; boundary to NOT overlap with
- `agents/gsd-security.md` — Reference for the "scan and report" pattern from Phase 34
- `agents/gsd-executor-backend.md` — Reference for 10-section format with engineering standards
- `agents/shared/security-rules.md` — 12 security rules to embed verbatim
- `agents/shared/engineering-standards.md` — 5 engineering standard categories to embed verbatim

### Prior Art
- `.planning/phases/34-security-pipeline/34-CONTEXT.md` — Phase 34 created gsd-security with same "scan and report" boundary pattern
- `.planning/phases/31-format-standard/31-CONTEXT.md` — 10-section format definition
- `.planning/phases/40-engineering-standards/40-CONTEXT.md` — Engineering standards embedding pattern

### Requirements
- `.planning/REQUIREMENTS.md` — REVIEW-01 through REVIEW-04 definitions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `agents/gsd-security.md` — Same "scan and report, don't fix" pattern; created in Phase 34
- `agents/gsd-validator.md` — The agent gsd-reviewer must be distinct from; read to understand boundary
- `agents/shared/security-rules.md` — 12 rules, embed verbatim
- `agents/shared/engineering-standards.md` — 17 rules across 5 categories, embed verbatim

### Established Patterns
- Phase 34: gsd-security boundary is "scan and report, never fix" — gsd-reviewer follows same pattern
- Phase 31/34/40: shared source-of-truth + verbatim copy + diff-verification tests
- Phase 40: `### Engineering standards` subsection under `## Behavioral rules`
- Test naming: `tests/35-code-review-agent.unit.test.cjs` and `tests/35-code-review-agent.integration.test.cjs`

### Integration Points
- The operator (`gsd-operator.md`) will route to gsd-reviewer explicitly — no automatic invocation
- gsd-reviewer output is advisory; operator decides whether to enforce `request_changes`

</code_context>

<specifics>
## Specific Ideas

- The reviewer is the solo developer's "second pair of eyes" — constructive, never personal
- Approval logic is deterministic based on severity classification, not holistic LLM judgment
- The agent describes detection rules in its behavioral rules section; it follows them when reviewing code because its prompt says to (same mechanism as all other behavioral rules)
- Security finding in Example (d) demonstrates that the reviewer CAN catch obvious security issues (like hardcoded keys) even though gsd-security is the primary security agent — this is realistic overlap, not a boundary violation

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 35-code-review-agent*
*Context gathered: 2026-04-13*

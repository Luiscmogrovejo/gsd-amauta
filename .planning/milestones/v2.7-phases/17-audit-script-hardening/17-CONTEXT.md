# Phase 17: Audit Script Hardening — Context

**Gathered:** 2026-04-10
**Status:** Ready for planning
**Milestone:** v2.7 "Steady Hands"
**Phase ID:** 17-audit-script-hardening
**Requirements:** AUDIT-01, AUDIT-02, AUDIT-03
**Scope ceiling:** ~80 LOC confined to `scripts/verify-v26.cjs` plus tests. Any temptation to refactor the audit script's internal structure "while in there" gets surfaced as a divergence observation, not absorbed. The three fixes are additive, not structural.

<domain>
## Phase Boundary

Phase 17 delivers three targeted fixes to `scripts/verify-v26.cjs` so the audit script stops producing silent false negatives:

- **AUDIT-01** — `checkVerificationFiles()` probes for both `<phase>-VERIFICATION.md` (prefixed form) and `VERIFICATION.md` (unprefixed form). Prefixed wins when both exist. Fixes the Phase 14 false-negative (`14:missing`).
- **AUDIT-02** — `parseNpmFailures()` is rewritten to match the actual `node --test` runner output format and return structured `{ test_file, test_name, reason }` objects. Satisfies the Phase 15 Q9 rule ("match by name, not count") on the npm side.
- **AUDIT-03** — `15-AUDIT-REPORT.json` schema gains a `tooling_bugs_observed` field distinct from `hygiene_debt_observed`, with a schema version bump. Depths 7 and 8 from the v2.6 ledger populate the new field.

Explicitly **out of scope:**
- Refactoring the audit script's internal structure (the "while I'm in the audit script" temptation is the Phase 13 fingerprint)
- Adding new audit criteria beyond the three named fixes
- Changing the audit's phase scope (AUDITED_PHASES stays as-is)
- Modifying the behavioral test runner or its criteria
- Fixing the `core.test.cjs` failure introduced by Phase 16's resolver change (that test expects the OLD resolver behavior — it's a pre-existing failure baseline update, not a Phase 17 fix)

</domain>

<decisions>
## Implementation Decisions

### Tooling Bug Entry Format (AUDIT-03)

- **Structured objects, not flat strings.** Each `tooling_bugs_observed` entry is an object with fields: `{ id, depth, description, phase_detected, resolved_by }`.
  - `id`: string identifier (e.g., `"TOOL-01"`)
  - `depth`: integer dogfood ledger depth number (e.g., `7`)
  - `description`: one-line human-readable description
  - `phase_detected`: string phase where the bug was first detected (e.g., `"15"`)
  - `resolved_by`: string phase that fixed it (e.g., `"16"`)
- **Rationale:** `hygiene_debt_observed` is flat strings because debt entries are free-text observations. Tooling bugs are structured findings with provenance — they came from specific dogfood depths, were detected in specific phases, and were fixed by specific phases. Structured entries let downstream consumers programmatically trace bug → detection → fix.
- **Initial population:** Depths 7 and 8 from the v2.6 ledger are the seed entries when the audit runs post-Phase 17.

### Schema Versioning (AUDIT-03)

- **Integer version field, starting at 2.** The report JSON gains `"schema_version": 2` as a top-level field. The implicit pre-Phase-17 schema is version 1 (never had the field — absence means version 1).
- **No semver.** This is an internal tooling report, not a public API. Integer suffices. The version increments when the schema shape changes (new fields, removed fields, type changes).
- **Placement:** Top-level, alongside `audit_timestamp` and `milestone`.

### npm Output Parsing (AUDIT-02)

- **Match the actual `node --test` runner format.** The npm test runner produces:
  ```
  test at tests/<filename>.test.cjs:<line>:<col>
  ✖ <test name> (<duration>)
    <ErrorType>: <message>
  ```
  The new `parseNpmFailures()` must parse this pattern. Key signals:
  - `test at <filepath>:<line>:<col>` — identifies the test file
  - `✖ <test name>` — marks a failure with its name
  - The line after `✖` contains the error type and message (the "reason")
- **Return structured objects:** `{ test_file, test_name, reason }` matching the AUDIT-02 requirement.
  - `test_file`: basename extracted from the `test at` line (e.g., `"core.test.cjs"`)
  - `test_name`: the text after `✖` and before the duration parenthetical
  - `reason`: first line of the error (e.g., `"TypeError: Cannot read properties of null"`)
- **Moderate resilience:** Also retain the existing `FAIL <filepath>` regex as a secondary pattern for compatibility with other runners. The `node --test` `✖` pattern is primary.
- **Pre-existing failure matching:** Compare `test_file` field against the `PRE_EXISTING_NPM_FAILURES` array (which is already file-basename based). A test file in the output matches a pre-existing failure if its `test_file` basename is in the array. New structured entries where `test_file` is NOT in the pre-existing list are `new_failures`.

### generateMarkdown Updates (AUDIT-03)

- **Two separate sections in the Markdown report:** `## Hygiene Debt Observed` (existing) and `## Tooling Bugs Observed` (new). Tooling bugs render as a table: `| ID | Depth | Description | Detected | Resolved |`.
- **Section ordering:** Tooling bugs BEFORE hygiene debt. Rationale: tooling bugs affect audit correctness (they caused the false negatives Phase 17 is fixing); hygiene debt is cosmetic. More important findings first.

### Claude's Discretion

- Exact regex syntax for `node --test` output parsing
- Whether to extract `reason` from the first error line or the full stack trace
- Test fixture format for npm output parsing tests (inline strings vs fixture files)
- Exact wording of the Markdown section headings
- Whether `pre_existing_failures_verified` entries get the full structured format or stay as filenames (AUDIT-02 requires structured — but the field contract with existing consumers may need a migration note)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirement definitions
- `.planning/REQUIREMENTS.md` § "Phase 17: Audit Script Hardening" — AUDIT-01, AUDIT-02, AUDIT-03 text, scope ceiling, acceptance criteria
- `.planning/ROADMAP.md` § "Phase 17: Audit Script Hardening" — goal statement, success criteria, dependency chain, files expected, pitfalls prevented

### The audit script itself
- `scripts/verify-v26.cjs` § `checkVerificationFiles` (line 93) — the function AUDIT-01 fixes
- `scripts/verify-v26.cjs` § `parseNpmFailures` (line 119) — the function AUDIT-02 rewrites
- `scripts/verify-v26.cjs` § `buildReport` (line 512) — where `hygiene_debt_observed` lives and `tooling_bugs_observed` must be added
- `scripts/verify-v26.cjs` § `generateMarkdown` (line 526) — the renderer that needs the new section

### Phase 15 prior decisions (locked, carry forward)
- `.planning/milestones/v2.2-phases/15-dogfood/15-CONTEXT.md` § Q9 — "Match by test name, not count" rule for pre-existing failure matching
- `.planning/milestones/v2.2-phases/15-dogfood/15-CONTEXT.md` § Q10 — Self-exclusion list for recursive scope

### Dogfood ledger entries that populate `tooling_bugs_observed`
- `docs/v2.6-dogfood-ledger.md` § "Depth 7: Ghost directory detection" — the first resolver bug firing
- `docs/v2.6-dogfood-ledger.md` § "Depth 8: Init resolver recurrence" — cross-surface confirmation
- `docs/v2.6-dogfood-ledger.md` § "Routed follow-ups (Phase 16 / v2.7)" items 3, 4, 5 — the three bugs this phase fixes

### Divergence protocol (applies during execution)
- `get-shit-done/references/divergence-protocol.md` v1.1.0 — behavioral half of the Phase 13 defense

### HARDEN-01 manifest enforcement
- `get-shit-done/bin/gsd-tools.cjs` § `manifestCheck` — active for all v2.7 tasks

### Existing test patterns
- `tests/13.1-manifest-check.test.cjs` — synthetic fixture test style precedent
- `tests/16-init-resolver.test.cjs` — most recent test file, same `node:test` framework

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`checkVerificationFiles()` (line 93-117):** Currently probes only `VERIFICATION.md` at line 102. The fix adds a prefixed-form probe (`path.join(dir, phase + '-VERIFICATION.md')`) before the unprefixed fallback. The function's return shape (`{ total, present, per_phase, all_present }`) stays the same — only the internal file lookup changes.
- **`parseNpmFailures()` (line 119-135):** Currently returns a flat `Array.from(failures)` of file basenames. AUDIT-02 changes this to return `[{ test_file, test_name, reason }]`. All consumers of the return value (`runNpmTest` at line 156, `buildReport` at line 504) need to be updated to handle the new shape.
- **`PRE_EXISTING_NPM_FAILURES` constant (line 42-47):** Already a basename-based list. Matching logic just needs to compare `entry.test_file` instead of the flat string.
- **`hygiene_debt_observed` pattern (line 512):** The `buildReport` function assigns `hygiene_debt_observed: hygieneDebt` where `hygieneDebt` is a flat string array. `tooling_bugs_observed` follows a parallel pattern but with structured objects.
- **`generateMarkdown` (line 526-621):** Hygiene debt rendering at lines 606-608 is a simple loop. Tooling bugs need a table renderer (similar to the per-criterion table at lines 550-554).
- **`module.exports` (line 657-664):** The test file will need `parseNpmFailures`, `checkVerificationFiles`, `buildReport`, and `generateMarkdown` exported. Most already are.

### Established Patterns

- **`node:test` framework with `assert`** — used by all recent test files. Phase 17 tests follow the same pattern.
- **Synthetic temp fixtures via `os.mkdtempSync`** — established by `tests/16-init-resolver.test.cjs`. Phase 17 tests use inline string fixtures for npm output parsing (no temp dirs needed — parsing is pure string → object transformation).
- **`error()` + `process.exit(1)` pattern** — the `captureError()` sentinel from Phase 16 tests can be reused if any error-path testing is needed.

### Integration Points

- **`buildReport()` output → `generateMarkdown()` input** — the report JSON is the single source of truth. Any schema change to the JSON must have a corresponding renderer change in `generateMarkdown`.
- **`15-AUDIT-REPORT.json` and `15-AUDIT-REPORT.md`** — these are the output files. After Phase 17, re-running the audit script overwrites them with the new schema. The files live in `.planning/milestones/v2.2-phases/15-dogfood/`.
- **`pre_existing_failures_verified` field** — currently a flat array of strings consumed by `buildReport`. After AUDIT-02, this becomes an array of structured objects. Any consumer that reads the JSON report directly needs to handle the new shape. Within the script this is only `generateMarkdown`.

### Bootstrap Observation

- **Phase 16 resolver fix revealed a residual ghost path.** Running `gsd-tools init phase-op 17` returned `v2.3-phases/17-task-manager-reliability` instead of phase_found:false. The `findPhaseInternal` fix works correctly (returns null for no v2.7 match), but `cmdInitPhaseOp` has an additional fallback path that still searches archived milestones when the primary resolver returns null. This is a Phase 16 gap, not a Phase 17 concern — but Phase 17 executors should use `--phase-dir .planning/milestones/v2.7-phases/17-audit-script-hardening` to bypass the residual bug.

</code_context>

<specifics>
## Specific Ideas

- **The npm failure output format is `node --test` style**, not Jest/Mocha. The actual output when a test fails:
  ```
  test at tests/core.test.cjs:579:3
  ✖ searches archived milestones when not in current (1.751916ms)
    TypeError: Cannot read properties of null (reading 'found')
  ```
  The `test at <file>:<line>:<col>` line precedes each `✖` failure line. Parse both together.
- **Known pre-existing npm failures as of Phase 16 completion:** `rlm-workflow-spec.test.cjs`, `agent-frontmatter.test.cjs`, `comprehensive-e2e.test.cjs`, `gsd-amauta.test.cjs`. Note: `core.test.cjs` may now also have a failure (`searches archived milestones when not in current`) introduced by Phase 16's resolver behavior change — this is a new pre-existing failure, not a regression. The test expects the OLD resolver behavior (searching archived milestones), which Phase 16 intentionally removed.
- **Depth 7 entry text:** "Ghost directory detection — discuss-phase init returned `v2.3-phases/15-data-purge` instead of `phase_found: false` when querying phase 15 from v2.7 context."
- **Depth 8 entry text:** "Init resolver recurrence — same bug fired at execute-phase init, confirming cross-surface reproduction (not a discuss-phase-only artifact)."

</specifics>

<deferred>
## Deferred Ideas

- **Phase 16 gap: `cmdInitPhaseOp` residual ghost fallback** — The `findPhaseInternal` fix scopes to current milestone correctly, but `cmdInitPhaseOp` (and possibly other init subcommands) has an additional fallback path that still returns archived-milestone matches when the primary resolver returns null. This should be a Phase 16.1 or Phase 16 gap closure, not a Phase 17 concern.
- **`core.test.cjs` pre-existing failure update** — The Phase 16 resolver change broke the "searches archived milestones when not in current" test in `core.test.cjs`. This test expects the OLD behavior. It should be updated to expect `null` (the new correct behavior), but that's a test maintenance task, not an audit script fix. Note for future work.
- **Audit script structural refactor** — `verify-v26.cjs` is 668 lines with significant internal complexity. A structural refactor (extract modules, split concerns) would improve maintainability but is explicitly out of Phase 17 scope.

</deferred>

---

*Phase: 17-audit-script-hardening*
*Context gathered: 2026-04-10*
*Next: `/amauta:plan-phase 17`*

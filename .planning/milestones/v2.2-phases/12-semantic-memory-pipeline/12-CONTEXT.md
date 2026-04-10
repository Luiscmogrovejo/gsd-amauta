# Phase 12: T-Phase QA Department + Spec Inheritance - Context

**Gathered:** 2026-04-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Upgrade the T-phase (testing) into a proper QA department: inherit parent story G/W/T specs via `_inherit_parent_spec()` helper, edge-case generation, regression sweeps against known-good baseline, adversarial testing for security-sensitive code, and RED-GREEN back-testing MANDATORY for bug-fix tasks. Advisory Gate 6 for spec inheritance verification (v2.6 advisory, v2.7 hard gate). All QA improvements are prompt engineering + one Python helper + one reference file + agent updates.

</domain>

<decisions>
## Implementation Decisions

### Spec Inheritance Depth & Resolution
- **Full chain walk:** `_inherit_parent_spec()` walks task -> story -> epic. First non-empty `success_criteria` wins. If task has none, check parent story; if story has none, check epic.
- **Exposed via CLI:** `amauta show TK-XXXX --json` returns new field `inherited_spec: { source: "ST-0001", criteria: [...] }`. The `source` field shows WHERE the spec came from (parent ID).
- **No-parent fallback:** `inherited_spec: none -- root task, no parent criteria`. T-phase proceeds without spec-driven testing -- falls back to task-level `success_criteria` if any, otherwise standard testing only. Never blocks execution.
- **Ships as commit 1:** Everything else depends on the helper. Python method in `amauta.py`.
- **Daemon API:** Existing task endpoint returns `inherited_spec` in JSON output. No separate endpoint needed.
- **Cap at 10 inherited criteria.** Truncation with pointer: "N criteria truncated, run `amauta show ST-XXXX --json` for full list."
- **Caching:** Cache resolved spec on `metadata.inherited_spec` at **claim time** (operator resolves and caches when task is claimed). Re-resolve only on explicit `amauta task resync-criteria TK-XXXX`. Claim-time caching makes spec available for ALL phases (P, E, T, D), not just T.
- **Criterion IDs:** Position-based (SC-01, SC-02, etc.) assigned by `_inherit_parent_spec()` based on position in parent's `success_criteria` array. Grep-friendly, unambiguous. Accept rare reorder edge case -- `resync-criteria` regenerates IDs if parent criteria change.
- **Two sections in T-phase:** `TASK_CRITERIA:` and `INHERITED_CRITERIA:` kept separate for source clarity. SC-01 through SC-N within each section independently. Validator needs to know which criteria came from where.
- **Precedence:** Task-level success_criteria SUPPLEMENTS inherited criteria. Both are checked in T-phase. They serve different purposes: task-level = implementation-specific goals, inherited = acceptance bar from parent story. If they literally contradict, task-level wins with a warning.
- **Kill switch:** `GSD_T_SPEC_INHERIT=false` disables the inheritance walk. Falls back to task-only `success_criteria` as in v2.5. QA mandate pieces (edge cases, regression, adversarial) are baked into agent prompts with no separate switch -- they're testing practices, not optional features. Without inherited criteria, structured QA naturally degrades to standard testing.
- **`--no-inherit` flag:** `amauta show TK-XXXX --json --no-inherit` skips the inherited spec resolution (useful for debugging or when you only want task-level criteria).

### Edge Case Generation
- **Checker generates** 2+ edge cases per G/W/T criterion using structured `EDGE_CASES:` block in T-phase content. Format parallel to `PRE_EXECUTION_EVIDENCE` (same parser pattern):
  ```
  EDGE_CASES:
    criterion_1: "SC-01: Given user login"
      edge_1: null username -> expect 400
      edge_2: 500-char username -> expect 400
      edge_3: SQL injection in username -> expect sanitized
    criterion_2: "SC-02: When payment processed"
      edge_1: $0.00 amount -> expect rejection
      edge_2: negative amount -> expect rejection
  ```
- **Applies to BOTH sets** -- inherited AND task-level criteria. Cap of 10 inherited max keeps it bounded.
- **Minimum 2 edge cases per criterion.** Non-testable criteria (e.g., "documentation updated"): `edge_cases: n/a -- non-testable criterion`.
- **Domain-specific generation:** Uses Phase 11 domain inference (file extension -> domain) + RLM test pattern query + per-domain templates in `qa-checklist.md`. NOT generic "null input" for everything -- SQL injection for database code, race conditions for concurrent code, timeouts for network code.
- **Executor writes the tests** during E-phase. Checker VERIFIES edge cases were covered and generates additional ones if missing during T-phase. Checker never writes production code.
- **Validator checks structural presence** (>=2 per criterion). Validator does NOT judge edge case quality. Same producer/consumer pattern.
- **Cap:** EDGE_CASES block <=400 chars.

### Regression Sweep
- **Compare "after" against known-good baseline** from STATE.md. No "before" run needed -- baseline already tracked (e.g., "2001 pass / 3 fail"). Just compare "after" count against baseline. Delta > 0 new failures = regression.
- **Targeted per-task:** Checker infers test files from `git diff --name-only` + glob for `*test*` files in same directory or matching name pattern. If no matching test file found, fall back to full suite for that module.
- **Full suite at phase end:** Phase-end `npm test && pytest` catches cross-cutting issues.
- **test-phase.md RUNS the tests** (orchestration). Checker VERIFIES results (intelligence).
- **Report format:** `REGRESSION: after: 2085 pass / 3 fail. Baseline: 2001 pass / 3 fail. Delta: +84 new tests, 0 new failures. Regression: none.`
- **Baseline auto-update with logging** at phase completion step. Format: "Baseline updated: 2001->2085 (+84 new tests, 0 new failures)." The log IS the approval trail. No manual approval gate.
- **Cap:** REGRESSION block <=100 chars (one-line summary).

### RED-GREEN Back-Testing
- **MANDATORY for bug-type tasks (BG-XXXX) only.** Not for regular tasks or stories.
- **Strict detection:** Type field canonical (`type: "bug"`), BG- prefix as fallback. NO title heuristics. If someone creates a bug fix as TK-XXXX, that's a process problem, not a tool problem.
- **RED commit** = a test that FAILS, proving the bug exists. Commit message: `test(red): reproduce BG-XXXX -- <bug description>`.
- **GREEN commit** = the fix that makes the red test pass. Commit message: `fix(green): resolve BG-XXXX -- <fix description>`.
- **Git pattern:** Validator checks `git log --grep="BG-XXXX"` and verifies RED commit appears BEFORE GREEN commit (chronological order). Both commits must reference the same BG-XXXX ID.
- **Advisory in v2.6** -- validator logs warning if RED-then-GREEN order missing. Hard gate in v2.7. Same advisory-first pattern as Phase 11.
- **Non-reproducible bugs:** `--force-reason "non-reproducible: <explanation>"` on existing `amauta validate` command. Validator sees `forced:true` in validation metadata and skips RED commit check. Same existing mechanism, no new flag.
- **Checker verifies:** (1) red test exists, (2) red test fails on pre-fix code (or --force-reason provided), (3) green test passes on post-fix code.

### Gate 6 & Adversarial Testing
- **Gate 6 is ADVISORY** in v2.6. Free-standing advisory check called `checkSpecInheritanceAdvisory()`. Not a numbered gate yet -- gets a gate number when promoted to hard gate in v2.7.
- **What validator checks per G/W/T:** Each inherited criterion gets a pass/fail/skipped status. Validator greps for criterion IDs (SC-01, SC-02) in T-phase content. Missing criteria = advisory warning. Validation still PASSES.
- **Adversarial triggering:** Task metadata `security_sensitive: true` set by OPERATOR at claim time based on file-pattern matching from `agent-capabilities.json`. NOT the executor -- consistent with external validation.
- **Security patterns:** New top-level key in `agent-capabilities.json`: `"security_patterns": ["**/auth*", "**/crypto*", "**/payment*", "**/admin*", "**/permission*", "**/token*", "**/session*", "**/password*", "**/secret*"]`. File globs trigger the flag.
- **Prescriptive adversarial:** Checker specifies WHAT adversarial tests to write based on security patterns matched. "Task modifies auth.py -> MUST test: (1) invalid token rejection, (2) expired token handling, (3) missing auth header -> 401." Structural-only "adversarial: yes/no" is cargo-cult.
- **Execution timeline:** Planner sets criteria -> executor writes code + adversarial tests during E-phase -> checker verifies tests exist and pass during T-phase. Checker never writes code.
- **Non-security tasks:** `adversarial_testing: n/a -- no security-sensitive files`.
- **ADVERSARIAL: block** -- separate from EDGE_CASES. Three blocks in T-phase: EDGE_CASES, REGRESSION, ADVERSARIAL. Each has its own parser.
- **Adversarial checks:** path traversal, injection (SQL/XSS/command), auth bypass, privilege escalation, secret exposure. Same categories as Phase 11 security checklist but applied as TEST requirements.
- **Cap:** ADVERSARIAL block <=200 chars (3-5 checks with pass/fail).

### T-Phase Memory & RLM Integration
- **Pre-T memory retrieval:** Checker queries `$MEM search --source auto_learning,lesson-learned --tags "testing,<domain>"` before generating edge cases. Surfaces past testing learnings ("always mock PG connections in unit tests", "e2e tests need 30s timeout"). Lighter than Phase 11's formal mandate -- no structured evidence block, just query+use.
- **RLM test pattern query:** `$RLM query "test <domain>" --path tests/ --top-k 3` before edge-case generation. Surfaces existing test conventions (assertion style, fixture patterns, mock approaches) so new tests match the codebase. Prevents checker from generating tests in different style.
- **Enrichment dedup:** T-phase queries use `--tags "testing,<domain>"` vs E-phase `--tags "failure,<domain>"`. Different dedup keys -- 300s window won't suppress T-phase queries.
- **RLM cache:** 200-file LRU sufficient for new files created during E-phase. New files aren't in cache, so read fresh on first query. No `--fresh` flag needed.

### T-Phase LEARNING & Citation Pipeline
- **Checker emits LEARNING blocks from T-phase findings.** Insights like "this edge case caught a real bug" or "regression sweep found unrelated failure" are valuable. Operator already parses ALL phases for LEARNING blocks (Phase 10). No new wiring needed.
- **Validator does NOT emit LEARNING blocks.** Its job is pass/fail, not insight generation.
- **Checker emits APPLIED_LEARNING citations in T-phase** when it finds relevant learnings during pre-T memory retrieval. `APPLIED_LEARNING: mem-xyz -- used for edge case generation`. Operator's all-phase citation scanner picks it up automatically. Extends citation pipeline to QA.

### QA Report & Operator Integration
- **QA_REPORT: block** -- one-line summary generated by checker: `QA_REPORT: 8/10 criteria verified, 3 edge cases, regression: clean, adversarial: 3/3 passed`. Operator surfaces at phase end alongside SKB candidates.
- **Block ownership:** Checker generates 4 blocks (EDGE_CASES, REGRESSION, ADVERSARIAL, QA_REPORT). Validator checks 3 structural blocks (EDGE_CASES, REGRESSION, ADVERSARIAL). Operator reads 1 summary block (QA_REPORT). Each parser owns its block type.

### T-Phase Token Budget
- **Total T-phase cap: ~1000 chars** (up from v2.5's 300 chars). Breakdown:
  - EDGE_CASES: <=400 chars (2 edge cases x ~80 chars x ~2.5 criteria average)
  - REGRESSION: <=100 chars (one-line before/after summary)
  - ADVERSARIAL: <=200 chars (3-5 checks with pass/fail)
  - QA_REPORT: ~100 chars (one-line summary)
- Still well under the 2000-char RPETD overall soft cap since other phases were reduced in v2.5.

### Agent & Workflow Architecture
- **qa-checklist.md reference file** absorbs the checker's current `<post_check_mode>` content. Centralizes ALL QA logic in one reference file. Checker's inline checklist becomes "Read qa-checklist.md." Same consolidation pattern as `cli-variables.md` and `pre-execution-checklist.md`.
- **Checker stays one agent** with runtime Read of qa-checklist.md. No split needed. Reference file carries the complexity; prompt stays under +25% budget.
- **test-phase.md orchestrates** (runs commands, captures output, logs to T-phase). Checker thinks (which edge cases, adversarial requirements, criteria assessment). Operator coordinates both. They don't call each other.
- **Validator meta-validates** -- checks that checker DID its job (QA blocks present, criteria referenced). Greps T-phase for structural blocks. Doesn't re-do QA. Advisory warning if blocks missing. Not too much for one agent -- same grep-and-check pattern as existing gates.

### Model Selection
- **Sonnet sufficient for checker.** Edge-case generation and adversarial prescription follow templates from qa-checklist.md. Templates carry the creative load. Sonnet applies them. Config change to Opus if insufficient later.

### Test Strategy
- **Both CJS AND Python tests.** Helper lives in `amauta.py` (Python), checker/validator logic lives in CJS.
- **Python tests:** `_inherit_parent_spec()` with fixture tasks -- task->story->epic chain, task with no parent, task with empty-criteria parent, cap-at-10 truncation, kill switch behavior.
- **CJS tests:** EDGE_CASES/REGRESSION/ADVERSARIAL block parsing, RED-GREEN commit detection via git log fixtures, criterion ID assignment, spec inheritance advisory check, QA_REPORT generation.
- **File naming:** `12-*.test.cjs` for CJS, `test_phase12_*.py` for Python. Following established convention.
- **Meta-test fixtures:** Mock tasks with known parent chains, fixture T-phase content with/without structured blocks, mock git log output for RED-GREEN verification.

### Claude's Discretion
- Exact wording of advisory warning messages for Gate 6
- Edge case template specifics within each domain category in qa-checklist.md
- QA_REPORT summary format details (as long as it's one line with key metrics)
- How to handle edge cases in domain inference for uncommon file extensions
- Exact structure of qa-checklist.md sections (as long as it consolidates post_check_mode + Phase 12 additions)
- Order of operations when multiple structural blocks need parsing

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & Research
- `.planning/REQUIREMENTS.md` -- QA-01 through QA-08 detailed specifications (lines 71-83)
- `.planning/research/v2.6/PITFALLS.md` -- T1 (parent G/W/T too vague), T2 (edge case bloat), T5 (back-testing on missing repro), T6 (G/W/T inheritance breaks on rename), T7 (trajectory evaluation theatre)
- `.planning/research/v2.6/SUMMARY.md` -- Ship order locked, advisory-first pattern
- `.planning/research/v2.6/ARCHITECTURE.md` -- Integration points, LOC budget

### Python Helper (commit 1)
- `amauta.py` -- `success_criteria` field (line 1276), `_enrich_task_context()` area (line 2218 gap), parent-child hierarchy (line 6: Epic > Story > Task > Bug), `_calculate_completeness_gaps()` for success_criteria checks (line 1456)

### CLI Tools
- `get-shit-done/bin/amauta.cjs` -- `show` command (needs `--json` + `inherited_spec` + `--no-inherit`), `validate` command (existing `--force-reason`)
- `get-shit-done/bin/gsd-memory.cjs` -- `search --source --tags` for pre-T memory retrieval
- `get-shit-done/bin/gsd-rlm.cjs` -- `query --path --top-k` for test pattern matching

### Checker & Validator Agents
- `agents/gsd-checker.md` -- `<post_check_mode>` (lines 82-139, to be absorbed into qa-checklist.md), current ~120 lines, +25% max = ~150
- `agents/gsd-validator.md` -- Quality gates section (lines 89-144), Gate 2 LEARNING block parser pattern, needs `checkSpecInheritanceAdvisory()` + RED-GREEN + structural block checks

### Workflow
- `get-shit-done/workflows/test-phase.md` -- Current basic test execution (lines 1-50), needs regression sweep integration + inherited spec pull

### Phase 10/11 Infrastructure (reused)
- `.planning/milestones/v2.1-phases/10-d-phase-structured-learning/10-CONTEXT.md` -- LEARNING block format, APPLIED_LEARNING citations, external validation principle, tag governance
- `.planning/milestones/v2.2-phases/11-context-engine-activation/11-CONTEXT.md` -- PRE_EXECUTION_EVIDENCE format, advisory-first pattern, domain inference, "each parser owns its block type"
- `get-shit-done/references/cli-variables.md` -- Runtime Read pattern (tool vars)
- `get-shit-done/references/pre-execution-checklist.md` -- Reference file pattern to follow for qa-checklist.md
- `get-shit-done/references/learning-format.md` -- LEARNING block template (checker emits T-phase learnings)

### Configuration
- `get-shit-done/config/agent-capabilities.json` -- Needs new `security_patterns` key for adversarial trigger detection

### State Tracking
- `.planning/STATE.md` -- Test baseline tracking (pass/fail counts), phase completion baseline updates

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `amauta.py:success_criteria` field (line 1276): Already exists in item schema. `_inherit_parent_spec()` will walk parent chain and read this field.
- `amauta.py:_calculate_completeness_gaps()` (line 1454): Already checks for missing success_criteria. Pattern reusable for inherited spec validation.
- `gsd-validator.md` Gate 2 parser: Already parses LEARNING blocks with structured field detection. EDGE_CASES/REGRESSION/ADVERSARIAL block parsers follow the same grep + field extraction pattern.
- `gsd-operator.md` APPLIED_LEARNING scanner: Already greps ALL RPETD phases for citations. T-phase citations from checker are picked up automatically.
- `gsd-operator.md` LEARNING block parser: Already parses ALL phases for LEARNING blocks. T-phase learnings from checker are picked up automatically.
- `gsd-checker.md:post_check_mode` (lines 82-139): Existing 6-step checklist to be absorbed into qa-checklist.md reference file.
- `get-shit-done/references/pre-execution-checklist.md`: Pattern for qa-checklist.md -- runtime Read, domain-grouped sections, structured block format.
- `get-shit-done/workflows/test-phase.md`: Existing test orchestration. Needs regression sweep integration (baseline comparison, targeted + full-suite modes).
- `get-shit-done/bin/amauta.cjs:validate` command: Existing `--force-reason` flag for RED-GREEN bypass.

### Established Patterns
- **Runtime Read for references:** 15+ files in `get-shit-done/references/`. qa-checklist.md follows this pattern.
- **External validation:** Agents produce, validator validates. Checker generates QA blocks, validator checks structural presence.
- **Kill switch per phase:** `GSD_T_SPEC_INHERIT=false` follows `GSD_D_STRUCTURED=false` and `GSD_E_MANDATE=off` patterns.
- **Advisory-first:** v2.6 advisory, v2.7 hard gate. Same pattern as Phase 11 evidence advisory.
- **Indented-field block format:** LEARNING, PRE_EXECUTION_EVIDENCE, EDGE_CASES, REGRESSION, ADVERSARIAL all use same parser pattern.
- **Criterion IDs:** SC-01, SC-02 parallel to task IDs (TK-XXXX, BG-XXXX, ST-XXXX). Grep-friendly, position-based.
- **Phase-specific enrichment:** Phase 11 added pre-E queries. Phase 12 adds pre-T queries with different tags to avoid dedup.

### Integration Points
- `amauta.py`: New `_inherit_parent_spec(item)` method called from `_enrich_task_context()`. Walks parent chain, assigns SC-XX IDs, caches to `metadata.inherited_spec`. Kill-switch guarded.
- `amauta.cjs show`: Add `inherited_spec` to JSON output. Add `--no-inherit` flag.
- `agents/gsd-checker.md`: Replace `<post_check_mode>` with Read instruction for qa-checklist.md. Add pre-T memory+RLM queries. Generate EDGE_CASES, REGRESSION interpretation, ADVERSARIAL prescription, QA_REPORT, T-phase LEARNING blocks.
- `agents/gsd-validator.md`: Add `checkSpecInheritanceAdvisory()`. Add structural checks for EDGE_CASES/REGRESSION/ADVERSARIAL blocks. Add RED-GREEN git log verification for bug-type tasks.
- `get-shit-done/workflows/test-phase.md`: Add regression sweep (baseline comparison), inherited spec pull, adversarial trigger detection.
- `get-shit-done/config/agent-capabilities.json`: Add `security_patterns` key for adversarial trigger detection.
- New file: `get-shit-done/references/qa-checklist.md` -- Consolidated QA logic (existing post_check_mode + edge-case templates + adversarial triggers + RED-GREEN steps + regression sweep + domain-specific guidance).
- `agents/gsd-operator.md`: Parse QA_REPORT block for phase-end summary (alongside SKB candidates).
- `.planning/STATE.md`: Auto-update test baseline at phase completion.

</code_context>

<specifics>
## Specific Ideas

- "Structural-only 'adversarial: yes/no' is cargo-cult -- the same anti-pattern we're fighting in Phase 12" -- prescriptive adversarial tests required
- "If someone creates a bug fix as TK-XXXX, that's a process problem, not a tool problem" -- strict bug detection, no title heuristics
- "Don't run the suite twice per task" -- compare against known-good baseline instead of before/after snapshots
- "The checker thinks, the workflow runs commands, the operator coordinates" -- clear separation of concerns
- "Edge cases need to be DOMAIN-SPECIFIC, not generic null-input" -- SQL injection for DB code, race conditions for concurrent code
- "Never block execution for missing inherited criteria" -- graceful fallback, not a gate
- "Cap at 10 inherited criteria" -- prevents token bloat from complex parent stories
- "Claim-time caching makes spec available for ALL phases" -- not just T-phase
- "Two sections (TASK_CRITERIA + INHERITED_CRITERIA) with source clarity" -- validator needs to know origin
- "Each parser owns its block type: checker generates 4, validator checks 3, operator reads 1"
- "The log IS the approval trail" -- auto-update baseline with delta logging, no manual approval friction
- "Partial structure beats no structure" (Phase 10 principle) -- non-testable criteria get n/a, not blocked
- "v2.5 proved honor systems don't work" (Phase 10 principle) -- hard caps on block sizes
- "Defense in depth" -- type field canonical for bug detection, BG- prefix as fallback

</specifics>

<deferred>
## Deferred Ideas

- **Hash-based criterion IDs** (SC-{hash}) instead of position-based (SC-01) -- position-based accepted, resync-criteria handles reorder edge case
- **Opus model for checker** -- Sonnet sufficient with template-driven edge cases. Config change later if needed.
- **Per-item kill switch granularity** for QA features -- one switch (GSD_T_SPEC_INHERIT) covers all. QA mandate pieces baked into prompts.
- **Manual baseline approval gate** -- auto-update with logging accepted. Manual approval deferred as unnecessary friction.
- **Title-based bug-fix heuristic** -- strict type=bug detection only. Heuristics deferred as unreliable.
- **T-phase compliance summary in operator** (e.g., "8/10 tasks had QA blocks") -- deferred. QA_REPORT per task is sufficient for v2.6.
- **Checker agent split** -- stays one agent with qa-checklist.md reference. Split deferred unless prompt grows beyond +25%.
- **RLM `--fresh` flag for post-E-phase cache** -- 200-file LRU sufficient. Flag deferred.
- **Phase 14 awareness in `_inherit_parent_spec()`** -- pure read-only helper. Phase 14 can refactor.
- **RLM indexing of test learnings** -- deferred from Phase 10. Still out of scope.

</deferred>

---

*Phase: 12-semantic-memory-pipeline*
*Context gathered: 2026-04-09*

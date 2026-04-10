# Phase 15: End-to-End Dogfood Verification - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Observational audit of the full v2.6 milestone. Verifies that all RPETD upgrades (phases 9-14) hold together as a working pipeline when exercised end-to-end. Phase 15 produces an audit report, verification tooling, and the published dogfood ledger. It does NOT produce code changes to existing files, fix findings, or modify the pipeline it observes.

**Hard scope rule:** If the audit reveals something that needs fixing, the fix goes to Phase 15.1, Phase 13.2, or v2.7 — not into Phase 15. Phase 15's job is to see, not to act on what it sees.

**Out of scope (hard, from postmortem follow-ups):**
- manifest_violation taxonomy gap — Phase 13.2
- v2.2-phases → v2.6-phases rename — hygiene milestone
- STATE.md frontmatter counter — deferred until all values derivable
- gsd-amauta.cjs inline resolvePhaseDir refactor — dedicated cleanup PR
- Parser registry introduction — Phase 15+ (after Phase 15, not during)

</domain>

<decisions>
## Implementation Decisions

### New files vs existing file modifications (Q1)
- **New file creation is in scope.** Creating `scripts/verify-v26.cjs`, `docs/v2.6-dogfood-ledger.md`, `commands/amauta/verify-v26.md`, `get-shit-done/bin/audit-rpetd-intelligence.cjs`, `get-shit-done/workflows/verify-rpetd-intelligence.md` are all Phase 15 deliverables — new files that read the system read-only.
- **Modification of existing code-bearing files is out of scope.** No changes to files in `agents/`, `get-shit-done/` (except new files listed above), `services/`, `migrations/`, `amauta.py`, or any pre-existing `.cjs`/`.js`/`.py` file.
- **If the audit tooling needs something from an existing file that isn't exposed:** document the gap in the audit report, do not patch the existing file. Route to Phase 16 or v2.7.
- **Lock:** Modification of any file outside `.planning/milestones/v2.2-phases/15-dogfood/` and the new deliverable paths listed above requires explicit orchestrator approval at a wave boundary.

### Behavioral test execution (Q2)
- **Accept partial results.** Run `npm run test:behavioral` once. Do not fix the test harness.
- The test aborting on first failure per scenario is itself a finding the audit captures.
- Expected output: (a) which scenarios pass, (b) which scenarios abort, (c) first-failure reason per aborting scenario.
- n=1 per failing scenario is a limitation, not a blocker — the audit verifies infrastructure works, not statistical protocol correctness.
- **Lock:** Run once, capture structured output, document the abort-on-first-failure limitation, route remediation to Phase 13.2. Do not modify `tests/13.1-divergence-protocol.integration.test.cjs`.

### Dogfood ledger depth-3 gap (Q3)
- **Keep the gap visible.** Placeholder row in the published ledger: "Depth 3: Not yet observed in v2.6 milestone."
- Include an "expected shape" description: sub-task-level recursion within an executor's own work.
- **Do not renumber** the depths to close the gap. A ledger that renumbers itself to hide holes cannot be trusted for provenance.
- Current depths: 0, 1, 2, 4, 5, 6, 7. Depth 3 still open.

### Audit report pass/fail criteria (Q4)
Three categories, every DOGFOOD criterion tagged with one:

1. **Deterministic criteria** — npm test exit code, migration count, file existence, grep presence of load-bearing markers. Binary assertions, no judgment.
2. **Sampling criteria** — Scale to actual pool size. If pool is 7 tasks, criterion becomes "6 of 7 sampled tasks." If pool < 5, document as "assessed on n=N pool, below ROADMAP's assumed sample size of 10" and route gap as Phase 16+ re-audit opportunity. **Never fake the sample size. Never generate synthetic tasks to reach n=10.**
3. **Indirectly assessed** — Capabilities that cannot be assessed without running new work. Marked as "not directly assessable in observational audit" with note that capability is indirectly assessed by presence of structural infrastructure.

**Lock:** No criterion silently skipped. No criterion faked.

### Ghost directory handling (Q5)
- The stale `v2.3-phases/15-data-purge` directory is not Phase 15's to clean up.
- Phase 15 creates its own directory at `.planning/milestones/v2.2-phases/15-dogfood/`.
- Documents the ghost as a finding in the audit report's "known hygiene debt" section.
- Routes cleanup to hygiene milestone (same bucket as v2.2→v2.6 rename).
- **Audit finding to include:** "discuss-phase init is a recurring drift-detection surface (3 instances: Phase 14, Phase 15, Phase 13.1 reconciliation); consider formalizing the cross-reference check as part of init itself."

### Verification script language (Q6)
- **`scripts/verify-v26.cjs`** (Node, not bash).
- The script `require()`s `gsd-tools.cjs` directly for `manifestCheck`, `resolvePhaseDir`, `GLOBAL_ALLOWLIST`, and dedup check bypass — exercising the CJS exports that Phase 13.1 introduced.
- If those imports fail, the audit immediately fails with a clear error proving the audit can't silently run without Phase 13.1 infrastructure.

### Audit report format (Q7)
- **Dual output:** `15-AUDIT-REPORT.json` (machine-consumable) + `15-AUDIT-REPORT.md` (human-readable, derived from JSON).
- The markdown is generated from the JSON via a helper function — the two can never drift.
- **JSON schema (locked):**
```json
{
  "audit_timestamp": "...",
  "milestone": "v2.6",
  "phases_audited": ["10", "11", "12", "13", "13.1", "14"],
  "phase_15_excluded_from_audit": true,
  "criteria": [
    {
      "id": "DOGFOOD-01",
      "category": "deterministic | sampling | indirectly_assessed",
      "verdict": "pass | gaps_found | fail | not_assessable",
      "evidence": ["..."],
      "details": "..."
    }
  ],
  "behavioral_test_results": {
    "total_invocations_attempted": 16,
    "invocations_completed": "N",
    "phase_13_incident_replay": "pass | fail",
    "per_scenario_results": {},
    "harness_limitations_observed": ["..."]
  },
  "pre_existing_failures_verified": ["..."],
  "new_failures_surfaced": ["..."],
  "hygiene_debt_observed": ["..."],
  "dogfood_ledger_depths_captured": [0, 1, 2, 4, 5, 6, 7],
  "dogfood_ledger_gaps": [3]
}
```

### Ledger artifact location (Q8)
- **`docs/v2.6-dogfood-ledger.md`** — published for repo readers, not buried in phase directory.
- Memory entries are retrievable but not discoverable; phase directories are discoverable only if you know which phase. `docs/` is the only location where a future reader can find the ledger without knowing where to look.

### Pre-existing failure matching (Q9)
- Verify against STATE.md baseline (4 npm + 3 pytest known failures).
- **Match by test name, not count.** If a new failure replaces a known one (same count, different test), that's still an audit failure because the matching set changed.
- Counted staleness is not matched staleness.

### Recursive scope exclusion (Q10)
- `verify-v26.cjs` does NOT audit its own deliverables: `scripts/verify-v26.cjs`, `15-AUDIT-REPORT.json`, `15-AUDIT-REPORT.md`, `docs/v2.6-dogfood-ledger.md`.
- These are verified by the plan-phase checker, not by the audit script.
- Hard-coded exclusion list with inline comment naming the reason.

### Ledger structure (Q11, locked)
```markdown
# v2.6 Dogfood Ledger

## What this is
(Preamble about divergence protocol and recursive depths.)

## Entries
| Depth | Phase | Actor | Artifact | Rationalization Named | Outcome |
|-------|-------|-------|----------|----------------------|---------|
| 0 | 13.1 Wave 1 | ... | ... | ... | Caught, surfaced |
...
| 3 | -- | -- | -- | -- | Not yet observed |
...
| 7 | Phase 15 discuss-phase | ... | ... | ... | ... |

## Details per entry
(One subsection per entry with source memory file path, timestamp, literal quote.)

## Expected shape of depth-3
(Description so future phases can recognize it.)

## How this ledger is maintained
(Protocol for future additions.)
```

### Behavioral test run count (Q12)
- **Single run.** Expensive (15-25 min realistic). Multiple runs don't add information the audit needs.
- If results differ from 13.1 findings memo, that's a finding for Phase 13.2.

### Plan structure (Q13)
- **Plan 15-01 (Wave 1): Tooling creation.** `scripts/verify-v26.cjs` + `commands/amauta/verify-v26.md` + `get-shit-done/bin/audit-rpetd-intelligence.cjs` + `get-shit-done/workflows/verify-rpetd-intelligence.md`. Four new files.
- **Plan 15-02 (Wave 2): Run the audit.** Execute verify-v26.cjs, capture 15-AUDIT-REPORT.json, generate 15-AUDIT-REPORT.md, run behavioral test suite, capture structured output. Zero new code — uses Plan 15-01 output.
- **Plan 15-03 (Wave 3): Publish ledger.** Create `docs/v2.6-dogfood-ledger.md` by transcribing seven memory entries + depth-3 placeholder. Ships last to include any new dogfood moments during Phase 15 itself (depth-7 already captured).
- **Sequential waves.** Phase 15 is small enough that parallelism doesn't help.

### Phase 15 pass/fail semantics (Q14)
- **Phase 15 passes on audit completeness, not audit cleanliness.** The audit is expected to find failures (e.g., 3 behavioral test scenarios from 13.1 findings).
- A Phase 15 audit that finds "3 behavioral scenarios abort, Phase 13.2 owns remediation" is a **successful** audit.
- **Acceptance criterion for 15-02:** "verify-v26.cjs exits 0 AND 15-AUDIT-REPORT.json contains entries for all DOGFOOD criteria AND behavioral_test_results is populated with structured data, regardless of individual criterion verdicts."

### Milestone closeout (Q15)
- After the Phase 15 closeout commit, flag v2.6 milestone as complete in ROADMAP.md.
- Add downstream note: "v2.6 closed. v2.7 planning deferred to separate session."
- This prevents the next discuss-phase invocation from hitting another ghost directory at milestone transition.

### DOGFOOD-03 errata: .sh → .cjs (Gap 1a)
- REQUIREMENTS.md says `scripts/verify-v26.sh` (shell). Q6 locked `scripts/verify-v26.cjs` (Node) with a correctness argument: the script must `require()` gsd-tools.cjs exports (`manifestCheck`, `resolvePhaseDir`, `GLOBAL_ALLOWLIST`) to exercise the Phase 13.1 infrastructure directly, not via subprocess indirection.
- **This is a real requirements change, not a reinterpretation.** Same shape as PLAN-04 errata.
- **Handle at Phase 15 closeout:** Strike through the `.sh` language in REQUIREMENTS.md DOGFOOD-03, add `.cjs` underneath with a footnote citing the require-based dogfooding argument and this CONTEXT.md decision. Do NOT edit REQUIREMENTS.md during execution.
- **Why this matters:** Without the errata, future readers see "verify-v26.sh" in REQUIREMENTS.md and `verify-v26.cjs` in the filesystem with no audit trail explaining the drift.

### DOGFOOD-01 errata: subcommand → standalone binary (Gap 1c)
- REQUIREMENTS.md line 126 and ROADMAP.md line 352 describe DOGFOOD-01 as a `gsd-tools.cjs audit-rpetd-intelligence <task_id>` **subcommand**. Q1 (new files only, no modification of existing `.cjs` files) prevents adding a subcommand to gsd-tools.cjs. Q6 rationale (require the exports, don't subprocess them) applies equally here.
- **Locked implementation:** `get-shit-done/bin/audit-rpetd-intelligence.cjs` as a **standalone binary** that `require()`s gsd-tools.cjs exports. Same correctness argument as Gap 1a — direct require() over subprocess indirection.
- **This is a real requirements change, not a reinterpretation.** Same shape as Gap 1a.
- **Handle at Phase 15 closeout:** Strike through "gsd-tools.cjs audit-rpetd-intelligence subcommand" language in REQUIREMENTS.md DOGFOOD-01 AND ROADMAP.md Phase 15 deliverable row 1, replace with "standalone binary `get-shit-done/bin/audit-rpetd-intelligence.cjs`" with a footnote citing Q1 (no-modify-existing-files) + Q6 (require over subprocess) as the correctness argument. Both DOGFOOD-01 and DOGFOOD-03 errata ship in the same closeout commit.
- **Why this matters:** Without the errata, future readers see "gsd-tools.cjs audit-rpetd-intelligence" in REQUIREMENTS.md and no such subcommand in the filesystem, with no audit trail explaining the drift.

### DOGFOOD-05 phase enumeration (Gap 1b)
- REQUIREMENTS.md says "6/6 phases green." v2.6 contains 8 slots (9, 10, 11, 12, 13, 13.1, 14, 15). "6/6" doesn't match 8 or 7.
- **Locked interpretation (#2):** Phase 9 is excluded as baseline (tech-debt sweep, not an RPETD upgrade). Phase 15 is excluded per Q10 (recursive scope exclusion). Remaining: **10, 11, 12, 13, 13.1, 14 = 6 phases.** The "6/6" was correct for the current reality.
- **Lock:** `DOGFOOD-05` audits exactly these 6 phases: `["10", "11", "12", "13", "13.1", "14"]`. Phase 9 excluded as baseline. Phase 15 excluded per Q10. The audit script hard-codes this list — it does not pick which 6 at runtime. Non-reproducible audit results from ambiguous phase enumeration is exactly the kind of drift Phase 15 exists to prevent.
- DOGFOOD-05 is a milestone ship gate assessed by Plan 15-02. The audit captures the 6/6 verdict as a `criteria[]` entry. If not 6/6, verdict is `gaps_found` — does not prevent Phase 15 from completing (per Q14: audit completeness, not cleanliness). Milestone closeout (Q15) consults DOGFOOD-05 verdict separately.

### Behavioral test timeout (Gap 2)
- **Hard timeout: 30 minutes total wall-clock** for the behavioral suite, enforced by the audit script via subprocess timeout wrapper around `npm run test:behavioral`.
- If timeout fires, the audit records `"behavioral_test_timeout": true` with `"timeout_minutes": 30` and `"partial_results_captured": [...]` as a distinct finding category — different from "test completed with failures."
- **Lock:** Plan 15-01's verify-v26.cjs includes the timeout wrapper. Failing to timeout means the audit can hang indefinitely during Wave 2.

### Environment pre-flight check (Gap 3)
- Real LLM invocation needs API keys (ANTHROPIC_API_KEY for Task tool). Auth errors look identical to protocol failures.
- **Lock:** Plan 15-01's verify-v26.cjs includes a pre-flight function that checks required env vars (`ANTHROPIC_API_KEY`, any others needed) and aborts with a specific exit code if missing, BEFORE invoking any tests.
- The abort is not a Phase 15 failure — it's a `"environment_missing"` finding category. The report captures what was missing and skips the behavioral test rather than running it to an auth error.
- Deterministic checks (npm test, file existence, grep assertions) run regardless of API key presence.

### Commit/gitignore policy for audit artifacts (Gap 4)
- Audit reports under `.planning/milestones/v2.2-phases/15-dogfood/` are gitignored — need `git add -f` (same as other `.planning/` artifacts).
- Ledger under `docs/v2.6-dogfood-ledger.md` is tracked normally — plain `git add`.
- New tooling files (`scripts/verify-v26.cjs`, `commands/amauta/verify-v26.md`, `get-shit-done/bin/audit-rpetd-intelligence.cjs`, `get-shit-done/workflows/verify-rpetd-intelligence.md`) are tracked normally — plain `git add`.
- **Lock:** Closeout checklist must explicitly list which files need `-f` and which don't. Executor should not have to discover the gitignore interaction mid-commit.

### Ledger transcription source paths (locked)
The seven memory entries for Plan 15-03, listed by filesystem path under `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/`:
1. `project_phase13_1_wave1_dogfood.md` — Depth 0
2. `project_phase13_1_meta_recursive_dogfood.md` — Depth 1
3. `project_phase13_1_wave3_near_miss.md` — Depth 2
4. `project_phase13_1_closeout_paperwork_dogfood.md` — Depth 4
5. `project_phase13_1_discuss_phase_reconciliation_dogfood.md` — Depth 5
6. `project_phase14_prior_session_verification_dogfood.md` — Depth 6
7. `project_phase15_ghost_directory_dogfood.md` — Depth 7

Plan 15-03 executor reads these directly — no memory search required.

### Claude's Discretion
- Exact verify-v26.cjs internal structure (helper function organization, error handling patterns)
- How audit-rpetd-intelligence.cjs parses RPETD content (field extraction approach)
- Markdown formatting details of 15-AUDIT-REPORT.md (derived from JSON, exact layout)
- Exact wording of the depth-3 "expected shape" description in the ledger

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and scope
- `.planning/REQUIREMENTS.md` — DOGFOOD-01..05 requirement definitions, traceability table, out-of-scope items
- `.planning/ROADMAP.md` §Phase 15 (line 341) — Goal, deliverables table, success criteria, pitfalls prevented, rollback plan

### Dogfood evidence (the seven memory entries — primary evidence for the ledger)
- Memory: `project_phase13_1_wave1_dogfood.md` — Depth 0: executor surfaced doc-vs-reality mismatch
- Memory: `project_phase13_1_meta_recursive_dogfood.md` — Depth 1: protocol self-application
- Memory: `project_phase13_1_wave3_near_miss.md` — Depth 2: "helper useless if nothing consumes it"
- Memory: `project_phase13_1_closeout_paperwork_dogfood.md` — Depth 4: paperwork drift resistance
- Memory: `project_phase13_1_discuss_phase_reconciliation_dogfood.md` — Depth 5: directory-slot-vs-roadmap-identity
- Memory: `project_phase14_prior_session_verification_dogfood.md` — Depth 6: cross-session pre-commit verification
- Memory: `project_phase15_ghost_directory_dogfood.md` — Depth 7: v2.3 ghost directory detection

### Protocol design gap (deferred findings, context for audit)
- Memory: `project_phase13_1_behavioral_test_findings.md` — manifest_violation taxonomy gap, behavioral test 1/4 pass, Phase 13.2 input
- Memory: `project_phase13_1_postmortem_followups.md` — 9 deferred items (all out of scope for Phase 15)

### v2.6 infrastructure being audited
- `get-shit-done/references/divergence-protocol.md` — Version 1.1.0, the protocol Phase 15 verifies (DO NOT MODIFY)
- `get-shit-done/bin/gsd-tools.cjs` — manifestCheck, resolvePhaseDir, GLOBAL_ALLOWLIST, planToTasks exports (READ ONLY)
- `get-shit-done/bin/gsd-amauta.cjs` — cmdValidate with --pass/--fail/--gaps-found (READ ONLY)
- `tests/13.1-divergence-protocol.integration.test.cjs` — Behavioral test suite (RUN, DO NOT MODIFY)
- `tests/13.1-manifest-check.test.cjs` — Deterministic manifest check tests (RUN via npm test)

### Test baseline
- `.planning/STATE.md` §Test Baseline — 4 npm_fail + 3 pytest_fail known failures with test names

### Phase 13 incident (negative counterpart)
- Memory: `project_phase13_incident.md` — The failure mode the entire dogfood ledger documents resistance to

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `gsd-tools.cjs` exports: `manifestCheck()`, `resolvePhaseDir()`, `GLOBAL_ALLOWLIST`, `planToTasks()` — verify-v26.cjs can `require()` these directly to exercise Phase 13.1/14 infrastructure
- `gsd-amauta.cjs` exports (test-only block): `_checkQaBlocks()`, `_checkRedGreenOrder()`, `checkEvidenceAdvisory()`, `checkSpecInheritanceAdvisory()` — audit can verify these exist via require without invoking them on live tasks
- `scripts/run-behavioral-tests.cjs` — existing runner for behavioral test suite; audit invokes via `npm run test:behavioral`

### Established Patterns
- **Dual JSON+MD output:** Used by HARDEN-01 (manifest-violation-*.json) — audit follows same pattern
- **test:behavioral npm script:** Separate from `npm test`, real-LLM execution — audit captures its output
- **Phase verification files:** Each completed phase has a VERIFICATION.md in its directory — audit checks existence and content

### Integration Points
- `require('../get-shit-done/bin/gsd-tools.cjs')` — verify-v26.cjs imports from repo-local path
- `npm run test:behavioral` — subprocess execution from the audit script
- `npm test` / `pytest` — subprocess execution for deterministic test gate
- `.planning/milestones/v2.2-phases/*/VERIFICATION.md` — glob pattern for per-phase verification artifacts

</code_context>

<specifics>
## Specific Ideas

- verify-v26.cjs first lines: `const { manifestCheck, resolvePhaseDir, GLOBAL_ALLOWLIST } = require('../get-shit-done/bin/gsd-tools.cjs')` — if these imports fail, the audit immediately fails with a clear error proving the audit can't run without Phase 13.1 infrastructure
- Phase 15 is "the most boring phase in the milestone." Any excitement during execution is a sign of scope reach. Observational phases earn value by being maximally boring.
- The dogfood ledger is the qualitative proof the pipeline works under pressure. The behavioral test findings and post-mortem follow-ups are the known-unknowns.
- "Counted staleness is not matched staleness" — test failure matching must be by name, not count
- "inconsistent state implies someone updated some of it" — uniform staleness over partial correction (depth-4 principle, applies to audit findings too)
- discuss-phase init is a recurring drift-detection surface (3 instances) — formalize this observation in the audit report as a finding

</specifics>

<deferred>
## Deferred Ideas

- **Formalize discuss-phase init cross-reference check** — the depth-5/7 pattern suggests the init tool should validate directory identity against roadmap before returning. This is a tooling improvement for gsd-tools.cjs, not Phase 15 scope. Route to v2.7 or a tooling cleanup PR.
- **Phase 13.2 behavioral test fixes** — all three scenario failures from the 13.1 findings memo (harness -u flag, taxonomy disambiguation, manifest_violation scenario redesign) are explicitly Phase 13.2 scope.
- **v2.3-phases/15-data-purge ghost cleanup** — same bucket as v2.2→v2.6 rename, hygiene milestone.
- **v2.7 milestone initialization** — referenced in closeout but not created during Phase 15.

</deferred>

---

*Phase: 15-dogfood*
*Context gathered: 2026-04-10*

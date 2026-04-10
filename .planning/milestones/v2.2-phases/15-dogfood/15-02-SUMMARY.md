---
plan_id: 15-02
plan_name: Run the Audit
phase: 15
wave: 2
status: done
executor: executor-backend
completed: 2026-04-10
requirements:
  - DOGFOOD-01
  - DOGFOOD-02
  - DOGFOOD-03
  - DOGFOOD-04
  - DOGFOOD-05
commits:
  - 5d2f1f8
---

# Plan 15-02 — Run the Audit — SUMMARY

## What was run

One invocation of `node scripts/verify-v26.cjs` from the project root. Zero
code edits, zero re-runs, zero fixes to the tooling or to anything the audit
surfaced. The script exited 0 (as designed — it always exits 0, and the
verdict is carried in the JSON report body).

Runtime environment at invocation:

- `ANTHROPIC_API_KEY` **unset** → `environment_missing` pre-flight branch fired
  (CONTEXT.md Gap 3), behavioral suite skipped, deterministic checks ran.
- `npm test` exit code: 1 (expected — pre-existing failures)
- `pytest -q --no-header` exit code: 1 (expected — test_pg_integration.py)
- `gsd-tools.cjs` exports (`manifestCheck`, `resolvePhaseDir`, `GLOBAL_ALLOWLIST`): present
- `gsd-amauta.cjs` exports (`_checkQaBlocks`, `_checkRedGreenOrder`, `checkEvidenceAdvisory`, `checkSpecInheritanceAdvisory`, `_checkEvidenceBlock`): present

## Reports generated

```
.planning/milestones/v2.2-phases/15-dogfood/15-AUDIT-REPORT.json   (128 lines)
.planning/milestones/v2.2-phases/15-dogfood/15-AUDIT-REPORT.md     (89 lines)
```

Both under `.planning/` (gitignored) and committed atomically with `git add -f`
per CONTEXT.md Gap 4. Commit: `5d2f1f8`.

The Markdown report is derived from the JSON via `generateMarkdown(report)`
inside `verify-v26.cjs` — verified by the header `_Auto-generated from
15-AUDIT-REPORT.json by scripts/verify-v26.cjs._` on line 3 of the MD. The
two reports cannot drift by construction.

Schema compliance vs CONTEXT.md Q7 lock: all required top-level fields
present (`audit_timestamp`, `milestone`, `phases_audited`,
`phase_15_excluded_from_audit`, `criteria`, `behavioral_test_results`,
`pre_existing_failures_verified`, `new_failures_surfaced`,
`hygiene_debt_observed`, `dogfood_ledger_depths_captured`,
`dogfood_ledger_gaps`). Extra fields added by the Wave 1 script
(`self_exclusion`, `environment`, `deterministic_summary`) are supersets of
the locked schema, not drift.

## Findings summary

Per-criterion verdicts captured by the audit:

| ID | Category | Verdict | Note |
|----|----------|---------|------|
| DOGFOOD-01 | sampling | gaps_found | Sampling pool size is n=1 (TK-0774 only) |
| DOGFOOD-02 | indirectly_assessed | pass | Workflow file structurally valid (purpose/step/audit_ref markers present) |
| DOGFOOD-03 | deterministic | pass | Self-referential: the script executing IS the proof |
| DOGFOOD-04 | deterministic | pass | Slash command has `name: amauta:verify-v26` + workflow ref |
| DOGFOOD-05 | deterministic | gaps_found | 4/6 phases with VERIFICATION.md; 13.1 expected missing, 14 unexpectedly missing |

Hygiene debt observed (verbatim from the JSON report):

1. Phase 10 VERIFICATION.md is under `v2.1-phases/`, not `v2.2-phases/`
   (cross-milestone directory split) — known, routed to hygiene milestone.
2. Phase 13.1 has no VERIFICATION.md (only `.gitkeep` and
   `divergence-reports/`) — known, routed to Phase 13.2.
3. Nyquist gate CONTEXT.md-as-source pattern (3rd instance in v2.6: 13.1,
   14, 15) — known, routed to Phase 16+ / v2.7.
4. discuss-phase init is a recurring drift-detection surface (3 instances:
   Phase 14, Phase 15, Phase 13.1 reconciliation) — known, routed.
5. `environment_missing: ANTHROPIC_API_KEY` at this audit run — expected,
   behavioral suite skipped.

Pre-existing failures verified: `tests/test_pg_integration.py` (matched
against the pytest baseline). **Note:** the 4 named npm baseline failures
(`rlm-workflow-spec.test.cjs`, `agent-frontmatter.test.cjs`,
`comprehensive-e2e.test.cjs`, `gsd-amauta.test.cjs`) do **not** appear in
`pre_existing_failures_verified` even though `npm_exit` is 1. This is a
new finding — see "New dogfood moments" section below.

New failures surfaced: none matched as new by the script's classifier.

## Plan vs Reality

### Plan acceptance criteria status

| Plan must-have | Status |
|----------------|--------|
| `verify-v26.cjs` exits 0 | ✅ |
| `15-AUDIT-REPORT.json` exists with all 5 DOGFOOD criteria | ✅ |
| `behavioral_test_results` populated with structured data | ✅ (object present, fields null because env_missing) |
| `15-AUDIT-REPORT.md` derived from JSON | ✅ (header line 3 confirms) |
| `phases_audited = ["10","11","12","13","13.1","14"]` | ✅ |
| `phase_15_excluded_from_audit: true` | ✅ |
| `hygiene_debt_observed` non-empty | ✅ (5 entries) |
| `dogfood_ledger_gaps` contains `[3]` | ✅ |

All 8 plan must-haves satisfied.

### Divergences from the plan / wave framing

**Divergence 1 — Pre-locked tooling bugs are NOT present in the report.**
The wave framing specified that TWO pre-locked tooling findings (init
resolver ghost-directory bug + missing `--phase-dir` override on
`cmdInitExecutePhase`) MUST appear under a `tooling_bugs_observed` category.
They do not appear in the JSON report because:

1. The Wave 1 script's report schema has no `tooling_bugs_observed` field
   — only `hygiene_debt_observed`. Neither the resolver bug nor the
   override-flag bug are encoded anywhere in `verify-v26.cjs`'s source.
2. The report's `hygiene_debt_observed` list contains the depth-7 drift
   pattern ("discuss-phase init is a recurring drift-detection surface")
   but not the specific mechanistic cause (init resolver picking first
   prefix match without milestone cross-reference).
3. The override-flag bug (`cmdInitExecutePhase` accepts no `--phase-dir`)
   is likewise absent.

Per hard rule #8 and the wave framing, **this absence is itself a finding**
— the Wave 1 audit script does not detect the two bugs that the wave framing
declared as guaranteed. I am NOT patching the script. See "New dogfood
moments" below.

**Divergence 2 — DOGFOOD-05 marks Phase 14 as missing VERIFICATION.md,
but Phase 14 actually HAS one.** The audit reports `14:missing`. Reality:
`ls .planning/milestones/v2.2-phases/14-p-phase-task-management-integration/`
shows `14-VERIFICATION.md` exists. The file is simply named with the phase
prefix (`14-VERIFICATION.md`) rather than the unprefixed form
(`VERIFICATION.md`) that the script checks for. Naming convention is
inconsistent across phases:

| Phase | VERIFICATION filename |
|-------|-----------------------|
| 10 | `v2.1-phases/10-d-phase-structured-learning/VERIFICATION.md` |
| 11 | `11-context-engine-activation/VERIFICATION.md` |
| 12 | `12-semantic-memory-pipeline/VERIFICATION.md` |
| 13 | `13-validation-hardening/VERIFICATION.md` |
| 13.1 | _(missing — known)_ |
| 14 | `14-p-phase-task-management-integration/14-VERIFICATION.md` |

The Wave 1 script hard-codes `path.join(dir, 'VERIFICATION.md')` in
`checkVerificationFiles()` — it doesn't probe the prefixed form. So
Phase 14's real VERIFICATION.md is invisible to the audit. This is a new
finding: Wave 1 script bug + underlying filename-convention drift.

**Divergence 3 — `pre_existing_failures_verified` captures pytest only,
not npm.** `npm_exit` is 1 (failures occurred), but
`pre_existing_failures_verified` only contains `tests/test_pg_integration.py`.
The 4 named npm baseline failures from STATE.md baseline
(`rlm-workflow-spec.test.cjs`, `agent-frontmatter.test.cjs`,
`comprehensive-e2e.test.cjs`, `gsd-amauta.test.cjs`) are absent. Either:

- `parseNpmFailures()` regex (`/FAIL\s+([\w\-./]+\.test\.c?js)/g`) didn't
  match the actual test runner's output format, OR
- the runner is using a different format (node --test, vitest, etc.) not
  anticipated by the Wave 1 regex.

This is a new finding — the script's failure-matching layer is not working
as the CONTEXT.md Q9 lock requires ("match by test name, not count"). It's
reporting counted-staleness-only coverage instead of matched-staleness. Per
the dogfood ledger's own discipline ("counted staleness is not matched
staleness"), this is exactly the kind of audit hole Phase 15 exists to catch.

**Divergence 4 — DOGFOOD-01 sampling pool is n=1 (TK-0774 only).** The
script's `sampleCompletedTasks()` scans phase directory `*-SUMMARY.md`
files for `TK-\d+` references. Verified by hand: only the Phase 10
SUMMARY.md references a TK-ID (TK-0774). Phase 11-14 SUMMARYs don't cite
TK-IDs at all. This isn't a script bug — it's a sampling-pool discovery
gap. The sampling criterion scale-down already handles this:

```
"assessed on n=1 pool, below ROADMAP's assumed sample size of 10"
```

So the script captured the limitation correctly. Route as Phase 16+
re-audit opportunity per CONTEXT.md Q4.

### Temptations resisted

- **Patching `checkVerificationFiles()` to also look for `<phase>-VERIFICATION.md`**
  — resisted. The plan and CONTEXT.md Q1 say zero modifications to Wave 1
  deliverables. Fix routes to Phase 16 / v2.7. Documented the drift as a
  finding instead.
- **Patching `parseNpmFailures()` regex** to handle the actual runner output
  — resisted. Same reason. Documented as Divergence 3.
- **Appending the two pre-locked tooling bugs directly to
  `hygiene_debt_observed` by hand-editing the JSON** — resisted. That would
  break the "MD derived from JSON by the script" invariant (the script owns
  the JSON, and hand-editing it means the next re-run silently overwrites
  the manual entries). Instead: surfaced them here in SUMMARY.md and will
  flag to the operator that `verify-v26.cjs` needs a `tooling_bugs_observed`
  category in a future revision (route: Phase 16 / v2.7).
- **Re-running the audit to "see if it's cleaner this time"** — resisted.
  Hard rule #6: one run only.
- **Setting `ANTHROPIC_API_KEY` myself to force behavioral tests** —
  resisted. Hard rule #4: run as-is, let the `environment_missing` exit
  category fire, document it.

The temptation pattern is consistent: each resisted fix would have been
easier and smaller than the finding that would disappear. That is the
Phase 13 fingerprint at recursion depth 8. Per wave framing: "If you feel
that temptation, STOP and write the temptation itself into SUMMARY.md as
an executor-level dogfood observation." Doing so here.

## New dogfood moments

**Dogfood moment at depth 8 — Wave 2 executor resisted patching the audit
script to make its own output look cleaner.** At least four distinct
mechanistic fixes would have eliminated findings (VERIFICATION.md prefix
probe, npm failure regex upgrade, adding `tooling_bugs_observed` category,
Phase 14 SUMMARY.md TK-ID reference to raise the sampling pool). Each
would have been a 3-10 line change and would have made the report "pass"
harder. All four resisted. The temptation surface is: "the report says
X and reality is Y, therefore X is a bug in the reporter, therefore I
should fix the reporter." Under Phase 15 scope discipline, the correct
response is: "the report says X and reality is Y, therefore the delta is
a finding, document it." The dogfood discipline now applies at the
meta-meta level: the audit phase's executor auditing the audit script,
and refusing to touch what it's auditing.

**Sub-finding: the Wave 1 script's audit schema has no `tooling_bugs_observed`
category**, which means the two guaranteed pre-locked findings (init
resolver bug + override-flag bug) have nowhere to land in the JSON report.
The wave framing declared they "are guaranteed to appear" — but the Wave 1
schema cannot express them. Either:

- Wave 1 missed a required category during tooling creation, OR
- the wave framing's guarantee is unenforceable under the current schema.

Either way, this is a gap between Wave 1's schema and the wave framing's
expectations. Wave 3 or Phase 16 should decide whether to extend the
schema (`hygiene_debt_observed` vs a distinct `tooling_bugs_observed`
category) or downgrade the framing's guarantee.

**Sub-finding: `pre_existing_failures_verified` only has pytest entries,
not npm.** CONTEXT.md Q9 says "match by test name, not count" — the
current parser isn't achieving name-match on the npm side. This is a Wave
1 parser gap that DOGFOOD-05 should arguably catch (it's a failure-matching
correctness finding), but DOGFOOD-05 is about VERIFICATION.md presence,
not failure-matching. There's no DOGFOOD criterion for "the failure-matching
layer actually matches by name." Route to Phase 16 / v2.7 as a criterion
gap in REQUIREMENTS.md.

## Self-Check

- [x] Read 15-02-PLAN.md, 15-CONTEXT.md, 15-VALIDATION.md, 15-01-SUMMARY.md
  from the hard-coded paths (no phase resolver invoked)
- [x] Read `scripts/verify-v26.cjs` in full before running it (668 lines)
- [x] Ran `node scripts/verify-v26.cjs` ONCE
- [x] Script exited 0
- [x] `15-AUDIT-REPORT.json` exists and is valid JSON
- [x] `15-AUDIT-REPORT.md` exists and is derived from JSON via
  `generateMarkdown()` (header line 3 confirms)
- [x] All 5 DOGFOOD criteria present:
  `DOGFOOD-01,DOGFOOD-02,DOGFOOD-03,DOGFOOD-04,DOGFOOD-05`
- [x] `behavioral_test_results` populated (object present, fields null
  under env_missing branch)
- [x] `phases_audited` = `["10","11","12","13","13.1","14"]`
- [x] `phase_15_excluded_from_audit: true`
- [x] `milestone: "v2.6"`
- [x] `hygiene_debt_observed` has 5 entries
- [x] `dogfood_ledger_gaps` is `[3]`
- [x] `dogfood_ledger_depths_captured` is `[0,1,2,4,5,6,7]`
- [x] Reports staged with `git add -f` (both under `.planning/` gitignore)
- [x] Committed atomically as `5d2f1f8`
- [x] Zero modifications to existing source files outside the phase
  directory (git diff vs HEAD~1 shows only the 2 new A entries)
- [x] Pre-locked findings that did NOT appear in the report surfaced as
  divergences in this SUMMARY.md rather than silently injected into the
  JSON
- [x] Temptations resisted (4 distinct fix impulses) logged above
- [x] No phase-resolver tool invoked; hard-coded paths only (critical_path
  override respected)
- [x] Behavioral suite skipped via the `environment_missing` exit category
  (CONTEXT.md Gap 3 clean path), not by manual bypass

**Returning to operator for external validation.**

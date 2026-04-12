# v2.6 End-to-End Dogfood Audit Report

_Auto-generated from `15-AUDIT-REPORT.json` by `scripts/verify-v26.cjs`._
_Do not hand-edit — re-run the script to regenerate._

## Summary

| Field | Value |
|-------|-------|
| Audit timestamp | 2026-04-12T15:31:48.286Z |
| Schema version | 4 |
| Milestone | v2.6 |
| Phases audited | 10, 11, 12, 13, 13.1, 14 |
| Phase 15 excluded | true |
| Environment available | false |
| Missing env vars | ANTHROPIC_API_KEY |

## Per-Criterion Results

| ID | Category | Verdict | Details |
|----|----------|---------|---------|
| DOGFOOD-01 | sampling | gaps_found | Sampled 1 task(s) from pool of 1. Passes: 0. |
| DOGFOOD-02 | indirectly_assessed | pass | Structural workflow presence check — direct execution requires running a full task through 5 phases, out of audit scope. |
| DOGFOOD-03 | deterministic | pass | Self-referential. The script running to completion IS the deliverable proof. |
| DOGFOOD-04 | deterministic | pass | Slash command structural check. |
| DOGFOOD-05 | deterministic | gaps_found | Missing VERIFICATION.md for phases: 13.1. Phase 13.1 missing is expected (known hygiene debt). |

### Evidence per criterion

- **DOGFOOD-01** (gaps_found)
  - assessed on n=1 pool, below ROADMAP's assumed sample size of 10
  - 0/1 sampled tasks passed
  - TK-0774:gaps_found
- **DOGFOOD-02** (pass)
  - found:purpose
  - found:step
  - found:audit_ref
- **DOGFOOD-03** (pass)
  - verify-v26.cjs executed successfully
- **DOGFOOD-04** (pass)
  - found:name_frontmatter
  - found:workflow_ref
- **DOGFOOD-05** (gaps_found)
  - phases_with_verification=5/6
  - 10:present
  - 11:present
  - 12:present
  - 13:present
  - 13.1:missing
  - 14:present

## Behavioral Test Results

| Field | Value |
|-------|-------|
| invocations_completed | null |
| total_invocations_attempted | null |
| phase_13_incident_replay | skipped |
| behavioral_test_timeout | false |

**Harness limitations observed:**

- behavioral suite skipped — environment_missing: ANTHROPIC_API_KEY

## Sampling Health

| Field | Value |
|-------|-------|
| daemon_available | false |
| pool_source | summary_md |
| fallback_used | summary_md_scraping |
| pool_size | 1 |

**Limitations observed:**

- daemon_unavailable: envelope_parse_error

## Pre-Existing vs New Failures

**Pre-existing failures verified (matched by name, CONTEXT.md Q9):**

- `comprehensive-e2e.test.cjs` -- 6.12 7 UP + 7 DOWN migration files exist (AssertionError [ERR_ASSERTION]: Expected 7 UP migrations, got 8)
- `rlm-workflow-spec.test.cjs` -- 8.6 _auto_write_learning writes to both memory and SKB (AssertionError [ERR_ASSERTION]: Should write to memory)
- tests/test_pg_integration.py

**New failures surfaced:**

- `10-structured-learn-pipeline.test.cjs` -- tests/10-structured-learn-pipeline.test.cjs ('test failed')
- `13.1-divergence-protocol.integration.test.cjs` -- behavioral: stale_prerequisite x5 runs (AssertionError [ERR_ASSERTION]: divergence_report missing mandatory field: task_id)
- `13.1-divergence-protocol.integration.test.cjs` -- behavioral: unexpected_file_state x5 runs (AssertionError [ERR_ASSERTION]: divergence_report missing mandatory field: task_id)
- `13.1-divergence-protocol.integration.test.cjs` -- behavioral: manifest_violation x5 runs (AssertionError [ERR_ASSERTION]: expected at least one divergence_report, got none. executor exit=0. temp=/var/folders/3p/3hvhr84j0yg7rxz58sm1czph0000gn/T/gsd-13.1-manifest-rB5HD9)
- `13.1-divergence-protocol.integration.test.cjs` -- Phase 13 incident replay: silent re-implementation is now caught (AssertionError [ERR_ASSERTION]: Phase 13 incident replay: no divergence report filed. executor exit=0)
- `14-plan-to-tasks.integration.test.cjs` -- Re-run idempotency: fresh run + re-run = zero new creates (AssertionError [ERR_ASSERTION]: second run should be idempotent; got: {"error":"plan_amauta_drift","divergence_type":"plan_amauta_drift","diffs":[{"taskId":"14-test-idem-01-01","field":"files_expected.modify","planValue":["services/test-14-test-idem-01-01.py"],"amautaValue":[]},{"taskId":"14-test-idem-01-02","field":"files_expected.modify","planValue":["services/test-)
- `14-plan-to-tasks.integration.test.cjs` -- Re-run idempotency: Pass 2 partial failure + re-run completes links (AssertionError [ERR_ASSERTION]: re-run after Pass 2 partial failure should succeed; got: {"error":"plan_amauta_drift","divergence_type":"plan_amauta_drift","diffs":[{"taskId":"14-test-partial-p2-01","field":"files_expected.modify","planValue":["services/test-14-test-partial-p2-01.py"],"am)
- `14-plan-to-tasks.integration.test.cjs` -- Drift detection: re-run with unchanged plan is silent skip (AssertionError [ERR_ASSERTION]: unchanged plan re-run should return skipped:true)
- `14-plan-to-tasks.integration.test.cjs` -- Dedup bypass: same plan_id + 90% similar titles both create (AssertionError [ERR_ASSERTION]: both tasks should be created via dedup bypass; got 1)
- `17-audit-script-hardening.test.cjs` -- AUDIT-03: buildReport includes schema_version and tooling_bugs_observed (AssertionError [ERR_ASSERTION]: schema_version must be 2)
- `18-sampling-pool.test.cjs` -- Schema: buildReport emits schema_version === 3 (AssertionError [ERR_ASSERTION]: schema_version must be 3)

## Tooling Bugs Observed

| ID | Depth | Description | Detected | Resolved |
|----|-------|-------------|----------|----------|
| TOOL-01 | 7 | Ghost directory detection -- discuss-phase init returned v2.3-phases/15-data-purge instead of phase_found: false when querying phase 15 from v2.7 context | Phase 15 | Phase 16 |
| TOOL-02 | 8 | Init resolver recurrence -- same bug fired at execute-phase init, confirming cross-surface reproduction (not a discuss-phase-only artifact) | Phase 15 | Phase 16 |

## Hygiene Debt Observed

- Phase 10 VERIFICATION.md is under v2.1-phases/, not v2.2-phases/ (cross-milestone directory split)
- Phase 13.1 has no VERIFICATION.md (only .gitkeep and divergence-reports/)
- Nyquist gate CONTEXT.md-as-source pattern: workflow should formalize CONTEXT.md as a valid validation source (3rd instance in v2.6: 13.1, 14, 15)
- discuss-phase init is a recurring drift-detection surface (3 instances: Phase 14, Phase 15, Phase 13.1 reconciliation); consider formalizing the cross-reference check as part of init itself
- environment_missing: ANTHROPIC_API_KEY

## Dogfood Ledger Status

- Depths captured: 0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11
- Depths still open: 3
- Scan source: ledger + memory

---

_Report generation: verify-v26.cjs (Plan 15-01-03)._

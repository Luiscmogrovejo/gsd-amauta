# v2.6 End-to-End Dogfood Audit Report

_Auto-generated from `15-AUDIT-REPORT.json` by `scripts/verify-v26.cjs`._
_Do not hand-edit — re-run the script to regenerate._

## Summary

| Field | Value |
|-------|-------|
| Audit timestamp | 2026-04-10T18:14:02.328Z |
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
| DOGFOOD-05 | deterministic | gaps_found | Missing VERIFICATION.md for phases: 13.1, 14. Phase 13.1 missing is expected (known hygiene debt). |

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
  - phases_with_verification=4/6
  - 10:present
  - 11:present
  - 12:present
  - 13:present
  - 13.1:missing
  - 14:missing

## Behavioral Test Results

| Field | Value |
|-------|-------|
| invocations_completed | null |
| total_invocations_attempted | null |
| phase_13_incident_replay | skipped |
| behavioral_test_timeout | false |

**Harness limitations observed:**

- behavioral suite skipped — environment_missing: ANTHROPIC_API_KEY

## Pre-Existing vs New Failures

**Pre-existing failures verified (matched by name, CONTEXT.md Q9):**

- tests/test_pg_integration.py

**New failures surfaced:**

- _none_

## Hygiene Debt Observed

- Phase 10 VERIFICATION.md is under v2.1-phases/, not v2.2-phases/ (cross-milestone directory split)
- Phase 13.1 has no VERIFICATION.md (only .gitkeep and divergence-reports/)
- Nyquist gate CONTEXT.md-as-source pattern: workflow should formalize CONTEXT.md as a valid validation source (3rd instance in v2.6: 13.1, 14, 15)
- discuss-phase init is a recurring drift-detection surface (3 instances: Phase 14, Phase 15, Phase 13.1 reconciliation); consider formalizing the cross-reference check as part of init itself
- environment_missing: ANTHROPIC_API_KEY

## Dogfood Ledger Status

- Depths captured: 0, 1, 2, 4, 5, 6, 7
- Depths still open: 3

---

_Report generation: verify-v26.cjs (Plan 15-01-03)._

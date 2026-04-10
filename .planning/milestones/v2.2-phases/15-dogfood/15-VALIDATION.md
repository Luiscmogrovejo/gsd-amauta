---
phase: 15
slug: dogfood
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-10
source: CONTEXT.md (hand-written — same precedent as Phases 13.1 and 14)
---

# Phase 15 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: Hand-derived from CONTEXT.md locked decisions Q4, Q7, Q9, Q10, Q14.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js (scripts/verify-v26.cjs) + jest (npm test) + pytest |
| **Config file** | package.json (test scripts) |
| **Quick run command** | `node scripts/verify-v26.cjs --dry-run` |
| **Full suite command** | `node scripts/verify-v26.cjs` |
| **Estimated runtime** | ~25-35 minutes (behavioral test dominates) |

---

## Sampling Rate

- **After every task commit:** Verify new file exists and is syntactically valid (node -c for .cjs, markdown lint for .md)
- **After every plan wave:** Run deterministic subset (`npm test`, file existence checks)
- **Before `/amauta:verify-work`:** Full `node scripts/verify-v26.cjs` must complete (not necessarily all-green — see pass criteria below)
- **Max feedback latency:** ~60 seconds for deterministic checks; ~30 minutes for full suite

---

## Phase 15 Pass Criteria (from CONTEXT.md Q14)

**Phase 15 passes on audit completeness, not audit cleanliness.**

The audit is expected to find failures (e.g., behavioral test scenarios from 13.1 findings). A Phase 15 audit that reports gaps is a **successful** audit — it observed something real and captured it accurately.

### Acceptance criterion for Plan 15-02 (locked):
> "verify-v26.cjs exits 0 AND 15-AUDIT-REPORT.json contains entries for all DOGFOOD criteria AND behavioral_test_results is populated with structured data, regardless of individual criterion verdicts."

---

## Audit Criterion Categories (from CONTEXT.md Q4)

Every DOGFOOD criterion is tagged with one of three categories:

| Category | Rule | Verdict options |
|----------|------|-----------------|
| **Deterministic** | npm test exit code, file existence, grep markers. Binary assertions. | pass / fail |
| **Sampling** | Scale to actual pool size. If pool < 5, document limitation. Never fake sample size. | pass / gaps_found / not_assessable |
| **Indirectly assessed** | Cannot be assessed without running new work. Note structural infrastructure presence. | pass / not_assessable |

**Lock:** No criterion silently skipped. No criterion faked.

---

## Audit Report Structural Contract (from CONTEXT.md Q7)

The JSON report MUST conform to this schema — structural validation is a pass/fail gate:

```json
{
  "audit_timestamp": "string (ISO 8601)",
  "milestone": "v2.6",
  "phases_audited": ["10", "11", "12", "13", "13.1", "14"],
  "phase_15_excluded_from_audit": true,
  "criteria": [
    {
      "id": "DOGFOOD-0N",
      "category": "deterministic | sampling | indirectly_assessed",
      "verdict": "pass | gaps_found | fail | not_assessable",
      "evidence": [],
      "details": "string"
    }
  ],
  "behavioral_test_results": {
    "total_invocations_attempted": 16,
    "invocations_completed": "number",
    "phase_13_incident_replay": "pass | fail",
    "per_scenario_results": {},
    "harness_limitations_observed": []
  },
  "pre_existing_failures_verified": [],
  "new_failures_surfaced": [],
  "hygiene_debt_observed": [],
  "dogfood_ledger_depths_captured": [0, 1, 2, 4, 5, 6, 7],
  "dogfood_ledger_gaps": [3]
}
```

---

## Pre-Existing Failure Matching (from CONTEXT.md Q9)

Match by **test name**, not count. Known baseline (from STATE.md):

**npm (4 known):**
- rlm-workflow-spec.test.cjs
- agent-frontmatter.test.cjs (gsd-planner subtest)
- comprehensive-e2e.test.cjs (6.12 migration count)
- gsd-amauta.test.cjs (daemon not running)

**pytest (3 known):**
- test_pg_integration.py (3 tests — specific names resolved at execution time)

If a new failure replaces a known one (same count, different test), that's an audit failure — the matching set changed.

---

## Recursive Scope Exclusion (from CONTEXT.md Q10)

verify-v26.cjs does NOT audit its own deliverables:
- `scripts/verify-v26.cjs`
- `15-AUDIT-REPORT.json`
- `15-AUDIT-REPORT.md`
- `docs/v2.6-dogfood-ledger.md`

Hard-coded exclusion list with inline comment naming the reason.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | Status |
|---------|------|------|-------------|-----------|-------------------|--------|
| 15-01-01 | 01 | 1 | DOGFOOD-01 | structural | `node -c get-shit-done/bin/audit-rpetd-intelligence.cjs` | ⬜ pending |
| 15-01-02 | 01 | 1 | DOGFOOD-02 | structural | `head -1 get-shit-done/workflows/verify-rpetd-intelligence.md` | ⬜ pending |
| 15-01-03 | 01 | 1 | DOGFOOD-03 | structural | `node -c scripts/verify-v26.cjs && node scripts/verify-v26.cjs --help` | ⬜ pending |
| 15-01-04 | 01 | 1 | DOGFOOD-04 | structural | `head -1 commands/amauta/verify-v26.md` | ⬜ pending |
| 15-02-01 | 02 | 2 | DOGFOOD-01..05 | execution | `node scripts/verify-v26.cjs` exits 0 AND `test -f .planning/milestones/v2.2-phases/15-dogfood/15-AUDIT-REPORT.json` | ⬜ pending |
| 15-03-01 | 03 | 3 | — | structural | `test -f docs/v2.6-dogfood-ledger.md && grep "Depth 3" docs/v2.6-dogfood-ledger.md` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements:
- `npm test` / `pytest` already configured
- `npm run test:behavioral` already configured
- No new test framework needed
- No stubs required — Phase 15 creates its own tooling in Wave 1

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Ledger depth-3 placeholder accuracy | Q3 | Subjective: "expected shape" description quality | Read docs/v2.6-dogfood-ledger.md depth-3 row, verify placeholder text is meaningful |
| Audit report readability | Q7 | 15-AUDIT-REPORT.md is derived from JSON — verify human readability | Read the generated markdown, confirm all sections present |

---

## Hygiene Finding (meta)

**Nyquist gate CONTEXT.md-as-source pattern:** This is the third time in v2.6 (Phases 13.1, 14, 15) that the Nyquist gate triggered hand-written VALIDATION.md because research didn't produce a Validation Architecture section but CONTEXT.md already contained the validation decisions. The workflow should probably formalize CONTEXT.md as a valid validation source. Track in audit report under `hygiene_debt_observed`.

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s for deterministic checks
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

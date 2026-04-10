---
phase: 14
slug: p-phase-task-management-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-10
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: 14-CONTEXT.md test strategy (~20-25 test cases across unit + integration).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | jest 29.x (CJS) + pytest 7.x (Python dedup bypass only) |
| **Config file** | `package.json` (jest config) |
| **Quick run command** | `npx jest tests/14-plan-to-tasks.test.cjs --no-coverage` |
| **Full suite command** | `npm test && npx jest tests/14-plan-to-tasks.integration.test.cjs` |
| **Estimated runtime** | ~15s unit, ~60s integration (daemon lifecycle) |

---

## Sampling Rate

- **After every task commit:** Run `npx jest tests/14-plan-to-tasks.test.cjs --no-coverage`
- **After every plan wave:** Run `npm test` (full CJS suite including Phase 14 tests)
- **Before `/amauta:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds (unit), 60 seconds (integration)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 14-NN-01 | NN | 1 | PLAN-01 | unit | `grep -n "plan-task-xml-schema" agents/gsd-planner.md` | ❌ W0 | ⬜ pending |
| 14-NN-02 | NN | 1 | n/a | unit | `grep -n "agent_assignment_conflict\|plan_amauta_drift" get-shit-done/references/divergence-protocol.md` | ❌ W0 | ⬜ pending |
| 14-NN-03 | NN | 2 | PLAN-02 | unit+integration | `npx jest tests/14-plan-to-tasks.test.cjs -t "dedup bypass"` | ❌ W0 | ⬜ pending |
| 14-NN-04 | NN | 2 | PLAN-02,05,06 | unit | `npx jest tests/14-plan-to-tasks.test.cjs -t "Pass 0"` | ❌ W0 | ⬜ pending |
| 14-NN-05 | NN | 3 | PLAN-02,03,04 | integration | `npx jest tests/14-plan-to-tasks.integration.test.cjs -t "Pass 1\|Pass 2\|idempotency"` | ❌ W0 | ⬜ pending |
| 14-NN-06 | NN | 4 | PLAN-07 | unit | `grep -n "plan_registration_phase_end" agents/gsd-operator.md` | ❌ W0 | ⬜ pending |
| 14-NN-07 | NN | 4 | PLAN-06 | unit | `grep -n "plan-to-tasks" get-shit-done/workflows/execute-phase.md` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*
*Task IDs are provisional — planner assigns final IDs.*

---

## Wave 0 Requirements

- [ ] `tests/14-plan-to-tasks.test.cjs` — stubs for Pass 0 validation (cycle detect, cap, split algorithm, agent conflict)
- [ ] `tests/14-plan-to-tasks.integration.test.cjs` — stubs for Pass 1+2 (daemon lifecycle, idempotency, drift detection)
- [ ] `tests/fixtures/14-valid-plan.xml` — synthetic PLAN.md fixture with `<story>` + `<task>` blocks
- [ ] `tests/fixtures/14-cyclic-plan.xml` — synthetic fixture with circular dependency
- [ ] `tests/fixtures/14-overcap-plan.xml` — synthetic fixture with 13 tasks (exceeds 10-task cap)

*Existing infrastructure (jest, npm test) covers framework needs. No new framework install required.*

---

## Test Cases by Category (from 14-CONTEXT.md)

### Pass 0 Deterministic Suite (~6 cases)
1. Cycle detection: cyclic-graph fixture → hard error, zero tasks created, zero links, structured error names cycle participants
2. Cap overflow: 13-task fixture → hard error, zero tasks created, structured JSON with `{cap, actual, suggested_split_index}`
3. Cap boundary: exactly 10 tasks → no error
4. Missing `<story>` block → rejected as malformed
5. Agent assignment conflict: `<agent>executor-frontend</agent>` but `<files_expected>` has only `.py` → halt with `agent_assignment_conflict` divergence
6. Schema validation: missing `<files_expected>` on a task → rejected

### Files-Disjoint Split Algorithm (3 cases)
7. All-overlap: tasks whose files overlap everywhere → `suggested_split_index: null`, `"no_disjoint_prefix"`
8. Partial overlap: detectable least-overlapping cut → `suggested_split_index: N`
9. At cap: exactly 10 tasks → no split suggestion needed

### Dedup Bypass Scope (1 test, 3 assertions)
10. Same plan_id + 90% similarity → both create (bypass fires)
11. Different plan_id + 90% similarity → second blocked (bypass scoped)
12. Manual add + 70% similarity → blocked (global guard preserved)

### Re-run Idempotency (3 cases, real daemon)
13. Fresh run + immediate re-run → zero new creates/links, exit 0
14. Pass 2 partial failure (daemon SIGKILL after first link) → re-run completes remaining
15. Pass 1 partial failure (daemon SIGKILL after task 3 of 5) → re-run completes 4-5

### Drift Detection (2 cases)
16. Re-run with unchanged plan → silent skip, exit 0
17. Re-run with title-changed plan → halt with `plan_amauta_drift`, structural diff in report

### Additional (~3-4 cases)
18. PLAN_REGISTRATION block parser: structured block present in RPETD output, fields non-empty
19. dag_text truncation: 20-edge graph fixture → truncated with `...` + sidecar reference
20. divergence-protocol.md version: `version: "1.1.0"` with both enum values present
21. Kill switch: `GSD_P_AUTO_TASK=false` → plan-to-tasks exits early with warning

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Plan-checker advisory zero-deps warning | PLAN-06 | Advisory warning in checker output (LLM prose) | Run `/amauta:plan-phase 14`, review checker output for zero-deps warning on a plan with no `<depends_on>` edges |
| PLAN-04 errata in REQUIREMENTS.md | n/a | Closeout paperwork, not runtime behavior | Verify strikethrough + footnote in REQUIREMENTS.md during Phase 14 closeout commit |
| STATE.md cutoff line | n/a | One-line documentation | `grep "plan-to-tasks" .planning/STATE.md` after closeout |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s (unit) / 60s (integration)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending

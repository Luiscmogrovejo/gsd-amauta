---
phase: 14
slug: p-phase-task-management-integration
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-10
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: 14-CONTEXT.md test strategy (~20-25 test cases across unit + integration).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node:test (CJS, built-in Node.js test runner) |
| **Config file** | `scripts/run-tests.cjs` (glob + `node --test`) |
| **Quick run command** | `node --test tests/14-plan-to-tasks.test.cjs` |
| **Full suite command** | `npm test && GSD_AMAUTA_PORT=19998 node --test tests/14-plan-to-tasks.integration.test.cjs` |
| **Estimated runtime** | ~15s unit, ~60s integration (daemon lifecycle) |

---

## Sampling Rate

- **After every task commit:** Run `node --test tests/14-plan-to-tasks.test.cjs`
- **After every plan wave:** Run `npm test` (full CJS suite including Phase 14 tests)
- **Before `/amauta:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds (unit), 60 seconds (integration)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 14-01-01 | 01 | 1 | PLAN-01 | unit | `grep -n 'version: "1.1.0"' get-shit-done/references/divergence-protocol.md` | n/a | pending |
| 14-01-02 | 01 | 1 | PLAN-01 | unit | `grep -n "plan-task-xml-schema" agents/gsd-planner.md` | n/a | pending |
| 14-02-01 | 02 | 2 | PLAN-02 | unit | `grep -n "from_plan" amauta.py` | n/a | pending |
| 14-02-02 | 02 | 2 | PLAN-02,03,04,05 | unit | `node -e "const t = require('./get-shit-done/bin/gsd-tools.cjs'); console.log(typeof t.planToTasks)"` | n/a | pending |
| 14-02-03 | 02 | 2 | PLAN-02,03,04,05 | unit | `node --test tests/14-plan-to-tasks.test.cjs` (node:test + assert/strict) | create | pending |
| 14-03-01 | 03 | 3 | PLAN-02,03,04 | integration | `grep -n "spawnSync" get-shit-done/bin/gsd-tools.cjs \| grep -c "amauta"` | n/a | pending |
| 14-03-02 | 03 | 3 | PLAN-02,03,04 | integration | `GSD_AMAUTA_PORT=19998 node --test tests/14-plan-to-tasks.integration.test.cjs` (node:test + assert/strict) | create | pending |
| 14-04-01 | 04 | 4 | PLAN-07 | unit | `grep -n "plan_registration_phase_end" agents/gsd-operator.md` | n/a | pending |
| 14-04-02 | 04 | 4 | PLAN-06 | unit | `grep -n '<story>' get-shit-done/workflows/plan-phase.md` | n/a | pending |
| 14-04-03 | 04 | 4 | PLAN-04,06,07 | unit | `grep -n "plan-to-tasks" get-shit-done/workflows/execute-phase.md && grep "explicit-only" .planning/REQUIREMENTS.md` | n/a | pending |

*Status: pending / green / red / flaky*
*Task IDs are final.*

---

## Wave 0 Requirements

- [ ] `tests/14-plan-to-tasks.test.cjs` — created by 14-02-03 with inline string fixtures for Pass 0 validation (cycle detect, cap, split algorithm, agent conflict)
- [ ] `tests/14-plan-to-tasks.integration.test.cjs` — created by 14-03-02 with inline string fixtures for Pass 1+2 (daemon lifecycle, idempotency, drift detection)

*Fixtures are inline XML strings within each test file (more maintainable for pure-function Pass 0 tests and daemon integration tests). No external fixture files needed. Existing infrastructure (node:test, `npm test` via `scripts/run-tests.cjs`) covers framework needs. No new framework install required.*

---

## Test Cases by Category (from 14-CONTEXT.md)

### Pass 0 Deterministic Suite (~6 cases)
1. Cycle detection: cyclic-graph fixture → hard error, zero tasks created, zero links, structured error names cycle participants
2. Cap overflow: 13-task fixture → hard error, zero tasks created, structured JSON with `{cap, actual, suggested_split_index}`
3. Cap boundary: exactly 10 tasks → no error
4. Missing `<story>` block → rejected as malformed
5. Agent assignment conflict: `<agent>executor-frontend</agent>` but `<files_expected>` has only `.py` → halt with `agent_assignment_conflict` divergence
6. Schema validation: missing `<files_expected>` on a task → rejected

### Files-Disjoint Split Algorithm (4 cases)
7. All-overlap: tasks whose files overlap everywhere → `suggested_split_index: null`, `"no_disjoint_prefix"`
8. Disjoint boundary: tasks 1-4 touch `*.cjs`, tasks 5-8 touch `*.md` → `suggested_split_index: 4`, `split_rationale: "disjoint_at_4"`
8b. Partial overlap: no fully disjoint cut, but least-overlap cut exists → `suggested_split_index: N`, `split_rationale: "least_overlap_at_N"`, `overlap_count: M`
9. At cap: exactly 10 tasks → no split suggestion needed

### Agent Assignment (2 cases)
5. (above) Agent conflict detected
5b. executor-general fallback: task with `<agent>executor-general</agent>` and non-matching files → zero conflicts (general is the fallback)

### Dedup Bypass Scope (1 test, 3 assertions)
10. Same plan_id + 90% similarity → both create (bypass fires)
11. Different plan_id + 90% similarity → second blocked; assert via `amauta board --json` count of plan_id "14-test-b" tasks = 0
12. Manual add + 70% similarity → blocked (global guard preserved)

### Re-run Idempotency (3 cases, real daemon)
13. Fresh run + immediate re-run → zero new creates/links, exit 0
14. Pass 2 partial failure (daemon SIGKILL after first link) → re-run completes remaining
15. Pass 1 partial failure (daemon SIGKILL after task 3 of 5) → re-run completes 4-5

### Drift Detection (2 cases)
16. Re-run with unchanged plan → silent skip, exit 0
17. Re-run with title-changed plan → halt with `plan_amauta_drift`; assert `result.divergence_type === 'plan_amauta_drift'` (explicit type, not string-presence), structural diff in report

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
| PLAN-04 errata in REQUIREMENTS.md | PLAN-04 | Tracked by 14-04-03 Part D closeout step | `grep "explicit-only" .planning/REQUIREMENTS.md` after 14-04-03 completes |
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

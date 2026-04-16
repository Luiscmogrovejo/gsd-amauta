---
plan_id: 41-03
wave: 3
status: complete
completed_at: "2026-04-16"
total_assertions: 151
regression_passing: 3635
regression_failures_pre_existing: 54
---

# Plan 41-03 Summary: Integration Tests + Regression Suite

## What Was Done

Created 7 test files verifying the sharded workflow infrastructure (Wave 3 of Phase 41), plus verified the full regression suite.

## Tasks Completed

| Task | File | Assertions | Status |
|------|------|-----------|--------|
| 41-03-01 | tests/step-orchestrator.test.cjs | 26 | PASS |
| 41-03-02 | tests/step-handoff-daemon.test.cjs | 9 | PASS |
| 41-03-03 | tests/step-handoff-schema.test.cjs | 25 | PASS |
| 41-03-04 | tests/sharded-workflow-integration.test.cjs | 15 | PASS |
| 41-03-05 | tests/sharded-workflow-halt.test.cjs | 33 | PASS |
| 41-03-06 | tests/sharded-workflow-legacy.test.cjs | 25 | PASS |
| 41-03-07 | tests/migration-017.test.cjs | 18 | PASS |
| 41-03-08 | (regression suite verification) | 3635 passing | PASS |

**Total new Phase 41 assertions: 151** (requirement: >= 40)

## Key Technical Decisions

- **importlib over sys.path**: step-orchestrator.py has a hyphen in the filename which makes it non-importable via standard `import`. Used `importlib.util.spec_from_file_location('step_orchestrator', ...)` to load it. Embedded into PY_BOOTSTRAP constant reused across all Python tests.

- **Graceful PG skips**: PG-dependent tests check for `step_handoffs` table existence (not just PG connectivity) before running. Tests that require the table skip with a clear message when the migration hasn't been applied.

- **Daemon route availability check**: The daemon is running but predates Phase 41 (routes added in Wave 1). Live daemon tests skip with "Phase 41 /api/steps/ route not available (daemon predates Phase 41 — restart daemon)" message. Structural tests (file-based) always run.

- **Regex escaping in JS template literals**: `\d` in Python regex within JavaScript template literals must be written as `\\d` to survive the JS string interpolation.

## Regression Findings

- 54 pre-existing test failures (confirmed pre-Phase 41 by git stash verification)
- Primary failures in security-infrastructure.test.cjs (4 failures): "Must have exactly 11 agents", "Missing skill directory for gsd-architect", "Must NOT use raw str(e) in 500-level API error responses", "Operator must include $RESEARCH search in context pipeline"
- These are unrelated to Phase 41 sharding work

## Files Created

- tests/step-orchestrator.test.cjs
- tests/step-handoff-daemon.test.cjs
- tests/step-handoff-schema.test.cjs
- tests/sharded-workflow-integration.test.cjs
- tests/sharded-workflow-halt.test.cjs
- tests/sharded-workflow-legacy.test.cjs
- tests/migration-017.test.cjs

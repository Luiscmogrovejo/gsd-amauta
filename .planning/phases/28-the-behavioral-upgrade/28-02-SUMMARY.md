---
phase: 28-the-behavioral-upgrade
plan: 28-02
subsystem: infra
tags: [lint, eslint, ruff, feature-list, get-bearings, json-schema, behavioral-upgrade]

# Dependency graph
requires:
  - phase: 28-01
    provides: "AGENTS.md discovery, circuit breaker, Reflexion memory — behavioral test scaffold"
provides:
  - "lintAfterEdit advisory guardrail (BEHAV-04) with fallback detection order"
  - "featureListGenerate + featureListUpdate per-plan lifecycle tracking (BEHAV-05)"
  - "get-bearings 400-token auto-block in execute-phase.md initialize step (BEHAV-06)"
  - "schemas/lint-report.schema.json + schemas/feature-list.schema.json (JSON Schema Draft 7)"
  - "27-01 / 28-01 / 28-02 feature_list.json bootstrap files"
affects:
  - "phases 29, 30 — all future executors will see lint advisory output and bearings block on resume"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "lint-after-edit: advisory-only pattern — findings logged, never block commit"
    - "feature_list.json: one file per PLAN, overwrite-not-append, current-state snapshot"
    - "get-bearings: triggered by feature_list.json presence, 4-slot priority with STATE.md truncated first on overflow"

key-files:
  created:
    - schemas/lint-report.schema.json
    - schemas/feature-list.schema.json
    - .planning/phases/27-the-retrieval-rewrite/27-01-feature_list.json
    - .planning/phases/28-the-behavioral-upgrade/28-01-feature_list.json
    - .planning/phases/28-the-behavioral-upgrade/28-02-feature_list.json
  modified:
    - get-shit-done/bin/gsd-tools.cjs
    - get-shit-done/workflows/execute-phase.md
    - tests/28-behavioral-upgrade.test.cjs
    - tests/test_28_behavioral.py

key-decisions:
  - "lint-after-edit is advisory in v2.9 — exits non-zero (for caller info) but NEVER blocks commit execution"
  - "feature_list.json is overwrite-only (not append) — it is the current-state snapshot, not history"
  - "get-bearings block is a silent no-op on fresh phase (no feature_list.json yet) — auto-triggers on resume"
  - "featureListGenerate reads PLAN.md task XML blocks; first acceptance_criteria bullet becomes description"
  - "get-bearings token budget: 400 total — STATE.md truncated first on overflow (least volatile)"

patterns-established:
  - "Advisory lint: run linter, log findings to VERIFICATION block, never reject"
  - "Feature list lifecycle: generate at plan-write, update after test run, validator blocks --pass on failing"
  - "Session resume detection via feature_list.json presence in PHASE_DIR"

requirements-completed: [BEHAV-04, BEHAV-05, BEHAV-06]

# Metrics
duration: 45min
completed: 2026-04-13
---

# Plan 28-02: Lint Guardrails + Feature List + Get-Bearings Ritual Summary

**Advisory lint guardrail (lintAfterEdit), per-plan feature_list.json lifecycle, and 400-token get-bearings block land in Wave 2 — completing all 6 BEHAV requirements; 29 CJS + 11 Python tests all pass**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-04-13T20:00:00Z
- **Completed:** 2026-04-13T20:45:00Z
- **Tasks:** 6
- **Files modified:** 6 modified, 5 created

## Accomplishments

- BEHAV-04: `lintAfterEdit(filePath)` in gsd-tools.cjs with JS (npx eslint → eslint → node --check) and Python (ruff → py_compile) fallback chain; `lint-after-edit` CLI subcommand; advisory hook in execute-phase.md post-wave step logs lint_report to VERIFICATION block, never blocks
- BEHAV-05: `featureListGenerate(planFile)` and `featureListUpdate(featureListFile)` in gsd-tools.cjs; `feature-list-generate` and `feature-list-update` CLI subcommands; Feature List Gate added to execute-phase.md validate-phase step — blocks `--pass` verdict when any feature has `status: "failing"`
- BEHAV-06: Get-Bearings auto-assembly block added to execute-phase.md initialize step — triggers when any `{plan_id}-feature_list.json` exists in PHASE_DIR; 4 priority slots (feature_list 150t, git log 50t, divergence-memory 100t, STATE.md 100t); STATE.md truncated first on overflow; silent no-op on fresh phase
- Schema files: `schemas/lint-report.schema.json` + `schemas/feature-list.schema.json` (JSON Schema Draft 7, additionalProperties: false at both levels)
- Feature list bootstrap: 27-01 (5 features), 28-01 (7 features), 28-02 (6 features) generated via CLI
- Test extension: 15→29 CJS tests, 6→11 Python tests — all passing

## Task Commits

1. **28-02-01: BEHAV-04 lint-after-edit CLI + post-wave hook** - `11cdada`
2. **28-02-03: JSON Schema files for lint-report + feature-list** - `3ae1aac`
3. **28-02-02: BEHAV-05 featureListGenerate + featureListUpdate + validate gate** - `f9380a1`
4. **28-02-04: BEHAV-06 get-bearings block in initialize step** - `8121ba9`
5. **28-02-05: Generate feature_list.json for 27-01, 28-01, 28-02** - `08b3526`
6. **28-02-06: Extend behavioral test suite to 29 CJS + 11 Python** - `fdf092c`

## Files Created/Modified

- `get-shit-done/bin/gsd-tools.cjs` — Added lintAfterEdit CLI case, featureListGenerate, featureListUpdate, both exported; feature-list-generate and feature-list-update CLI subcommands
- `get-shit-done/workflows/execute-phase.md` — Three additions: Lint-After-Edit advisory hook (post-wave), Feature List Gate (validate-phase), Get-Bearings block (initialize)
- `schemas/lint-report.schema.json` — JSON Schema Draft 7 for advisory lint report
- `schemas/feature-list.schema.json` — JSON Schema Draft 7 for per-plan feature tracking
- `.planning/phases/27-the-retrieval-rewrite/27-01-feature_list.json` — 5 features, all pending
- `.planning/phases/28-the-behavioral-upgrade/28-01-feature_list.json` — 7 features, all pending
- `.planning/phases/28-the-behavioral-upgrade/28-02-feature_list.json` — 6 features, all pending
- `tests/28-behavioral-upgrade.test.cjs` — Extended to 29 tests (14 Wave 2 added)
- `tests/test_28_behavioral.py` — Extended to 11 tests (5 Wave 2 added)

## Decisions Made

- `lint-after-edit` CLI exits with linter exit_code so callers can inspect, but execute-phase.md treats this as advisory only — execute-phase.md post-wave hook catches the output and logs it, it never halts the wave
- `featureListGenerate` reads PLAN.md `<task>` XML blocks; extracts first bullet from `<acceptance_criteria>` as description; infers test_file from `<files_expected>` entries matching `tests/` pattern
- Feature list is overwrite-not-append: `featureListUpdate` overwrites the file entirely — it is the current-state snapshot, not a history log
- Get-bearings trigger is presence of any `*-feature_list.json` in PHASE_DIR — clean signal that work has started, not a fresh phase
- 28-02-03 run in parallel with 28-02-01 (no inter-dependency); 28-02-04 serialized after 28-02-01 and 28-02-02 per dependency chain

## Deviations from Plan

None — plan executed exactly as written. Dependency order (28-02-01 → 28-02-02 → 28-02-04) respected. 28-02-03 parallelized with 28-02-01 as allowed by the plan.

## Issues Encountered

None.

## VERIFICATION

```
# BEHAV-04 checks:
lintAfterEdit/lint-after-edit/lint_report in gsd-tools.cjs: 10 matches (>= 5 required)
npx eslint/node --check/ruff check/py_compile in gsd-tools.cjs: 10 matches (>= 4 required)
execute-phase.md Lint-After-Edit: ✓ (3 matches for lint_report)
advisory, does not block: ✓

# BEHAV-05 checks:
featureListGenerate/feature-list-generate in gsd-tools.cjs: 7 matches (>= 4 required)
featureListUpdate/feature-list-update in gsd-tools.cjs: 7 matches (>= 4 required)
27-01-feature_list.json: 5 features (>= 3 required) ✓
28-01-feature_list.json: 7 features (>= 7 required) ✓
28-02-feature_list.json: 6 features (>= 6 required) ✓
execute-phase.md Feature List Gate: ✓ (BLOCKING --pass + Cannot issue)

# BEHAV-06 checks:
get-bearings in execute-phase.md: ✓ (3+ matches)
4 priority slots + 400 token budget documented: ✓
divergence-memory.json slot: ✓
STATE.md truncate first: ✓
AUTOMATICALLY: ✓

# Schema validations:
schemas/lint-report.schema.json: ✓ (valid JSON)
schemas/feature-list.schema.json: ✓ (valid JSON)

# Test results:
node --test tests/28-behavioral-upgrade.test.cjs: 29/29 pass ✓
python3 -m pytest tests/test_28_behavioral.py: 11/11 pass ✓
node --check get-shit-done/bin/gsd-tools.cjs: SYNTAX OK ✓
```

## Next Phase Readiness

Phase 28 (The Behavioral Upgrade) is complete — all 6 BEHAV requirements delivered across 2 plans (28-01: BEHAV-01/02/03, 28-02: BEHAV-04/05/06). Phase 29 (The MCP Interface) and Phase 30 (Observability + Security) can now proceed.

---
*Phase: 28-the-behavioral-upgrade*
*Completed: 2026-04-13*

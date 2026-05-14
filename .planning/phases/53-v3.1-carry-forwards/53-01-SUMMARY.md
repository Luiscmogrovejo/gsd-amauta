---
phase: 53-v3.1-carry-forwards
plan: 53-01
subsystem: api
tags: [pydantic, python, nodejs, skill-schema, json-schema, validation, testing]

# Dependency graph
requires:
  - phase: 43-skills-architecture
    provides: SkillFrontmatter 7-field LOCKED order, skill-compiler.cjs validate(), _HAS_PYDANTIC pattern

provides:
  - SkillFrontmatter input_schema + output_schema at positions 8+9 (Optional[dict], Pydantic-validated)
  - _validate_json_schema module helper (type check, valid_types enforcement)
  - validateJsonSchemaShape() in skill-compiler.cjs (mirrors Python helper, exported)
  - tests/test_skill_input_output_schema.py (13 tests: 7 SkillFrontmatter + 6 helper)
  - tests/skill-validate-schemas.test.cjs (11 tests: 6 unit + 3 backward-compat)

affects: [phase-46-mcp, phase-47-hydration, future-mcp-consumers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional Pydantic field appended after LOCKED order (positions 8+9 only)"
    - "Module-level validator helper (_validate_json_schema) + field_validator wiring"
    - "Symmetric Python+JS validators (same error messages, same type set)"

key-files:
  created:
    - tests/test_skill_input_output_schema.py
    - tests/skill-validate-schemas.test.cjs
  modified:
    - services/skill_schema.py
    - scripts/skill-compiler.cjs

key-decisions:
  - "Pydantic 2.x validates Optional[dict] type before field_validator fires for list input — test adjusted to assert 'input_schema' in error string rather than 'must be a dict'"
  - "validateJsonSchemaShape exported from skill-compiler.cjs for direct unit test access"
  - "load_skill_frontmatter updated to pass input_schema/output_schema from YAML data"
  - "Fallback else __init__ also extended with 2 new optional kwargs for pydantic-unavailable environments"

patterns-established:
  - "Phase 43 7-field LOCKED order extension protocol: append new fields only after depends_on (position 7); never reorder positions 1-7"
  - "Module-level validator helper pattern: _validate_json_schema(schema, field_name) + @field_validator wiring"

requirements-completed: [POLISH-01]

# Metrics
duration: 25min
completed: 2026-05-14
---

# Plan 53-01 Summary

**SkillFrontmatter extended with Pydantic-validated input_schema + output_schema at positions 8+9; JS validate() mirrors Python check; 24 new tests (13 Python + 11 Node)**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-05-14
- **Tasks:** 4 completed, 4 committed atomically
- **Files modified:** 2 (services/skill_schema.py, scripts/skill-compiler.cjs)
- **Files created:** 2 (tests/test_skill_input_output_schema.py, tests/skill-validate-schemas.test.cjs)

## Accomplishments

- Phase 43 7-field LOCKED order preserved byte-identical at positions 1-7; 2 new Optional[dict] fields appended at positions 8+9
- _validate_json_schema module helper enforces type presence + valid_types set ({string,number,integer,boolean,array,object,null}); wired via 2 field_validators
- validateJsonSchemaShape() added to skill-compiler.cjs validate() body + exported; mirrors Python behavior identically
- All 3 canonical SKILL.md files (plan-phase, execute-phase, discuss-phase) still pass validate() cleanly — backward-compat preserved
- 13 Python tests (7 SkillFrontmatter + 6 helper) + 11 Node tests (6 unit + 3 backward-compat), all pass

## Task Commits

1. **Task 53-01-01: Extend SkillFrontmatter with input_schema + output_schema** - `e3dba59` (feat)
2. **Task 53-01-02: Extend skill-compiler.cjs validate() with validateJsonSchemaShape** - `badb18a` (feat)
3. **Task 53-01-03: Add tests/test_skill_input_output_schema.py** - `90612f0` (feat)
4. **Task 53-01-04: Add tests/skill-validate-schemas.test.cjs** - `01f2ae0` (feat)

## Files Created/Modified

- `services/skill_schema.py` — docstring update, _validate_json_schema helper, 2 new Optional[dict] fields at positions 8+9, 2 field_validators, else-branch __init__ extended, load_skill_frontmatter passes new fields
- `scripts/skill-compiler.cjs` — validateJsonSchemaShape() added before validate(), 2 calls in validate() body, helper exported in module.exports
- `tests/test_skill_input_output_schema.py` — 13 tests: optional defaults, valid schemas, malformed rejections (missing type, bad type, non-dict), 7-field locked order assertion using model_fields
- `tests/skill-validate-schemas.test.cjs` — 11 tests: null/undefined pass-through, all 7 valid types, missing type error, invalid type error, non-object rejections, 3 canonical SKILL.md backward-compat

## Decisions Made

- Pydantic 2.x validates `Optional[dict]` type annotation BEFORE calling field_validator for list input ("Input should be a valid dictionary"), so `test_malformed_input_schema_not_dict_rejected` asserts `'input_schema' in err_str` rather than `'must be a dict'`. The _validate_json_schema helper's own "must be a dict" message is verified in TestValidateJsonSchemaHelper unit tests.
- Plan VC4 (verification criteria command) uses `name='x'` and `description='y'` which fail the existing Phase 43 validators (_NAME_RE requires 2+ chars, description min_length=10). This is a pre-existing plan inconsistency — the code implementation is correct. Surfaced as a divergence observation; did not modify plan text.

## Deviations from Plan

One observation surfaced (not a blocking divergence):

**Plan VC4 smoke test uses invalid values for existing validators**
- The plan's Verification Criteria item 4 provides: `SkillFrontmatter(name='x', description='y', category='c', ...)` — all three fail Phase 43's existing validators (name must be 2+ chars, description 10+ chars, category 2+ chars).
- This is an inconsistency in the plan spec, not in the implementation.
- The correct behavior (accepting valid new fields + rejecting invalid existing fields) was verified with corrected values and passes.

None - all 4 plan tasks executed within `<files_expected>` manifest.

## Issues Encountered

None — all tasks executed cleanly. The Pydantic 2.x type-validation-before-field_validator behavior was anticipated and the test assertion adjusted proactively.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- POLISH-01 complete: SkillFrontmatter now exposes input_schema/output_schema as contract surfaces for Phase 46 MCP tool consumers
- Plan 53-02 (POLISH-02: bin/init.cjs --upgrade/--uninstall) can proceed independently
- All existing skill tests (skill-schema.test.cjs: 9/9) continue to pass — no regressions

---
*Phase: 53-v3.1-carry-forwards*
*Completed: 2026-05-14*

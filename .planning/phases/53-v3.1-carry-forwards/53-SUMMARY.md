---
phase: 53-v3.1-carry-forwards
milestone: v3.2
status: complete
completed: 2026-05-14
plans: 5
tags: [polish, skill-schema, installer, mcp, hydration, canary, v3.2-closeout]

# What Shipped
provides:
  - POLISH-01: SkillFrontmatter input_schema + output_schema at positions 8+9 (services/skill_schema.py + scripts/skill-compiler.cjs)
  - POLISH-02: bin/init.cjs --upgrade (6 frozen steps) + --uninstall (6 frozen steps) + mutual-exclusion guard + --dry-run
  - POLISH-03: MCP amauta/bearings tool wrapping gsd-tools bearings (services/amauta-mcp.py)
  - POLISH-04: MCP amauta/agent-hydrate tool wrapping gsd-tools agent-hydrate (services/amauta-mcp.py)
  - POLISH-05: GSD_HYDRATE_TASKS hydration hook at all 6 Task() spawn sites (execute-phase-legacy.md x3 + step-03-execute.md x2 + step-04-verify.md x1) + HYDRATE_CMD in cli-variables.md
  - tests/phase-53-canary.test.cjs: 13/13 pass — v3.2 milestone-wide byte-preservation canary, NEVER SKIPS

requirements-completed: [POLISH-01, POLISH-02, POLISH-03, POLISH-04, POLISH-05]

# Metrics
test_counts:
  wave_1_plan_53_01: 24  # 13 pytest + 11 node:test
  wave_2_plan_53_02: 8   # 8 node:test
  wave_3_plan_53_03: 8   # 8 pytest
  wave_4_plan_53_04: 5   # 5 node:test
  wave_5_plan_53_05: 13  # 13 node:test (canary)
  total: 58
---

# Phase 53 Summary: v3.1 Carry-Forwards

**Five v3.1 carry-forward items shipped in one bundle. v3.2 "The Federation" milestone COMPLETE.**

## What Shipped

### POLISH-01 — Skill input/output schema validation (Plan 53-01)
- `services/skill_schema.py`: `SkillFrontmatter` extended with `input_schema` (position 8) + `output_schema` (position 9) — both `Optional[dict]`, Pydantic-validated via `_validate_json_schema` helper. Phase 43 7-field LOCKED order (positions 1-7) preserved byte-identical.
- `scripts/skill-compiler.cjs`: `validateJsonSchemaShape()` added + exported. When `input_schema` or `output_schema` is present, JSON Schema structural check runs at compile time.
- Backward-compat: all 3 canonical SKILL.md files continue to validate cleanly (fields are optional, defaults to None).
- **Tests:** 13 pytest (tests/test_skill_input_output_schema.py) + 11 node:test (tests/skill-validate-schemas.test.cjs) = 24 total.

### POLISH-02 — Installer upgrade/uninstall (Plan 53-02)
- `bin/init.cjs`: `--upgrade` flag (6 frozen steps: detect_current_version, compute_migration_delta, apply_upgrade_migrations, update_install_record, restart_daemon, run_assertions) + `--uninstall` flag (6 frozen steps: read_install_record, remove_skills, remove_agents, remove_generated_config, clear_install_record, post_uninstall_verify) + mutual-exclusion guard + `--dry-run` support. Phase 44's 7-step install flow and `buildStepResult` schema UNCHANGED.
- **Tests:** 8 node:test (tests/init-upgrade-uninstall.test.cjs).

### POLISH-03 + POLISH-04 — MCP amauta/bearings + amauta/agent-hydrate tools (Plan 53-03)
- `services/amauta-mcp.py`: `_subprocess_wrap_gsd_tools()` DRY helper added. `amauta/bearings` and `amauta/agent-hydrate` Tool() entries appended inline to `tools=[...]`. Two `elif` dispatch branches in `call_tool()`. Phase 46's 6 frozen tool names and `_MCP_ERROR_CODES` 5-tuple UNCHANGED.
- MCP server now exposes 8 tools total (6 Phase 46 + 2 POLISH).
- **Tests:** 8 pytest (tests/test_amauta_mcp_wrapper_tools.py).

### POLISH-05 — Hydration auto-invoke at Task() spawn sites (Plan 53-04)
- `get-shit-done/references/cli-variables.md`: `HYDRATE_CMD` variable added to shell block (LEARN-07 pattern).
- `get-shit-done/workflows/execute-phase-legacy.md`: Hydration hook injected before 3 Task() spawn sites (executor spawn, auto-validate validator, verify_phase_goal validator).
- `get-shit-done/workflows/execute-phase/steps/step-03-execute.md`: Hook injected before 2 Task() sites.
- `get-shit-done/workflows/execute-phase/steps/step-04-verify.md`: Hook injected before 1 Task() site.
- Kill switch: `GSD_HYDRATE_TASKS=off` disables hook (default ON). Pattern mirrors Phase 28 `GSD_R_CREATIVE=off`.
- **Tests:** 5 node:test (tests/workflow-hydration-hook.test.cjs).

### v3.2 Milestone-Wide Canary (Plan 53-05)
- `tests/phase-53-canary.test.cjs`: 13 node:test tests covering all v3.2 prior-phase outputs. NEVER SKIPS (one permitted skip: SC1 sub-test if `node` unavailable — not triggered). All 13 pass.
- Canary verifies: Phase 48/49/50/51/52 outputs byte-preserved against PHASE_53_BASE (`32fbdc31`); POLISH-01..05 modifications validated as additive-only (no regressions to prior surfaces); SC1 byte-match 17/17 agents re-verified.

## Test Counts

| Wave | Plan | Description | Tests |
|------|------|-------------|-------|
| 1 | 53-01 | POLISH-01 skill schema | 24 (13 pytest + 11 node) |
| 2 | 53-02 | POLISH-02 installer | 8 (node) |
| 3 | 53-03 | POLISH-03 + 04 MCP tools | 8 (pytest) |
| 4 | 53-04 | POLISH-05 hydration hook | 5 (node) |
| 5 | 53-05 | Canary | 13 (node) |
| **Total** | | | **58** |

## Canary Status

`tests/phase-53-canary.test.cjs`: 13/13 PASS. NEVER SKIPS. SC1 byte-match 17/17 PASS.

All v3.2 prior-phase outputs (Phases 48-52) confirmed byte-preserved against PHASE_53_BASE (`32fbdc31527cb9fc5ca81db3036214054c49ae71`).

## Commits

| Task | SHA | Description |
|------|-----|-------------|
| 53-01-01 | e3dba59 | Extend SkillFrontmatter with input_schema + output_schema |
| 53-01-02 | badb18a | Extend skill-compiler.cjs validate() with validateJsonSchemaShape |
| 53-01-03 | 90612f0 | Add tests/test_skill_input_output_schema.py |
| 53-01-04 | 01f2ae0 | Add tests/skill-validate-schemas.test.cjs |
| 53-02-01 | 4e728e5 | Flag parsing + dispatch stubs |
| 53-02-02 | b875eb3 | runUpgrade() implementation |
| 53-02-03 | 535b3b0 | runUninstall() implementation |
| 53-02-04 | 98dc071 | Add tests/init-upgrade-uninstall.test.cjs |
| 53-03-01 | df54a59 | _subprocess_wrap_gsd_tools + 2 Tool entries + 2 call_tool handlers |
| 53-03-02 | 93bc91a | Add tests/test_amauta_mcp_wrapper_tools.py |
| 53-04-01 | 9ffb05b | Add HYDRATE_CMD to cli-variables.md shell block |
| 53-04-02 | 2238522 | Inject hook in execute-phase-legacy.md (3 sites) |
| 53-04-03 | b7b3f31 | Inject hook in step-03-execute.md + step-04-verify.md |
| 53-04-04 | 0a46a14 | Add tests/workflow-hydration-hook.test.cjs |
| 53-05-01 | fb323e9 | Add tests/phase-53-canary.test.cjs |
| 53-05-02 | 84b6b24 | Update REQUIREMENTS.md traceability |

## Open Items

None. All 5 POLISH items fulfilled. All acceptance criteria met. No deviations from plan scope.

Minor observations surfaced during execution (non-blocking):
1. **53-01**: Plan VC4 uses invalid field values for existing Phase 43 validators (`name='x'`, `description='y'`). Surfaced as observation; plan text unchanged per discipline.
2. **53-03**: CONTEXT.md §Areas 3+4 template shows `TOOLS.append()` but Phase 46 actual code uses inline `tools=[...]`. Plan task action correctly specified inline pattern — no divergence.
3. **53-04**: execute-phase-legacy.md had exactly 3 Task() sites vs plan estimate of "~3-5 locations" — matched expected range.

## Key Decisions

- **Field order discipline**: New Pydantic fields always appended after `depends_on` (position 7); never reorder existing positions 1-7.
- **Alias injection for frozen contract**: `restart_daemon→start_daemon` alias injects into `prevResults` in `runUpgrade()` to preserve Phase 44's frozen `stepAssertions` lookup without modifying Phase 44 code.
- **Inline tools=[...]**: Phase 46 uses an inline `tools=[...]` inside `@server.list_tools()`, not module-level `TOOLS.append()`. POLISH-03/04 appended inline accordingly.
- **HYDRATE_CMD absolute path**: LEARN-07 cli-variables.md pattern; absolute path avoids relative-path resolution issues at runtime.

## LEARNING

LEARNING: Close all phase requirement checkboxes in REQUIREMENTS.md at final wave; update Coverage block to reflect 22/22 after POLISH additions.
  WHAT: Close all phase requirement checkboxes in REQUIREMENTS.md at final wave; update Coverage block to reflect total after new requirements added.
  WHY: Traceability table drifts stale across multi-wave phases; final-wave canary plan is the correct reconciliation point.
  WHEN: Any milestone with requirements added mid-execution (e.g., POLISH items added after initial 17).
  CATEGORY: process
  TAGS: requirements, traceability, milestone-close, v3.2, canary

---
*Phase: 53-v3.1-carry-forwards*
*Completed: 2026-05-14*
*v3.2 "The Federation" SHIPPED*

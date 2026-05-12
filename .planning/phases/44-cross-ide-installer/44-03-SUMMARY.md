---
phase: 44-cross-ide-installer
plan: "44-03"
subsystem: installer
tags: [assertions, post-install, smoke, worst-of, graceful-degradation, node, installer]

requires:
  - plan: 44-02
    provides: 6-step orchestrator + FROZEN step names + FROZEN exit rule + buildStepResult + export gate

provides:
  - stepAssertions() in bin/init.cjs — 5 FROZEN post-install assertions with worst-of combinator
  - totalSteps bumped 6→7 in main() orchestrator; assertLog/assertResult/push wired after stepVerify
  - tests/init-assertions.test.cjs — 10 hermetic unit tests for all 5 assertions + combinator
  - tests/init-smoke.test.cjs — 8 hermetic subprocess smoke tests for FROZEN 7-step pipeline contract

affects:
  - Phase 44 acceptance (INST-01, INST-02, INST-03, INST-04) — all requirements now satisfied

tech-stack:
  added: []
  patterns:
    - FROZEN assertion names as hard contract (skill_files_present, compiler_validates, daemon_health, schema_applied, semgrep_rules_present)
    - Worst-of combinator: STATUS_RANK {fail:3, warn:2, pass:1, skip:0}; skip ignored; all-skip → pass
    - Upstream step status cross-reference: skill_files_present skips when installResult.status==='skip'
    - SQLite schema self-creating contract: schema_applied skips (not fails) when .db file absent
    - semgrep_rules_present: file presence only, no Semgrep binary execution
    - Subprocess isolation: tmpDir as cwd + HOME + AMAUTA_DATA_DIR
    - Hermetic prevResults: synthetic step result arrays for unit test isolation

key-files:
  created:
    - tests/init-assertions.test.cjs
    - tests/init-smoke.test.cjs
  modified:
    - bin/init.cjs

key-decisions:
  - "skill_files_present also skips when installResult.status==='skip' (--skip-install), not just when no IDE action:install rows — required for skills-only smoke exit=0"
  - "STATUS_RANK {fail:3,warn:2,pass:1,skip:0} with skip:0 ensures skip never influences worst-of but is still expressible as a value"
  - "schema_applied sqlite path: skip (not fail) when .db file absent — self-creating per 44-CONTEXT.md §Area 3; file eventually appears after daemon first write"
  - "compiler_validates uses --dry-run mode (not validate subcommand) per plan spec note: 'if validate subcommand absent, use --dry-run --source=get-shit-done/skills'"
  - "semgrep_rules_present checks PLUGIN_ROOT/.semgrep/skill-enforcement.yml (absolute path) — not relative to process.cwd() so works from any subprocess cwd"
  - "stepAssertions exported in module.exports alongside prior exports — required for hermetic unit test import without triggering main()"

patterns-established:
  - "Post-install assertion step: cross-reference upstream step statuses (install, daemon, infra) before deciding skip vs run"
  - "All-skip step status = pass — empty result set is not a failure (graceful degradation baseline)"
  - "Subprocess smoke pattern: runSmoke() with tmpDir isolation, JSON.indexOf('{') to skip preamble, exitCode from catch block"

requirements-completed:
  - INST-01  (7-step flow with pass/fail/exit code — run_assertions is the 7th step)
  - INST-02  (IDE detection table visible in 7-step JSON output)
  - INST-03  (CI exit codes 0/1 only; graceful degradation; no fail in skills-only mode)
  - INST-04  (legacy migration + idempotency)
---

# Plan 44-03: stepAssertions (5 checks) + final reporting + 7-step smoke

**5 FROZEN post-install assertions + worst-of combinator + 18 new hermetic tests close Phase 44.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-05-12
- **Completed:** 2026-05-12
- **Tasks:** 3 (all complete)
- **Files modified:** 1 (bin/init.cjs +192 LOC net)
- **Files created:** 2 (tests/init-assertions.test.cjs, tests/init-smoke.test.cjs)

## Accomplishments

- `stepAssertions(prevResults)` added to `bin/init.cjs` as async function immediately after `stepVerify`
- 5 FROZEN assertion names implemented verbatim: `skill_files_present`, `compiler_validates`, `daemon_health`, `schema_applied`, `semgrep_rules_present`
- Worst-of combinator: `STATUS_RANK = {fail:3,warn:2,pass:1,skip:0}`; skip ignored; all-skip → pass
- `totalSteps` bumped from 6 to 7; `assertLog/assertResult/push` wired in `main()` after `stepVerify`
- FROZEN exit rule `results.some(r => r.status === 'fail') ? 1 : 0` UNCHANGED
- `stepAssertions` added to `module.exports` preserving all prior exports from Waves 1+2
- Skills-only smoke `--skip-install --skip-daemon --backend sqlite --json` exits 0 with 7 steps, 0 fail
- `tests/init-assertions.test.cjs`: 10 hermetic tests (all assertions + combinator)
- `tests/init-smoke.test.cjs`: 8 hermetic subprocess tests (full 7-step pipeline end-to-end)
- Phase 44 total: 47 tests across 6 files / 0 failures

## Task Commits

1. **Task 44-03-01: Add stepAssertions() + 7-step orchestrator** — `04e6455` (feat)
2. **Task 44-03-02: Create tests/init-assertions.test.cjs** — `e3943f4` (feat/test)
3. **Task 44-03-03: Create tests/init-smoke.test.cjs** — `9bfe053` (feat/test)

## Files Created/Modified

- `bin/init.cjs` — +192 LOC net. Added: stepAssertions() (5 assertions + combinator), totalSteps 6→7, assertLog wired, stepAssertions in module.exports.
- `tests/init-assertions.test.cjs` — 10 hermetic unit tests for stepAssertions() directly (via require export gate).
- `tests/init-smoke.test.cjs` — 8 hermetic subprocess tests for the full 7-step pipeline via execFileSync.

## FROZEN Contracts Established (full Phase 44 closure)

| Assertion name | Status in skills-only smoke | Reason |
|---|---|---|
| `skill_files_present` | `skip` | install_skills.status === 'skip' (--skip-install) |
| `compiler_validates` | `pass` | canonical skills at HEAD + dry-run exits 0 |
| `daemon_health` | `skip` | start_daemon.status === 'skip' (--skip-daemon) |
| `schema_applied` | `skip` or `pass` | sqlite self-creating; passes if .db exists |
| `semgrep_rules_present` | `pass` | .semgrep/skill-enforcement.yml at HEAD |

All INST-01..04 requirements closed.

## Deviations from Plan

- `skill_files_present` assertion skips not only when no IDE action is `install`, but also when `installResult.status === 'skip'` (install step skipped entirely via `--skip-install`). This is required for the skills-only smoke to exit 0 — the plan spec implied this but did not make it explicit. Functionally correct per 44-CONTEXT.md §Area 3 intent.
- Plan AC grep `'"name":"run_assertions"'` (no space) does not match pretty-printed JSON `"name": "run_assertions"` (with space). Functional contract met via parsed JSON in smoke test. Noted as plan-spec documentation artifact; no code change warranted.
- Init-assertions.test.cjs has 10 test blocks instead of the plan's minimum of 7 — more coverage is not a violation.
- Init-smoke.test.cjs has 8 test blocks instead of the plan's minimum of 6 — additional coverage for step name verification.

## Issues Encountered

None. All 3 tasks executed within `files_expected` scope. All 47 Phase 44 tests pass.

## Next Phase Readiness

- Phase 44 is complete. All INST-01..04 requirements satisfied.
- Phase 45 (Intelligent Help Routing — HELP-01..03) can start. Depends on Phase 43 (complete).
- Phase 46 (Standalone MCP Server — MCP-01..03) can start in parallel with 45.
- Phase 47 (Agent Dynamic Hydration — HYDRA-01..02) depends on 42+43 (both complete).

---
*Phase: 44-cross-ide-installer*
*Completed: 2026-05-12*

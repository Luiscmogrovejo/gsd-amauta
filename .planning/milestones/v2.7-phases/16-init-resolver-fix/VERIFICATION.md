---
phase: 16-init-resolver-fix
validator: gsd-validator
date: 2026-04-10
verdict: PASS
requirements_covered: [RESOLVE-01, RESOLVE-02]
test_results: 11/11 pass, 0 fail
---

# Phase 16: Init Resolver Fix — Verification

## Verdict: PASS

All must-haves across all three plans verified against the live codebase. 11/11 regression tests pass. Both requirement IDs (RESOLVE-01, RESOLVE-02) are fully implemented.

---

## Test Evidence

```
$ node --test tests/16-init-resolver.test.cjs

✔ depth-7/8 replay: phase 15 from v2.7 context returns null (not v2.3 or v2.2 ghost) (3.668042ms)
✔ depth-10 replay: phase 16 from v2.7 returns v2.7 dir (not v2.3-phases/16-data-integrity ghost) (2.390209ms)
✔ RESOLVE-02 override: --phase-dir returns exact path even cross-milestone (v2.3) (1.95325ms)
✔ config.json missing: findPhaseInternal returns null (1.410625ms)
✔ malformed current_milestone (empty string): findPhaseInternal returns null (1.311417ms)
✔ --phase-dir nonexistent path: error() fires with "does not exist" (0.824333ms)
✔ --phase-dir empty directory (no PLANs): error() fires with "no PLAN.md files" (1.279583ms)
✔ --phase-dir absolute path accepted and normalized to relative (1.256833ms)
✔ .planning/phases/ secondary location: found when v2.7 milestone dir is absent (0.904417ms)
✔ no cross-milestone bleed: v2.7 milestone ignores v2.3-phases/15-data-purge entirely (1.966958ms)
✔ live smoke: init phase-op 16 from real repo returns v2.7 directory (0.474458ms)

ℹ tests 11
ℹ pass 11
ℹ fail 0
ℹ duration_ms 108.910625
```

---

## Requirement ID Coverage

| ID | Plan | Status | Evidence |
|----|------|--------|----------|
| RESOLVE-01 | 16-01 | PASS | findPhaseInternal scoped to config.json::current_milestone; no archived-milestone fallback; code confirmed in core.cjs lines 277-310 |
| RESOLVE-02 | 16-02 | PASS | validatePhaseDirOverride() + phaseDirOverride ternary in all four init subcommands; --phase-dir extraction in gsd-tools.cjs lines 1824-1837 |

Both IDs appear in REQUIREMENTS.md Phase 16 section. Both are marked completed in their respective SUMMARY.md frontmatter. No requirement IDs from the PLAN frontmatter are unaccounted for.

---

## Plan 16-01 Must-Haves (RESOLVE-01)

**findPhaseInternal reads current_milestone from config.json and scopes walk to that milestone only**
- PASS. core.cjs lines 282-298: reads config.json, sets currentMilestone, searches ONLY `.planning/milestones/v2.7-phases/`. No archived-milestone walk.
- Verified live: `node -e "... findPhaseInternal(cwd,'15')"` returns `null`.

**When phase number has zero matches in current milestone, resolver returns null (no fallback)**
- PASS. core.cjs lines 306-309: explicit comment "Do NOT fall back to archived milestones" + `return null`. Confirmed by depth-7/8 replay test and live: phase 15 is absent from v2.7-phases, returns null.

**When phase number matches both current and archived milestones, current always wins**
- PASS. The resolver only searches v2.7-phases; archived milestones are never consulted when current_milestone is set. Depth-10 replay test confirms phase 16 returns v2.7 dir, not v2.3 ghost.

**config.json gains current_milestone field with value 'v2.7'**
- PASS. `.planning/config.json` line 7: `"current_milestone": "v2.7"`. Confirmed by `node gsd-tools.cjs config-get current_milestone --raw` returning `v2.7`.

**VALID_CONFIG_KEYS includes 'current_milestone'**
- PASS. config.cjs line 11: `'search_gitignored', 'brave_search', 'current_milestone',` — present in VALID_CONFIG_KEYS Set.

**config-set uses atomic write-to-temp + rename pattern**
- PASS. config.cjs lines 135-137: `const tmpPath = configPath + '.tmp.' + process.pid; fs.writeFileSync(tmpPath, ...); fs.renameSync(tmpPath, configPath)`.

**getMilestoneInfo reads current_milestone from config.json as primary source**
- PASS. core.cjs lines 418-438: reads config.json first; returns `{ version: config.current_milestone, name }`. ROADMAP.md consulted only for display name. Fallback to ROADMAP.md parsing preserved for projects without the field.
- Verified live: `getMilestoneInfo(cwd)` returns `{"version":"v2.7","name":"Steady Hands"}`.

---

## Plan 16-02 Must-Haves (RESOLVE-02)

**cmdInitExecutePhase, cmdInitPlanPhase, cmdInitVerifyWork, cmdInitPhaseOp all accept --phase-dir**
- PASS. init.cjs: all four function signatures updated to `(cwd, phase, raw, phaseDirOverride)`. Confirmed at lines 98, 173, 427, 458.

**--phase-dir bypasses findPhaseInternal entirely when provided**
- PASS. Each function uses: `const phaseInfo = phaseDirOverride ? validatePhaseDirOverride(...) : findPhaseInternal(...)`. Confirmed in init.cjs at the four ternary bypass points.

**--phase-dir with nonexistent path returns hard error**
- PASS. validatePhaseDirOverride: `if (!fs.existsSync(absPath)) { error('--phase-dir: path does not exist: ' + ...) }`. Test case passes.

**--phase-dir with empty directory (no PLAN.md files) returns hard error with sibling suggestion**
- PASS. validatePhaseDirOverride lines 38-57: filters for PLAN.md files, calls `error('--phase-dir: directory exists but contains no PLAN.md files: ' + ... + suggestion)`. Test case passes.

**Both absolute and relative paths accepted, normalized to relative-from-cwd internally**
- PASS. validatePhaseDirOverride lines 16-18: `path.isAbsolute(phaseDirOverride) ? phaseDirOverride : path.resolve(cwd, phaseDirOverride)`. Normalized to relpath before return. Absolute-path test case passes.

**CLI argument parsing in gsd-tools.cjs extracts --phase-dir before passing to init subcommands**
- PASS. gsd-tools.cjs lines 1824-1837: extracts `--phase-dir <value>` (space form) and `--phase-dir=value` (equals form), splices both from args, passes `phaseDirOverride` as 4th arg to all four subcommand calls.

---

## Plan 16-03 Must-Haves (RESOLVE-01 + RESOLVE-02 tests)

**Test case 1: depth-7/8 replay — query phase 15 from v2.7 context returns null**
- PASS. Test "depth-7/8 replay" passes. Fixture uses exact historical dir names: `v2.3-phases/15-data-purge`, `v2.2-phases/15-dogfood`.

**Test case 2: depth-10 replay — query phase 16 from v2.7 context returns v2.7 directory**
- PASS. Test "depth-10 replay" passes. Fixture uses `v2.3-phases/16-data-integrity` as ghost and `v2.7-phases/16-init-resolver-fix` as the correct target.

**Test case 3: RESOLVE-02 override bypass — --phase-dir pointing at cross-milestone directory returns that path**
- PASS. Test "RESOLVE-02 override: --phase-dir returns exact path even cross-milestone" passes.

**Edge cases: missing config, malformed milestone, nonexistent --phase-dir, empty directories, absolute paths**
- PASS. All 5 edge-case tests pass (config.json missing, empty current_milestone, nonexistent path, empty dir, absolute path).

**Live smoke test: gsd-tools init phase-op 16 from real repo returns v2.7 directory**
- PASS. Live smoke test passes. Manual confirmation: `gsd-tools init phase-op 16 --raw` returns `"phase_dir": ".planning/milestones/v2.7-phases/16-init-resolver-fix"`.

**All tests use exact historical directory names**
- PASS. Fixture names confirmed: `v2.3-phases/15-data-purge`, `v2.2-phases/15-dogfood`, `v2.3-phases/16-data-integrity`, `v2.7-phases/16-init-resolver-fix`.

---

## Git Evidence

10 atomic commits spanning tasks 16-01-01 through 16-03-01:

```
b9a4493 docs(16-03): record learning — captureError() sentinel pattern for process.exit testing
abb9396 docs(16-03): SUMMARY.md + STATE.md — plan 16-03 complete, Phase 16 fully closed
5ffd1e6 tests(16-03-01): resolver regression suite — 11 tests, depths 7/8/10 + edge cases
03b6751 docs(16-02): SUMMARY, STATE, ROADMAP — Phase 16 complete
4a44444 docs(16-01): SUMMARY.md, STATE.md, ROADMAP.md — plan 01 complete
e2c37d7 feat(16-02-02): add --phase-dir validation and bypass in all four init subcommands
be36977 feat(16-01-03): getMilestoneInfo reads current_milestone from config.json as primary source
a3dd52e feat(16-01-02): make findPhaseInternal milestone-scoped via config.json
d3f781e feat(16-01-01): add current_milestone to config.json + VALID_CONFIG_KEYS + atomic write
019d767 feat(16-02-01): extract --phase-dir from CLI args in gsd-tools init dispatch
```

All commits carry `(16-XX-XX)` or `(16-XX)` scope tags matching the plan/task structure. No unrelated changes mixed in.

---

## Phase Goal Verification

**Goal:** The `gsd-tools init` family of commands resolves phase directories within the current milestone only, and operators can bypass the resolver entirely with an explicit `--phase-dir` override when needed.

- Milestone-scoped resolution: CONFIRMED. findPhaseInternal reads config.json::current_milestone and searches only that milestone's directory. Zero fallback to archived milestones.
- Operator override: CONFIRMED. --phase-dir accepted on all four phase-aware init subcommands, bypasses resolver entirely, hard-errors on bad paths.

Phase goal is fully achieved.

---

## Deviations

None. All three plans executed as written. The one clarification (process.exit sentinel pattern in tests) was anticipated during the R-phase of 16-03 and designed into the test helper accordingly — not a deviation.

---

*Validated by: gsd-validator*
*Date: 2026-04-10*

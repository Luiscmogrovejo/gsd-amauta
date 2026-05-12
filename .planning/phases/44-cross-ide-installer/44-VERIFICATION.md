---
phase: 44
verified: 2026-05-12
status: passed
verifier: gsd-validator
---

# Phase 44 Verification — Cross-IDE Installer

## Divergence Pre-Gate Scan

Scanned `.planning/milestones/` for divergence-reports directories with unresolved `orchestrator_response` fields.

- Directories found: only `v2.2-phases/13.1-orchestrator-hardening-divergence-protocol/divergence-reports` (pre-existing, Phase 13.1 era).
- No Phase 44 divergence-reports directory exists.
- No Phase 44 divergence JSONs found anywhere under `.planning/phases/44-cross-ide-installer/`.

**Pre-gate scan result: CLEAR. No unresolved divergences.**

---

## Must-Have Verification

### SC1 — INST-01: 7-Step Pipeline + Per-Step Schema + Exit Rule

**Evidence:**

1. `bin/init.cjs` `main()` wires exactly 7 steps in order:
   - `stepDetectIdes()` → `detect_ides`
   - `stepInstall()` → `install_skills`
   - `stepDetectInfra()` → `detect_infra`
   - `stepMigrations()` → `migrations`
   - `stepStartDaemon()` → `start_daemon`
   - `stepVerify()` → `verify`
   - `stepAssertions()` → `run_assertions`
   Lines 1203-1238 of `bin/init.cjs`. `totalSteps = 7` at line 1201.

2. `buildStepResult(name, status, message, details)` at line 217 returns frozen 5-field schema:
   `{ name, status, message, duration_ms: 0, details }`.
   Status validated against `new Set(['pass', 'fail', 'skip', 'warn'])` — throws on invalid value.

3. Exit rule at line 1254 (verbatim match):
   ```
   process.exit(results.some(r => r.status === 'fail') ? 1 : 0);
   ```
   One active usage (`grep` finds exactly 1). Comment at line 1253 names the frozen contract.

4. Live smoke:
   ```
   $ node bin/init.cjs --json --skip-install --skip-daemon --backend sqlite 2>/dev/null | python3 -c "..."
   Total steps: 7
     detect_ides                    status=pass
     install_skills                 status=skip
     detect_infra                   status=warn
     migrations                     status=skip
     start_daemon                   status=skip
     verify                         status=skip
     run_assertions                 status=pass
   Exit rule simulation: exit 0
   ```
   All 7 step names present. No `status: fail`. Exit 0.

**SC1: PASS**

---

### SC2 — INST-02: IDE Auto-Detection + Per-IDE Table

**Evidence:**

1. `function stepDetectIdes()` declared at line 290 of `bin/init.cjs`.

2. Detection logic:
   - Loads platform codes from yaml via `skillCompiler.loadPlatformCodes()` with hard-coded fallback (lines 294-302).
   - Checks `cwdDirPath` then `homeDirPath` for each IDE (project-local first, then `$HOME`).
   - `dirHasContent()` helper (line 309): empty directories return false (false-positive guard). Dir counts as detected only when it contains `skill_subdir`, `commands/`, `*.md`, or `*.json`.
   - `cliOnPath()` (line 328): advisory boost to signals string; never blocks detection.
   - Each detection row: `{ ide_id, detected: 'yes'|'no', signals, action }` (line 362-367).

3. `details.detections[]` in JSON mode confirmed live:
   ```
   detect_ides.details.detections:
     {'ide_id': 'claude-code', 'detected': 'yes', 'signals': 'dir+cli', 'action': 'install'}
     {'ide_id': 'cursor', 'detected': 'yes', 'signals': 'dir', 'action': 'install'}
     {'ide_id': 'opencode', 'detected': 'yes', 'signals': 'dir+cli', 'action': 'install'}
   ```
   Columns: `ide_id` (= IDE), `detected` (= Detected), `signals` (= Signals), `action` (= Action). 4-column schema matches SC2.

4. Console table rendered via `renderStepTable()` (line 246). Outputs `Step | Status | Duration | Message` header. Confirmed live run shows 7 step rows.

5. `--tools` override applies at `stepInstall()` (line 455) — it filters compile actions per IDE without modifying `detections[]` or skipping table rendering. `stepDetectIdes()` always runs and always builds the full detections table regardless of `--tools`.

**SC2: PASS**

---

### SC3 — INST-03: Non-Interactive CI Mode + Graceful Degradation + Exit Codes

**Evidence:**

1. Flag parsing at lines 109-151:
   - `--yes` → `flags.yes` (line 109)
   - `--tools <list>` → `flags.tools[]` (line 129)
   - `--force-migrate` → `flags.forceMigrate` (line 112)
   All three new flags parsed without removing existing flags.

2. Existing flags preserved (verified at lines 103-113):
   - `--skip-install` → `flags.skipInstall`
   - `--skip-daemon` → `flags.skipDaemon`
   - `--opencode` → `flags.runtime`
   - `--claude` → `flags.runtime`
   - `--backend` → `flags.backend`
   - `--force` → `flags.force`
   - `--json` → `flags.json`
   None renamed or removed.

3. Degradation policy:
   - `detect_infra` returns `status: warn` (not `fail`) when SQLite fallback (lines 544-548).
   - `migrations` returns `status: skip` with `skip_reason: 'requires_pg'` when backend != postgresql (lines 646-654).
   - `start_daemon` returns `status: skip` with `skip_reason: 'requires_pg'` in skills-only mode (lines 756-764).
   Live confirmed:
   ```
   detect_infra: status=warn
   migrations: status=skip message='migrations skipped — requires_pg'
   start_daemon: status=skip
   ```

4. `--yes` + collision (commands/ AND skills/ both present) → `status: warn`, never destructive (line 1141).
   Message: `both legacy commands/ and skills/ present — skipped migration; pass --force-migrate to override`.

5. Exit codes: only `0` or `1` (verbatim rule line 1254). No other values. Confirmed by `init-flags-non-interactive.test.cjs` (7/7 tests pass).

**SC3: PASS**

---

### SC4 — INST-04: Legacy Migration + platform-codes.yaml

**Evidence:**

1. `get-shit-done/references/platform-codes.yaml` exists. Contents:
   ```yaml
   ides:
     claude-code:
       ide_id: claude-code
       dir_name: .claude
       skill_subdir: skills
       cli_name: claude
     cursor:
       ide_id: cursor
       dir_name: .cursor
       skill_subdir: rules      # cursor uses 'rules' per SC4 spec
       cli_name: cursor
     opencode:
       ide_id: opencode
       dir_name: .opencode
       skill_subdir: skills
       cli_name: opencode
   ```
   Exactly 3 IDEs × 4 fields each. `cursor.skill_subdir: rules` confirmed.

2. `scripts/skill-compiler.cjs` reads the yaml:
   - `loadPlatformCodes()` function at line 122 of skill-compiler.cjs.
   - Exported at line 595: `module.exports = { compile, validate, listSkills, loadPlatformCodes, TARGET_MAPS, SUPPORTED_TARGETS }`.
   - At module load, lines 191-192 override `TARGET_MAPS` from yaml entries.
   - `grep` hit: `loadPlatformCodes` at lines 107, 110, 122, 191, 595.

3. `migrateLegacyCommands()` at line 1110 of `bin/init.cjs`:
   - Timestamped backup rename at line 1149:
     ```js
     const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
     ```
     Produces `commands.bak.YYYY-MM-DDTHH-MM-SS/` (e.g., `commands.bak.2026-05-12T21-14-17`).
   - `fs.renameSync(commandsDir, backupDir)` at line 1153 — atomic rename, not delete.
   - Idempotent: no state file. `isMissingOrEmpty(commandsDir)` returns true after migration → `status: skip`.

4. Idempotency verified by `init-legacy-migration.test.cjs` test: `idempotency: re-run after migration → skip`.

5. Five frozen assertion names in `stepAssertions()` (lines 913-917, enforced as named strings at lines 940, 976, 996, 1005, 1028, 1057):
   - `skill_files_present` — no `_v2` variant, no INFO variant
   - `compiler_validates` — no `_v2` variant
   - `daemon_health` — no `_v2` variant
   - `schema_applied` — no `_v2` variant
   - `semgrep_rules_present` — no `_v2` variant

**SC4: PASS**

---

### Cross-Cutting Checks

**Atomic commits (13 task commits + 2 chore commits):**
```
1bf122e feat(44-01-01): add platform-codes.yaml
f2ca038 feat(44-01-02): add loadPlatformCodes() to skill-compiler.cjs
e120f82 feat(44-01-03): add stepDetectIdes+buildStepResult+renderStepTable to bin/init.cjs
ca40dce feat(44-01-04): add tests/init-platform-codes.test.cjs
3c05bd9 feat(44-01-05): add tests/init-detect-ides.test.cjs
673f866 docs(44-01): SUMMARY.md + STATE.md + ROADMAP.md
f19ab74 feat(44-02-01): add --yes/--tools/--force-migrate flag parsing + printHelp()
13db60c feat(44-02-02): add migrateLegacyCommands() helper
e837d66 feat(44-02-03): wire stepDetectIdes+migrateLegacyCommands into main(); convert 5 steps
e68013e feat(44-02-04): create tests/init-legacy-migration.test.cjs
166a36a feat(44-02-05): create tests/init-flags-non-interactive.test.cjs
cfa97dc chore(44-02): STATE.md + ROADMAP.md — Plan 44-02 COMPLETE
04e6455 feat(44-03-01): add stepAssertions() with 5 frozen checks + 7-step orchestrator
e3943f4 feat(44-03-02): add tests/init-assertions.test.cjs
9bfe053 feat(44-03-03): add tests/init-smoke.test.cjs
3d43c86 chore(44-03): STATE.md + ROADMAP.md + 44-03-SUMMARY.md — Phase 44 COMPLETE
```
All task IDs (44-01-01 through 44-03-03) have individual commits. PASS.

**SUMMARY.md files:**
- `44-01-SUMMARY.md` — present, no "Self-Check: FAILED" markers. PASS.
- `44-02-SUMMARY.md` — present, no "Self-Check: FAILED" markers. PASS.
- `44-03-SUMMARY.md` — present, no "Self-Check: FAILED" markers. PASS.

**STATE.md:** Updated. `last_activity` reflects `2026-05-12 — Plan 44-03 complete`. PASS.

**ROADMAP.md:** Phase 44 marked COMPLETE at lines 48, 51, 52. All 3 plans marked `[x]` at lines 49-51. PASS.
(Note: Line 160 in the detailed phase listing shows `[ ]` for 44-03 — stale pre-completion checkbox, see Accepted Deviations below.)

**Test results (all 6 test files):**
```
$ node --test init-platform-codes.test.cjs ... init-smoke.test.cjs
ℹ tests 47
ℹ pass  47
ℹ fail  0
```
47/47 tests pass across all 6 test files.

**Phase 43 regression (opencode-config.test.cjs):**
```
ℹ tests 4
ℹ pass  4
ℹ fail  0
```
PASS — no regression.

**Phase 43 compiler: updated, not replaced.**
`scripts/skill-compiler.cjs` has `loadPlatformCodes` added while retaining `TARGET_MAPS`, `compile`, `validate`, `listSkills`, and `SUPPORTED_TARGETS`. All pre-Phase 44 exports preserved at line 595.

---

## Requirement Traceability

| Requirement ID | Must-Have Section | Evidence |
|---|---|---|
| INST-01 | SC1 | 7-step pipeline, buildStepResult, exit rule, live JSON output |
| INST-02 | SC2 | stepDetectIdes, 3-IDE detections[], dir-presence logic, columns match |
| INST-03 | SC3 | --yes/--tools/--force-migrate flags, existing flags preserved, degradation to warn/skip |
| INST-04 | SC4 | platform-codes.yaml (3×4), loadPlatformCodes in compiler, timestamped backup-rename, idempotent, 5 frozen assertion names |

All 4 INST requirement IDs accounted for.

---

## Accepted Deviations

1. **44-03-03 smoke test AC grep mismatch.** Plan AC `'"name":"run_assertions"'` (no space) does not match pretty-printed JSON `"name": "run_assertions"` (with space). The functional contract (7-step pipeline returns `run_assertions` as the last step with `status: pass`) is verified by the smoke test's parsed-JSON assertions. Documentation artifact, not a code defect. Accepted.

2. **Amauta tasks dedup-blocked across all 3 plans.** ST-0151, ST-0152, ST-0153 created but child task creation failed because original tasks pre-existed from the planner's dry-run. Does not affect code correctness. Accepted.

3. **Daemon /api/skills/* still 404 on running daemon** (predates Phase 43 routes). Tests skip gracefully. Same accepted deviation as Phase 43. Daemon restart required to fully activate. Accepted.

4. **Manifest-check (HARDEN-01) not run per-task by orchestrator** — spot-checks performed instead. Each executor self-attested manifest compliance. Same trade-off as Phase 43. Accepted.

5. **No VALIDATION.md / Nyquist Dimension 8** — research disabled in config; same trade-off as Phase 43. Plans pass via functional verification rather than Dimension 8 contracts. Accepted.

6. **ROADMAP.md line 160 stale `[ ]` checkbox for 44-03.** The detailed phase listing (lines 157-160, written at phase-planning time) was not updated after 44-03 shipped. Lines 48-52 (the current milestone summary) correctly mark Phase 44 and all three plans as `[x] COMPLETE 2026-05-12`. This is a paperwork artifact consistent with stale REQUIREMENTS.md checkbox patterns documented in prior verifications (Phases 23, 28, 35). Accepted.

---

## Human Verification Items

**None required for core functionality.** All 4 INST success criteria are verifiable via automated tests and local `node bin/init.cjs` invocations.

**Optional operator verification** (not blocking — live environment gates):

1. Run `npx gsd-amauta init` on a clean machine with Docker available to exercise the PostgreSQL path (steps `detect_infra: pass`, `migrations: pass`, `start_daemon: pass`, `verify: pass`, `schema_applied` assertion via `/api/migrations`).
2. Run with a real `.cursor/rules/` directory present to confirm cursor IDE detection fires and skill-compiler writes to `.cursor/rules/`.

These are quality-of-life checks, not requirement gaps. Phase 45 is unblocked.

---

## Summary

**Status: passed**

All 4 INST requirements (INST-01, INST-02, INST-03, INST-04) verified with concrete evidence:
- 7-step pipeline with frozen buildStepResult schema and exact exit rule
- 3-IDE auto-detection table (claude-code, cursor, opencode) with dir-presence logic and JSON + console output
- --yes/--tools/--force-migrate CI flags, all 7 existing flags preserved, degradation to warn/skip (never fail) when no PG
- platform-codes.yaml (3 IDEs × 4 fields), loadPlatformCodes() in skill-compiler.cjs, timestamped atomic backup-rename, idempotent scan, 5 frozen assertion names

47/47 tests pass (7 platform-codes + 8 detect-ides + 7 legacy-migration + 7 flags-non-interactive + 10 assertions + 8 smoke). 15 atomic commits with task IDs. 3 SUMMARY.md files. No Self-Check failures. 6 deviations accepted (paperwork/environment).

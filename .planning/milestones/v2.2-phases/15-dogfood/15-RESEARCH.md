# Phase 15: End-to-End Dogfood Verification — Research

**Gathered:** 2026-04-10
**Status:** Ready for planning
**Researcher:** gsd-researcher

---

## Sources

1. [primary] `.planning/milestones/v2.2-phases/15-dogfood/15-CONTEXT.md` — 15 locked decisions + 4 gap resolutions (full read)
2. [primary] `.planning/REQUIREMENTS.md` — DOGFOOD-01..05 definitions + traceability table (full read)
3. [primary] `.planning/STATE.md` — Test baseline, known failures, pending todos (full read)
4. [codebase] `get-shit-done/bin/gsd-tools.cjs` — Exact exports, function signatures, CLI subcommand router (lines 230-330, 1429-1448, 1880-1929)
5. [codebase] `scripts/run-behavioral-tests.cjs` — Runner logic, output format, exit contract (full read)
6. [codebase] `tests/13.1-divergence-protocol.integration.test.cjs` — Behavioral test structure, scenario names, discovery manifest (lines 1-85)
7. [codebase] `.planning/milestones/v2.2-phases/14-p-phase-task-management-integration/14-VERIFICATION.md` — Authoritative VERIFICATION.md structure (full read)
8. [codebase] `.planning/milestones/v2.2-phases/13-validation-hardening/VERIFICATION.md` — Second VERIFICATION.md example (full read)
9. [codebase] `commands/amauta/health.md` + `get-shit-done/workflows/health.md` — Slash command and workflow pattern (full reads)
10. [codebase] `get-shit-done/workflows/verify-work.md` — Workflow depth and step structure (full read)
11. [glob] `commands/amauta/*.md` — 32 existing slash commands enumerated
12. [glob] `get-shit-done/workflows/*.md` — 36 existing workflows enumerated
13. [glob] `get-shit-done/bin/` — 7 existing binary files

---

## Key Findings

### 1. gsd-tools.cjs exports (exact)

The `module.exports` block lives at line 1430-1448, guarded by `require.main !== module`. Exact exports:

```js
module.exports = {
  manifestCheck,
  GLOBAL_ALLOWLIST,
  ORCHESTRATOR_OWNED,
  MANIFEST_GLOB_BLOCKLIST,
  resolvePhaseDir,
  _parseFilesExpectedYaml,
  _globToRegExp,
  _diffNameStatus,
  routeExecutor,
  planToTasks,
  _validatePlanShape,
  _detectCycles,
  _checkAgentConflicts,
  _filesDisjointSplit,
  _renderDagText,
  _diffPlanVsAmauta,
};
```

The four CONTEXT.md Q6 imports for `verify-v26.cjs` are all present:
- `manifestCheck` — exported, line 1432
- `resolvePhaseDir` — exported, line 1436
- `GLOBAL_ALLOWLIST` — exported, line 1433
- `planToTasks` — exported, line 1441

The `audit-rpetd-intelligence` subcommand does NOT exist yet in gsd-tools.cjs. DOGFOOD-01 says it belongs in `gsd-tools.cjs audit-rpetd-intelligence <task_id>`. However, CONTEXT.md Q1 says no modification of pre-existing `.cjs` files is in scope. This is a potential plan-time conflict the planner must resolve. The CONTEXT.md says if tooling needs something from an existing file that isn't exposed, "document the gap in the audit report, do not patch the existing file." Two resolution paths exist:
  - Path A: Create a standalone `get-shit-done/bin/audit-rpetd-intelligence.cjs` binary (new file, no modification of gsd-tools.cjs) that internally `require()`s the gsd-tools.cjs exports — satisfying both DOGFOOD-01 and Q1 simultaneously.
  - Path B: Treat DOGFOOD-01 as requiring a gsd-tools.cjs subcommand dispatch addition, which would be a modification of an existing file and violates Q1.

CONTEXT.md Q1 lists `get-shit-done/bin/audit-rpetd-intelligence.cjs` explicitly as a new deliverable. The file path confirms Path A is the locked intent. The DOGFOOD-01 text "gsd-tools.cjs audit-rpetd-intelligence" describes the user-facing invocation pattern, not necessarily that the code lives inside gsd-tools.cjs — the standalone binary `audit-rpetd-intelligence.cjs` satisfies the intent when invoked as `node get-shit-done/bin/audit-rpetd-intelligence.cjs <task_id>`.

### 2. gsd-amauta.cjs test-only exports (exact)

From `gsd-amauta.cjs` line 2060:

```js
module.exports = {
  _checkEvidenceBlock,
  checkEvidenceAdvisory,
  _checkQaBlocks,
  _checkRedGreenOrder,
  checkSpecInheritanceAdvisory,
  writeGapsReport
};
```

The CONTEXT.md code_context section says audit can verify these exist via `require` without invoking them on live tasks. These four functions are the structural markers for E-phase and T-phase RPETD upgrade presence.

### 3. Behavioral test runner contract

`scripts/run-behavioral-tests.cjs` is a thin runner:
- Pattern: finds all `tests/*.integration.test.cjs` files
- Execution: `spawnSync(process.execPath, ['--test', filePath], { stdio: 'inherit' })`
- Exit: `0` if all pass, `1` otherwise
- Output: `Behavioral: N/M passed` (the `Behavioral:` prefix is grep-verifiable)
- Failure contract: preserves temp dirs at `/tmp/gsd-13.1-*` on failure (does NOT clean up)
- Currently 1 file matches: `tests/13.1-divergence-protocol.integration.test.cjs`

The behavioral test suite has 4 named tests (from `[discovery]` manifest lines):
1. `behavioral: stale_prerequisite x5 runs` (5 invocations)
2. `behavioral: unexpected_file_state x5 runs` (5 invocations)
3. `behavioral: manifest_violation x5 runs` (5 invocations)
4. `Phase 13 incident replay: silent re-implementation is now caught` (1 invocation)

Total: 16 invocations (not 15 as CONTEXT.md JSON schema says `total_invocations_attempted: 16`).

The Phase 13.1 behavioral test findings memo (memory: `project_phase13_1_behavioral_test_findings.md`) records that 1/4 scenarios pass, 3/4 abort. This is the known pre-existing state the audit captures.

### 4. Pre-existing failure test names (exact, from STATE.md line 178)

npm failures (4 tests):
- `rlm-workflow-spec.test.cjs`
- `agent-frontmatter.test.cjs` (gsd-planner subtest)
- `comprehensive-e2e.test.cjs` (6.12 migration count)
- `gsd-amauta.test.cjs` (daemon not running)

pytest failures (3 tests):
- `test_pg_integration.py` (exact test name TBD — STATE.md names the file, not the test name within it)

The audit must match by test name, not count (CONTEXT.md Q9). For pytest, the planner should specify that the audit grep/parse the test names within `test_pg_integration.py` at execution time and baseline them as found — STATE.md doesn't enumerate the 3 subtest names, only the file.

### 5. RPETD content structure for audit-rpetd-intelligence.cjs

From REQUIREMENTS.md DOGFOOD-01, the audit checks:
- D-phase: non-empty structured LEARNING with WHAT/WHY/WHEN/TAGS fields (LEARN-01 template)
- E-phase: non-empty `PRE_EXECUTION_EVIDENCE:` block (EXEC-03)
- T-phase: `inherited_success_criteria` verification + `EDGE_CASES:` block + `REGRESSION:` block (QA-02, QA-05, QA-06)

These fields live in the RPETD content stored per task via `amauta rpetd <task_id> --phase <X>`. The audit script needs to call `node amauta.cjs show <task_id> --json` and inspect the `rpetd` field per phase, or call `node amauta.cjs rpetd <task_id>` and parse the text. The planner should resolve which daemon endpoint exposes RPETD content for a completed task.

The tasks sampled for the audit are v2.6 phase 10-14 tasks. The pool size will determine sample size (CONTEXT.md Q4: if pool < 5, document as below-assumed-n).

### 6. Slash command pattern (exact structure from commands/amauta/health.md)

```yaml
---
name: amauta:<command-name>
description: <one-line description>
argument-hint: <hint or [args]>
allowed-tools:
  - Read
  - Bash
  - Write
  [...]
---
<objective>
[single paragraph describing what it does]
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/<workflow-name>.md
</execution_context>

<process>
Execute the <name> workflow from @~/.claude/get-shit-done/workflows/<workflow-name>.md end-to-end.
[Parse flags from arguments and pass to workflow.]
</process>
```

The `verify-v26.md` slash command should follow this pattern exactly. It is a thin wrapper that references the workflow. Allowed tools need to include at minimum: Read, Bash, Glob, Grep.

### 7. Workflow pattern (from get-shit-done/workflows/health.md)

Workflows use `<purpose>`, `<required_reading>` (optional), `<process>` with named `<step>` elements. Steps contain bash blocks with actual commands. Steps have `priority="first"` annotation when ordering matters.

The `verify-rpetd-intelligence.md` workflow should follow this pattern. It describes the sequence: create sample story → claim through 5 phases → populate RPETD blocks → invoke audit-rpetd-intelligence → report.

### 8. Phase directory structure for Phase 15

Phase 15 directory: `.planning/milestones/v2.2-phases/15-dogfood/`
Current contents: only `15-CONTEXT.md` (just written by discuss-phase)

Expected after execution:
```
15-dogfood/
  15-CONTEXT.md        (exists)
  15-RESEARCH.md       (this file)
  15-01-PLAN.md        (Wave 1)
  15-01-SUMMARY.md     (Wave 1 done)
  15-02-PLAN.md        (Wave 2)
  15-02-SUMMARY.md     (Wave 2 done)
  15-03-PLAN.md        (Wave 3)
  15-03-SUMMARY.md     (Wave 3 done)
  15-AUDIT-REPORT.json (Wave 2 output, git add -f)
  15-AUDIT-REPORT.md   (Wave 2 output, git add -f)
  15-VALIDATION.md     (post-execution)
  15-VERIFICATION.md   (post-execution)
```

Published outside phase dir:
```
docs/v2.6-dogfood-ledger.md   (Wave 3 output, plain git add)
```

New tool files (plain git add, tracked normally):
```
scripts/verify-v26.cjs
get-shit-done/bin/audit-rpetd-intelligence.cjs
get-shit-done/workflows/verify-rpetd-intelligence.md
commands/amauta/verify-v26.md
```

### 9. REQUIREMENTS.md errata handling (at closeout, not during execution)

CONTEXT.md documents two errata to apply to REQUIREMENTS.md at Phase 15 closeout:
- DOGFOOD-03: `scripts/verify-v26.sh` → `scripts/verify-v26.cjs` (Gap 1a)
- DOGFOOD-05: "6/6 phases" clarification — 10+11+12+13+13.1+14 = 6, excluding Phase 9 (baseline) and Phase 15 (recursive scope exclusion) (Gap 1b)

The errata pattern from Phase 14: ~~strikethrough~~ + replacement + footnote citing CONTEXT.md decision. These are committed in Wave 3 (closeout plan 15-03), not during tooling creation.

### 10. DOGFOOD-05 phases list (exact, locked)

The 6 audited phases are hard-coded in verify-v26.cjs:
```js
const AUDITED_PHASES = ["10", "11", "12", "13", "13.1", "14"];
// Phase 9 excluded: baseline sweep, not an RPETD upgrade
// Phase 15 excluded: recursive scope exclusion (Q10)
```

Each phase's VERIFICATION.md at `.planning/milestones/v2.2-phases/<phase_dir>/VERIFICATION.md` is checked for existence and `verdict: PASS` frontmatter. Phase directories to check:
- `11-context-engine-activation/VERIFICATION.md` — exists (confirmed by Glob)
- `12-semantic-memory-pipeline/VERIFICATION.md` — exists (confirmed by Glob)
- `13-validation-hardening/VERIFICATION.md` — exists (confirmed by Glob)
- `13.1-orchestrator-hardening-divergence-protocol/VERIFICATION.md` — directory exists, VERIFICATION.md presence not confirmed, needs runtime check
- `14-p-phase-task-management-integration/VERIFICATION.md` — exists (confirmed by read)
- Phase 10 VERIFICATION.md — directory name not yet known (Phase 10 is "D-Phase Structured Learning + CLI Dedup"), needs glob resolution at audit time

### 11. Existing bin file pattern

`get-shit-done/bin/` contains: `amauta.cjs`, `gsd-amauta.cjs`, `gsd-memory-learn-blocks.sh`, `gsd-memory.cjs`, `gsd-research.cjs`, `gsd-rlm.cjs`, `gsd-tools.cjs`, `lib/`. The new `audit-rpetd-intelligence.cjs` follows the `.cjs` extension convention. It will be the 6th `.cjs` binary in that directory.

### 12. Commit/gitignore policy (locked, from CONTEXT.md Gap 4)

| File | git add command |
|------|-----------------|
| `15-AUDIT-REPORT.json` | `git add -f` |
| `15-AUDIT-REPORT.md` | `git add -f` |
| `docs/v2.6-dogfood-ledger.md` | `git add` |
| `scripts/verify-v26.cjs` | `git add` |
| `get-shit-done/bin/audit-rpetd-intelligence.cjs` | `git add` |
| `get-shit-done/workflows/verify-rpetd-intelligence.md` | `git add` |
| `commands/amauta/verify-v26.md` | `git add` |

### 13. Dogfood ledger source memory paths (from CONTEXT.md, locked)

The 7 memory entries for ledger transcription live at `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/`:

| Memory file | Depth | Dogfood event |
|---|---|---|
| `project_phase13_1_wave1_dogfood.md` | 0 | Executor surfaced doc-vs-reality mismatch |
| `project_phase13_1_meta_recursive_dogfood.md` | 1 | Protocol self-application |
| `project_phase13_1_wave3_near_miss.md` | 2 | "helper useless if nothing consumes it" near-miss |
| (Depth 3) | 3 | Not yet observed — placeholder row |
| `project_phase13_1_closeout_paperwork_dogfood.md` | 4 | Paperwork drift resistance |
| `project_phase13_1_discuss_phase_reconciliation_dogfood.md` | 5 | Directory-slot-vs-roadmap-identity drift |
| `project_phase14_prior_session_verification_dogfood.md` | 6 | Cross-session pre-commit verification |
| `project_phase15_ghost_directory_dogfood.md` | 7 | v2.3 ghost directory detection |

Ledger depth-3 gap: "Depth 3: Not yet observed in v2.6 milestone." Do NOT renumber. The gap is a finding, not a hole to close.

### 14. verify-v26.cjs structural requirements (aggregated)

From CONTEXT.md decisions Q6/Gap 2/Gap 3:
1. First line: `const { manifestCheck, resolvePhaseDir, GLOBAL_ALLOWLIST } = require('../get-shit-done/bin/gsd-tools.cjs')` — if this fails, audit exits immediately with a clear error
2. Pre-flight function: checks `ANTHROPIC_API_KEY` (and any others needed for behavioral tests); aborts with `environment_missing` finding category, not a Phase 15 failure
3. Timeout wrapper: 30-minute wall-clock timeout around `npm run test:behavioral` subprocess; if fires, records `behavioral_test_timeout: true` with `partial_results_captured: [...]`
4. Deterministic checks run regardless of API key presence
5. Recursive self-exclusion: hard-coded list of Phase 15 deliverables excluded from audit

---

## Recommendations

### Plan structure (from CONTEXT.md Q13, locked)

**Plan 15-01 (Wave 1): Tooling creation**
- `scripts/verify-v26.cjs` — main end-to-end verification script
- `get-shit-done/bin/audit-rpetd-intelligence.cjs` — standalone binary (new file, require()s gsd-tools.cjs)
- `get-shit-done/workflows/verify-rpetd-intelligence.md` — workflow for DOGFOOD-02
- `commands/amauta/verify-v26.md` — slash command for DOGFOOD-04

**Plan 15-02 (Wave 2): Run the audit**
- Execute `verify-v26.cjs` (no new code written)
- Capture `15-AUDIT-REPORT.json` and generate `15-AUDIT-REPORT.md` from it
- Run behavioral test suite with 30-min timeout
- Capture structured output for all DOGFOOD criteria

**Plan 15-03 (Wave 3): Publish ledger + closeout**
- Transcribe 7 memory entries to `docs/v2.6-dogfood-ledger.md`
- Add depth-3 placeholder
- Apply REQUIREMENTS.md errata (DOGFOOD-03 .sh→.cjs, DOGFOOD-05 phase enumeration)
- Flag v2.6 milestone complete in ROADMAP.md

Sequential waves — no parallelism needed.

### Audit report criteria classification

DOGFOOD criteria map to categories as follows:
- **DOGFOOD-01** (RPETD content audit): `sampling` — scale to actual pool size
- **DOGFOOD-02** (workflow execution): `indirectly_assessed` — the workflow is structural infrastructure; direct execution would require running a full real task through 5 phases
- **DOGFOOD-03** (verify-v26.cjs existence + exit 0): `deterministic` — file existence check + exit code check
- **DOGFOOD-04** (slash command existence): `deterministic` — file existence + structural grep
- **DOGFOOD-05** (6/6 phases green): `deterministic` — VERIFICATION.md existence per 6 listed phases + frontmatter verdict parse

### RPETD audit implementation approach for audit-rpetd-intelligence.cjs

The binary needs to:
1. Accept a task ID argument
2. Call `amauta.cjs show <task_id> --json` via spawnSync
3. Extract `rpetd` object from the JSON output
4. For each phase (R, P, E, T, D), check for the required structured blocks via string matching
5. Return JSON with per-phase verdict

The RPETD content field names from `amauta show --json` output are not confirmed — the planner should grep `amauta.py` for how RPETD content is stored and returned by the show command. The key question is: does the show JSON include full RPETD text or just metadata?

### Behavioral test result capture

`run-behavioral-tests.cjs` uses `stdio: 'inherit'` — output goes directly to parent process stdout/stderr, not captured. `verify-v26.cjs` must spawn it differently (pipe stdio) to capture output for the JSON report. The planner should note this: `spawnSync('node', ['scripts/run-behavioral-tests.cjs'], { stdio: 'pipe' })` captures stdout/stderr at the cost of losing real-time progress display.

---

## Risks

### R1: audit-rpetd-intelligence.cjs needs RPETD content from amauta show
The exact JSON field name and nesting for RPETD content in `amauta show --json` output is not confirmed in research. If the show command doesn't expose full RPETD text, the audit script can't parse phase content without a separate RPETD display command. **Mitigation:** Planner should grep `amauta.py` for `cmd_show` output structure before finalizing the audit approach. If RPETD content is not in show --json, use `amauta rpetd <task_id>` as the retrieval path.

### R2: Phase 10 VERIFICATION.md location unknown
Phase 10 directory name is not confirmed (it would follow the pattern `10-d-phase-structured-learning` or similar). The 6/6 DOGFOOD-05 check needs all 6 VERIFICATION.md paths. **Mitigation:** verify-v26.cjs should resolve phase dirs dynamically using `resolvePhaseDir()` or `find-phase` gsd-tools subcommand rather than hard-coding directory names.

### R3: Behavioral test stdio capture breaks real-time output
`verify-v26.cjs` using `stdio: 'pipe'` for behavioral tests means the operator can't watch test progress during Wave 2. **Mitigation:** Use `stdio: 'pipe'` but write each test file's output to a temp file as it arrives, then read the temp file back for the report. Or use `spawnSync` with `stdio: 'inherit'` and accept that the report captures only the exit code + console summary line.

### R4: amauta.cjs vs gsd-amauta.cjs confusion
There are two binaries: `amauta.cjs` (the main CLI) and `gsd-amauta.cjs` (the internal daemon wrapper). `verify-v26.cjs` must call the right one. The CONTEXT.md code_context refers to `get-shit-done/bin/gsd-amauta.cjs` for `cmdValidate` with `--pass/--fail/--gaps-found`. Calling `amauta health` should use the user-install path `~/.claude/get-shit-done/bin/amauta.cjs`, not the repo-local one, unless the script is designed for repo-local execution only. **Mitigation:** Planner should lock which path the script uses and document it explicitly.

### R5: Pool size for DOGFOOD-01 sampling may be below n=5
If the number of fully completed v2.6 tasks with complete RPETD content is below 5, the audit must document `"below ROADMAP's assumed sample size of 10"` (per CONTEXT.md Q4). The actual pool size is not known at research time — it depends on how many tasks were registered and completed during phases 10-14 via plan-to-tasks. **Mitigation:** This is a known limitation, not a blocker. Capture whatever pool is available, document the gap.

### R6: pytest failure names within test_pg_integration.py not enumerated in STATE.md
STATE.md says "pytest 3 (test_pg_integration.py)" but does not name the 3 specific tests. The Q9 by-name matching requirement means the audit must run pytest to discover the actual failing test names before it can call them "pre-existing." **Mitigation:** The audit script runs pytest and captures its output at Wave 2 execution time; the names discovered become the baseline in 15-AUDIT-REPORT.json.

---

## Planner Must-Resolve Items

These are gaps discovered in research that the planner must make a decision about before writing plans:

1. **RPETD content retrieval path**: Does `node amauta.cjs show <task_id> --json` return RPETD phase content? Or does the audit need a different command? The planner should grep `amauta.py` for `cmd_show` implementation.

2. **verify-v26.cjs path for amauta health**: The health check calls `amauta health`. Does verify-v26.cjs use the user-install path (`$HOME/.claude/get-shit-done/bin/amauta.cjs`) or the repo-local path? The script lives in `scripts/` and uses `require('../get-shit-done/bin/gsd-tools.cjs')` — consistent repo-local positioning suggests repo-local amauta.cjs as well.

3. **audit-rpetd-intelligence invocation form**: DOGFOOD-01 says `gsd-tools.cjs audit-rpetd-intelligence <task_id>`. CONTEXT.md Q1 says no modification of existing `.cjs` files. CONTEXT.md deliverables list `get-shit-done/bin/audit-rpetd-intelligence.cjs` as a new file. Planner should explicitly resolve whether the DOGFOOD-01 requirement text is a user-facing description (invoked as standalone binary) or a literal CLI subcommand requiring gsd-tools.cjs modification. Evidence points to standalone binary (new file pattern is established).

4. **Behavioral test stdout capture strategy**: Does Wave 2 use `stdio: 'pipe'` (captures for JSON report, loses real-time) or `stdio: 'inherit'` (real-time visible, only captures via console.log intercept)? Recommend `stdio: 'pipe'` with the summary line captured.

5. **Phase 10 directory name**: Glob `.planning/milestones/v2.2-phases/10-*/VERIFICATION.md` at plan time to confirm the exact name.

---

*Phase: 15-dogfood*
*Research gathered: 2026-04-10*
*Researcher: gsd-researcher*

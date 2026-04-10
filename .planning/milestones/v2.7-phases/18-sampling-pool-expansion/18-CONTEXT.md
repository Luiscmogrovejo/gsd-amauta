# Phase 18: Sampling Pool Expansion — Context

**Gathered:** 2026-04-10
**Status:** Ready for planning
**Milestone:** v2.7 "Steady Hands"
**Phase ID:** 18-sampling-pool-expansion
**Requirements:** SAMPLE-01
**Scope ceiling:** ~30 LOC. One function in `scripts/verify-v26.cjs` (the `sampleCompletedTasks` rewrite) plus its tests. Not a full redesign of DOGFOOD-01's sampling methodology — that would be a v2.8 research question. The current fix is the minimum viable broadening: swap the input source, keep the downstream structure.

<domain>
## Phase Boundary

Phase 18 rewrites `sampleCompletedTasks()` at `scripts/verify-v26.cjs:376-395` to query the amauta daemon for `status=done` tasks in the current milestone scope, with graceful fallback to the existing SUMMARY.md scraping when the daemon is unavailable. Introduces a new top-level `sampling_health` field in the audit JSON that makes data source and limitations explicit.

Explicitly **out of scope:**
- Full redesign of DOGFOOD-01 sampling methodology (v2.8 research question)
- Changes to `assessDogfood01()` beyond what the new `sampleCompletedTasks` return shape requires
- New amauta daemon endpoints or CLI subcommands — consume the existing `exec list` / `show` surface
- Fixing the `cmdInitPhaseOp` residual ghost fallback (Phase 16 gap, route to Phase 16.1 — see deferred)
- Fixing the `amauta.cjs` wrapper HTTP routing bug (noted, not in scope)
- Any refactor of `verify-v26.cjs` internal structure "while in there" — same Phase 13 fingerprint the prior v2.7 phases resisted

</domain>

<decisions>
## Implementation Decisions

### GA1 — Daemon Query Interface: shell out to gsd-amauta.cjs CLI

- **Locked:** `child_process.execFileSync('node', ['get-shit-done/bin/gsd-amauta.cjs', 'exec', 'list', '--status', 'done', '--json'])` wrapped in try/catch. On any error (non-zero exit, empty output, parse failure, timeout), fall back to SUMMARY.md scraping with `sampling_degraded: daemon_unavailable` observation.

- **Critical correction to the user-locked answer:** The user's lock named `amauta.cjs`. Investigation during this discuss-phase found that `get-shit-done/bin/amauta.cjs` is a thin HTTP wrapper that routes commands through `/api/exec` and rejects commands like `--help` with "Command '--help' not allowed via /api/exec. Use specific endpoint." The underlying CLI that actually works from the filesystem is `get-shit-done/bin/gsd-amauta.cjs`. Phase 18 MUST use `gsd-amauta.cjs` directly, not the wrapper. Confirmed working via live call in this session.

- **Three reasons (from the locked answer, still apply):**
  1. **Precedent exists in the same file.** `verify-v26.cjs` already shells out to `npm test` and `pytest`. Adding one more shell-out is consistent; introducing HTTP or `require()` would add a third pattern in one file.
  2. **CLI is the documented stable interface.** Daemon HTTP ports are internal implementation; the CLI is the public contract. Audit scripts should consume public contracts, not internals.
  3. **Failure mode is cleanest.** Shell-out failures (non-zero exit, empty output, JSON parse error) are easy to detect and route to fallback. HTTP failures need timeout handling, connection refused detection, and JSON parsing.

- **Critical `--json` output caveat:** During investigation, `gsd-amauta.cjs exec list --status done --json` returned a JSON envelope wrapping ANSI-formatted text: `{"output": "\u001b[96m[TA]\u001b[0m \u001b[1mTK-0001\u001b[0m ..."}`. This is NOT a clean structured task list. The `list` subcommand's `--json` flag is not a proper JSON API. Phase 18's parser MUST either:
  - **Option A:** Parse the envelope's `output` field with regex to extract `TK-\d+` task IDs from the wrapped text (same pattern as the SUMMARY.md scraper, just applied to different text).
  - **Option B:** Investigate whether a different flag or subcommand returns clean JSON (the `show TK-XXXX --json` call DOES return clean structured JSON — perhaps there's a raw-JSON list mode that the investigation missed).

- **Locked strategy:** Start with Option A (regex on `output` field) because it's known to work. If the planner or executor finds a clean raw-JSON list endpoint during implementation, switch to it as an optimization. Document the choice either way.

- **Per-task RPETD enrichment:** After extracting task IDs from `exec list`, the audit script calls `gsd-amauta.cjs show <TK-ID> --json` per task to get clean structured task data (including `rpetd_phases`, `parent`, `metadata`, `tags`, `created_at`). This DOES return proper JSON — confirmed in this session. But see GA3 for whether this happens eagerly or lazily.

### GA2 — Milestone Scope Filter: parent-story prefix OR phase-number regex with investigation note

- **Locked preference:** Filter by task `parent` field, where the parent is an ST-XXXX story whose title or tags include a milestone-version prefix (e.g., `v2.7-phase-18-sampling-pool-expansion`).

- **Required investigation during planning:** Read `get-shit-done/bin/gsd-tools.cjs` (or wherever `plan-to-tasks` is implemented — grep for `plan-to-tasks` in the bin directory) and confirm whether the parent story created during registration has a milestone-prefixed title or tag. The planner MUST verify this assumption before locking the filter strategy.

- **Fallback if parent stories are NOT milestone-prefixed:** Filter tasks by regex on their description/title for a phase-number prefix (`/^[0-9]+(\.[0-9]+)?-/`). This is uglier but works when metadata is absent.

- **Exclude-and-document if neither works:** If tasks from the current milestone have neither a milestone-prefixed parent story nor a phase-number in their description, the sampler excludes those tasks from the pool and records a limitation in `sampling_health.limitations_observed`. Small pools are acceptable per the SAMPLE-01 requirement.

- **Major finding during investigation:** The live amauta daemon in this session has tasks from TK-0001 through TK-0391, all created between 2026-03-13 and 2026-03-14. None of them correspond to v2.7 phase work. Recent test tasks (TK-0375 through TK-0391) are all `GSD-AMAUTA-TEST-TASK-AUTO` placeholder tasks with no v2.7 tags or parents. **The daemon appears to contain NO v2.7 phase tasks.** This is a significant constraint: `plan-to-tasks` auto-registration either didn't run for v2.7 phases, or the tasks are stored in a different database, or the registration is broken. The planner MUST investigate this BEFORE assuming a daemon-query strategy will yield any pool at all. If the daemon contains no v2.7 tasks, Phase 18's daemon-query path is structurally unable to produce a statistically meaningful sample — the fallback to SUMMARY.md scraping becomes the PRIMARY path for this repo's current state, not an edge case.

- **Locked behavior:** If the parent-story filter returns an empty pool because no v2.7 tasks exist, log `sampling_degraded: no_v2.7_tasks_registered` as an additional observation (distinct from `daemon_unavailable`), and fall back to SUMMARY.md scraping. Do NOT collapse to `gaps_found` — record the degradation and proceed.

### GA3 — RPETD Content Return Shape: flat task IDs, lazy loading in consumer

- **Locked:** `sampleCompletedTasks()` returns a flat array of task ID strings (`['TK-0001', 'TK-0002', ...]`). RPETD content is loaded lazily in `assessDogfood01()` via the existing `auditTask(tk)` call. The function contract between `sampleCompletedTasks` and `assessDogfood01` is UNCHANGED.

- **Two reasons:**
  1. **Function contract stability.** `assessDogfood01()` currently expects flat task IDs. Changing the return shape means changing both functions in the same plan, expanding scope beyond SAMPLE-01's ~30 LOC ceiling. Keeping the return shape flat means Plan 18-01 is one function rewrite, not two.
  2. **Lazy loading is already correct for sampling.** The whole point of sampling is that you don't audit every task. Pre-loading RPETD content for all tasks in the pool wastes work because most pool members won't be audited. Lazy load means `auditTask()` only fetches RPETD for tasks that actually get sampled.

- **Requirement errata note:** SAMPLE-01 says "returns a list of task IDs with their RPETD phase content attached." That's the literal requirement text, but it's underspecified. The locked interpretation: "returns task IDs, and the consumer is able to fetch RPETD content per task via `auditTask()` which already exists." The "attached" language refers to the architectural relationship (RPETD content is reachable from the task ID), not the immediate-return shape.

- **Errata fallback:** If the planner or checker pushes back that this violates the requirement text literally, propose errata at Phase 18 closeout: strike "with their RPETD phase content attached" and replace with "task IDs that the consumer can fetch RPETD content for via `auditTask()`." Same pattern as PLAN-04 errata in Phase 14 and DOGFOOD-01/03 errata in Phase 15. Errata is the pressure-release valve.

### GA4 — Degradation Placement: new top-level `sampling_health` field

- **Locked:** Add a new top-level field `sampling_health` to the audit report JSON (alongside `schema_version`, `tooling_bugs_observed`, etc.). NOT inside `tooling_bugs_observed` (that's for tooling defects that need fixing, not runtime environment state). NOT inside DOGFOOD-01 criterion evidence (the verdict is `pass`/`gaps_found`, the degradation is a separate fact about the audit run itself).

- **Schema:**
  ```json
  "sampling_health": {
    "daemon_available": false,
    "pool_source": "summary_md",
    "fallback_used": "summary_md_scraping",
    "pool_size": 7,
    "limitations_observed": [
      "daemon_unavailable: tasks with summaries-only registration excluded from pool"
    ]
  }
  ```
  - `daemon_available`: boolean — was the daemon reachable during this audit run
  - `pool_source`: `"daemon_query"` | `"summary_md"` — which code path populated the pool
  - `fallback_used`: string or null — name of the fallback if the primary path failed (e.g., `"summary_md_scraping"` or null if the primary path worked)
  - `pool_size`: integer — number of tasks in the sampled pool (not the sample size, the pool size)
  - `limitations_observed`: array of strings — human-readable observations about data quality or coverage gaps (e.g., `daemon_unavailable: X`, `no_v2.7_tasks_registered: Y`)

- **Schema version bump:** Phase 17 introduced `schema_version: 2` with `tooling_bugs_observed`. Phase 18 adds `sampling_health`, so bump to `schema_version: 3`.

- **Markdown rendering:** `generateMarkdown()` gets a new `## Sampling Health` section that renders the struct as a bullet list or small table. Position: after `## Behavioral Test Results` and before `## Pre-Existing vs New Failures`, because sampling health is audit methodology, not verdict evidence.

- **Rationale for NOT putting it in `tooling_bugs_observed`:** The Phase 17 semantics lock `tooling_bugs_observed` = "defects in the tooling the audit relies on that produced silent drift." Daemon unavailability is not a bug; it's a runtime environment state. Putting environment state into `tooling_bugs_observed` would inflate the bug count with noise and dilute the signal of real tooling bugs.

### Dual-Path Test Coverage (MANDATORY)

- **Both code paths MUST have test coverage in the same test file:**
  - **Path A (daemon available):** Mock the daemon response via fixture, assert sample pool comes from daemon query, assert `sampling_health.daemon_available: true`, assert `pool_source: "daemon_query"`.
  - **Path B (daemon unavailable):** Simulate daemon failure (shell-out fails), assert fallback to SUMMARY.md scraping, assert `sampling_health.daemon_available: false`, assert `fallback_used: "summary_md_scraping"`, assert `limitations_observed` contains `daemon_unavailable`.

- **Why mandatory:** The daemon state during this discuss-phase session is ambiguous (wrapper fails, direct CLI works, `list --json` returns wrapped text, `show --json` returns clean JSON, no v2.7 tasks exist in the database). Whichever state the executor's session happens to land in will exercise only one path. If the executor only writes tests for whichever path the current environment allows, the other path is untested and will silently break later. This is the HARDEN-05 lesson from Phase 13.1 — "tests are easier this way" compresses away behavioral coverage.

- **Implementation hint:** Mock the daemon by monkey-patching `child_process.execFileSync` in the test file, OR by putting the daemon query behind a small indirection (e.g., `queryDaemonOrThrow()`) that tests can stub. The indirection approach is preferred because it's cleaner than monkey-patching and easier to reason about.

### Claude's Discretion

- Exact regex for extracting TK-IDs from the `{"output": "..."}` envelope (basename-like pattern is fine)
- Whether the test file imports from `scripts/verify-v26.cjs` directly or via a test helper
- Exact wording of the `sampling_health.limitations_observed` strings (provided they name the specific degradation mode)
- How many iterations the sampler runs (sample size of N=10 from the pool is currently hardcoded in `assessDogfood01`; no change needed to that constant)
- Whether to retry the daemon call once before falling back (probably no — fall-fast is cleaner)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirement definitions
- `.planning/REQUIREMENTS.md` § "Phase 18: Sampling Pool Expansion" — SAMPLE-01 text, scope ceiling, acceptance criteria
- `.planning/ROADMAP.md` § "Phase 18: Sampling Pool Expansion" — goal statement, success criteria, pitfalls prevented

### The audit script itself
- `scripts/verify-v26.cjs` § `sampleCompletedTasks` (line 376) — the function to rewrite
- `scripts/verify-v26.cjs` § `assessDogfood01` (line 397) — the consumer that still expects flat task IDs (contract must stay stable)
- `scripts/verify-v26.cjs` § `buildReport` (line 512+) — where `sampling_health` field lives
- `scripts/verify-v26.cjs` § `generateMarkdown` (line 526+) — where the Sampling Health section renders

### Amauta daemon surface
- `get-shit-done/bin/gsd-amauta.cjs` — the WORKING CLI (use this directly, NOT `amauta.cjs` wrapper)
- `get-shit-done/bin/amauta.cjs` — HTTP wrapper that fails for audit script usage (documented constraint)
- `get-shit-done/bin/audit-rpetd-intelligence.cjs` § `auditTask` — per-task RPETD audit function (still called lazily in `assessDogfood01`)

### Investigation targets during planning
- `get-shit-done/bin/gsd-tools.cjs` § `plan-to-tasks` — check whether parent story created during registration has a milestone-prefixed title/tag (determines GA2 filter strategy)
- Any `plan-to-tasks.cjs` or equivalent helper file

### Phase 15 prior decisions (locked, carry forward)
- `.planning/milestones/v2.2-phases/15-dogfood/15-CONTEXT.md` § Q10 — Self-exclusion list for recursive scope

### Phase 17 schema precedent
- `.planning/milestones/v2.7-phases/17-audit-script-hardening/17-CONTEXT.md` § GA4 (tooling_bugs_observed) — schema versioning precedent, field placement rationale (semantics differ: tooling_bugs vs sampling_health)

### Divergence protocol (applies during execution)
- `get-shit-done/references/divergence-protocol.md` v1.1.0 — Phase 13 fingerprint protection

### HARDEN-01 manifest enforcement
- `get-shit-done/bin/gsd-tools.cjs` § `manifestCheck` — active for all v2.7 tasks

### Test patterns
- `tests/17-audit-script-hardening.test.cjs` — most recent precedent, same file being modified
- `tests/16-init-resolver.test.cjs` — temp-dir fixture pattern (relevant for SUMMARY.md fallback test)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`sampleCompletedTasks()` at line 376-395:** 20-line function. The rewrite keeps the function name and return signature (flat task IDs), swaps the body.
- **`assessDogfood01()` at line 397:** Consumer. Currently calls `auditTask(tk)` for each task in `pool.slice(0, 10)`. This call-site is UNCHANGED by Phase 18 — GA3 locks lazy RPETD loading.
- **`AUDITED_PHASES` constant (line 23):** Currently `["10", "11", "12", "13", "13.1", "14"]`. The SUMMARY.md scraping walks these phase directories. The daemon query does NOT use this constant (it queries by milestone scope, not by phase list), but the fallback path still uses it.
- **`findPhaseDir()` helper:** Used by both `sampleCompletedTasks()` and `checkVerificationFiles()`. No changes needed.
- **Phase 17's `TOOLING_BUGS_SEED` constant pattern:** Precedent for how to add a new top-level schema field. Phase 18 follows the same pattern for `sampling_health`, though the value is computed at audit time rather than a static constant.
- **`child_process.spawnSync` pattern:** Already used for `npm test` and `pytest` at lines 148 and 166. Phase 18's daemon shell-out can use the same pattern (or `execFileSync` — same module, slightly different ergonomics).

### Established Patterns

- **Shell-out for external commands:** `spawnSync('npm', ['test', '--silent'], {...})`. Phase 18 adds `spawnSync('node', ['get-shit-done/bin/gsd-amauta.cjs', 'exec', 'list', '--status', 'done', '--json'], {...})`.
- **Graceful degradation:** Phase 17 established the pattern of "hard error on drift, soft error on environment." SAMPLE-01 extends it to sampling: daemon unavailable is a soft error (degrade + continue), not a hard failure.
- **Structured fields in report:** `hygiene_debt_observed`, `tooling_bugs_observed`, `new_failures_surfaced` all live at the top level of the report JSON. `sampling_health` follows the same flat structure.

### Integration Points

- **`buildReport()` → `generateMarkdown()`:** The report JSON is the single source of truth. Any new field in `buildReport` needs a corresponding renderer in `generateMarkdown`.
- **`schema_version` bump:** Phase 17 set it to 2. Phase 18 bumps to 3. Downstream consumers of the report can check version to know which fields are present.
- **`sampling_health` vs `tooling_bugs_observed`:** These are semantically distinct. Tooling bugs are defects in the audit tooling itself. Sampling health is the runtime state of the audit's data source. A human reader should see them in different sections of the Markdown.

### Bootstrap Observations from Investigation

- **Daemon IS running in this session.** The `gsd-amauta.cjs health` command returned exit 0, and `gsd-amauta.cjs exec list --status done` returned ~200 tasks. The earlier ambiguity was because `amauta.cjs` (the wrapper) routes through `/api/exec` and rejects commands the direct CLI accepts.
- **The `list --json` output is an envelope, not structured data.** `{"output": "<ANSI-formatted text>"}`. Phase 18's parser must either regex the text or find a different endpoint.
- **`show TK-XXXX --json` returns clean JSON.** Full schema with `id`, `title`, `description`, `parent`, `tags`, `metadata`, `rpetd_phases`, `created_at`, `status`, etc.
- **No v2.7 tasks exist in the daemon database.** Latest TK-ID is 0391, all created 2026-03-14, all named `GSD-AMAUTA-TEST-TASK-AUTO`. This is a CRITICAL finding for the planner: `plan-to-tasks` auto-registration may not have run for any v2.7 phase. Phase 18's daemon-query path will return an empty pool for the current repo state, and the fallback to SUMMARY.md scraping will be the EFFECTIVE primary path, not an edge case. The plan should treat this as expected behavior and ensure the fallback path produces a meaningful sample from v2.7 SUMMARYs.

</code_context>

<specifics>
## Specific Ideas

- **The `amauta.cjs` wrapper vs `gsd-amauta.cjs` CLI distinction is load-bearing.** Use `gsd-amauta.cjs` directly. The wrapper's `/api/exec` routing rejects audit-script-friendly commands.
- **The `list --json` envelope format is:** `{"output": "\u001b[...]TK-0001\u001b[...]..."}`. Strip ANSI escape sequences before regex (or use a regex that matches `TK-\d+` which isn't affected by ANSI codes).
- **For the daemon-available test path:** Mock the shell-out to return a canned envelope like `'{"output": "TK-0001 done\\nTK-0002 done\\n"}'` and verify the parser extracts both IDs.
- **For the daemon-unavailable test path:** Mock the shell-out to throw `ENOENT` or return non-zero exit, verify fallback runs and `sampling_health.daemon_available` is false.
- **For the parent-story filter investigation:** Grep `get-shit-done/bin/gsd-tools.cjs` for `plan-to-tasks` or `plan_to_tasks`. If the function sets a parent story with a milestone-prefix, use the prefix filter. If not, use phase-number regex on task description. If neither works for the current repo, exclude and document.
- **Known pre-existing pool:** Even with SUMMARY.md fallback, Phase 18 should produce a pool of at least 5 tasks from v2.7 SUMMARYs (16-01, 16-02, 16-03, 17-01, 17-02). The scraper grepping for `TK-\d+` in these files is likely to find few or none because v2.7 plans don't cite TK-IDs in their summaries — which means the SUMMARY.md fallback is ALSO broken for v2.7's current state. This is a meta-finding: the entire sampling approach (daemon OR scrape) may yield zero tasks for v2.7, making `sampling_health.pool_size: 0` the expected output. Plan accordingly.

</specifics>

<deferred>
## Deferred Ideas

- **Phase 16 gap: `cmdInitPhaseOp` residual ghost fallback** — Phase 16 fixed `findPhaseInternal` but the init subcommand wrappers retain a fallback path that returns archived-milestone matches when the primary resolver returns null. This fired at Phase 17 discuss-phase and again at Phase 18 discuss-phase. Routed to **Phase 16.1 gap closure** or a v2.7 closeout follow-up. NOT Phase 18's concern. Captured in `project_phase18_init_resolver_residual_dogfood.md` memory entry (depth 11).
- **`amauta.cjs` wrapper HTTP routing bug** — The wrapper rejects commands that the direct CLI accepts. Should be a v2.8+ cleanup or a separate bug fix. NOT Phase 18's concern.
- **`list --json` returning wrapped text envelope** — The daemon CLI's `--json` flag is not a clean JSON API. This is a daemon-side bug or feature that should be addressed in a future phase. For Phase 18, work around it by parsing the envelope.
- **`plan-to-tasks` auto-registration not running for v2.7 phases** — If investigation confirms this is a real gap (v2.7 tasks are not in the daemon database), it's a v2.8 infrastructure phase, NOT Phase 18's concern. Phase 18 documents the limitation in `sampling_health.limitations_observed` and continues. Do NOT absorb "fix plan-to-tasks for v2.7" into Phase 18.
- **Full DOGFOOD-01 sampling methodology redesign** — Statistical rigor, random vs stratified sampling, pool size thresholds, significance testing. v2.8 research question. Phase 18 is the minimum viable broadening.
- **Dogfood ledger depth 11 entry publication** — The init resolver residual ghost firing at Phase 17 and Phase 18 discuss-phase init should eventually be added to `docs/v2.6-dogfood-ledger.md` or a `v2.7-dogfood-ledger.md`. Route to Phase 16.1 or v2.7 closeout alongside the fix itself.

</deferred>

<positive_observations>
## Positive Observations (not depth entries, not ledger-bound)

- **The orchestrator caught the cmdInitPhaseOp residual ghost on the first init call without being flagged.** The Phase 17 precedent and the v2.6 depth 7/8 entries primed the discipline. The pattern "init resolver returned a cross-milestone ghost path" is now automatic recognition — no pre-warning required.
- **The daemon investigation surfaced three load-bearing findings in one pass:** (1) `amauta.cjs` wrapper vs `gsd-amauta.cjs` CLI distinction; (2) `list --json` envelope format; (3) zero v2.7 tasks in the daemon. All three would have caused Phase 18 execution failures if discovered during plan or execute. Finding them at discuss-phase is exactly the right surface.
- **The user's locked answers corrected a Claude assumption in real time.** The user locked shell-out to `amauta.cjs`, the investigation found `amauta.cjs` is a failing wrapper, the CONTEXT.md corrects the lock to `gsd-amauta.cjs` with the reasoning preserved. The builder-mentor pattern at work — user locks intent, Claude verifies against reality, both inform the final decision.

</positive_observations>

---

*Phase: 18-sampling-pool-expansion*
*Context gathered: 2026-04-10*
*Next: `/amauta:plan-phase 18`*

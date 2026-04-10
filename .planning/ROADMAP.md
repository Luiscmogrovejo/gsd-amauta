# Roadmap: GSD-Amauta v2.7 "Steady Hands"

**Milestone:** v2.7 — Steady Hands (Hardening Milestone)
**Starting phase number:** 16 (previous milestone v2.6 ended at phase 15)
**Phases:** 4 (Phase 16..19)
**Requirements:** 7 total (v2.7 scope)
**Granularity:** coarse (per config.json)
**Primary input:** `docs/v2.6-dogfood-ledger.md` § "Routed follow-ups (Phase 16 / v2.7)" — 7 items clustered into 4 phases
**Research:** skipped (no external domain to research; v2.7 is hardening of code the team wrote during v2.6). The v2.6 dogfood ledger IS the research input.
**Status:** Defined 2026-04-11 — awaiting `/amauta:plan-phase 16`

**Core value:** Every RPETD phase must see what other phases have already learned — past failures, validated best-practices, existing codebase style, parent-story acceptance criteria — so the system makes better decisions with each task it runs, not worse as context bloats. The brain synthesizes, not accumulates.

**Body-metaphor sequence:** v2.5 "Smarter Brain" (cognition) → v2.6 "Sight Beyond Sight" (perception) → v2.7 "Steady Hands" (action/tooling). This is the milestone where the tooling stops shaking. After v2.5 gave the system a brain and v2.6 gave it eyes, v2.7 fixes the hands so that when the eyes see a problem, the hands can act on it without producing the same divergence event for the fourth time.

**Ship order is dependency-driven:** 16 (resolver) → 17 (audit script) → 18 (sampling) → 19 (schema). Phase 16 must ship first because every other phase's executor will use the resolver to locate its own phase directory; fixing the resolver early means Phases 17-19 run against a clean init surface. Phases 17-19 are sequential because each builds on the audit surface the previous one stabilized: Phase 17 stabilizes `verify-v26.cjs` (the audit script itself), Phase 18 broadens the sampling pool the audit consumes, and Phase 19 modernizes the schema the audit emits.

**Total v2.7 scope: ~250 LOC of surgical fixes** — the smallest milestone since v2.3. This is deliberate. Hardening milestones should feel small.

---

## Hard Constraints (apply to every phase)

1. **Scope ceilings are load-bearing.** Each phase has a declared LOC ceiling in its deliverable table. Exceeding the ceiling without an explicit divergence report is a Phase 13 fingerprint and triggers halt-phase.
2. **Post-13.1:** HARDEN-01 manifest enforcement is active for every task in this milestone. `files_expected` blocks with all three subfields (`modify` / `create` / `delete`) are mandatory per task. No grandfather clause applies — v2.7 phases are all newly authored.
3. **Post-14:** `gsd-tools plan-to-tasks` auto-registration is mandatory for any phase that touches the orchestrator or its adjacent tooling. Every PLAN.md must have `<story>` and `<task>` XML blocks with `metadata.plan_local_id` identity. Phase 16 (which touches `gsd-tools.cjs`) definitely applies; Phases 17-19 touch `scripts/verify-v26.cjs` which is orchestrator-adjacent audit tooling and the hard cutoff also applies.
4. **Divergence protocol v1.1.0 active:** any plan-vs-reality mismatch during execution triggers the STOP → `divergence_report` JSON → exit non-zero flow. Surface mismatches; never silently absorb them.
5. **Dogfood ledger continues.** New depths captured during v2.7 are added to `docs/v2.6-dogfood-ledger.md` (or its v2.7 successor per Phase 19). **Depth 3 is still open.** Phase 16 is a candidate to fill depth 3 if a sub-task-level rationalization surfaces during the resolver fix (e.g., "while I'm in the resolver code I should also fix items 3-7").
6. **No out-of-scope fixes.** The 7 routed follow-ups from the v2.6 ledger are the complete v2.7 scope. Any other bugs noticed during execution are v2.8 candidates, not phase expansions. Surface via divergence report, do not absorb.
7. **No new mandates.** v2.7 is a hardening milestone, not a mandate-expansion milestone. No new RPETD phase mandates, no new kill switches, no new D-phase formats. The existing v2.6 kill switches (`GSD_D_STRUCTURED`, `GSD_E_MANDATE`, `GSD_T_SPEC_INHERIT`, `GSD_R_CREATIVE`, `GSD_P_AUTO_TASK`, `GSD_MANIFEST_CHECK`) cover the behavioral surface unchanged.
8. **Green test gate.** `npm test && pytest` must pass with 0 new failures before each phase is marked complete. Pre-existing failures from the v2.6 baseline (4 known npm failures in `rlm-workflow-spec`, `agent-frontmatter`, `comprehensive-e2e`, `gsd-amauta`) are tolerated until Phase 17's AUDIT-02 regex fix surfaces them in the audit report.

---

## Phases

- [x] **Phase 16: Init Resolver Fix** — milestone-scoped resolver + `--phase-dir` override so cross-milestone phase-number collisions stop returning ghost directories (RESOLVE-01..02) — COMPLETE 2026-04-10
- [ ] **Phase 17: Audit Script Hardening** — `verify-v26.cjs` prefix-form probe, npm failure parser, and `tooling_bugs_observed` schema category so the audit script stops producing silent false negatives (AUDIT-01..03)
- [ ] **Phase 18: Sampling Pool Expansion** — `sampleCompletedTasks()` queries the amauta daemon's RPETD logs instead of scraping SUMMARY text so DOGFOOD-01 stops collapsing to n=1 (SAMPLE-01)
- [ ] **Phase 19: Dynamic Ledger Schema** — runtime filesystem scan of memory directory populates `dogfood_ledger_depths_captured` so depths discovered during execution stop getting orphaned from the audit JSON (SCHEMA-01)

---

## Phase Details

### Phase 16: Init Resolver Fix

**Goal:** The `gsd-tools init` family of commands resolves phase directories within the current milestone only, and operators can bypass the resolver entirely with an explicit `--phase-dir` override when needed.

**Depends on:** nothing (v2.6 is complete; this phase starts from a clean baseline)

**Requirements:** RESOLVE-01, RESOLVE-02

**Scope ceiling:** ~100 LOC across `get-shit-done/bin/lib/init.cjs` and `get-shit-done/bin/gsd-tools.cjs`, plus tests. Hard do-not-expand. Any temptation to also fix items 3-7 "while in the resolver code" gets surfaced as a divergence observation, not absorbed.

**Files expected (preview, to be finalized per-task in PLAN.md):**
- modify: `get-shit-done/bin/lib/init.cjs`, `get-shit-done/bin/gsd-tools.cjs`
- create: `tests/16-init-resolver.test.cjs` (or equivalent test file covering the three cases)
- delete: []

**Success Criteria (what must be TRUE for users after Phase 16 ships):**

1. **Cross-milestone ghost directory bug no longer fires.** Running `gsd-tools init execute-phase 15` from a v2.7 context returns `phase_found: false` with a clear "no Phase 15 in current milestone v2.7" diagnostic, instead of silently resolving to the v2.3-phases or v2.2-phases directory that happens to have a `15-*` entry. The three fire events from v2.6 (depths 7, 8, and the closeout edit) cannot reoccur because the resolver now consults ROADMAP.md to identify the current milestone before walking directories.
2. **Operator escape hatch exists.** Running `gsd-tools init execute-phase 15 --phase-dir .planning/milestones/v2.2-phases/15-dogfood/` resolves to that exact directory without consulting the resolver at all. The override works across all four phase-aware init subcommands (`phase-op`, `execute-phase`, `plan-phase`, `verify-work`) and the `--phase-dir` flag is documented in each subcommand's help text.
3. **"No match" is a distinct outcome from "wrong match".** When a phase number has zero matches in the current milestone, the resolver returns `phase_found: false` with an explicit message, rather than falling back to a historical match from an archived milestone. Operators can distinguish "this phase doesn't exist yet" from "I pointed at the wrong phase."
4. **Tests cover the three cases that caused real-world drift.** Test suite exercises (a) the cross-milestone collision case where N matches directories in both v2.7-phases and an archived milestone, (b) the `--phase-dir` override bypass path, and (c) the "no match in current milestone" path. The tests are runnable via the standard `npm test` harness.

**Pitfalls prevented:**
- **Phase 13 fingerprint: "while I'm in the resolver code" scope expansion.** HARDEN-01 manifest enforcement catches this deterministically by rejecting edits to files not in `files_expected`. The divergence protocol v1.1.0 catches the behavioral form by requiring a STOP + divergence_report when the plan-vs-reality mismatch surfaces.
- **Silent cross-milestone drift.** The root cause of depths 7, 8, and the v2.6 closeout incident is first-match-by-numeric-prefix across all historical `v*.*-phases/` folders. Replacing the lookup with a milestone-scoped search via ROADMAP.md cross-reference makes this class of bug structurally impossible.

**Rollback plan:** Revert the two modified files (`init.cjs` and `gsd-tools.cjs`) and delete the new test file. No schema changes, no data migration, no orchestrator state changes, no kill switch to toggle. Clean rollback, no side effects.

**Dogfood depth 3 candidate:** Phase 16 is the primary candidate to fill depth 3 in the dogfood ledger (currently open). Depth 3 is a sub-task-level rationalization catch — if the executor notices a temptation to refactor adjacent code "while here" and surfaces it as an observation instead of absorbing it, that's a depth-3 event. The resolver fix has a high density of "while I'm here" temptations (item 3 in the same file, item 4 in a neighbor), so the dogfood surface is rich.

**Plans:** 3/3 plans complete

---

### Phase 17: Audit Script Hardening

**Goal:** `scripts/verify-v26.cjs` stops producing silent false negatives: it finds prefixed verification files, parses real npm runner output, and emits a distinct `tooling_bugs_observed` category so the class of findings that routed from Phase 15 Wave 2 can land in the machine-readable audit trail.

**Depends on:** Phase 16 (shares test infrastructure patterns; Phase 16's clean init surface also makes future re-runs of the audit script deterministic across milestones)

**Requirements:** AUDIT-01, AUDIT-02, AUDIT-03

**Scope ceiling:** ~80 LOC confined to `scripts/verify-v26.cjs` plus tests. Any temptation to refactor the audit script's internal structure "while in there" gets surfaced as a divergence observation. The three fixes are additive, not structural.

**Files expected (preview, to be finalized per-task in PLAN.md):**
- modify: `scripts/verify-v26.cjs`
- create: `tests/17-audit-script-hardening.test.cjs` (or equivalent) plus any fixture files needed for npm output parsing
- delete: []

**Success Criteria (what must be TRUE for users after Phase 17 ships):**

1. **Phase 14's `14-VERIFICATION.md` is discoverable.** Re-running `node scripts/verify-v26.cjs` against the v2.6 codebase produces an audit report where DOGFOOD-05 marks Phase 14 as `present` instead of `missing`. The prefix-form probe (`<phase>-VERIFICATION.md`) wins when both forms exist; unprefixed `VERIFICATION.md` remains the fallback. Tests cover both naming conventions and the collision case where both files exist.
2. **npm pre-existing failures are captured by name, not just count.** `pre_existing_failures_verified` in the audit JSON contains structured entries `{ test_file, test_name, reason }` for the four known v2.6 npm failures (`rlm-workflow-spec.test.cjs`, `agent-frontmatter.test.cjs`, `comprehensive-e2e.test.cjs`, `gsd-amauta.test.cjs`), matching the locked CONTEXT.md Q9 rule ("match by name, not count") on the npm side the same way the pytest side already does.
3. **Tooling bugs have a place to land in the audit JSON.** `15-AUDIT-REPORT.json` has a new `tooling_bugs_observed: []` field distinct from `hygiene_debt_observed: []`. The generator function emits both sections in the Markdown report with separate headings, and a human reader of the rendered audit can tell "defect in the tooling the audit itself relies on" apart from "known accumulated debt that won't affect audit correctness."
4. **The v2.6 ledger depths 7 and 8 are encoded in the JSON after re-running the audit post-Phase 17.** The audit run against the v2.6 codebase populates `tooling_bugs_observed` with at least the two resolver-bug entries, closing the schema-orphan gap for those two depths. Depths 8 and 9 are addressed structurally by Phase 19 (dynamic scan); here they finally have a machine-readable home at the report level.
5. **Schema version is bumped.** `15-AUDIT-REPORT.json` gains a version field increment (or equivalent provenance marker) so downstream consumers of the report can tell Phase 17's schema apart from the Wave 1 schema.

**Pitfalls prevented:**
- **Silent false negatives in the audit script itself.** Before Phase 17, the audit script's three bugs produced a report that looked clean but had three known gaps the Wave 2 executor had to document in a sidecar ledger. After Phase 17, the audit report is self-describing.
- **"While I'm in the audit script" refactor temptation.** `verify-v26.cjs` is a single file with significant internal complexity. Manifest enforcement restricts edits to the three named functions. Divergence protocol catches any attempt to absorb a broader refactor.

**Rollback plan:** Revert the single modified file and delete the new test file. The audit JSON schema change is additive (`tooling_bugs_observed: []` defaults to empty list) so downstream consumers that haven't learned the new field continue to work. Clean rollback.

**Plans:** 1/2 plans complete (17-01: three-fix bundle in scripts/verify-v26.cjs DONE 2026-04-10; 17-02: regression tests in tests/17-audit-script-hardening.test.cjs pending). 5/8 tasks complete.

---

### Phase 18: Sampling Pool Expansion

**Goal:** DOGFOOD-01 stops collapsing to n=1 because `sampleCompletedTasks()` queries authoritative task state (RPETD logs via the amauta daemon) instead of scraping SUMMARY.md text for `TK-\d+` pattern matches. Audits against v2.7 produce statistically meaningful sampling pools.

**Depends on:** Phase 17 (audit script surface must be stable before changing how one of its functions consumes data; Phase 17 ships `verify-v26.cjs` changes first, then Phase 18 touches the same file)

**Requirements:** SAMPLE-01

**Scope ceiling:** ~30 LOC. One function in `scripts/verify-v26.cjs` (the `sampleCompletedTasks` rewrite) plus its tests. Not a full redesign of DOGFOOD-01's sampling methodology — that would be a v2.8 research question. The current fix is the minimum viable broadening: swap the input source, keep the downstream structure.

**Files expected (preview, to be finalized per-task in PLAN.md):**
- modify: `scripts/verify-v26.cjs`
- create: `tests/18-sampling-pool.test.cjs` (or equivalent)
- delete: []

**Success Criteria (what must be TRUE for users after Phase 18 ships):**

1. **Sampling pool reflects actual task population, not SUMMARY happenstance.** Running `verify-v26.cjs` against the v2.7 codebase with the amauta daemon available produces a DOGFOOD-01 verdict with a sampling pool of at least 5 tasks (v2.7 has 4 phases × ~3 plans each ≈ 12 tasks, plus sub-tasks). The n=1 collapse observed in v2.6 is structurally prevented because the sampler no longer depends on SUMMARY.md happening to cite a TK-ID.
2. **RPETD-phase compliance rate is measurable.** The audit surfaces the percentage of sampled tasks that have all 5 RPETD intelligence checks firing (Layer 1 enrichment, creative research, PRE_EXECUTION_EVIDENCE, QA block, structured learning) across the sampled pool. Before Phase 18, DOGFOOD-01 could only report "1 task checked" with no statistical weight; after, it reports a percentage across a meaningful pool.
3. **Graceful degradation when the daemon is unavailable.** When the amauta daemon is unreachable (wrong port, not running, permission denied), the function falls back to the old SUMMARY-scraping behavior and logs a `sampling_degraded: daemon_unavailable` observation in the audit report. The audit does not hard-fail because of infrastructure state; it reports the degradation and continues.
4. **Small pools are evidence, not failures.** When the sampling pool is below 5 tasks (e.g., a hotfix milestone with only 2 tasks), DOGFOOD-01 records the pool size as part of the evidence and does NOT collapse to `gaps_found` automatically. Small pools are a finding about project scope, not an audit failure verdict. This matches how the other DOGFOOD-* criteria handle low-signal situations.

**Pitfalls prevented:**
- **Statistical theater.** An n=1 sampling pool masquerading as evidence of compliance across a 46-requirement milestone is not honest evidence. Phase 18 makes the sampling either statistically meaningful or honestly degraded.
- **Infrastructure coupling absorbed silently.** The SUMMARY-scraping approach created an implicit coupling between "executor remembered to cite a TK-ID in SUMMARY text" and "audit sampling works." Phase 18 replaces this with the daemon query, which has an explicit degradation path.

**Rollback plan:** Revert the single modified file and delete the new test file. If rollback leaves the daemon-query path in other phases' code, the fallback behavior (SUMMARY scraping) continues to work. Clean rollback.

**Plans:** To be atomized by `/amauta:plan-phase 18`. Expected 1 plan (single function rewrite, cohesive scope).

---

### Phase 19: Dynamic Ledger Schema

**Goal:** The `dogfood_ledger_depths_captured` field in `15-AUDIT-REPORT.json` reflects the state of the memory directory at audit run time, not the state at Wave 1 authoring time. Depths discovered during execution itself are automatically included in subsequent audit runs without any code change.

**Depends on:** Phase 18 (same file, sequential edits; also, Phase 18's sampling fix and Phase 19's ledger scan both demonstrate the pattern of replacing static Wave-1 data with runtime queries, so Phase 19 builds conceptually on Phase 18's infrastructure)

**Requirements:** SCHEMA-01

**Scope ceiling:** ~40 LOC. One new function (`scanDogfoodLedgerDepths()`) in `scripts/verify-v26.cjs` plus its tests. The filesystem scan pattern is already used elsewhere in the script (for phase directory walks), so the addition is structurally straightforward.

**Files expected (preview, to be finalized per-task in PLAN.md):**
- modify: `scripts/verify-v26.cjs`
- create: `tests/19-ledger-scan.test.cjs` (or equivalent) plus memory directory fixture
- delete: []

**Success Criteria (what must be TRUE for users after Phase 19 ships):**

1. **The audit report reflects reality at audit run time, not Wave 1 authoring time.** Running `verify-v26.cjs` during v2.7 closeout produces a `dogfood_ledger_depths_captured` field containing `[0, 1, 2, 4, 5, 6, 7, 8, 9]` with `gaps: [3]` — matching the actual state of the v2.6 ledger at the moment of the audit run. This closes the meta-finding from the v2.6 Limitations section (schema-orphaned depths 8 + 9) structurally.
2. **Newly captured depths auto-include without code change.** If v2.7 execution itself captures a new depth — for example, Phase 16's executor catching depth 3 during the resolver fix, or a future milestone capturing depth 10+ — that depth appears in the subsequent audit run's JSON automatically. The audit script's depth list is never stale because it is never hard-coded.
3. **Graceful degradation when memory is unreachable.** When the memory directory is unreachable (wrong path, permission denied, running outside a Claude Code context), the function logs a `ledger_scan_degraded: memory_unavailable` observation in the audit report and falls back to a static depth list for backward compatibility. The audit does not hard-fail because of infrastructure state.
4. **Gap identification is structural, not manually maintained.** The function identifies the gap set (the list of missing depth numbers between 0 and the max observed depth) automatically by set difference. The "depth 3 still open" observation is no longer a hand-maintained note in the ledger prose — it is emitted by the audit script from the actual filesystem state.
5. **The parser tolerates both YAML frontmatter and first-line-of-body depth annotations.** Memory entries use two conventions for depth annotation depending on when they were authored. The parser handles both so the historical ledger entries are not retroactively orphaned by the new scanner.

**Pitfalls prevented:**
- **Schema ossification.** A static list in a Wave-1 script forces every future depth to either retrofit the script or get orphaned. Phase 19 makes the schema self-healing against exactly the kind of meta-findings the dogfood discipline is designed to surface.
- **"This audit is a snapshot" rationalization.** The v2.6 Limitations section documented the schema-orphan gap as a "we accept the JSON is a snapshot" rationalization. Phase 19 closes that rationalization by making the snapshot dynamic. The resistance-to-fix ratio flips: instead of 1 snapshot orphan, 0 dynamic scans, the new ratio is 0 orphans, 1 scan.

**Rollback plan:** Revert the single modified file and delete the new test file. The field name `dogfood_ledger_depths_captured` is unchanged, so downstream consumers that read the field continue to work against the pre-Phase-19 static output after rollback. Clean rollback.

**Plans:** To be atomized by `/amauta:plan-phase 19`. Expected 1 plan (new function + parser + tests, cohesive scope).

---

## Phase Dependency Graph

```
Phase 16 (Init Resolver Fix) ──> unlocks clean init surface for all downstream phases
    │                             (Phases 17-19 all use gsd-tools init execute-phase
    │                              to locate their own phase directory)
    ▼
Phase 17 (Audit Script Hardening) ──> stabilizes verify-v26.cjs for Phase 18's sampling work
    │                                  (three additive fixes land in one file before it
    │                                   gets edited again in Phase 18)
    ▼
Phase 18 (Sampling Pool Expansion) ──> provides real sampling pool for DOGFOOD-01 re-audit
    │                                   (daemon query replaces SUMMARY scrape; demonstrates
    │                                    the runtime-query-over-static-data pattern that
    │                                    Phase 19 generalizes)
    ▼
Phase 19 (Dynamic Ledger Schema) ──> final v2.7 deliverable, closes schema-orphan meta-finding
                                     (runtime memory directory scan replaces Wave 1 static
                                      depth list; audit JSON becomes self-describing)
```

**Critical path:** 16 → 17 → 18 → 19 (strictly sequential). No parallelization possible because Phases 17-19 all edit `scripts/verify-v26.cjs`. Phase 16 is technically parallelizable with the others since it touches different files, but is sequenced first to unblock the clean init surface that downstream phases rely on for their own execute-phase invocations.

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|---|---|---|---|
| 16. Init Resolver Fix | 2/2 | Complete    | 2026-04-10 |
| 17. Audit Script Hardening | 2/2 | Planned     | - |
| 18. Sampling Pool Expansion | 0/? | Not started | - |
| 19. Dynamic Ledger Schema | 0/? | Not started | - |

---

## Milestone Exit Criteria

v2.7 "Steady Hands" ships when all of the following are TRUE:

1. All 7 v2.7 requirements (RESOLVE-01..02, AUDIT-01..03, SAMPLE-01, SCHEMA-01) marked Done in REQUIREMENTS.md traceability table.
2. All 4 phases (16, 17, 18, 19) pass their individual VERIFICATION.md gate.
3. `npm test && pytest` passes with 0 new failures against the v2.6 baseline (pre-existing failures tolerated; new regressions not).
4. Re-running `node scripts/verify-v26.cjs` against the v2.7 codebase produces an audit report where:
   - Phase 14 is marked `present` (AUDIT-01)
   - `pre_existing_failures_verified` contains npm entries matched by name (AUDIT-02)
   - `tooling_bugs_observed` contains at least depths 7 and 8 (AUDIT-03)
   - DOGFOOD-01 sampling pool is >= 5 tasks (SAMPLE-01)
   - `dogfood_ledger_depths_captured` is populated via runtime scan, not a static list (SCHEMA-01)
5. `gsd-tools init execute-phase 15` from a v2.7 context returns `phase_found: false` instead of a v2.3 ghost directory (RESOLVE-01).
6. `gsd-tools init execute-phase 15 --phase-dir <path>` bypasses the resolver (RESOLVE-02).
7. Dogfood ledger updated with any new depths captured during v2.7 execution (depth 3 candidate from Phase 16, plus any incidental captures from Phases 17-19).
8. MILESTONES.md gains a `## Complete: v2.7` entry archiving the four phases.
9. `.planning/ROADMAP.md` is either archived to `.planning/milestones/v2.7-ROADMAP.md` and replaced by the next milestone's ROADMAP, or marked with a `Status: COMPLETE` header and left in place until the next milestone begins.

---

*Roadmap created: 2026-04-11 for v2.7 Steady Hands milestone.*
*Primary input: docs/v2.6-dogfood-ledger.md (9 captured depths, 7 routed follow-ups)*
*Research: skipped (hardening milestone on code we wrote; no external domain)*
*Previous milestone (v2.6 Sight Beyond Sight) archived to .planning/milestones/v2.6-ROADMAP.md*

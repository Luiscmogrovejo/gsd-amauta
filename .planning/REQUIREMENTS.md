# Requirements: GSD-Amauta v2.7 "Steady Hands"

**Defined:** 2026-04-11
**Core Value:** Every RPETD phase must see what other phases have already learned — past failures, validated best-practices, existing codebase style, parent-story acceptance criteria — so the system makes better decisions with each task it runs, not worse as context bloats.

**Milestone Goal:** Close the loops that the v2.6 audit phase opened. Fix the tooling bugs that caused the most real-world friction during v2.6 (the init resolver fired as a dogfood event three times — depths 7, 8, and again during v2.6 closeout), harden the audit script that Phase 15 trusted to produce its own verdict (three resisted patches from depth 9), and modernize the schema layer so depths discovered during execution no longer get orphaned from the machine-readable audit trail. **v2.7 is a hardening milestone, not a mandate-expansion milestone.**

**Primary input:** `docs/v2.6-dogfood-ledger.md` § "Routed follow-ups (Phase 16 / v2.7)" — the 7 items clustered into 4 phases below.

**No new research.** This is hardening work on code the team wrote during v2.6. There is no external domain to research.

**All v2.7 phases are post-13.1.** HARDEN-01 manifest enforcement is active by default for every task in this milestone — `files_expected` blocks are mandatory.

**All v2.7 phases are post-14.** `gsd-tools plan-to-tasks` auto-registration is mandatory for any phase that touches the orchestrator or its adjacent tooling. Phase 16 (which touches `gsd-tools.cjs`) definitely applies.

**Divergence protocol v1.1.0 active.** Any plan-vs-reality mismatch during v2.7 execution gets surfaced as a `divergence_report` JSON, not silently absorbed. The dogfood ledger continues — depth-3 is still open, and Phase 16 is a candidate to fill it if a sub-task-level temptation surfaces during the resolver fix.

---

## v1 Requirements (v2.7 scope)

### Phase 16: Init Resolver Fix (Cluster A — items 1+2 from v2.6 dogfood ledger)

**Rationale:** The init resolver bug fired three times in v2.6 — discuss-phase init (depth 7), execute-phase init (depth 8), and again during the v2.6 closeout when the orchestrator had to hand-edit ROADMAP.md because `gsd-tools phase complete 15` would have re-triggered the bug. Three strikes on a single root cause. Fix: make the resolver milestone-scoped via ROADMAP.md cross-reference instead of first-match-by-numeric-prefix across all `.planning/milestones/*-phases/` directories, and add a `--phase-dir <path>` override flag so operators can bypass the resolver when needed.

**Scope ceiling:** ~100 LOC across `get-shit-done/bin/lib/init.cjs` and `get-shit-done/bin/gsd-tools.cjs`. Do-not-expand. Any temptation to also fix items 3-7 "while in the resolver code" gets surfaced as a divergence observation, not absorbed.

- [x] **RESOLVE-01**: `gsd-tools init phase-op`, `gsd-tools init execute-phase`, `gsd-tools init plan-phase`, and `gsd-tools init verify-work` all perform milestone-scoped phase-directory resolution. For any given phase number `N`, the resolver must consult `.planning/ROADMAP.md` to identify the current active milestone and scope its directory search to that milestone's phase directories (e.g., `v2.2-phases/` during v2.6, `v2.7-phases/` during v2.7), NOT return the first `N-*` directory match across all historical `v*.*-phases/` folders. When a phase number matches multiple directories (one in current milestone, one or more in archived milestones), the current-milestone match always wins. When a phase number matches zero directories in the current milestone, the resolver returns `phase_found: false` instead of falling back to a historical match.
- [x] **RESOLVE-02**: `cmdInitExecutePhase(cwd, phase, raw)` gains a `--phase-dir <path>` parameter that bypasses the resolver entirely when present. When supplied, the resolver is not called and the provided path is used verbatim (after basic existence + shape validation). The same override is available on `cmdInitPlanPhase`, `cmdInitPhaseOp`, and `cmdInitVerifyWork` so all phase-aware init surfaces support the escape hatch. The override flag is documented in the help text of each subcommand. ~20 LOC per subcommand.

**Success (Phase 16):** After Phase 16 ships, running `gsd-tools init execute-phase 15` from a v2.7 context resolves to `phase_found: false` (because v2.7 doesn't have a Phase 15) instead of the v2.3 ghost directory. Running `gsd-tools init execute-phase 15 --phase-dir .planning/milestones/v2.2-phases/15-dogfood/` resolves to that exact directory without consulting the resolver. Tests cover the cross-milestone collision case, the override bypass, and the "no match in current milestone" case.

---

### Phase 17: Audit Script Hardening (Cluster B — items 3+4+5 from v2.6 dogfood ledger)

**Rationale:** The Phase 15 Wave 2 executor ran `verify-v26.cjs` against the v2.6 codebase and produced an audit report with three specific classes of findings that the executor recognized as Wave-1 script bugs: `checkVerificationFiles()` hard-coded `VERIFICATION.md` misses the phase-prefixed `14-VERIFICATION.md` form, `parseNpmFailures()` regex doesn't match the actual npm runner output so `pre_existing_failures_verified` captures pytest-only, and the `15-AUDIT-REPORT.json` schema has no `tooling_bugs_observed` category so depths 7 and 8 had nowhere to land. All three were resisted in Phase 15 per its observational scope and routed to v2.7. Phase 17 implements the three fixes.

**Scope ceiling:** All three fixes are confined to `scripts/verify-v26.cjs` (the audit script) plus tests. Total ~80 LOC. Any temptation to refactor the audit script's internal structure "while in there" gets surfaced as a divergence observation.

- [ ] **AUDIT-01**: `verify-v26.cjs::checkVerificationFiles()` probes for both `<phase>-VERIFICATION.md` (prefixed form) and `VERIFICATION.md` (unprefixed form) when scanning a phase directory. Prefixed form wins when both exist; unprefixed is the fallback. The function preserves the current per-phase verdict logic and only changes which filename(s) it looks for. The Phase 14 false-negative from the v2.6 audit (`14:missing`) no longer fires after Phase 17. Tests cover both naming conventions and the "both exist" collision case. ~3-5 LOC in the probe + a few lines of test fixture.
- [ ] **AUDIT-02**: `verify-v26.cjs::parseNpmFailures()` regex is upgraded to match the actual npm runner output format currently used by the test suite. The matcher is parsed into a structured failure list of `{ test_file, test_name, reason }` objects rather than a flat array, so the locked Q9 rule ("match by name, not count") is satisfied on the npm side as well as the pytest side. When the audit runs against the current codebase, `pre_existing_failures_verified` contains entries for at least the four known v2.6 pre-existing npm failures from STATE.md's test baseline (`rlm-workflow-spec.test.cjs`, `agent-frontmatter.test.cjs`, `comprehensive-e2e.test.cjs`, `gsd-amauta.test.cjs`). ~10-20 LOC. Tests cover the npm output format parsing against fixture runs.
- [ ] **AUDIT-03**: `15-AUDIT-REPORT.json` schema gains a `tooling_bugs_observed: []` field alongside `hygiene_debt_observed: []`. The two fields are semantically distinct: `hygiene_debt_observed` entries are "known accumulated debt that won't affect audit correctness if left alone" while `tooling_bugs_observed` entries are "defects in the tooling the audit itself relies on (resolvers, parsers, schema gaps) that produced silent drift during prior milestones." The `generateMarkdown()` function is updated to render both fields in the Markdown report with separate section headings so human readers see them as distinct classes. Schema version bumped to reflect the addition. Depths 7 and 8 from the v2.6 ledger are added as the initial `tooling_bugs_observed` entries when the audit runs post-Phase 17. ~10 LOC schema + ~15 LOC generator. Tests cover the new field's presence in JSON output and its rendering in MD.

**Success (Phase 17):** After Phase 17 ships, re-running `node scripts/verify-v26.cjs` against the v2.6 codebase produces an audit report where: DOGFOOD-05 marks Phase 14 as present (not missing), `pre_existing_failures_verified` contains both pytest and npm entries matched by name, and `tooling_bugs_observed` contains at least the two resolver-bug entries from the v2.6 ledger depths 7 and 8. The three orphaned findings from the v2.6 ledger's "Routed follow-ups" section (items 3, 4, 5) are now encoded in the machine-readable audit JSON, not just the human-readable ledger.

---

### Phase 18: Sampling Pool Expansion (Cluster D — item 6 from v2.6 dogfood ledger)

**Rationale:** The Phase 15 audit's DOGFOOD-01 criterion sampled "completed v2.6 tasks" to verify they have all 5 RPETD intelligence checks firing. The sampler collapsed to n=1 because only Phase 10's SUMMARY.md happened to cite a TK-ID (`TK-0774`), and the sampler was scanning SUMMARY text for `TK-\d+` references rather than the authoritative source (RPETD logs in the amauta task database). An n=1 sampling pool is not statistical evidence of anything. The fix: broaden `sampleCompletedTasks()` to scan RPETD logs directly via the amauta daemon instead of scraping SUMMARY text.

**Scope ceiling:** One function in `verify-v26.cjs` plus its tests. ~30 LOC. Not a full redesign of DOGFOOD-01's sampling design — that would be a v2.8 research question.

- [ ] **SAMPLE-01**: `verify-v26.cjs::sampleCompletedTasks()` is rewritten to query the amauta daemon for tasks with `status=done` in the current milestone's project scope, rather than scanning `.planning/milestones/*/SUMMARY.md` files for `TK-\d+` pattern matches. The function returns a list of task IDs with their RPETD phase content attached, which downstream DOGFOOD-01 checks consume as structured data. When the daemon is unavailable, the function falls back to the old SUMMARY-scraping behavior and logs a `sampling_degraded: daemon_unavailable` observation in the audit report (graceful degradation principle). The sampling floor is documented: if the pool is below 5 tasks, DOGFOOD-01 records the pool size as evidence and does NOT collapse to `gaps_found` automatically — small pools are a finding about project scope, not an audit failure. Tests cover: daemon-available path with 10+ completed tasks, daemon-unavailable fallback to SUMMARY scraping, and the below-5-pool-size documentation.

**Success (Phase 18):** After Phase 18 ships, running `verify-v26.cjs` against the v2.7 codebase produces a DOGFOOD-01 verdict with a sampling pool of at least 5 tasks (v2.7 has 4 phases × ~3 plans each ≈ 12 tasks, plus sub-tasks) when the daemon is available. The audit surfaces the actual RPETD-phase compliance rate across the sampled tasks rather than n=1 verdict.

---

### Phase 19: Dynamic Ledger Schema (Cluster C — item 7 from v2.6 dogfood ledger)

**Rationale:** The `dogfood_ledger_depths_captured` field in `15-AUDIT-REPORT.json` was populated as `[0, 1, 2, 4, 5, 6, 7]` during Phase 15 Wave 2. Depths 8 and 9 were captured during Phase 15 execution itself (orchestrator resolver catch + Wave 2 executor self-restraint), but they never made it into the JSON because the Wave 1 script hard-coded the depth list at authoring time. The v2.6 ledger's Limitations section names this as "schema-orphaned depths" — the most important meta-finding of the entire Phase 15 audit, and one that a machine-readable consumer of the audit JSON has no way to see. Phase 19 fixes this by making the field dynamic: the audit script scans the memory directory for `*dogfood*.md` entries at runtime and extracts their depth values.

**Scope ceiling:** One function in `verify-v26.cjs` plus its tests. ~40 LOC. The file-system scan is already a pattern the script uses elsewhere (for the phase directory walks), so the addition is straightforward.

- [ ] **SCHEMA-01**: `verify-v26.cjs` gains a `scanDogfoodLedgerDepths()` function that walks the memory directory (`~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/`) at runtime, globs `project_*dogfood*.md` files, parses their `Depth: N` YAML-frontmatter or first-line-of-body annotations, returns a sorted list of unique depth integers, and identifies the gap set (the list of missing depth numbers between 0 and the max observed depth). The result populates `dogfood_ledger_depths_captured` and `dogfood_ledger_gaps` dynamically in each audit run, replacing the Wave 1 static `[0, 1, 2, 4, 5, 6, 7]` list. When the memory directory is unreachable (wrong path, permission denied, Claude Code context missing), the function logs a `ledger_scan_degraded: memory_unavailable` observation and falls back to the static list for backward compatibility. The v2.7 closeout audit must show depths `[0, 1, 2, 4, 5, 6, 7, 8, 9]` captured with `gaps = [3]` — matching the actual state of the ledger — and any new depths captured during v2.7 execution itself (e.g., a potential depth 3 or 10+) are auto-included. Tests cover: the happy-path memory scan, the degraded path, the depth parser against real fixtures from memory/, and the gap identification logic.

**Success (Phase 19):** After Phase 19 ships, running `verify-v26.cjs` during the v2.7 closeout produces a `dogfood_ledger_depths_captured` field that reflects reality at the moment of the audit, not the reality at Wave 1 authoring time. If v2.7 execution itself captures a new depth (e.g., Phase 16's executor catches depth 3 during the resolver fix), that depth appears in the JSON automatically without any code change to the audit script.

---

## v2 Requirements (deferred past v2.7)

Items explicitly recognized but not in v2.7 scope. Tracked here so they don't get lost.

### Nyquist-gate formalization (deferred from v2.6 Phase 13.1 post-mortem follow-ups)

- **NYQUIST-01** *(v2.8+)*: Formalize CONTEXT.md-as-source-of-truth pattern as a first-class validation source. The Phase 13.1, 14, and 15 audits all surfaced the same hygiene-debt observation: validators sometimes need to consult CONTEXT.md for phase-specific locks that are not in ROADMAP.md or REQUIREMENTS.md, but the workflow doesn't formally document CONTEXT.md as a valid validation source. Requires workflow spec changes, not tooling changes.

### Discuss-phase init cross-reference formalization

- **INIT-01** *(v2.8+)*: The Phase 13.1, 14, and 15 dogfood depths all came from discuss-phase or execute-phase init. This is a recurring drift-detection surface. Consider formalizing the init-time cross-reference check (directory name vs roadmap identity vs timestamp) as a first-class init action, not just an orchestrator-level discipline. Phase 16's resolver fix is a prerequisite; this one is the follow-on feature that makes the cross-reference automatic rather than orchestrator-driven.

### Ledger maintenance automation

- **LEDGER-01** *(v2.8+)*: The v2.6 dogfood ledger was hand-transcribed in Phase 15 Wave 3. Future ledger updates should be tool-assisted: a `gsd-tools ledger-sync` subcommand that reads memory entries, sorts by depth, and produces a canonical Markdown ledger automatically. Requires the Phase 19 dynamic depth scanner as a prerequisite.

## Out of Scope

Explicit exclusions for v2.7. Documented to prevent scope creep.

| Feature | Reason |
|---|---|
| New RPETD intelligence upgrades (R/P/E/T/D phase mandates) | v2.7 is a hardening milestone, not a mandate-expansion milestone. New mandates belong in v2.8+. |
| New agent roles beyond the existing 11 | No agent gap was identified during the v2.6 audit. Adding specialists without a named gap is scope creep. |
| New kill switches | The existing v2.6 kill switches (`GSD_D_STRUCTURED`, `GSD_E_MANDATE`, `GSD_T_SPEC_INHERIT`, `GSD_R_CREATIVE`, `GSD_P_AUTO_TASK`, `GSD_MANIFEST_CHECK`) cover the behavioral surface. v2.7 is code-level fixes to existing behavior, not new feature flags. |
| Rewriting `gsd-tools.cjs` or `amauta.py` | Phase 16 touches `gsd-tools.cjs` surgically (resolver + override flag only). No broader refactor. Same Phase 13 fingerprint trap as v2.6 — "while I'm here" in the orchestrator core is the most dangerous scope expansion. |
| Schema migration changes to PostgreSQL | No new columns, no new tables, no schema migrations in v2.7. Existing 8 migrations continue unchanged. |
| README rewrite for v2.7 | The v2.6 README was comprehensive and still accurate for v2.7's stack. At v2.7 closeout, a targeted addendum section documenting the 4 new hardening capabilities (NOT a full rewrite). |
| Public release notes / GitHub Release ceremony | This is local + friends use per the operator's framing, not a deployed product. Release-ceremony polish is not scope. |
| Fixing items unrelated to the 7 routed follow-ups | Any bug noticed during v2.7 execution that is NOT in the 7-item routed-follow-up list is a v2.8 candidate or a separate hotfix, not a Phase 16/17/18/19 scope expansion. Surface via divergence report. |

---

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|---|---|---|
| RESOLVE-01 | Phase 16 | Complete |
| RESOLVE-02 | Phase 16 | Complete |
| AUDIT-01 | Phase 17 | Pending |
| AUDIT-02 | Phase 17 | Pending |
| AUDIT-03 | Phase 17 | Pending |
| SAMPLE-01 | Phase 18 | Pending |
| SCHEMA-01 | Phase 19 | Pending |

**Coverage:**
- v2.7 requirements: 7 total
- Mapped to phases: 7
- Unmapped: 0 ✓

---

## Previous milestone archive

v2.6 Sight Beyond Sight requirements archived to `.planning/milestones/v2.6-REQUIREMENTS.md`. All 46 requirements (TECH-01..06 + LEARN-01..07 + EXEC-01..08 + QA-01..08 + CREATIVE-01..05 + HARDEN-01..05 + PLAN-01..07 + DOGFOOD-01..05) shipped 2026-04-10. Closeout errata for DOGFOOD-01 (subcommand → standalone binary) and DOGFOOD-03/05 (.sh → .cjs) applied per Phase 15 CONTEXT.md Gap 1a/1c.

Earlier milestones (v2.1-v2.4) archived to `.planning/milestones/v2.{1,2,3,4}-REQUIREMENTS.md`. v2.5 REQUIREMENTS.md was replaced inline at the v2.5→v2.6 transition and lives in git history only.

---

*Requirements defined: 2026-04-11 (v2.7 "Steady Hands" milestone start)*
*Last updated: 2026-04-11 after v2.7 initialization*

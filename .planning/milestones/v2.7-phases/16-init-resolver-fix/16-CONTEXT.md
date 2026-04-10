# Phase 16: Init Resolver Fix — Context

**Gathered:** 2026-04-11
**Status:** Ready for planning
**Milestone:** v2.7 "Steady Hands"
**Phase ID:** 16-init-resolver-fix
**Requirements:** RESOLVE-01, RESOLVE-02
**Scope ceiling:** ~100 LOC total across: (a) `get-shit-done/bin/lib/init.cjs` — the four resolver-consuming init subcommands (`cmdInitExecutePhase`, `cmdInitPlanPhase`, `cmdInitVerifyWork`, `cmdInitPhaseOp`) plus the `--phase-dir` override wiring on each; (b) `get-shit-done/bin/gsd-tools.cjs` — the `resolvePhaseDir` function itself plus the atomic write-to-temp+rename pattern on `config-set` if it's not already in place; (c) `get-shit-done/workflows/new-milestone.md` and `get-shit-done/workflows/complete-milestone.md` — integration of the atomic `current_milestone` field write; (d) the new test file `tests/16-init-resolver.test.cjs` — three primary test cases (depth-7/8 replay, depth-10 replay, RESOLVE-02 override bypass) plus the edge cases plus the live CI smoke test. The ~100 LOC total budget is load-bearing: any implementation that requires more than this is by definition out of scope and must be surfaced as a divergence observation, not absorbed into the phase.

<domain>
## Phase Boundary

Phase 16 delivers a milestone-scoped `gsd-tools init` resolver plus a `--phase-dir` override flag that bypasses the resolver when operators already know the correct path. Specifically:

- **RESOLVE-01** — `gsd-tools init phase-op`, `gsd-tools init execute-phase`, `gsd-tools init plan-phase`, and `gsd-tools init verify-work` all perform milestone-scoped phase-directory resolution. Phase numbers are looked up only within the current milestone's phase directories, never across archived milestones. When a phase number has no match in the current milestone, the resolver returns `phase_found: false` with a diagnostic — it does NOT fall back to a historical match.
- **RESOLVE-02** — `cmdInitExecutePhase` (and the three sibling init subcommands) gain a `--phase-dir <path>` override parameter that bypasses the resolver entirely when present. The override accepts both absolute and relative paths, validates path existence + non-empty PLAN.md population, and normalizes internally to relative-from-cwd.

Explicitly **out of scope** for Phase 16:

- Fixing `routeExecutor` (the file-extension-based executor router). It's architecturally similar but a different bug class, and `agent_assignment_conflict` (divergence protocol v1.1.0) already catches its main failure mode. Routed to v2.8 as a separate candidate.
- Fixing audit script items 3-7 from the v2.6 dogfood ledger's routed follow-ups (those are Phases 17-19 of v2.7).
- Fixing the deferred `v2.2-phases/` → `v2.6-phases/` rename from 13.1 post-mortem item 9. v2.7 phases live in `v2.7-phases/` (starting with this one) but v2.6 phases remain in `v2.2-phases/` for historical consistency. Not a migration.
- Any refactoring of `gsd-tools.cjs` or `get-shit-done/bin/lib/init.cjs` beyond the minimum diff needed to land RESOLVE-01 and RESOLVE-02. The "while I'm in the resolver code I should also fix X" temptation is the exact Phase 13 fingerprint this phase exists to prevent in its own execution.

</domain>

<decisions>
## Implementation Decisions

### Milestone Identity Source (the architectural foundation of RESOLVE-01)

- **Single source of truth: `.planning/config.json::current_milestone`.** A new top-level string field set to the active milestone version (e.g., `"v2.7"`). The resolver reads this field and this field only.
- **One canonical writer: the milestone workflows.** `new-milestone` writes `current_milestone` when it creates a new milestone. `complete-milestone` clears or rewrites it when a milestone closes. No other workflow writes to this field.
- **One canonical reader: the resolver path.** `resolvePhaseDir` (and any helper it calls) reads `current_milestone` to scope its directory walk to `.planning/milestones/v{N}-phases/`. Other components that need "current milestone" context also read this field — no parallel source of truth anywhere.
- **Rejected alternatives and why:**
  - `ROADMAP.md` header parsing → brittle against mid-edit state, typos, format drift across milestones.
  - `STATE.md` frontmatter → has its own freshness drift (caught at 13.1 closeout where STATE.md lagged actual milestone state).
  - cwd-walking for closest `.planning/` directory → IS the bug. Replicates first-match-wins pattern resolution, recreates depths 7/8/10 in a different shape.
- **Behavior when cwd is outside any known milestone:** Hard error. `phase_found: false` with diagnostic `"no milestone context — run from within a project root with .planning/config.json"`. **No silent fallbacks ever.**
- **Behavior when `config.json` is missing or has a stale/malformed `current_milestone` field:** Hard error. Two legitimate states: operator hasn't run `new-milestone` yet (error is correct), or something is broken (error surfaces it). Auto-detection from directory structure is explicitly forbidden — it recreates the original bug class.
- **Atomic write requirement:** `new-milestone` and `complete-milestone` MUST update `current_milestone` atomically via write-to-temp + rename. `config.json` must never be in a half-updated state. If the existing `config-set` path in `gsd-tools.cjs` doesn't already use temp+rename, bringing it onto that pattern is **part of RESOLVE-01's scope**, not a separate task.

### Scope of the Fix — Resolver Only, Not Router

- **In scope:** `resolvePhaseDir` in `get-shit-done/bin/lib/init.cjs` (or wherever it currently lives — confirm via grep during execution).
- **In scope (consumers of resolvePhaseDir):** `cmdInitExecutePhase`, `cmdInitPhaseOp`, `cmdInitPlanPhase`, `cmdInitVerifyWork` — all four phase-aware init subcommands that currently consume the buggy resolver.
- **Out of scope:** `routeExecutor` in `gsd-tools.cjs`. It's architecturally similar (pattern-based resolution with first-match semantics) but it's a different bug class (file extension routing to executor agents, not numeric-prefix directory matching) and `agent_assignment_conflict` in divergence protocol v1.1.0 already catches its main failure mode. Routed to v2.8 as a separate candidate (see `project_phase13_1_postmortem_followups.md`).
- **Rationale:** "While I'm in the resolver code I should also fix `routeExecutor`" is the exact Phase 13 fingerprint. Holding scope discipline here is the same discipline the v2.6 dogfood ledger documented at depths 2, 4, and 9.

### `--phase-dir` Override Semantics

- **Path validation — strict.** The override accepts only paths that exist on the filesystem. `--phase-dir /nonexistent/path` returns a hard error immediately, before any further work. Rationale: the override exists to bypass the resolver, not to bypass sanity checking. Loose acceptance moves the failure further from where it was introduced.
- **Absolute vs relative — both accepted.** Operators under pressure type whatever their shell history gives them. Rejecting absolute paths is operator-hostile. Both forms are accepted at the CLI boundary.
- **Internal normalization — relative from cwd.** After validation, the override is normalized to a relative-from-cwd path so the rest of the resolver code path handles a single form. Preserves the existing contract where resolver returns relative paths.
- **Empty directory (path exists but contains no PLAN.md files) — hard error** with diagnostic: `--phase-dir <path>: directory exists but contains no PLAN.md files. Did you mean <suggestion>?`. The suggestion is optional-but-cheap: list sibling directories under the same parent that contain PLAN.md files. Skip the suggestion if no siblings have PLANs.
- **General rule:** the override exists for the **bootstrapping case** — the resolver is broken and we need to bypass it during Phase 16's own execution and any future bootstrap scenario. It is NOT a permanent operator workflow. The edge-case errors are deliberately loud so it doesn't quietly become routine.
- **Override available on all four init subcommands:** `phase-op`, `execute-phase`, `plan-phase`, `verify-work`. Not just `execute-phase`. RESOLVE-02's test coverage must verify all four.

### Test Strategy

- **Synthetic fixture tests are the primary regression guard.** Isolated, reproducible, fast, no dependency on real repo state.
- **Three required test cases replaying the exact v2.6/v2.7 dogfood firings** (not generic v1.0/v2.0 fixtures — historical specificity is load-bearing):
  1. **Depth 7/8 replay — no-match-in-current-milestone**: fixture has `v2.7-phases/` (no phase 15) + `v2.3-phases/15-data-purge/` + `v2.2-phases/15-dogfood/`, config.json sets `current_milestone: v2.7`. Query phase 15. Assert `phase_found: false`. Assert NEITHER historical match is returned. Assert error message names the current milestone explicitly.
  2. **Depth 10 replay — phase number matches current milestone AND archived ghost**: fixture has `v2.7-phases/16-init-resolver-fix/` (with a PLAN.md so the empty-directory error doesn't fire) + `v2.3-phases/16-data-integrity/` (the real ghost that fired today), config.json sets `current_milestone: v2.7`. Query phase 16. Assert returns the v2.7 directory. Explicitly assert NOT the v2.3 match. This test is the self-referential regression guard — if it ever breaks, depth 10 has recurred.
  3. **RESOLVE-02 override bypass**: same fixture as test case 2, config.json still `v2.7`. Call resolver with `--phase-dir .planning/milestones/v2.3-phases/16-data-integrity/` (explicitly pointing at a ghost in a different milestone). Assert returns that exact path. Proves the override actually overrides, including cross-milestone.
- **Plus edge-case tests**: cwd outside any known milestone, config.json missing, config.json with malformed `current_milestone` field, `--phase-dir` pointing at nonexistent path (hard error expected), `--phase-dir` pointing at empty directory (hard error with suggestion expected), `--phase-dir` with both absolute and relative input (both accepted).
- **Live smoke test** runs against the real repo in CI only (belt-and-suspenders against the "synthetic fixture missed something" failure mode). One assertion: `gsd-tools init phase-op 16` from the current repo returns `v2.7-phases/16-init-resolver-fix/` (or whatever the repo state says is correct), NOT `v2.3-phases/16-data-integrity/`.
- **Test file location:** `tests/16-init-resolver.test.cjs` (or `tests/resolver-phase-16.test.cjs` — planner decides final name). All three primary test cases and the edge cases live in that one file for discoverability.

### Claude's Discretion

- **Exact implementation of the `current_milestone` read path** — whether the resolver loads `config.json` directly or goes through an existing `config-get` helper. Planner decides based on what already exists in `gsd-tools.cjs`.
- **Exact temp+rename atomicity pattern** for `config.json` writes — whether to use Node's `fs.writeFile` + `fs.rename` or an existing helper. Planner decides based on what's already established.
- **Error message formatting** — the exact wording of hard-error diagnostics, provided they name the current milestone and name the specific failure mode (not a generic "phase not found").
- **Whether RESOLVE-02's override also propagates through any internal helper paths** that consume the resolver — planner decides by tracing the call graph.
- **Exact placement of the test file** and whether the edge cases live in the same file as the three primary cases — provided all required test cases are present and the synthetic fixture is isolated from real repo state.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirement definitions
- `.planning/REQUIREMENTS.md` § "Phase 16: Init Resolver Fix" — RESOLVE-01 and RESOLVE-02 text, scope ceiling, acceptance criteria
- `.planning/ROADMAP.md` § "Phase 16: Init Resolver Fix" — goal statement, success criteria, dependency chain, files_expected preview, rollback plan, pitfalls prevented

### Dogfood ledger (why Phase 16 exists)
- `docs/v2.6-dogfood-ledger.md` § "Routed follow-ups (Phase 16 / v2.7)" — the original routed-follow-up text for items 1 and 2
- `docs/v2.6-dogfood-ledger.md` § "Depth 7: Ghost directory detection (Phase 15 discuss-phase)" — the first firing event
- `docs/v2.6-dogfood-ledger.md` § "Depth 8: Init resolver recurrence at next workflow surface" — the second firing event, cross-surface confirmation
- `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/project_phase16_init_resolver_self_referential_dogfood.md` — **depth 10**, the self-referential firing that happened during this very discuss-phase init. The single strongest motivation for Phase 16's existence.

### Divergence protocol (applies during execution)
- `get-shit-done/references/divergence-protocol.md` v1.1.0 — behavioral half of the Phase 13 defense, full schema for `divergence_report` JSON, four-option orchestrator decision tree, `rationalization_check` field mandatory content, exit code 87 fallback
- `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/feedback_divergence_over_flow.md` — the general rule this phase's execution must honor

### HARDEN-01 manifest enforcement (applies to every task in Phase 16)
- `get-shit-done/bin/gsd-tools.cjs` § `manifestCheck` — deterministic per-task check, GLOBAL_ALLOWLIST, ORCHESTRATOR_OWNED hard halts, `GSD_MANIFEST_CHECK=warn` bootstrap override, JSON violation reports
- `get-shit-done/bin/gsd-tools.cjs` § `ORCHESTRATOR_OWNED` constant — `.planning/STATE.md`, `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`. None of these are in Phase 16's file footprint, so no hard-halt risk.

### Existing code the fix will touch
- `get-shit-done/bin/lib/init.cjs` § `cmdInitExecutePhase` (and the three sibling init functions) — the current resolver consumers
- `get-shit-done/bin/gsd-tools.cjs` § `resolvePhaseDir` — the function that currently returns first-match-by-numeric-prefix across all `.planning/milestones/*-phases/` (the bug)
- `get-shit-done/bin/gsd-tools.cjs` § `config-get` / `config-set` commands — the existing config.json read/write path. Planner must verify whether it uses atomic write-to-temp + rename. If not, atomicity fix is in scope.

### Phase 13 fingerprint (the failure mode Phase 16's execution must resist)
- `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/project_phase13_incident.md` — canonical negative example, the Phase 13 silent scope expansion incident
- `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/project_phase13_1_wave3_near_miss.md` — depth 2, "helper useless if nothing consumes it" near-miss
- `~/.claude/projects/-Users-luismogrovejo-Code-gsd-amauta/memory/project_phase15_wave2_auditor_self_restraint_dogfood.md` — depth 9, resistance pattern "the report says X and reality is Y, therefore the delta is a finding, document it"

### v2.7 milestone context
- `.planning/PROJECT.md` § "Current Milestone: v2.7 Steady Hands" — body-metaphor sequence, hardening milestone framing
- `.planning/STATE.md` § "v2.7 Phase Map (proposed, pre-roadmapper)" and the locked version after the roadmapper ran
- `.planning/MILESTONES.md` § "Complete: v2.6 — Sight Beyond Sight" — the archived milestone this phase is the first hardening response to

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`config-get` / `config-set` commands in `gsd-tools.cjs`** — already read and write `.planning/config.json`. The fix adds `current_milestone` as a new recognized field under the existing config schema, and the milestone workflows call `config-set workflow.current_milestone <version>` or equivalent. Planner must confirm whether the existing `config-set` uses atomic write-to-temp + rename; if not, atomicity is in Phase 16 scope.
- **`manifestCheck` in `gsd-tools.cjs`** — HARDEN-01 enforcement. Every task in Phase 16 declares `files_expected` and the check fires post-commit. No change needed to the check itself; Phase 16 is a consumer, not a modifier.
- **Existing `.planning/config.json` infrastructure** — the config file already exists and is read by multiple workflows. Adding a new top-level field is additive, not schema-breaking.
- **Existing test harness** (`npm test` + the `tests/*.test.cjs` files) — the new `tests/16-init-resolver.test.cjs` plugs into the same harness with no special infrastructure.

### Established Patterns

- **Resolver-returns-relative-paths contract** — the existing `resolvePhaseDir` returns paths like `.planning/milestones/v2.2-phases/15-dogfood/`, not absolute paths. The fix preserves this contract: internal normalization of `--phase-dir` inputs to relative form, resolver output continues to be relative.
- **Hard-error-over-silent-fallback pattern** — the v2.6 milestone established (via HARDEN-01 + divergence protocol v1.1.0 + validator vocabulary lock) that silent fallbacks to wrong state are always worse than loud errors. Phase 16's resolver fix extends this pattern to phase directory lookup.
- **Test fixture isolation** — v2.6 phase tests (e.g., `13.1-manifest-check.test.cjs`) use synthetic fixture directories isolated from the real repo. Phase 16 follows the same pattern for test cases 1-3.
- **Bootstrap workaround pattern from Phase 15** — when the resolver is broken, executors hard-code paths via explicit task brief instructions and orchestrator passes paths directly (no init tool call). Phase 16 execution itself will use this pattern until RESOLVE-02 lands, at which point the override flag becomes the canonical workaround for any future similar bootstrap case.

### Integration Points

- **`new-milestone` workflow** — must be updated to write `current_milestone` to config.json atomically when it creates a new milestone. This is NOT a modification of the workflow's scope, just its implementation detail.
- **`complete-milestone` workflow** — must be updated to clear or rewrite `current_milestone` when a milestone closes.
- **Every existing workflow that consumes `gsd-tools init ...`** — `discuss-phase`, `plan-phase`, `execute-phase`, `verify-work`, `phase-op`. They continue to call the init tool unchanged; only the tool's internal behavior changes. No callsite updates.
- **Phase 17-19 executors** — all three downstream v2.7 phases use the init resolver to locate their own phase directories. Fixing it in Phase 16 means Phases 17-19 run against a clean init surface. This is why Phase 16 is strict-serial-first in the v2.7 dependency chain.

### Bootstrap constraint (load-bearing)

- **Phase 16's own execution cannot use the init tool.** Until RESOLVE-01 + RESOLVE-02 land in a merged commit, calling `gsd-tools init phase-op 16` returns the v2.3-phases/16-data-integrity ghost (depth 10). The Phase 16 executor must work around this the same way the Phase 15 executors did: hard-coded paths passed explicitly via task brief, manual `git add -f` for `.planning/` artifacts, no reliance on any tool that calls `resolvePhaseDir` internally.
- This bootstrap constraint lifts the moment the fix ships. After Phase 16 closes, every subsequent workflow (including Phases 17-19 of v2.7, and all v2.8+ phases) uses the fixed resolver normally.
- **The test suite's live smoke test is the validator for this bootstrap transition.** If the smoke test passes (real-repo `init phase-op 16` returns `v2.7-phases/16-init-resolver-fix/`), the bootstrap is over and the workaround is no longer needed.

</code_context>

<specifics>
## Specific Ideas

- **Depth 10 is the most consequential dogfood moment in the entire ledger** because it's the bug firing on the first invocation of the phase designed to fix it. The memory entry (`project_phase16_init_resolver_self_referential_dogfood.md`) captures this with the framing: the protocol held ONLY because the orchestrator pre-warned about the risk before the init call. Without the pre-warning, the workflow would have routed into the "plans already exist, replan?" branch and silently inherited v2.3 data-integrity plans as Phase 16 resolver-fix plans.
- **The three synthetic fixture test cases must use the exact historical directory names** (`v2.3-phases/15-data-purge`, `v2.3-phases/16-data-integrity`, `v2.2-phases/15-dogfood`, etc.) so that when a future reader breaks one of these tests, they can read the test name and immediately know which dogfood depth regressed. Generic "v1.0 / v2.0 collision" fixtures are explicitly rejected — historical specificity is load-bearing.
- **The agent surfacing "while I'm here is the Phase 13 fingerprint" during discuss-phase without being flagged is a positive dogfood data point**, noted in passing. It's routine protocol application at the discuss-phase surface, not a new recursion variant, so it's NOT a new depth ledger entry. Logged here as a positive-signal observation.
- **The `routeExecutor` parallel bug is a v2.8 candidate** and has been noted for the post-mortem follow-ups memory. Do not address in Phase 16.
- **The `v2.2-phases/` → `v2.6-phases/` deferred rename from 13.1 post-mortem item 9 is NOT in scope.** v2.7 organically starts using `v2.7-phases/` (this phase's directory is the first example), but v2.6 stays in `v2.2-phases/` for historical consistency. Not a migration, not a rename — just a forward-looking convention change.

</specifics>

<deferred>
## Deferred Ideas

- **`routeExecutor` first-match-wins pattern resolution** — same architectural class as the init resolver bug, different bug class (file-extension routing vs numeric-prefix directory lookup). Routed to v2.8 as a separate fix candidate. Added to `project_phase13_1_postmortem_followups.md`.
- **`v2.2-phases/` → `v2.6-phases/` directory rename** — deferred from 13.1 post-mortem item 9, still deferred. v2.7 organically starts `v2.7-phases/`; v2.6 stays historical. Full retroactive rename is a v2.8+ cleanup phase if ever.
- **Retroactive milestone-identity marker for archived milestones** — if the new `current_milestone` config field turns out to be useful as historical metadata (e.g., for the dogfood ledger's depth capture), adding a `previous_milestone` or `milestones_completed` field could be a v2.8 consideration. Not in Phase 16 scope.
- **Wildcard globs in `--phase-dir` override** — rejected for Phase 16 (the override is for the explicit-path bootstrap case only). If a future operator needs wildcard expansion, it's a v2.8+ feature, not a regression of Phase 16's scope.

</deferred>

<positive_observations>
## Positive Observations (not depth entries, not ledger-bound)

- **The agent correctly surfaced "while I'm in the resolver code I should also fix `routeExecutor`" as a Phase 13 fingerprint without being flagged.** This is the discipline working at the discuss-phase surface — routine protocol application, not a new recursion variant. Not a depth entry, just noted so future reviewers of this phase's CONTEXT.md can see the pattern at work.
- **The pre-warning mechanism caught depth 10.** Before running `gsd-tools init phase-op 16`, the orchestrator explicitly noted: "this is the first invocation of the init tool for the phase designed to fix the init tool — if it returns a ghost, that's depth 10." The bug then fired exactly as anticipated. The anticipation is what made the catch clean: without the pre-warning, the workflow would have routed into the "replan existing plans" branch silently. This is evidence that the memory entries for depths 7 and 8 were doing their job — they were in context, they named the risk, they caused the pre-warning, the pre-warning caught the bug.
- **This CONTEXT.md itself was written via hand-routed paths.** No `gsd-tools init phase-op 16` call was made during this discuss-phase workflow after the first (ghost-returning) init. The phase directory was created via `mkdir -p .planning/milestones/v2.7-phases/16-init-resolver-fix/`, the CONTEXT.md write goes to a hand-resolved path, and the commit will use `git add -f` for the `.planning/` artifacts. Same workaround pattern Phase 15 established.

</positive_observations>

---

*Phase: 16-init-resolver-fix*
*Context gathered: 2026-04-11*
*Next: `/amauta:plan-phase 16`*

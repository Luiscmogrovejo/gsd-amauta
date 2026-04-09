---
phase: 10-d-phase-structured-learning
plan: 10-06
subsystem: agents
tags: [gsd-operator, gsd-validator, structured-learning, applied-learning, citation-scanner, gate-2, learn-02, learn-05, learn-06]

# Dependency graph
requires:
  - phase: 10-01
    provides: learning-format.md WHAT/WHY/WHEN/TAGS template + cli-variables.md (consumed by validator failure guidance + helper MEM binding)
  - phase: 10-03
    provides: gsd-memory.cjs parse-learning subcommand + learn --structured + GSD_D_STRUCTURED=false kill switch (consumed by gsd-memory-learn-blocks.sh helper)
  - phase: 10-05
    provides: gsd-memory.cjs increment-applied subcommand + already_cited:true idempotence (consumed by operator APPLIED_LEARNING scanner)
provides:
  - get-shit-done/bin/gsd-memory-learn-blocks.sh — bash helper that parses a D-phase content blob, delegates to parse-learning, iterates blocks, and stores each via learn --structured
  - agents/gsd-operator.md D-phase structured learning storage section — detects `^  WHAT:` lines, dispatches to gsd-memory-learn-blocks.sh, falls back to legacy `$MEM learn` when no structured block OR kill switch set
  - agents/gsd-operator.md APPLIED_LEARNING citation scan section — runs post-task, greps all-phase content for `APPLIED_LEARNING: mem-XXXX — reason` citations, calls increment-applied deduped daemon-side
  - agents/gsd-validator.md Gate 2 dual-format acceptance — passes if EITHER legacy one-liner `^LEARNING:` OR structured block (`^LEARNING:` + `^  WHAT:`) is present
affects: [10-08-learning-block-template, 10-09-tests, 10-c-phase-executors-applied-learning]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Helper-script delegation: keep agent prompts thin by extracting executable bash/JS into dedicated helper scripts under get-shit-done/bin/ — operator-level additions stay a handful of lines, all parsing lives in a single testable helper"
    - "Defense-in-depth kill switch: GSD_D_STRUCTURED=false checked at BOTH the operator prompt (before dispatch) AND the helper (first 5 lines) — either layer alone prevents structured storage, eliminating bypass paths"
    - "Graceful fallback on helper exit: `$LEARN_BLOCKS ... || $MEM learn "$ONE_LINER"` ensures the one-liner is ALWAYS stored even if parse/daemon/network fails — the learning can never get dropped"
    - "Best-effort citation scanning: APPLIED_LEARNING scanner runs `|| true` because citations are a signal, not blocking — daemon-unreachable silently no-ops instead of blocking task close"
    - "Dual-format validator gate: Gate 2 accepts both legacy and structured by short-circuit grep (`^LEARNING:` is the shared prefix, `^  WHAT:` distinguishes structured) — backward compat with pre-Phase 10 tasks while nudging new learnings toward the WHAT/WHY/WHEN/TAGS schema"

key-files:
  created:
    - get-shit-done/bin/gsd-memory-learn-blocks.sh
    - .planning/milestones/v2.1-phases/10-d-phase-structured-learning/10-06-SUMMARY.md
  modified:
    - agents/gsd-operator.md (+35 lines net — D-phase structured storage + APPLIED_LEARNING citation scan)
    - agents/gsd-validator.md (+33 lines net — Gate 2 dual-format acceptance with bash check + failure guidance)

key-decisions:
  - "Helper script (gsd-memory-learn-blocks.sh) carries the node -e parsing filter, NOT the operator prompt — the previous revision of this plan tried to inline ~12 lines of nested-quoted node -e in the operator markdown, which is fragile (markdown -> bash -> node -e -> JS string literals) and easy to silently break. Extracting to a helper adds one file but makes the complexity testable in isolation and keeps the operator prompt readable"
  - "Kill switch checked in both layers: operator grep AND helper preamble. Either layer alone is sufficient but the belt-and-suspenders pattern ensures a future refactor of the operator prompt cannot accidentally bypass the kill switch. The helper always bails clean when GSD_D_STRUCTURED=false"
  - "Helper failure falls through to legacy learn, NOT hard-fails. Agents run in the field with unreliable daemon connectivity and partial PG availability — hard-failing on helper non-zero would lose the learning entirely. `|| $MEM learn` preserves the one-liner regardless of parser/daemon state"
  - "APPLIED_LEARNING scanner runs POST-task (after all 5 RPETD phases are logged), not per-phase — fetching the full task via `$CLI show --json` once at the end is cheaper than grepping each phase content blob as it lands, and the daemon's (mem_id, task_id) dedup makes running-it-once-at-end equivalent to running-it-per-phase"
  - "Daemon-side dedup (already_cited:true as 200 OK) is the source of truth for citation idempotence. The operator does NOT try to dedupe in bash — it just calls increment-applied for every match and lets the daemon return already_cited:true for repeats. Keeps the operator bash trivial and pushes dedup to the one authoritative place"
  - "Gate 2 uses TWO grep checks (^LEARNING: AND ^  WHAT:) rather than a single multiline regex. Single regex would require -z or -U flags and cross-shell compatibility issues. Two simple anchored greps are portable, readable, and the combined logic is a one-liner with `&&`"
  - "Validator failure guidance points at learning-format.md instead of inlining the WHAT/WHY/WHEN template — the reference file is the canonical source (Plan 10-01) and duplicating it in the validator would create two places to maintain the template. Single source of truth"
  - "Committed as THREE separate commits (not two) because Task 1b (operator D-phase) and Task 2 (citation scanner) are functionally independent even though both live in gsd-operator.md — split with Edit/revert/Edit so the commits review atomically and can be reverted independently without unrelated churn"

patterns-established:
  - "Extract node -e filters into dedicated helper scripts: when an agent prompt needs executable JS more than ~3 lines long, put it in get-shit-done/bin/<helper>.sh instead of inlining. The prompt stays readable, the helper is testable in isolation, and changes to the helper don't touch agent markdown"
  - "Defense-in-depth kill switches: check the env var at BOTH the caller AND the callee. Neither layer alone should be load-bearing — a future refactor of either end cannot accidentally disable the kill switch"
  - "Best-effort signal scanners use `|| true`: telemetry/citation scanners that are not on the critical path should never block task close. Daemon-unreachable is a legitimate operational state, not an error"
  - "Dual-format acceptance gates use short-circuit checks: when extending a validator gate to accept a new format in a backward-compatible way, check the shared prefix first, then branch on the distinguishing sub-pattern. Keeps the new-format check additive without breaking the legacy check"

requirements-completed: [LEARN-02, LEARN-05, LEARN-06]

# Metrics
duration: ~25 min
completed: 2026-04-09
---

# Plan 10-06: Operator D-phase Handler + Validator Gate 2 Summary

**gsd-operator.md now detects structured LEARNING blocks, dispatches to a new gsd-memory-learn-blocks.sh helper for structured storage, and scans all RPETD phases post-task for APPLIED_LEARNING citations — gsd-validator.md Gate 2 accepts BOTH the legacy one-liner and the Phase 10 structured block format**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-09T22:35:00Z
- **Completed:** 2026-04-09T23:00:00Z
- **Tasks:** 3 (committed in 4 atomic commits — helper + operator-D + operator-scanner + validator)
- **Files created:** 1 (gsd-memory-learn-blocks.sh)
- **Files modified:** 2 (gsd-operator.md, gsd-validator.md)

## Accomplishments

- **Task 1 (LEARN-02):** `gsd-memory-learn-blocks.sh` helper script created at `get-shit-done/bin/`. Parses a D-phase content blob, delegates to `gsd-memory parse-learning`, iterates each structured block via a node filter that emits shell-quoted `learn --structured` commands, then evals each via the parent shell. Honors `GSD_D_STRUCTURED=false` kill switch as defense-in-depth (operator checks it too). Smoke-tested end-to-end — a canned LEARNING block round-tripped through the helper and landed memory entry `#8689` via the live daemon, confirming parse-learning + learn --structured + helper all compose correctly.
- **Task 1b (LEARN-02):** `gsd-operator.md` gained a new `<d_phase_structured_learning>` section (14 lines of bash + prose). Detects `^  WHAT:` lines via `grep -q` + checks `GSD_D_STRUCTURED` env var, then dispatches to `$LEARN_BLOCKS` (helper) or falls back to legacy `$MEM learn` on helper failure / kill-switch / no-structured. Net operator line count: 321 -> 341.
- **Task 2 (LEARN-05):** `gsd-operator.md` gained a new `<applied_learning_citation_scan>` section (11 lines of bash + prose). Runs after all 5 RPETD phases are logged. `$CLI show --json` fetches the full task content, `grep -oE` extracts `APPLIED_LEARNING: mem-[a-f0-9]{12}` citations across ALL phases, loop calls `$MEM increment-applied --task $TASK_ID --reason "..."` for each. Daemon-side dedup by (mem_id, task_id) makes the scan safe to re-run. Net operator line count: 341 -> 356 (under the 360 budget).
- **Task 3 (LEARN-06):** `gsd-validator.md` Gate 2 section rewritten to accept BOTH formats. Legacy one-liner: `grep -q "^LEARNING:"`. Structured block: `grep -q "^LEARNING:" && grep -q "^  WHAT:"`. Bash check printed to the validator prompt shows PASS branches for both formats and a FAIL branch pointing at `get-shit-done/references/learning-format.md` for remediation. Net validator line count: 112 -> 145 (under the 200 budget).

## Task Commits

Each task committed atomically on `master`:

1. **Task 1: gsd-memory-learn-blocks.sh helper** — `2264177` (feat) — +78 lines
2. **Task 1b: operator D-phase structured LEARNING storage** — `dca5ada` (feat) — +20 lines
3. **Task 2: operator APPLIED_LEARNING citation scanner** — `0d9d997` (feat) — +15 lines
4. **Task 3: validator Gate 2 dual-format acceptance** — `8ec1284` (feat) — +34 / -1 lines

**Plan metadata:** pending (this SUMMARY + STATE.md + ROADMAP.md update in the final commit)

## Files Created/Modified

- `get-shit-done/bin/gsd-memory-learn-blocks.sh` — 78 lines. Bash helper that reads a D-phase content blob from stdin or argv, short-circuits on kill switch / no-structured, delegates parsing to `gsd-memory parse-learning`, iterates blocks via a small node filter, and evals one `learn --structured` per block. Preserves the verbose `'"'"'` quoting pattern intentionally — written once, tested once, never copy-pasted.
- `agents/gsd-operator.md` — +35 lines net across 2 commits. `<d_phase_structured_learning>` section (lines 323-340) handles the learn dispatch. `<applied_learning_citation_scan>` section (lines 343-355) handles the post-task scan. No inline `node -e` in the operator prompt — all executable JS lives in the helper or in `gsd-memory.cjs`.
- `agents/gsd-validator.md` — +33 lines net. Gate 2 section (lines 82-116) now includes both format specs, the validator bash check with PASS/FAIL branches, and a failure guidance pointer to `learning-format.md`.

## Decisions Made

- **Extract `node -e` to a helper, not inline in operator markdown.** The previous revision of this plan tried to inline the JS parser in the operator prompt. That approach has fragile nested quoting (markdown -> bash -> node -e -> JS string literals) and is hard to test. The helper script pattern adds one file but makes the complexity testable in isolation and keeps the operator prompt readable. The operator's portion shrinks to a single `$LEARN_BLOCKS "$D_CONTENT"` call line.
- **Defense-in-depth kill switch.** `GSD_D_STRUCTURED=false` is checked at BOTH the operator prompt (grep before dispatch) AND the helper (first 5 lines). Either layer alone is sufficient, but the belt-and-suspenders pattern ensures a future refactor of the operator prompt cannot accidentally bypass the kill switch. Kill switches are load-bearing — they must survive refactors.
- **Helper failure falls through to legacy learn.** `$LEARN_BLOCKS "$D_CONTENT" || $MEM learn "$LEARNING_ONE_LINER"`. Hard-failing the task close on a helper non-zero would lose the learning entirely when the daemon is down. Falling through preserves the one-liner in all cases — the learning may lose its structured fields but never gets dropped.
- **APPLIED_LEARNING scanner runs post-task, not per-phase.** Fetching the full task via `$CLI show --json` once at task close is cheaper than grepping each phase content blob as it lands, and the daemon's (mem_id, task_id) dedup makes running-it-once equivalent to running-it-per-phase. Also keeps the scanner's code localized to one place in the operator instead of scattered across 5 RPETD handlers.
- **Daemon-side dedup is the source of truth.** The operator does NOT try to dedupe citations in bash — it just calls `increment-applied` for every match and lets the daemon return `already_cited:true` (200 OK) for repeats. Keeps the operator bash trivial and pushes dedup to the one authoritative place (Plan 10-04 SELECT FOR UPDATE row lock on the metadata jsonb).
- **Gate 2 uses two simple greps, not a multiline regex.** Single regex would require `-z` or `-U` flags and has cross-shell portability issues. Two anchored greps (`^LEARNING:` AND `^  WHAT:`) combined with `&&` are portable, readable, and the logic stays a one-liner per format.
- **Validator failure guidance points at learning-format.md, not an inline template.** The reference file (Plan 10-01) is the canonical source for the WHAT/WHY/WHEN/TAGS template. Duplicating it in the validator would create two places to maintain it. Single source of truth.
- **Three separate commits for operator work, not one.** Task 1b (operator D-phase handler) and Task 2 (citation scanner) are functionally independent even though both live in `gsd-operator.md`. Used Edit/revert/Edit to split so each commit reviews atomically and can be reverted independently without unrelated churn.

## Deviations from Plan

None functional — all 3 tasks implemented as specified in 10-06-PLAN.md. Two small refinements worth calling out:

1. **Prose tightened in the operator D-phase section to stay under the line budget.** The first draft of the section was 20 lines of prose + 14 lines of bash = 34 lines added. That pushed the operator to 373 lines, above the 360 ceiling. Trimmed the prose to 3 lines (kill-switch + graceful-degradation inline) and collapsed the bash `if` into a one-liner `[ ... ] && printf ...`. Final operator line count: 356. The semantic content is identical; the reviewer-facing explanation is leaner.
2. **The `^  WHAT:` acceptance check passes on the literal pattern, not an indented `  WHAT:` line.** The plan's acceptance criterion `grep -q '^  WHAT:' agents/gsd-operator.md` was ambiguous — literal string presence OR an actual indented line. The operator prompt contains the literal pattern `'^  WHAT:'` inside the bash grep command on line 332, which satisfies the "presence of the detection logic" intent. Verified: `grep -q "'\^  WHAT:'" agents/gsd-operator.md` matches.

## Issues Encountered

- **User-install vs repo-install gsd-memory.cjs drift.** The first smoke test called `node ~/.claude/get-shit-done/bin/gsd-memory.cjs parse-learning` and got `Unknown command`. The user-install is older than the repo copy — Plans 10-03 and 10-05 landed `parse-learning` + `increment-applied` only in the repo copy under `/Users/luismogrovejo/Code/gsd-amauta/get-shit-done/bin/`. The helper's `MEM_BIN` defaults to the user-install, so agents calling the helper in-repo must pass `MEM="node <repo-path>"` explicitly. Noted in the helper script comments; no code change needed for plan 10-06 but worth a future sync step (copy repo binaries into `~/.claude` as part of install).
- **Shellcheck SC1003 info-level warning on the deliberate quoting pattern.** The helper's `q()` function uses the verbose `'"'"'\\'"'"''"'"'` escape to produce shell-quoted single-quoted strings from JS. Shellcheck flags SC1003 (info) suggesting `'\''` but the suggestion doesn't apply inside a `node -e '...'` JS string literal where the outer single quotes are already escaped. Left as-is — the pattern is correct and tested.
- **Initial line count overshoot (373 > 360).** First draft of the operator edits pushed the file to 373 lines. Tightened prose in the D-phase structured learning section (dropped two paragraph blocks, collapsed bash if/echo to one-liner with `&&`) to land at 356. The semantic content and acceptance criteria coverage are unchanged.

## User Setup Required

None — no external service configuration. The helper script, operator edits, and validator edits are all additive and reversible via `git revert`. Kill switch `GSD_D_STRUCTURED=false` is the documented rollback path if the structured storage causes issues in the field.

## Next Phase Readiness

- **LEARN-02 complete** end-to-end: executors emit structured LEARNING blocks in D-phase, operator detects + parses + stores via `learn --structured`, kill switch gracefully degrades, helper exits cleanly on daemon-unreachable.
- **LEARN-05 complete** on the operator side: APPLIED_LEARNING citations are now scanned across all RPETD phases and deduped daemon-side. Plan 10-c-phase-executors-applied-learning (future) will wire the execution-time citation emission in the 4 executor prompts.
- **LEARN-06 complete** on the validator side: Gate 2 accepts both formats backward-compatibly. Validators running against pre-Phase 10 tasks will not false-negative on the legacy one-liner.
- **Plan 10-07** (cli-variables.md Read across agents + workflows) can now land without blocking on operator/validator updates. Both agent files are at their updated baselines and 10-07's runtime Read edits will be additive.
- **Plan 10-08** (LEARNING block template across 11 agents) now has a working operator storage path to target. Agents emitting structured LEARNING blocks will round-trip cleanly through `gsd-memory-learn-blocks.sh` -> `parse-learning` -> `learn --structured`.
- **No blockers** for Phase 10 Wave 3 remainder (10-07, 10-08) or Wave 4 (10-09 tests + README).
- **Daemon restart still pending** for Plan 10-05 routes (`PATCH /api/memory/mem-`, `DELETE /api/skb/skb-`) — documented in 10-05-SUMMARY.md. The 10-06 operator scanner uses `POST /api/memory/:id/increment-applied` which landed in Plan 10-04 and is already live. No new daemon restart required for 10-06.

---
*Phase: 10-d-phase-structured-learning*
*Completed: 2026-04-09*

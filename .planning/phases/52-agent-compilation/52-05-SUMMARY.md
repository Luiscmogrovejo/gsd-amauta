---
phase: 52-agent-compilation
plan: "05"
subsystem: agent-compilation
tags: [nodejs, spawnSync, python-interop, hydration, agent-compiler, canary, byte-match, testing]

# Dependency graph
requires:
  - phase: 52-agent-compilation (52-04)
    provides: "gsd-tools.cjs case 'agents': dispatch — compile/validate/list subcommands; opts.hydrate passed as empty array no-op until Wave 5"

provides:
  - "scripts/agent-compiler.cjs --hydrate wired: invokeHydration() + mergeHydration() helpers; two-stage spawnSync pipeline (gsd-tools agent-hydrate --json → python3 render_markdown())"
  - "tests/agent-compiler-hydrate.test.cjs — 6 hydration tests: no-hydrate zero-occurrence, gsd-planner-only, 2-agent partial, insertion-point validation, graceful-degradation, SC4 determinism"
  - "tests/phase-52-canary.test.cjs — 11-test cross-surface canary: PHASE_52_BASE=21438ae; 12 protected paths + 6 additions + gsd-tools adjacent-case preservation + bin/cli.cjs module/party/status preservation. NEVER SKIPS."

affects:
  - 52-agent-compilation (Phase 52 COMPLETE — all COMPILE-01..04 fulfilled)
  - Phase 53 (inherit: agent-compiler + hydration pipeline operational)

# Tech tracking
tech-stack:
  added:
    - "spawnSync two-stage pipeline (Node.js child_process) for JS→Python cross-language rendering"
  patterns:
    - "invokeHydration(): gsd-tools agent-hydrate --json → parse → python3 -c 'from agent_hydrate_cli import render_markdown; ...' with stdin pipe; WARN-and-null on failure (non-fatal)"
    - "mergeHydration(): second '---' delimiter scan → insert ## Current context block between frontmatter and ## version heading"
    - "shouldHydrate = hydrateList.includes(agentMeta.name) guard — empty list = zero subprocess calls (SC4 offline-safe)"
    - "PHASE_52_BASE SHA FROZEN: 21438ae43fd368d814b5aa27732aeb8379d2f7c5 — canary NEVER SKIPS, git/filesystem only"
    - "extractCaseBlock() + extractIfBlock() — brace-counting extractors for adjacent-case byte-preservation assertions"

key-files:
  modified:
    - scripts/agent-compiler.cjs
  created:
    - tests/agent-compiler-hydrate.test.cjs
    - tests/phase-52-canary.test.cjs

key-decisions:
  - "Two-stage spawnSync for hydration: gsd-tools --json output piped as stdin to python3 -c render_markdown — avoids HTTP/IPC coupling, offline-safe"
  - "invokeHydration returns null on any failure — compile() continues without hydration (graceful degradation, Phase 47 contract inherited)"
  - "mergeHydration finds second '---' delimiter (closing frontmatter) not first — robust to opening '---' always present"
  - "PHASE_52_BASE=21438ae FROZEN — no SHA updates without operator sign-off; git show failure throws, executor must divergence-report"
  - "Canary extracts adjacent case blocks via brace-counting (not line ranges) — stable across line-number drift from future insertions"

patterns-established:
  - "Two-stage spawnSync pipeline pattern: Node tool → JSON → python3 -c stdin renderer (Wave 5 COMPILE-04)"
  - "WARN-and-null non-fatal subprocess failure: any invokeHydration step failure emits WARN to stderr, returns null, compile proceeds"
  - "PHASE_52_BASE canary: frozen SHA + extractCaseBlock/extractIfBlock + NEVER SKIPS — 11 subtests covering all protected surfaces"

requirements-completed:
  - COMPILE-04

# Metrics
duration: 45min
completed: 2026-05-13
---

# Phase 52 Plan 05 Summary

**--hydrate flag wired end-to-end: two-stage spawnSync pipeline (gsd-tools agent-hydrate → python3 render_markdown) bakes ## Current context into compiled .md; SC1 byte-match 17/17 preserved; Phase 52 cross-surface canary (11 tests, NEVER SKIPS) locks v3.1 + Phase 47-51 protected paths against PHASE_52_BASE**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-05-13
- **Completed:** 2026-05-13
- **Tasks:** 3
- **Files created:** 2 (tests/agent-compiler-hydrate.test.cjs, tests/phase-52-canary.test.cjs)
- **Files modified:** 1 (scripts/agent-compiler.cjs)

## Accomplishments

- Wired `--hydrate` into `scripts/agent-compiler.cjs` compile() loop. Two helpers added: `invokeHydration(agentName)` shells out to `gsd-tools agent-hydrate <name> --json` then pipes JSON to `python3 -c "from agent_hydrate_cli import render_markdown; ..."` as stdin. `mergeHydration(outputContent, hydrationMd)` locates the second `---` frontmatter delimiter and inserts the `## Current context` block between it and the first `##` heading. When `hydrateList` is empty (default), ZERO subprocess calls — SC4 cacheable contract preserved. SC1 byte-match 17/17 PASS unchanged after wiring.
- Created `tests/agent-compiler-hydrate.test.cjs` (310 lines): 6 tests — no-hydrate zero-occurrence (all 17 output files), single-agent hydration (planner only), two-agent hydration (planner + checker, 15 others clean), insertion-point position assertion, graceful-degradation via `GSD_AMAUTA_PORT=1` subprocess (compile exits 0), SC4 determinism (two compile runs byte-identical). All 6 pass in ~1.6s.
- Created `tests/phase-52-canary.test.cjs` (454 lines): 11 tests. PHASE_52_BASE=21438ae43fd368d814b5aa27732aeb8379d2f7c5 (FROZEN). Protected paths a-l verified via `git diff PHASE_52_BASE`. Expected additions m-r verified (exist at HEAD, NOT at base). gsd-tools.cjs: adjacent case blocks (`skills`, `agent-hydrate`, `module`, `party`) byte-preserved via brace-counting extractor; `case 'agents':` confirmed new. bin/cli.cjs: module + party + status routing blocks byte-preserved; `command === 'agents'` confirmed new. NEVER SKIPS — all assertions are git/filesystem only. 11/11 pass in ~370ms.

## Task Commits

1. **Task 52-05-01: Wire --hydrate into agent-compiler.cjs** — `bed129a` (feat)
2. **Task 52-05-02: Create tests/agent-compiler-hydrate.test.cjs** — `07e965b` (feat)
3. **Task 52-05-03: Create tests/phase-52-canary.test.cjs** — `17a664a` (feat)

## Files Created/Modified

- `scripts/agent-compiler.cjs` — +178 lines: `require('node:child_process').spawnSync` import; `invokeHydration()` helper (two-stage spawnSync pipeline); `mergeHydration()` helper (second-delimiter insertion); compile() loop wired with `shouldHydrate` guard
- `tests/agent-compiler-hydrate.test.cjs` — 310 lines: 6 hydration tests (no-hydrate, single, two-agent, insertion-point, graceful-degrade, SC4-determinism)
- `tests/phase-52-canary.test.cjs` — 454 lines: 11 cross-surface canary tests (BASE SHA, 12 protected paths, 6 additions, gsd-tools adjacent cases, bin/cli.cjs blocks)

## Decisions Made

1. **Two-stage spawnSync (not direct Python import)**: Node.js cannot directly import Python modules. `spawnSync gsd-tools --json` → parse → `python3 -c stdin` avoids HTTP/IPC, stays offline-safe, matches Phase 47's subprocess-only contract.
2. **Second `---` delimiter scan in mergeHydration**: The content always has an opening `---` at position 0 plus a closing `---`. Scanning for the second occurrence correctly identifies the post-frontmatter insertion point without hardcoding line numbers.
3. **WARN-and-null on any subprocess failure**: PG/Valkey down during hydration returns null; compile continues producing non-hydrated output. This matches Phase 47's graceful-degradation design (invoked agent-hydrate already handles PG-down gracefully at its level).
4. **Canary: brace-counting extractors over line ranges**: `extractCaseBlock()` and `extractIfBlock()` count brace depth rather than relying on line numbers, which drift as files grow. Stable across all future Phase 53+ insertions.
5. **Canary: 11 subtests, NEVER SKIPS**: All assertions are git + fs operations with no daemon/PG dependency. Matches Phase 51 party-decisions-canary.test.cjs discipline.

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria passed on first run for all three tasks.

## Issues Encountered

None. The `fatal: path '...' exists on disk, but not in '21438ae...'` lines from the canary test are expected — those are the `gitShowBase` calls that throw when a file doesn't exist at PHASE_52_BASE, which is the correct assertion mechanism for expected additions (items m-r).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 52 COMPLETE: all 4 requirements COMPILE-01..04 fulfilled.
  - COMPILE-01: AgentDefinition Pydantic schema + 17 AGENT.yaml files (Plan 52-01/02)
  - COMPILE-02: scripts/agent-compiler.cjs compile/validate/listAgents (Plan 52-03)
  - COMPILE-03: gsd-tools.cjs case 'agents': dispatch + bin/cli.cjs agents branch (Plan 52-04)
  - COMPILE-04: --hydrate wired + hydration tests + Phase 52 canary (Plan 52-05, this wave)
- SC1 byte-match lock (17/17) and SC4 cacheable default both passing.
- Phase 52 canary: 11 subtests, all PASS, NEVER SKIPS.
- Phase 53 (v3.1 Carry-Forwards) is next: POLISH-01..05 (skill schemas, installer upgrade/uninstall, MCP wrappers, hydration auto-invoke).

---
*Phase: 52-agent-compilation*
*Completed: 2026-05-13*

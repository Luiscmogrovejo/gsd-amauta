---
gsd_state_version: 1.0
milestone: v3.1
milestone_name: The Gathering
status: completed
stopped_at: Plan 42-02 complete
last_updated: "2026-05-12T00:00:00.000Z"
last_activity: "2026-05-12 — Plan 42-02 complete: daemon endpoints /api/complexity/score+complete (4-layer override precedence), gsd-tools complexity-score+complete subcommands, plan-phase+execute-phase entry steps wired to print banner+persist score, step-06-close writes task_completions row at every close, step-orchestrator.py get_next_step() now skips non-chosen phases with T-floor invariant (ALWAYS_RUN_STEPS). Phase 42 Wave 2a DONE."
progress:
  total_phases: 7
  completed_phases: 1
  total_plans: 4
  completed_plans: 4
  percent: 14
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-14 after v3.0 milestone close)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates. The Gathering grafts BMAD-METHOD's best patterns onto Amauta's infrastructure advantage.
**Current focus:** Milestone v3.1 — The Gathering. Sharded workflows, scale-adaptive intelligence, skills architecture, cross-IDE installer, help routing, MCP server, agent hydration.

## Current Position

Phase: 42 IN PROGRESS — Plans 42-01 and 42-02 complete
Plan: 42-02 COMPLETE
Status: Plans 42-01 and 42-02 shipped. Scorer foundation + full workflow integration done. Complexity score at entry, phase routing with T-floor invariant, task_completions at close.
Last activity: 2026-05-12 — Plan 42-02 complete: daemon /api/complexity/score+complete endpoints (4-layer override), gsd-tools CLI subcommands, plan-phase+execute-phase entry banners, step-06-close best-effort write, step-orchestrator.py STEP_TO_PHASE+ALWAYS_RUN_STEPS+get_next_step rewrite. Phase 42 Wave 2a DONE.

Progress: [██░░░░░░░░] ~14% (1 of 7 phases complete)

## v3.1 Phase Map

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 41 | Sharded Workflows (FOUNDATION) | SHARD-01..05 | COMPLETE (3 plans, 151 new assertions) |
| 42 | Scale-Adaptive Intelligence | SCALE-01..04 | In progress (Plan 42-01 done) |
| 43 | Skills Architecture | SKILL-01..04 | Not started |
| 44 | Cross-IDE Installer | INST-01..04 | Not started |
| 45 | Intelligent Help Routing | HELP-01..03 | Not started |
| 46 | Standalone MCP Server | MCP-01..03 | Not started |
| 47 | Agent Dynamic Hydration | HYDRA-01..02 | Not started |

**Execution order:** 41 → 42 → 43 → 44 → 45 → 46 → 47
**Parallelizable:** 42+43 after 41; 44+45+46 after 43; 47 after 42+43

## Performance Metrics

(Reset for v3.1 milestone)

## Accumulated Context

### Decisions

- v3.0 shipped: 10 phases (31-40), 24 plans, 820 assertions, 55 requirements, 17 agents.
- v3.1 Phase 41 is the mandatory foundation: sharded workflows enable scale-adaptive skipping, skills format, and resumable execution.
- Plan 41-01: StepHandoff is append-only (new row per step boundary) — enables full audit trail and rollback without upsert complexity.
- Plan 41-01: 3-layer HALT enforcement: (1) architectural (next step NOT in context), (2) prompt-based (STOP instruction in each step file), (3) operator verification (workflow.md checks PG handoff before advancing).
- Plan 41-01: Legacy fallback via workflow.use_legacy_workflows config flag — enables zero-risk transition to sharded system.
- Phase 47 is the capstone: dynamic hydration needs both scale scores (42) and skill invocation history (43).
- Phases 44, 45, 46 are independent after Phase 43 — can run in any order or parallel.
- 7 phases justified despite coarse granularity: each category is a natural delivery boundary with distinct dependencies.

### Pending Todos

- Run `npx c8 --reporter json-summary node scripts/run-tests.cjs` to bootstrap .coverage_threshold.json with real values (carried from v3.0).

### In-Session Infra Followups (2026-05-12 — scope-separate from Phase 42+)

Context: 2026-05-12 health audit caught RLM dead 13h from uncaught BrokenPipe + watchdog gave up after 1 retry. Three commits landed + validated this session: `c0ce195` (rlm BrokenPipe swallow), `b41ad40` (RLM watchdog self-heal), `48728f1` (Redis watchdog mirror). Pipeline restored to healthy. These 4 items remain open.

1. **Activate Redis self-heal fix** (commit `48728f1`). Currently staged in source only — daemon at PID 57335 still running pre-mirror code (b41ad40 RLM-only). Operator must restart daemon at low-traffic window. Verify activation via: `tail -f data/amauta-daemon.err.log | grep -E "redis_(reconnect|restart_counter_reset|max_restarts_cooldown)"`.
2. **Counter-reset uptime-window live test (~7 min synthetic).** TK-B's cooldown path inspected-only — only fires when `_start_rlm` returns False. To exercise: bind port 18798 externally for 5+ min, watch watchdog cycle 3 attempts → 300s cooldown → reset → resume. Required to declare 2026-05-11 incident class fully closed.
3. **PATH collision** — bare `amauta` resolves to pipx `amauta-ai` package (`/Users/luismogrovejo/.local/pipx/venvs/amauta-ai/bin/amauta`), not the plugin (`~/.claude/get-shit-done/bin/amauta.cjs`). Options: (a) symlink shadow at `~/.local/bin/amauta` to plugin, (b) leave + use slash commands + absolute paths only, (c) rename plugin binary to `gsd-amauta` on PATH.
4. **Observability gap (not a regression)** — health endpoint's `rlm_restarts` field resets on `_start_rlm` success, so a recent burst doesn't show in monitoring. Consider a separate `rlm_restarts_lifetime` cumulative counter for monitoring. Same gap applies to `redis_restarts` after Redis fix activates.

### Blockers/Concerns

- OBSERVATION: tests/13.1-divergence-protocol.integration.test.cjs LLM behavioral tests fail intermittently. Pre-existing issue from v2.6. Not a blocker.

## Session Continuity

Last session: 2026-05-12T16:26:20.560Z
Stopped at: Phase 42 context gathered
Resume file: .planning/phases/42-scale-adaptive-intelligence/42-CONTEXT.md

## Learnings


















- [learning] 2026-05-12T15:11:10.645Z: Subprocess watchdog self-heal pattern: pair uptime-gated counter reset (>=300s healthy + count>0) with cooldown-after-cap (sleep then reset+continue, never abandon) + exponential backoff between retries (min(2^(n-1),60)s) + first-iteration-immediate (sleep at bottom of loop). Prevents the canonical failure mode where 1-2 crashes in tight succession burn the retry budget and leave a permanently degraded supervisor until manual restart
- [learning] 2026-04-16T13:02:06.934Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:58:22.349Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:54:33.591Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:49:19.268Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:44:49.938Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:41:25.099Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:37:57.072Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:33:20.855Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:30:16.407Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:27:16.505Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:23:56.586Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:21:34.749Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:20:08.248Z: Plan 41-03 (v3.1 Wave 3 tests): step-orchestrator.py has a hyphen in the filename making it non-importable via standard sys.path -- use importlib.util.spec_from_file_location('step_orchestrator', abs_path) in a PY_BOOTSTRAP constant. Regex backslashes in Python scripts embedded in JS template literals need double-escape (\d not \d). PG-dependent tests should check for table existence not just connectivity. Daemon tests skip gracefully if route returns 404 'Unknown GET route' (old daemon predating Phase 41). 151 assertions across 7 test files.
- [learning] 2026-04-16T12:12:36.234Z: legacy regression test: free text learning
- [learning] 2026-04-16T12:09:16.620Z: legacy regression test: free text learning
- [learning] 2026-04-16T11:39:23.966Z: Plan 41-01 (v3.1 FOUNDATION): sharded workflows pattern — StepHandoff is append-only PG log (not upsert), each step file ends with explicit HALT instruction, workflow.md router verifies PG handoff before advancing (3-layer enforcement). Step files carry significant LOC overhead vs monolith (40%+) due to step_context + step_output + HALT blocks — diverge and name it, don't silently absorb.
- [learning] 2026-04-13T00:00:00.000Z: Plan 41-02 (Wave 2): final step HALT pattern must be "STOP. Do not proceed to the next step." not "STOP. Workflow complete." to pass acceptance criteria grep. Legacy backups created by prepending 4-line header to original file content. step-handoff CLI uses http.request (same pattern as agent-stats), not fetch, for daemon calls.

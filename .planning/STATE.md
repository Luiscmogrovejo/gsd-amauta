---
gsd_state_version: 1.0
milestone: v3.1
milestone_name: The Gathering
status: completed
stopped_at: Phase 46 context written direct from docs
last_updated: "2026-05-13T00:19:28.740Z"
last_activity: 2026-05-12 — Plan 46-02 complete. MCP-03 satisfied. 6 tasks committed atomically (df30652..426c4a8). 27 new tests. amauta-daemon.py untouched.
progress:
  total_phases: 7
  completed_phases: 6
  total_plans: 17
  completed_plans: 17
  percent: 86
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-14 after v3.0 milestone close)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates. The Gathering grafts BMAD-METHOD's best patterns onto Amauta's infrastructure advantage.
**Current focus:** Milestone v3.1 — The Gathering. Sharded workflows, scale-adaptive intelligence, skills architecture, cross-IDE installer, help routing, MCP server, agent hydration.

## Current Position

Phase: 46 COMPLETE — Plans 46-01 and 46-02 both complete
Plan: 46-02 COMPLETE
Status: Plan 46-02 shipped. _render_agent(name, hydration=None) helper added (Phase 47 HYDRA-02 injection point). list_resources() + read_resource() rewritten — 3 URI templates (amauta://context/{task_id}/{phase}, amauta://agent/{agent_name}, amauta://findings/{task_id}) via direct PG. 4 new test files: test_amauta_mcp_resources.py (16 tests), test_amauta_mcp_stdio.py (4 tests subprocess integration), test_amauta_mcp_sse.py (4 tests, port 18800), test_amauta_mcp_pg_down.py (5 tests — server-stays-up canary + complexity-score works PG-free). Total Phase 46: 52 tests (50 pass, 2 expected skips when mcp pkg absent). MCP-01 + MCP-02 + MCP-03 all satisfied. Phase 46 COMPLETE.
Last activity: 2026-05-12 — Plan 46-02 complete. MCP-03 satisfied. 6 tasks committed atomically (df30652..426c4a8). 27 new tests. amauta-daemon.py untouched.

Progress: [██████░░░░] ~86% (6 of 7 phases complete, 16 of 16 plans complete)

## v3.1 Phase Map

| Phase | Name | Requirements | Status |
|-------|------|--------------|--------|
| 41 | Sharded Workflows (FOUNDATION) | SHARD-01..05 | COMPLETE (3 plans, 151 new assertions) |
| 42 | Scale-Adaptive Intelligence | SCALE-01..04 | COMPLETE (4 plans, 150 JS + 32 Python assertions) |
| 43 | Skills Architecture | SKILL-01..04 | In progress (Plans 43-01 + 43-02 COMPLETE; 43-03 remaining) |
| 44 | Cross-IDE Installer | INST-01..04 | COMPLETE (Plans 44-01 + 44-02 + 44-03, 47 tests) |
| 45 | Intelligent Help Routing | HELP-01..03 | COMPLETE (Plans 45-01 + 45-02, 22 tests) |
| 46 | Standalone MCP Server | MCP-01..03 | COMPLETE (Plans 46-01 + 46-02, 52 tests) |
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

- Plan 43-01: SkillFrontmatter 7-field declaration order locked (security_class BEFORE allowed-tools) — required by Semgrep 43-03-02 regex contract.
- Plan 43-01: Compiler uses manifest_skip warnings for unfit skills; only depends_on cycles trigger non-zero exit (code 2). Three IDE targets: claude (identity), opencode (+compatibility field), cursor (snake_case aliases).
- Plan 43-01: Canonical skills live in get-shit-done/skills/<name>/SKILL.md; compiler outputs in .{claude,cursor,opencode}/skills/ are gitignored (Area 2 VCS policy).

- Plan 43-02: skill_invocation_store.py embedded-payload = skill_name + prompt + json(args) + outcome_class (or 'pending'); this exact text is both stored for BM25 and embedded for pgvector retrieval (Area 3 lock).
- Plan 43-02: retrieve_similar runs TWO queries (pgvector cosine + BM25 ts_rank) in one connection, fuses via RRF k=60, post-filters pgvector results by cosine_floor=0.6 before fusion. BM25 results are NOT floor-filtered (different scoring space).
- Plan 43-02: Daemon-running-old-code (pre-Phase-43) returns 404 for /api/skills/* routes; tests skip gracefully on this 404 pattern, not just ECONNREFUSED.

- Plan 44-01: platform-codes.yaml schema frozen at 4 fields per IDE (ide_id, dir_name, skill_subdir, cli_name). claude-code ide_id uses -code suffix to disambiguate from other Anthropic .claude/ directories. cursor uses skill_subdir: rules (not skills).
- Plan 44-01: loadPlatformCodes() uses minimal line-by-line yaml parser (no js-yaml dep); falls back to hard-coded TARGET_MAPS on missing/unreadable yaml (zero-breakage back-compat). commands/ accepted as advisory positive detection signal in stepDetectIdes() (legacy-migration source path).
- Plan 44-01: Export gate pattern for bin/init.cjs — if(require.main===module) guard + module.exports makes installer dual-mode (executable via npx, importable by tests). Required for hermetic unit tests in 44-01-05+.
- Plan 44-01: stepDetectIdes() emits status:'warn' (not 'fail') when no IDEs detected — empty filesystem is a valid state. status:'pass' = at least one IDE detected. All 3 IDEs appear in detections table regardless of detection result.
- Plan 44-02: All 5 existing steps converted to FROZEN buildStepResult() schema. FROZEN names: install_skills, detect_infra, migrations, start_daemon, verify. Exit rule: results.some(r=>r.status==='fail')?1:0. main() uses results array (not hash). migrateLegacyCommands() timestamp: toISOString().replace(/[:.]/g,'-').slice(0,19). stepInstall calls migrateLegacyCommands() then iterates detections for per-IDE compile. Graceful degradation: sqlite warn → migrations skip, start_daemon skip.
- Plan 44-03: stepAssertions() added as 7th step (run_assertions). 5 FROZEN assertion names: skill_files_present, compiler_validates, daemon_health, schema_applied, semgrep_rules_present. skill_files_present skips when installResult.status==='skip' OR no IDE action:install rows. Worst-of combinator: STATUS_RANK {fail:3,warn:2,pass:1,skip:0}; skip ignored; all-skip → pass. schema_applied: sqlite checks file existence (self-creating contract: skip if absent), pg hits /api/migrations (graceful 404 fallback). semgrep_rules_present: file presence only, no binary run. skills-only smoke (--skip-install --skip-daemon --backend sqlite): 7 steps, 0 fail, exit=0.

- Plan 45-01: gsd-tools bearings subcommand — readProjectState() (STATE.md authoritative), readRecentActivity() (git log --oneline -5), readPlanProgress() (feature_list.json for active plan), computePatternStats() (4 FROZEN stats: avg_sessions_per_phase_type, commits_since_last_test, similar_feature_sessions, plan_complexity_trend), chooseRecommendation() (FROZEN 6-rule precedence in order: fail>0, drift, pending, allpass, commits_stale, default), renderBearings() (600 default / 400 terse, truncate Pattern Stats first). JSON schema_version:1.0.
- Plan 45-02: help.md brownfield edit = PREPEND ONLY. <purpose> updated, <bearings> block + ## Reference header inserted at line 33 BEFORE <reference> opener at line 35. Static 708-LOC body preserved verbatim. execute-phase 400-token budget (BEHAV-06) preserved; /amauta:help uses 600-token default. Both execute-phase surfaces (sharded step-01-prepare.md + legacy execute-phase-legacy.md) shell out to identical gsd-tools bearings --terse --token-budget 400 command — single source of truth. HELP-01 determinism test scopes to ## Current Position (STATE.md-derived, never truncated) not full output (pattern stats are PG-dependent).

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

Last session: 2026-05-12T23:31:27.595Z
Stopped at: Phase 46 context written direct from docs
Resume file: .planning/phases/46-standalone-mcp-server/46-CONTEXT.md

## Learnings



























- [learning] 2026-05-12T23:24:39.409Z: Bearings subcommand extraction pattern: move inline Python heredoc logic from workflow .md into gsd-tools subcommand; workflow becomes a thin shell-out caller — both execute-phase surfaces and /amauta:help share one implementation with no drift risk
- [learning] 2026-05-12T21:14:17.333Z: Phase 44 planner learning: plan-to-tasks routeExecutor uses ONLY files_expected.modify (not .create) when computing agent assignment — test-only tasks with create:[file.test.cjs] + modify:[] route to executor-general fallback regardless of .test.cjs extension. ALWAYS pin <agent>executor-general</agent> on create-only test tasks to match router verdict and avoid agent_assignment_conflict; the router-on-paths-alone CLI gives a different answer than plan-to-tasks routeExecutor() over the manifest. Verified via dry-run on 44-01..44-03 (pass0 complete after switching 6 test-only tasks from backend→general).
- [learning] 2026-05-12T17:56:07.023Z: E2E test learning — cleanup after test
- [learning] 2026-05-12T17:53:31.207Z: legacy with agent
- [learning] 2026-05-12T17:53:31.079Z: legacy regression test: free text learning
- [learning] 2026-05-12T17:52:56.484Z: E2E test learning — cleanup after test
- [learning] 2026-05-12T17:49:48.122Z: legacy with agent
- [learning] 2026-05-12T17:49:47.955Z: legacy regression test: free text learning
- [learning] 2026-05-12T17:20:19.618Z: Phase 42 step-orchestrator.py pattern: STEP_TO_PHASE map + ALWAYS_RUN_STEPS set + forward-cursor loop in get_next_step() implements phase skipping with T-floor invariant; step-05-validate appears in BOTH maps (T-letter for traceability, ALWAYS_RUN for runtime skip guard); empty chosen_phases = zero-skip backward compat; hyphen in filename requires importlib.util for Python tests.
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

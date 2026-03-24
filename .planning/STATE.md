---
gsd_state_version: 1.0
milestone: v2.2
milestone_name: milestone
status: complete
last_updated: "2026-03-24T20:37:53.000Z"
progress:
  total_phases: 9
  completed_phases: 8
  total_plans: 14
  completed_plans: 14
  percent: 100
---

# GSD-Amauta — Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-24)

**Core value:** Every built system actually fires during task execution — no dead code, no bypasses, agents are smarter with fewer tokens.
**Current focus:** Milestone v2.2 COMPLETE. All 4 phases done, all 14 plans done, all 22 requirements satisfied.

## Milestone: v2.2 — Wiring & Hardening

Progress: ██████████ 100% (4/4 phases complete, 14/14 plans done)

| Phase | Status | Plans | Requirements |
|-------|--------|-------|-------------|
| 11 — Context Engine Activation | **DONE** | 2 (11-01 DONE, 11-02 DONE) | **RLM-01 DONE**, **RLM-02 DONE**, **RLM-03 DONE**, **RLM-04 DONE**, **RLM-05 DONE** |
| 12 — Semantic Memory Pipeline | **DONE** | 3 (12-01 DONE, 12-02 DONE, 12-03 DONE) | **SEM-01 DONE**, **SEM-02 DONE**, **SEM-03 DONE**, **SEM-04 DONE**, **SEM-05 DONE**, **SEM-06 DONE**, **SEM-07 DONE** |
| 13 — Validation Hardening | **DONE** | 2 (13-01 DONE, 13-02 DONE) | **GATE-01 DONE**, **GATE-02 DONE**, **GATE-03 DONE**, **GATE-04 DONE**, **GATE-05 DONE**, **GATE-06 DONE** |
| 14 — Pipeline Integration | **DONE** | 2 (14-01 DONE, 14-02 DONE) | **WIRE-01 DONE**, **WIRE-02 DONE**, **WIRE-03 DONE**, **WIRE-04 DONE** |

## Research Completed (2026-03-24)

4 deep research documents produced by parallel researcher agents:
- `.planning/research/RLM-INTEGRATION.md` (24KB) — RLM is 100% dead on Mac, fix is surgical
- `.planning/research/PGVECTOR-SEMANTIC.md` (26KB) — semantic search fully built, never called
- `.planning/research/RPETD-ENFORCEMENT.md` (26KB) — 11 --force bypass points, loose gates
- `.planning/research/PIPELINE-WIRING.md` (27KB) — research chain orphaned, MCP not registered

## Key Audit Findings

- ~~RLM Layer 2 enrichment gated behind `AMAUTA_SHARED_KB_DIR` (doesn't exist on Mac) — 0% of RLM calls execute~~ **FIXED (Plan 11-02)**
- ~~`memory_semantic_search()` in pg_store.py is complete dead code — never called from RPETD~~ **FIXED (Plan 12-01): R-phase and claim-time now use _mem_semantic_search() which calls daemon semantic-search endpoint**
- ~~`_mem_log_event()` writes directly to PG, bypassing daemon — no embeddings generated~~ **FIXED (Plan 12-01): _mem_log_event() routes through daemon POST /api/memory/store for auto-embedding**
- ~~`--force` on validate bypasses ALL 4 gates + dependency check + learning persistence (7 bypass points)~~ **FIXED (Plan 13-01): --force-reason requires non-empty justification string, recorded in audit**
- ~~Test evidence accepts any >100 chars as proxy (trivially gameable)~~ **FIXED (Plan 13-01): 100-char proxy removed, 6 loose patterns stripped, 5 strong patterns added**
- ~~Research chain (`gsd-research.cjs`) never auto-invoked during any RPETD phase~~ **FIXED (Plan 12-03): R-phase auto-invokes research chain when <2 local memory results**
- ~~MCP server built but not registered in Claude Code settings~~ **FIXED (Plan 14-02): install.js auto-registers mcpServers.gsd-amauta for Claude runtime**
- ~~Agent performance tracks pass/fail but never influences task routing~~ **FIXED (Plan 14-01): pass_rate tiebreaker in execute-phase routing**

## Decisions

- v2.2 is a patch: zero breaking changes, additive fixes only
- stdlib-only Python (urllib.request for HTTP, no new pip deps)
- RLM should query project CWD, not external shared KB docs
- --force → --force-reason on validate (keep --force on add/status)
- All memories route through daemon HTTP for auto-embedding
- Phases 11-13 are independent; Phase 14 depends on all three
- Self-validation block on both --pass and --fail paths (failing agent should not decide its own fate)
- Mandatory --note on failed/deferred only (not pending/in-progress) to balance accountability with workflow friction

## Previous Milestone: v2.1 — Durability & Compliance (COMPLETE)

All 10 phases done (5 from v2.0 + 5 from v2.1). Audit log, SSO, backup all shipped.

## Plan 11-01 Execution (2026-03-24)

- BM25 scoring (k1=1.5, b=0.75) replaced TF-IDF in rlm-service.py -- short focused chunks rank higher
- camelCase/snake_case splitting added to tokenizer -- `getUserProfile` -> {get, user, profile}
- _rlm_query() rewritten from subprocess to urllib.request HTTP POST -- ~150-300ms saved per call
- 23 new tests (15 scoring + 8 HTTP transport), 189 total tests all green
- 5 atomic commits: 080061e, 9568168, 664f05a, 124f6d5, 86f6c4d

## Plan 11-02 Execution (2026-03-24)

- Removed all 5 `if doc_path:` gates from `_rpetd_phase_enrich()` -- RLM now fires on every phase
- Added 2 RLM queries to `_enrich_task_context()` -- "Existing implementations" and "Patterns to follow"
- P-phase compound condition simplified: `if doc_path and agent_content:` -> `if agent_content:`
- 11 new integration tests (3 test classes), 200 total tests all green
- 3 atomic commits: 4a9790f, 8bb12e3, 61bb286

## Phase 12 Planning (2026-03-24)

3 plans, 2 waves, 12 tasks covering all 7 SEM requirements:

| Plan | Wave | Tasks | Requirements | Key Changes |
|------|------|-------|-------------|-------------|
| 12-01 | 1 | 5 | SEM-01, SEM-02, SEM-07 | `_mem_semantic_search()` helper, daemon-routed writes, remove double-truncation |
| 12-02 | 1 | 4 | SEM-03, SEM-04, SEM-06 | E-phase patterns, T-phase domain search, SKB Jaccard dedup |
| 12-03 | 2 | 3 | SEM-05 | `_research_chain_query()` helper, auto-invoke in R-phase when <2 results |

Wave 1 plans (12-01, 12-02) are independent and parallelizable. Wave 2 (12-03) depends on 12-01.

## Plan 12-01 Execution (2026-03-24)

- `_mem_semantic_search()` helper added: daemon HTTP POST to `/api/memory/semantic-search` with LIKE fallback
- R-phase and claim-time enrichment wired to use semantic search with `title + desc[:200]` query
- `_mem_log_event()` routes through daemon `POST /api/memory/store` for auto-embedding, SQL fallback
- `_auto_write_learning()` double-truncation removed: full phase content stored (2-5KB vs ~900 chars)
- 10 new tests (semantic search, daemon writes, full learning), 210 total tests all green
- 5 atomic commits: 17ec1bc, ec5ec88, 487d073, f921b74, 56ef8d5

## Plan 12-02 Execution (2026-03-24)

- `_jaccard_similarity()` helper added: word-overlap (3+ char words), threshold 0.7 matches gsd-research.cjs
- `_skb_promote()` dedup replaced exact title match with Jaccard combined title+content against last 50 entries
- E-phase enrichment adds second memory query for past execution patterns via `_mem_semantic_search()`
- T-phase enrichment replaced useless task-ID search with domain-based `_mem_semantic_search()` for test strategies
- 11 new tests + 1 timing test fix, 221 total tests all green
- 4 atomic commits: edc4290, 69dd81b, a4b6b4f, 594ba89

## Plan 12-03 Execution (2026-03-24)

- `_research_chain_query()` helper added: subprocess to gsd-research.cjs with --json --limit, 45s timeout, Node.js discovery via shutil.which()
- Nested provider JSON flattened: `{ results: [{ provider, results: [{text,...}] }] }` -> flat list with source attribution
- R-phase auto-invokes research chain when semantic search returns <2 relevant results (unfamiliar domain escalation)
- Research chain ONLY fires in R-phase (not E/T/P/D) -- verified by regex call-site count
- 14 new tests (9 unit + 5 integration), 235 total tests all green
- 3 atomic commits: 1c933a3, c0421ca, 0eb6d74

## Phase 13 Planning (2026-03-24)

2 plans, 1 wave (both parallelizable), 9 tasks covering all 6 GATE requirements:

| Plan | Wave | Tasks | Requirements | Key Changes |
|------|------|-------|-------------|-------------|
| 13-01 | 1 | 5 | GATE-01, GATE-02, GATE-03 | `--force` -> `--force-reason` on validate, remove 100-char proxy + loose patterns, LEARNING threshold 20->100 chars, `--test-exempt` flag |
| 13-02 | 1 | 4 | GATE-04, GATE-05, GATE-06 | self-validation block (claimed_by != validated_by), mandatory `--note` on failed/deferred, audit `forced: true` on status |

Both plans are Wave 1 and independent (touch different functions). 8 test files need `--force` -> `--force-reason` migration.

## Plan 13-01 Execution (2026-03-24)

- `--force` replaced with `--force-reason` (type=str) on validate: 11 bypass points updated, reason recorded in audit metadata
- `_has_test_evidence()` 100-char proxy removed, 6 loose patterns stripped, 5 strong patterns added (shell prompt, REPL, pytest, Jest)
- `--test-exempt` flag added to validate for tasks without testable behaviors (Gate 2 SKIP)
- LEARNING gate threshold increased from >=20 to >=100 chars with cross-phase quality verification
- CJS wrapper and daemon updated for --force-reason key-value passing
- 38 Python tests (7 new), 241 total Python tests green (1 pre-existing failure unrelated)
- 5 atomic commits: 4daeef2, 535d3c7, 4da09e0, 3a409c7, da83bce

## Plan 13-02 Execution (2026-03-24)

- Self-validation block: `claimed_by == validated_by` comparison blocks validation, `--force-reason` overrides with audit
- `self_validated` boolean added to audit metadata on both pass and fail validation paths
- Mandatory `--note` on failed/deferred transitions: check runs before data modifications for clean rejection
- `forced: true` added to `cmd_status()` audit metadata via `getattr(args, "force", False)`
- 12 new E2E tests (4 self-val + 6 note + 2 audit), 3 existing tests fixed for --note
- All 71 pipeline-offline tests, 114 deep-python tests, 241 Python tests pass
- 4 atomic commits: 78b3731, 3930cb1, f27fcef, 26cfd13

## Phase 14 Planning (2026-03-24)

2 plans, 1 wave (both parallelizable), 8 tasks covering all 4 WIRE requirements:

| Plan | Wave | Tasks | Requirements | Key Changes |
|------|------|-------|-------------|-------------|
| 14-01 | 1 | 3 | WIRE-02, WIRE-03 | Performance tiebreaker in execute-phase.md routing, PG_SYNC_WARN in daemon response |
| 14-02 | 1 | 5 | WIRE-01, WIRE-04 | MCP auto-registration in install.js, embedding coverage endpoint, health dashboard enhancement |

Both plans are Wave 1 and independent (touch different files). 14-01 modifies execute-phase.md + amauta-daemon.py. 14-02 modifies install.js + gsd-memory.cjs + amauta-daemon.py (different section).

## Plan 14-01 Execution (2026-03-24)

- Performance tiebreaker added to execute-phase.md routing: queries daemon for pass_rate, falls back to executor-general when <70% (5+ tasks)
- `_pg_sync_warning` var captures dual-write failures, appends `[PG_SYNC_WARN]` to HTTP response output field
- CLI already prints `data.output` to stdout, so agents see the warning without any CJS changes
- 5 new tests in test_pg_sync_warn.py: format, success silence, append order, diagnostic info, JSON compat
- 3 atomic commits: a83dbad, de84fb2, 8c311b6

## Plan 14-02 Execution (2026-03-24)

- MCP server auto-registered in settings.json during Claude Code install (runtime === 'claude' guard)
- Uninstall flow cleans up mcpServers['gsd-amauta'] entry and empty mcpServers object
- New `/api/memory/embedding-coverage` endpoint reuses existing `memory_embedding_stats()` store method
- Health dashboard enhanced: embedding coverage % (color-coded), SKB entry count, agent performance summary
- JSON output (`--json`) includes embedding_coverage, skb_stats, agent_performance fields
- 19 new tests (9 MCP registration + 10 health dashboard), 247 Python tests green
- 5 atomic commits: f902a82, b16c1b1, 14dd214, 57073b5, d18eda9

## Blockers

(None — Plan 14-02 ready for execution.)

---
*Milestone v2.2 started: 2026-03-24*

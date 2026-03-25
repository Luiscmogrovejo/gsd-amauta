# Roadmap: GSD-Amauta v2.3 — Clean Foundations

**Milestone:** v2.3
**Phases:** 5 (continuing from v2.2 Phase 14 -- starts at Phase 15)
**Requirements:** 18

## Phases

- [x] **Phase 15: Data Purge** - Delete ~1,900 synthetic/test entries from gsd_memory and SKB (completed 2026-03-24)
- [x] **Phase 16: Data Integrity** - Fix distillation bug, embedding dedup, project isolation for writes (completed 2026-03-25)
- [x] **Phase 17: Task Manager Reliability** - Archival, file locking, stale watchdog, dual-write reconciliation (completed 2026-03-25)
- [x] **Phase 18: Memory Optimization** - Source filtering, tiered retention, recency decay scoring (completed 2026-03-25)
- [ ] **Phase 19: Token Efficiency** - Enrichment dedup, research truncation, RPETD content caps

## Phase Details

### Phase 15: Data Purge
**Goal**: Production memory and SKB contain only real project data -- zero test pollution
**Depends on**: Nothing (first phase, prerequisite for all others)
**Requirements**: DATA-01, DATA-02
**Success Criteria** (what must be TRUE):
  1. `SELECT count(*) FROM gsd_memory WHERE content LIKE '%TK-0001%' OR content LIKE '%E2E-LIFECYCLE%' OR source='test_%'` returns 0
  2. `SELECT count(*) FROM agent_shared_knowledge WHERE content LIKE '%test%synthetic%'` returns 0
  3. Purge script is idempotent -- running it twice produces no errors and no further deletions
  4. Production memory count drops from ~1,904 to ~100 real entries (verified by `amauta status`)
**Plans**: 15-01 (4 tasks: backup, purge script, dry-run validation, execute + verify)

### Phase 16: Data Integrity
**Goal**: Every memory write is deduplicated, project-isolated, and distillation never re-merges its own output
**Depends on**: Phase 15 (clean data makes dedup and distillation meaningful)
**Requirements**: DATA-03, DATA-04, DATA-05, DATA-06
**Success Criteria** (what must be TRUE):
  1. Running `distill` on a database containing `source='distilled'` entries produces new summaries that exclude those entries from input
  2. Storing a memory with cosine similarity >0.95 to an existing entry skips the insert and returns a dedup notice
  3. Every memory write automatically includes `project_id` derived from the current working directory basename
  4. When `NODE_ENV=test` or `GSD_TEST_MODE=1`, all memory writes route to `project_id='__test__'` regardless of CWD
  5. Running the test suite produces zero entries in gsd_memory where `project_id != '__test__'`
**Plans**: 16-01 (5 tasks: exclude_source param, distill fix, embedding dedup, daemon response, tests) + 16-02 (5 tasks: daemon project_id, amauta.py project_id, CJS project_id, search exclusion, tests)

### Phase 17: Task Manager Reliability
**Goal**: Task operations are atomic, stale tasks self-heal, and file/PG stay in sync with full field fidelity
**Depends on**: Phase 15 (clean task data baseline)
**Requirements**: TASK-01, TASK-02, TASK-03, TASK-04, TASK-05, TASK-06
**Success Criteria** (what must be TRUE):
  1. `amauta archive` moves done tasks older than 7 days to `.planning/tasks-archive.json` and `amauta list` no longer shows them
  2. Two concurrent `amauta status TK-XXXX --status in-progress` calls on the same task never corrupt tasks.json (file lock serializes access)
  3. A task left in-progress for >48h with no RPETD activity is automatically reverted to pending by the daemon watchdog
  4. Dual-write retry queue entries are flushed every 60s by the daemon; `amauta reconcile` reports zero mismatches after flush
  5. `amauta reconcile` diffs tasks.json vs PG and reports/fixes field-level mismatches including doc_refs, risks, validation_checklist, estimated_hours, due_date, sprint, children
  6. All 7 previously-dropped fields survive a round-trip through dual-write (JSON -> PG -> JSON comparison matches)
**Plans**: 17-01 (3 tasks: archive cmd + TOCTOU fix + tests) + 17-02 (3 tasks: stale watchdog + retry flush + tests) + 17-03 (4 tasks: migration + upsert fix + reconcile cmd + tests)

### Phase 18: Memory Optimization
**Goal**: Semantic search returns relevant project memories, not task noise -- with automatic cleanup of low-value entries over time
**Depends on**: Phase 16 (project isolation and dedup must be in place before retention policies run)
**Requirements**: MEM-01, MEM-02, MEM-03
**Success Criteria** (what must be TRUE):
  1. Default `amauta search "topic"` results contain zero entries where `source IN ('task_event', 'rpetd_phase')` unless explicitly requested with `--include-noise`
  2. Entries with `source='task_event'` older than 30 days are archived (moved to cold storage or marked inactive); `source='rpetd_phase'` entries archived after 90 days
  3. Memory search scoring subtracts 0.5 points per 30 days since last access, making recent memories rank higher than stale ones with similar content
**Plans**: 18-01 (5 tasks: PG source filter, SQLite source filter, daemon+CLI wiring, recency decay, tests) + 18-02 (4 tasks: PG retention, SQLite retention, daemon thread, tests)

### Phase 19: Token Efficiency
**Goal**: RPETD pipeline produces the same quality output with measurably fewer tokens per task cycle
**Depends on**: Phase 16 (project isolation prevents test noise from inflating context)
**Requirements**: TOKEN-01, TOKEN-02, TOKEN-03
**Success Criteria** (what must be TRUE):
  1. When Layer 1 RLM/memory enrichment ran within the last 5 minutes, Layer 2 R-phase skips redundant queries and logs "Layer 1 cache hit -- skipping enrichment"
  2. Perplexity research chain output is capped at 1,500 chars with preamble/boilerplate stripped before injection into RPETD context
  3. RPETD phase writes exceeding 2,000 chars are truncated with a warning; `amauta rpetd` documentation shows optimal size guidance
**Plans**: TBD

## Progress

**Execution Order:** 15 -> 16 -> 17 -> 18 -> 19

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 15. Data Purge | 1/1 | Complete    | 2026-03-24 |
| 16. Data Integrity | 2/2 | Complete    | 2026-03-25 |
| 17. Task Manager Reliability | 3/3 | Complete    | 2026-03-25 |
| 18. Memory Optimization | 2/2 | Complete   | 2026-03-25 |
| 19. Token Efficiency | 0/TBD | Not started | - |

---
*Milestone v2.3 started: 2026-03-24*

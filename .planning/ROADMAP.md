# Roadmap: GSD-Amauta v2.4 — Bulletproof

**Milestone:** v2.4
**Phases:** 4 (continuing from v2.3 Phase 19.1 -- starts at Phase 20)
**Requirements:** 20

## Phases

- [x] **Phase 20: Critical Bug Fixes** - Fix 6 high-impact bugs: daemon mirror, HTTP race, distill count, research parse, reconcile archive, enrichment isolation (completed 2026-03-25)
- [ ] **Phase 21: Minor Bug Fixes** - Fix 4 lower-severity bugs: Jaccard edge case, retention shutdown, archive genealogy, auto-learn dedup
- [ ] **Phase 22: Core System Tests** - Comprehensive test coverage for archive, reconcile, RLM, PG integration, distill, auto-learn
- [ ] **Phase 23: Integration + E2E Tests** - Task manager stress tests, daemon integration, fallback paths, full lifecycle smoke test

## Phase Details

### Phase 20: Critical Bug Fixes
**Goal**: Every daemon-mediated operation (archive, reconcile, enrichment, research, distill) produces correct results without silent failures or data corruption
**Depends on**: Nothing (first phase -- fixes must land before tests validate them)
**Requirements**: FIX-01, FIX-02, FIX-03, FIX-04, FIX-05, FIX-06
**Success Criteria** (what must be TRUE):
  1. Running `amauta archive` followed by `amauta reconcile` with daemon active shows both commands synced to PG (daemon mirror list includes archive+reconcile)
  2. Calling `_mem_log_event` with a slow daemon (>5s response) produces exactly one PG entry, not two
  3. Running `amauta distill` on 5 memories reports `removedCount: 4` (not 5) -- the kept summary is excluded from the count
  4. Triggering `_research_chain_query` with malformed JSON from Perplexity logs the parse error and returns graceful fallback instead of empty []
  5. Running `amauta reconcile` detects tasks present in tasks-archive.json but missing from PG archive and reports them
  6. Enrichment `_mem_semantic_search` during RPETD returns only memories matching the current project -- zero cross-project results
**Plans**: 20-01 (daemon mirror + HTTP race + distill count), 20-02 (silent errors + reconcile archive + enrichment isolation)

### Phase 21: Minor Bug Fixes
**Goal**: Edge cases in text similarity, thread lifecycle, task genealogy, and learning dedup are eliminated
**Depends on**: Nothing (independent of Phase 20 -- can run in parallel)
**Requirements**: FIX-07, FIX-08, FIX-09, FIX-10
**Success Criteria** (what must be TRUE):
  1. `_jaccard_similarity("a b c", "a b d")` returns a valid similarity score (not NaN/error) even when all words are <3 characters
  2. Stopping the daemon with `SIGTERM` during an active retention sweep completes the current batch and exits cleanly within 5 seconds (no orphan threads)
  3. Archiving a child task removes its ID from `parent.children` array -- `amauta show PARENT-ID` no longer lists the archived child
  4. When `_auto_write_learning` attempts to promote a learning that already exists in SKB (by Jaccard >0.7), it skips the write and logs "SKB dedup hit"
**Plans**: 21-01 (Jaccard + Retention + Archive Genealogy + Auto-learn Dedup)

### Phase 22: Core System Tests
**Goal**: Archive, reconcile, RLM, PG integration, distill, and auto-learn each have comprehensive test suites proving they work under normal and edge conditions
**Depends on**: Phase 20, Phase 21 (tests validate the fixes)
**Requirements**: TEST-01, TEST-02, TEST-03, TEST-04, TEST-05, TEST-06
**Success Criteria** (what must be TRUE):
  1. Archive test suite covers: dry-run (no mutations), age threshold filtering, daemon mirror sync, parent-child genealogy update, `show --archive` retrieval
  2. Reconcile test suite covers: dry-run reporting, `--fix` sync, tasks-archive.json cross-reference, field-by-field comparison for all 37+ tracked fields
  3. RLM test suite covers: HTTP transport round-trip, BM25 scoring with camelCase terms, Layer 1 + Layer 2 enrichment, dedup window skip
  4. PG integration tests cover: semantic search with cosine threshold, memory store + embedding dedup (>0.95), retention sweep by source age, task_upsert with all 39 fields
  5. Distill test suite covers: exclusion of already-distilled entries, correct removedCount, interaction with embedding dedup, idempotent re-runs
  6. Auto-learn test suite covers: D-phase LEARNING extraction, full content storage (no truncation), SKB promotion dedup, web_search result capture
**Plans**: TBD

### Phase 23: Integration + E2E Tests
**Goal**: The complete system works end-to-end -- task manager under concurrency, daemon with all commands, graceful degradation, and a full lifecycle smoke test against live infrastructure
**Depends on**: Phase 22 (unit/component tests must pass before integration)
**Requirements**: TEST-07, TEST-08, TEST-09, TEST-10
**Success Criteria** (what must be TRUE):
  1. Task manager tests verify: concurrent TOCTOU safety (parallel status updates), stale watchdog (>48h auto-revert), retry flush (queue drains on schedule), archive+reconcile flow (end-to-end)
  2. Daemon integration tests verify: mirror sync for all mutating commands, `_resolve_project_id` from CWD, PG_SYNC_WARN propagation to agents, health endpoint returns all system stats
  3. Fallback path tests verify: semantic search degrades to LIKE when pgvector unavailable, `_mem_log_event` falls back to file write on daemon timeout, RLM falls back to no-context on service error, research chain respects timeout without hanging
  4. E2E smoke test completes a full task lifecycle (create -> claim -> R -> P -> E -> T -> D -> validate -> archive) against a live daemon with PG, and every intermediate state is verifiable
**Plans**: TBD

## Progress

**Execution Order:** 20 + 21 (parallel) -> 22 -> 23

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 20. Critical Bug Fixes | 2/2 | Complete    | 2026-03-25 |
| 21. Minor Bug Fixes | 1/1 | Complete    | 2026-03-25 |
| 22. Core System Tests | 0/? | Not started | - |
| 23. Integration + E2E Tests | 0/? | Not started | - |

---
*Milestone v2.4 started: 2026-03-25*

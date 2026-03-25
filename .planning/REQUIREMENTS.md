# Requirements: GSD-Amauta v2.4 — Bulletproof

**Defined:** 2026-03-25
**Core Value:** Every system works correctly under all conditions — no silent failures, no data corruption, no untested paths.

## v2.4 Requirements

### Bug Fixes (FIX)

- [x] **FIX-01**: Archive and reconcile commands added to daemon `_TASK_MUTATING_COMMANDS` — archived tasks synced to PG
- [x] **FIX-02**: HTTP timeout race in `_mem_log_event` fixed — no double-write on slow daemon response
- [x] **FIX-03**: Distill `removedCount` includes the "keep" entry (off-by-1 fix)
- [x] **FIX-04**: `_research_chain_query` logs parse errors instead of silently returning []
- [x] **FIX-05**: `cmd_reconcile` loads tasks-archive.json and cross-references against PG
- [x] **FIX-06**: Enrichment `_mem_semantic_search` calls pass project_id (prevent cross-project pollution)
- [x] **FIX-07**: `_jaccard_similarity` handles texts with only <3-char words
- [x] **FIX-08**: Retention thread uses shutdown event for graceful stop
- [x] **FIX-09**: `cmd_archive` updates parent.children arrays to remove archived child IDs
- [x] **FIX-10**: `_auto_write_learning` dedup against SKB before promoting

### Test Coverage (TEST)

- [x] **TEST-01**: Archive command — dry-run, age threshold, mirror sync, genealogy, show --archive
- [x] **TEST-02**: Reconcile command — dry-run, --fix sync, archive cross-ref, field comparison
- [x] **TEST-03**: RLM wiring — HTTP transport, BM25 scoring, Layer 1+2 enrichment, dedup window
- [x] **TEST-04**: PostgreSQL integration — semantic search, memory store+dedup, retention, task_upsert 40 fields
- [x] **TEST-05**: Distill — exclude distilled, correct count, dedup interaction, idempotency
- [x] **TEST-06**: Auto-learn — D-phase extraction, full content, SKB promotion dedup, web_search capture
- [ ] **TEST-07**: Task manager — TOCTOU concurrent, stale watchdog, retry flush, archive+reconcile flow
- [ ] **TEST-08**: Daemon integration — mirror sync all commands, _resolve_project_id, PG_SYNC_WARN, health
- [ ] **TEST-09**: Fallback paths — semantic search fallback, _mem_log_event fallback, RLM fallback, research timeout
- [ ] **TEST-10**: E2E smoke test — full lifecycle (create→claim→RPETD→validate→archive) against live daemon

## Out of Scope

| Feature | Reason |
|---------|--------|
| One-command setup | Feature, not fix — v2.5 |
| Docker auto-start | Feature — v2.5 |
| Voyage AI re-ranking | Feature — v2.5 |
| Layer 3 context | Feature — v2.5 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FIX-01 | Phase 20 | Complete |
| FIX-02 | Phase 20 | Complete |
| FIX-03 | Phase 20 | Complete |
| FIX-04 | Phase 20 | Complete |
| FIX-05 | Phase 20 | Complete |
| FIX-06 | Phase 20 | Complete |
| FIX-07 | Phase 21 | Complete |
| FIX-08 | Phase 21 | Complete |
| FIX-09 | Phase 21 | Complete |
| FIX-10 | Phase 21 | Complete |
| TEST-01 | Phase 22 | Complete |
| TEST-02 | Phase 22 | Complete |
| TEST-03 | Phase 22 | Complete |
| TEST-04 | Phase 22 | Complete |
| TEST-05 | Phase 22 | Complete |
| TEST-06 | Phase 22 | Complete |
| TEST-07 | Phase 23 | Pending |
| TEST-08 | Phase 23 | Pending |
| TEST-09 | Phase 23 | Pending |
| TEST-10 | Phase 23 | Pending |

**Coverage:**
- v2.4 requirements: 20 total
- Mapped to phases: 20/20
- Unmapped: 0

---
*Requirements defined: 2026-03-25*

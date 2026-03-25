# Requirements: GSD-Amauta v2.3 — Clean Foundations

**Defined:** 2026-03-24
**Core Value:** Every built system actually fires during task execution — now with clean data, reliable task management, and efficient token usage.

## v2.3 Requirements

### Task Manager Reliability (TASK)

- [ ] **TASK-01**: `amauta archive` moves done tasks >7 days to archive file, reducing working set by 52%
- [ ] **TASK-02**: TOCTOU race fixed — all cmd_* functions acquire file lock before load(), not just before save()
- [x] **TASK-03**: Stale task watchdog thread in daemon auto-reverts in-progress tasks >48h with no RPETD activity
- [x] **TASK-04**: Dual-write retry queue flushed automatically every 60s by daemon watchdog thread
- [ ] **TASK-05**: `amauta reconcile` command diffs tasks.json vs PG and reports/fixes mismatches
- [ ] **TASK-06**: Dual-write mirrors all 7 currently-dropped fields (doc_refs, risks, validation_checklist, estimated_hours, due_date, sprint, children)

### Data Quality (DATA)

- [x] **DATA-01**: Purge ~1,800 test/synthetic entries from gsd_memory (TK-0001, E2E-LIFECYCLE patterns) -- DONE: 1,918 purged, 218 remain
- [x] **DATA-02**: Purge ~91 test artifact entries from agent_shared_knowledge (SKB) -- DONE: 111 purged, 5 remain
- [ ] **DATA-03**: Fix distill function — exclude `source='distilled'` entries from distill input to prevent re-merging
- [ ] **DATA-04**: Pre-store embedding dedup — cosine similarity >0.95 against existing entries = skip insert
- [x] **DATA-05**: Auto-set `project_id` from CWD basename on every memory write for project isolation
- [x] **DATA-06**: Route test/E2E memory writes to `project_id='__test__'` when `NODE_ENV=test` or `GSD_TEST_MODE=1`

### Memory Optimization (MEM)

- [ ] **MEM-01**: Default semantic search excludes `source IN ('task_event', 'rpetd_phase')` noise sources
- [x] **MEM-02**: Tiered retention policy — archive task_event after 30 days, rpetd_phase after 90 days
- [ ] **MEM-03**: Recency decay in scoring — subtract 0.5 points per 30 days since last access/creation

### Token Efficiency (TOKEN)

- [x] **TOKEN-01**: Skip Layer 2 R-phase RLM/memory enrichment when Layer 1 ran within 5 minutes (dedup)
- [x] **TOKEN-02**: Research chain truncates Perplexity output to 1,500 chars with preamble stripping
- [x] **TOKEN-03**: RPETD phase content capped at 2,000 chars per phase write (guidance + soft enforcement)

## Future Requirements (v2.4+)

- **SETUP-01**: One-command setup: `npx gsd-amauta init` configures everything
- **DOCKER-01**: Docker auto-start: detect Docker, start PG container if no local PG
- **HYBRID-01**: Voyage AI re-ranking for hybrid RLM scoring (semantic + TF-IDF)
- **LAYER3-01**: Layer 3 agent-initiated context (rlm_client.py)
- **BRIDGE-01**: Claude Code TaskCreate/TaskUpdate bridge
- **SUMM-01**: LLM-based memory summarization (replace concatenation merging)
- **SYN-01**: RLM synonym expansion for semantic code queries

## Out of Scope

| Feature | Reason |
|---------|--------|
| Web UI dashboard | CLI-first tool, no web interface |
| Multi-user collaboration | Single developer tool |
| Cloud-hosted memory | Local-first philosophy |
| LLM-based memory summarization | Too expensive for single-user; concatenation with dedup is sufficient for v2.3 |
| Task manager rewrite | Surgical fixes, not rewrite; amauta.py stays monolithic for now |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DATA-01 | Phase 15 | Complete (2026-03-24) |
| DATA-02 | Phase 15 | Complete (2026-03-24) |
| DATA-03 | Phase 16 | Pending |
| DATA-04 | Phase 16 | Pending |
| DATA-05 | Phase 16 | Complete |
| DATA-06 | Phase 16 | Complete |
| TASK-01 | Phase 17 | Pending |
| TASK-02 | Phase 17 | Pending |
| TASK-03 | Phase 17 | Complete |
| TASK-04 | Phase 17 | Complete |
| TASK-05 | Phase 17 | Pending |
| TASK-06 | Phase 17 | Pending |
| MEM-01 | Phase 18 | Pending |
| MEM-02 | Phase 18 | Complete |
| MEM-03 | Phase 18 | Pending |
| TOKEN-01 | Phase 19 | Complete (2026-03-25) |
| TOKEN-02 | Phase 19 | Complete (2026-03-25) |
| TOKEN-03 | Phase 19 | Complete (2026-03-25) |

**Coverage:**
- v2.3 requirements: 18 total
- Mapped to phases: 18/18
- Unmapped: 0

---
*Requirements defined: 2026-03-24*
*Last updated: 2026-03-24 after deep research*

# Roadmap: GSD-Amauta v2.2 — Wiring & Hardening

**Milestone:** v2.2
**Phases:** 4 (continuing from v2.1 Phase 10 → starts at Phase 11)
**Requirements:** 22

| # | Phase | Goal | Requirements | Plans |
|---|-------|------|--------------|-------|
| 11 | Context Engine Activation | Complete    | 2026-03-24 | 2 (11-01 DONE, 11-02 DONE) -- **PHASE COMPLETE** |
| 12 | Semantic Memory Pipeline | In Progress | SEM-01, SEM-02, SEM-03, SEM-04, SEM-05, SEM-06, SEM-07 | 3 (12-01 DONE, 12-02, 12-03) |
| 13 | Validation Hardening | Gates can't be bypassed without justification, tighter evidence patterns | GATE-01, GATE-02, GATE-03, GATE-04, GATE-05, GATE-06 | 0 |
| 14 | Pipeline Integration | MCP registered, performance routing, health dashboard, dual-write alerting | WIRE-01, WIRE-02, WIRE-03, WIRE-04 | 0 |

## Phase Details

### Phase 11: Context Engine Activation
**Goal:** RLM enrichment works on every RPETD phase for every task, querying the project's own codebase via direct HTTP with BM25 scoring
**Dependencies:** None (standalone)
**Success Criteria:**
1. `_rpetd_phase_enrich()` calls `_rlm_query()` on all 5 phases without `if doc_path:` gate
2. `_rlm_query()` queries project CWD via HTTP GET to localhost:18798 (no subprocess)
3. `_enrich_task_context()` (Layer 1) includes 2 RLM queries for relevant code at claim-time
4. rlm-service.py uses BM25 formula with document length normalization
5. Tokenizer splits camelCase and snake_case identifiers into component words
6. Full RPETD cycle adds ≤1.5s from RLM
7. All existing tests pass, new tests cover HTTP path and BM25

### Phase 12: Semantic Memory Pipeline
**Goal:** Memory queries use vector similarity instead of LIKE matching, all writes generate embeddings, research chain fires automatically in R-phase
**Dependencies:** None (standalone)
**Success Criteria:**
1. R-phase calls daemon `/api/memory/semantic-search` instead of `_mem_pg_search()` LIKE query
2. All `_mem_log_event()` calls route through daemon HTTP for auto-embedding
3. E-phase enrichment queries memory for past failures (top 3)
4. T-phase enrichment queries memory for past test strategies (top 3)
5. R-phase auto-invokes research chain when PG memory returns <2 results
6. `_skb_promote()` checks Jaccard similarity >0.7 before inserting
7. `_auto_write_learning()` stores full phase content without double-truncation

### Phase 13: Validation Hardening
**Goal:** Validation gates cannot be bypassed without explicit justification, evidence patterns catch real issues
**Dependencies:** None (standalone)
**Success Criteria:**
1. `--force` on validate replaced with `--force-reason "text"` (non-empty required)
2. Test evidence gate removes 100-char proxy; requires structured signal or --test-exempt
3. Learning gate requires >100 chars with structured keyword
4. Self-validation block: claimed_by != validated_by unless --force-reason
5. failed/deferred transitions require --note
6. --force on status records forced:true in audit log

### Phase 14: Pipeline Integration
**Goal:** All systems visible and connected — MCP registered, performance influences routing, failures surface
**Dependencies:** Phases 11-13
**Success Criteria:**
1. install.js registers MCP server in ~/.claude/settings.json
2. Execute-phase uses agent pass rate as tiebreaker in routing
3. Dual-write failures append [PG_SYNC_WARN] to stdout
4. `amauta status` shows all system health

---

**Full details:** See `milestones/v2.2-ROADMAP.md`

**Previous milestone (v2.1):** See below (archived)

---

# (Archived below: v2.1 roadmap)

# Roadmap: GSD-Amauta v2.1 — Durability & Compliance

**Milestone:** v2.1
**Phases:** 5 (continuing from v2.0 Phase 5 → starts at Phase 6)
**Requirements:** 15

| # | Phase | Goal | Requirements | Plans |
|---|-------|------|--------------|-------|
| 6 | Audit Log | Immutable audit trail for every validation and RPETD event | AUDIT-01 through AUDIT-05 | 0 |
| 7 | SSO/OIDC | Token-based identity for API requests with graceful degradation | SSO-01 through SSO-05 | 0 |
| 8 | Data Durability | Backup/restore/verify for all persistent data | DUR-01 through DUR-05 | 0 |
| 9 | Audit CLI + SSO Actor Wiring | Wire audit CLI subcommands and fix SSO actor tracking in audit records | AUDIT-03, AUDIT-04, SSO-04 | 2 (09-01 complete, 09-02 complete) |
| 10 | Backup Audit Inclusion | Complete    | 2026-03-23 | 1 (10-01 complete) |

## Phase Details

### Phase 6: Audit Log
**Goal:** Every validation decision and RPETD event is permanently recorded with full context
**Dependencies:** Phase 2 (RPETD gates exist)
**Success Criteria:**
1. Validation pass/fail/force logged with timestamp, agent, gates, evidence
2. RPETD phase writes logged with timestamp and agent
3. `amauta audit export` produces JSON/CSV for a date range
4. `amauta audit show TK-XXXX` displays full task audit trail
5. Audit table is append-only (no UPDATE/DELETE)

### Phase 7: SSO/OIDC
**Goal:** API requests authenticated via OIDC tokens when configured, no-auth fallback when not
**Dependencies:** Phase 6 (audit needs actor identity from SSO)
**Success Criteria:**
1. Bearer token validated against configured OIDC issuer
2. Three env vars configure SSO (GSD_OIDC_ISSUER, GSD_OIDC_CLIENT_ID, GSD_OIDC_AUDIENCE)
3. All API endpoints (except /health) require valid token when SSO enabled
4. Token subject logged as actor in audit records
5. No SSO config = current behavior (no auth required)

### Phase 8: Data Durability
**Goal:** Never lose work — backup, restore, and verify all persistent data
**Dependencies:** Phase 6 (audit logs included in backup)
**Success Criteria:**
1. `amauta backup create` produces compressed JSON with memory, tasks, SKB, audit
2. `amauta backup restore` imports with merge/replace option
3. Backup includes schema version for compatibility
4. `amauta backup verify` validates counts, checksums, schema
5. Auto-backup on daemon start (last 7 days retained)

### Phase 9: Audit CLI + SSO Actor Wiring (Gap Closure)
**Goal:** Wire the audit CLI subcommands that are missing from amauta.py, and fix SSO actor injection into audit records
**Dependencies:** Phase 6, Phase 7
**Gap Closure:** Closes AUDIT-03, AUDIT-04, SSO-04 from v2.1 audit
**Success Criteria:**
1. `amauta audit export --format json --start X --end Y` produces JSON output from daemon endpoint
2. `amauta audit export --format csv` produces CSV output
3. `amauta audit show TK-XXXX` displays chronological audit trail for a task
4. When SSO enabled, audit records contain the OIDC `sub` claim as `actor` (not None)
5. When SSO disabled, audit records contain `actor: "local"` (current behavior preserved)

### Phase 10: Backup Audit Inclusion (Gap Closure)
**Goal:** Include gsd_audit_log table in backup/restore/verify pipeline
**Dependencies:** Phase 6, Phase 8
**Gap Closure:** Closes DUR-01 (partial) from v2.1 audit
**Success Criteria:**
1. `amauta backup create` output includes `gsd_audit_log` table with row count
2. `amauta backup restore` imports `gsd_audit_log` records (both merge and replace modes)
3. `amauta backup verify` checks `gsd_audit_log` count and integrity
4. Existing backups without `gsd_audit_log` still restore cleanly (backward compat)

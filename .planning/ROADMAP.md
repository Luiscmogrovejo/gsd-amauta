# Roadmap: GSD-Amauta v2.1 — Durability & Compliance

**Milestone:** v2.1
**Phases:** 5 (continuing from v2.0 Phase 5 → starts at Phase 6)
**Requirements:** 15

| # | Phase | Goal | Requirements | Plans |
|---|-------|------|--------------|-------|
| 6 | Audit Log | Immutable audit trail for every validation and RPETD event | AUDIT-01 through AUDIT-05 | 0 |
| 7 | SSO/OIDC | Token-based identity for API requests with graceful degradation | SSO-01 through SSO-05 | 0 |
| 8 | Data Durability | Backup/restore/verify for all persistent data | DUR-01 through DUR-05 | 0 |
| 9 | Audit CLI + SSO Actor Wiring | Wire audit CLI subcommands and fix SSO actor tracking in audit records | AUDIT-03, AUDIT-04, SSO-04 | 0 |
| 10 | Backup Audit Inclusion | Include gsd_audit_log table in backup create/restore/verify | DUR-01 | 0 |

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

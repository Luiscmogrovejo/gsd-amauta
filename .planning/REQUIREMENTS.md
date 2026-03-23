# Requirements: GSD-Amauta v2.1 — Durability & Compliance

**Defined:** 2026-03-21
**Core Value:** Trustworthy quality pipeline with accountability, identity, and data safety

## v2.1 Requirements

### Audit Log Export

- [ ] **AUDIT-01**: Every validation decision (pass/fail/force) is logged with timestamp, validator agent, task ID, gate results, and evidence
- [ ] **AUDIT-02**: Every RPETD phase log is timestamped and stored with the agent that wrote it
- [ ] **AUDIT-03**: `amauta audit export` generates a JSON or CSV report of all validation decisions for a project or date range
- [ ] **AUDIT-04**: `amauta audit show TK-XXXX` displays the full audit trail for a specific task (all RPETD phases, validation attempts, gate results)
- [ ] **AUDIT-05**: Audit records are immutable — once written, cannot be modified or deleted (append-only table)

### SSO/OIDC Integration

- [ ] **SSO-01**: Daemon supports OIDC token validation — requests with a Bearer token are verified against a configured OIDC issuer
- [ ] **SSO-02**: Configuration via environment variables: `GSD_OIDC_ISSUER`, `GSD_OIDC_CLIENT_ID`, `GSD_OIDC_AUDIENCE`
- [ ] **SSO-03**: When SSO enabled, all API endpoints require valid token (except /health)
- [ ] **SSO-04**: Token subject (sub claim) is logged as the actor in audit records
- [ ] **SSO-05**: Graceful degradation — when OIDC vars not set, daemon runs without auth (current behavior)

### Data Durability

- [ ] **DUR-01**: `amauta backup create` exports all memory, tasks, SKB, and audit logs to a single compressed JSON file
- [ ] **DUR-02**: `amauta backup restore <file>` imports a backup file, merging or replacing existing data (user choice)
- [ ] **DUR-03**: Backup includes schema version for forward/backward compatibility checking
- [ ] **DUR-04**: `amauta backup verify` checks data integrity — counts, checksums, and schema validation against the current database
- [ ] **DUR-05**: Automatic daily backup when daemon starts (saves to `~/.amauta/backups/`, keeps last 7)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-user RBAC | Single-user tool — SSO is for identity, not role management |
| Cloud backup sync | Local-first philosophy — user manages their own backups |
| Encryption at rest | OS-level encryption (FileVault, LUKS) handles this |
| Web-based audit viewer | CLI-first — export to JSON/CSV for external tools |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUDIT-01 | Phase 6 | Pending |
| AUDIT-02 | Phase 6 | Pending |
| AUDIT-03 | Phase 9 (gap closure) | Pending |
| AUDIT-04 | Phase 9 (gap closure) | Pending |
| AUDIT-05 | Phase 6 | Pending |
| SSO-01 | Phase 7 | Pending |
| SSO-02 | Phase 7 | Pending |
| SSO-03 | Phase 7 | Pending |
| SSO-04 | Phase 9 (gap closure) | Pending |
| SSO-05 | Phase 7 | Pending |
| DUR-01 | Phase 10 (gap closure) | Pending |
| DUR-02 | Phase 8 | Pending |
| DUR-03 | Phase 8 | Pending |
| DUR-04 | Phase 8 | Pending |
| DUR-05 | Phase 8 | Pending |

**Coverage:**
- v2.1 requirements: 15 total
- Mapped to phases: 15
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-21*

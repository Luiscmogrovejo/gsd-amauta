---
phase: 55-a2a-protocol-foundation
status: passed
validator: gsd-validator
validated_at: 2026-05-14
head_sha: d0e295a
---

# Phase 55 Verification: A2A Protocol Foundation

## Verdict

**PASSED** — All 4 A2A requirements verified against live codebase. 71 tests pass, 4 skipped (PG-integration gated). No regressions. Phase 52 17/17 byte-match LOCK preserved. No unresolved divergence reports.

---

## SC Verdict Summary Table

| SC# | A2A-ID | Check Command | Result | Verdict |
|-----|--------|---------------|--------|---------|
| SC1a | A2A-01 | `test -f migrations/024-a2a-messages.sql && test -f migrations/024-a2a-messages-DOWN.sql` | exit 0 | PASS |
| SC1b | A2A-01 | All 10 columns present (grep-verified in SQL text) | correlation_id, parent_correlation_id, from_agent, to_agent, capability, payload, kind, status, created_at, responded_at confirmed | PASS |
| SC1c | A2A-01 | CHECK constraint frozen 4 values: request, response, error, retried | `a2a_messages_kind_chk CHECK (kind IN ('request','response','error','retried'))` confirmed | PASS |
| SC1d | A2A-01 | `(to_agent, status)` index present | `idx_a2a_messages_to_agent_status ON a2a_messages (to_agent, status)` confirmed | PASS |
| SC1e | A2A-01 | `payload JSONB NOT NULL DEFAULT '{}'::jsonb` | Confirmed in migration text | PASS |
| SC1f | A2A-01 | `correlation_id UUID PRIMARY KEY` | Confirmed in migration text | PASS |
| SC1g | A2A-01 | DOWN file has `DROP TABLE IF EXISTS a2a_messages` | Confirmed: `DROP TABLE IF EXISTS a2a_messages CASCADE;` | PASS |
| SC1h | A2A-01 | `pytest tests/test_a2a_migration.py -q` | 10 passed in 0.02s | PASS |
| SC2a | A2A-02 | `capabilities` as 7th field AFTER `skills` | `python3` check exits 0: `['name', 'description', 'tools', 'color', 'memory', 'skills', 'capabilities', ...]` | PASS |
| SC2b | A2A-02 | `services/a2a_registry.py` exports `get_capabilities`, `list_agents`, `all_capabilities` | Import test exits 0; 17 agents returned | PASS |
| SC2c | A2A-02 | `gsd-tools.cjs` has `case 'a2a':` exactly once | `grep -c "case 'a2a':"` = 1 | PASS |
| SC2d | A2A-02 | `node gsd-tools.cjs a2a capabilities gsd-reviewer --json` exits 0 with JSON `agent`+`capabilities` keys | `{"schema_version":"1.0","agent":"gsd-reviewer","capabilities":[]}` | PASS |
| SC2e | A2A-02 | Phase 52 byte-match LOCK preserved | `node --test tests/agents-compile-claude-target-byte-match.test.cjs` exits 0, 1/1 pass (17/17 agents) | PASS |
| SC2f | A2A-02 | No AGENT.yaml has `capabilities:` line | `find ... -exec grep -l "^capabilities:" {} \; \| wc -l` = 0 | PASS |
| SC2g | A2A-02 | `pytest tests/test_agent_schema_capabilities.py tests/test_a2a_registry.py -q` | 18 passed | PASS |
| SC3a | A2A-03 | `from services.a2a_client import send_request, await_response, send_response, A2AError, A2ATimeoutError, A2AUnknownCapabilityError, A2AAgentUnavailableError, A2APayloadInvalidError` | exits 0 | PASS |
| SC3b | A2A-03 | `grep -c "parent_correlation_id" services/a2a_client.py` >= 3 | count = 24 | PASS |
| SC3c | A2A-03 | `grep -E "WHERE[[:space:]]+parent_correlation_id" services/a2a_client.py` >= 1 | 1 match: `WHERE parent_correlation_id = %s::uuid` | PASS |
| SC3d | A2A-03 | `POLL_INTERVAL_S = 0.1` exact (runtime verified) | `POLL_INTERVAL_S: float = 0.1` — runtime assertEqual passes | PASS |
| SC3e | A2A-03 | All 4 error tokens as strings in source | a2a_timeout, unknown_capability, agent_unavailable, payload_invalid all found | PASS |
| SC3f | A2A-03 | `services/amauta-daemon.py` UNCHANGED | `git diff --stat 95888e6..HEAD services/amauta-daemon.py` = 0 lines (no output) | PASS |
| SC3g | A2A-03 | `pytest tests/test_a2a_client.py -q -k "not integration"` | 19 passed, 3 deselected | PASS |
| SC3h | A2A-03 | Integration tests gated: `GSD_PG_INTEGRATION="" pytest -k "integration"` all skipped | 3 skipped, 19 deselected | PASS |
| SC4a | A2A-04 | `from services.a2a_client import send_request_with_retry, RETRY_BASE, RETRY_INITIAL_S, RETRY_CAP_S, RETRY_JITTER_PCT, RETRY_MAX; assert RETRY_BASE==2...` | exits 0 | PASS |
| SC4b | A2A-04 | `_send_retried_row` writes `kind='retried'` | `VALUES (%s, %s, %s, %s::jsonb, 'retried', 'retried')` confirmed | PASS |
| SC4c | A2A-04 | `pytest tests/test_a2a_retry_error_vocab.py -q` | 24 passed, 1 skipped | PASS |
| SC4d | A2A-04 | `test_payload_invalid_does_not_retry` exists and passes | line 146, PASSED | PASS |
| SC4e | A2A-04 | `grep -c "^class Test" tests/test_a2a_retry_error_vocab.py` = 6 | 6 | PASS |
| SC5  | ALL    | Each A2A-XX in exactly one plan; no A2A-05..07, MARK-*, PUB-* in Phase 55 | A2A-01→55-01, A2A-02→55-02, A2A-03→55-03, A2A-04→55-04; no out-of-scope IDs | PASS |
| SC6  | ALL    | 55-03 depends_on 55-01+55-02; 55-04 depends_on 55-03; commit SHAs ordered | Commit log: ca30aa9(55-01-01)→66b8966(55-01-02)→f489756(55-02-01)→...→78ed59e(55-04-01)→d9b5dbd(55-04-02) | PASS |
| SC7  | ALL    | Aggregate 5-file pytest run | 71 passed, 4 skipped (PG-gated) | PASS |

---

## Detailed Findings

### SC1 — A2A-01: Migration 024 (a2a_messages table)

Migration file `migrations/024-a2a-messages.sql` contains the complete 10-column schema as planned:

```sql
CREATE TABLE IF NOT EXISTS a2a_messages (
  correlation_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_correlation_id UUID,
  from_agent            VARCHAR(64) NOT NULL,
  to_agent              VARCHAR(64) NOT NULL,
  capability            VARCHAR(128) NOT NULL,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  kind                  VARCHAR(16) NOT NULL,
  status                VARCHAR(64) NOT NULL DEFAULT 'pending',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at          TIMESTAMPTZ,
  CONSTRAINT a2a_messages_kind_chk CHECK (kind IN ('request','response','error','retried'))
);
```

- `BEGIN;` / `COMMIT;` transaction wrap: present
- `IF NOT EXISTS` guard on CREATE TABLE and CREATE INDEX: present
- `COMMENT ON TABLE` references `Phase 55 A2A-01`: present
- DOWN file: `DROP TABLE IF EXISTS a2a_messages CASCADE;` in `BEGIN;`/`COMMIT;` wrap: present
- 10 structural tests pass (no PG connection required)

**REQUIREMENTS.md A2A-01 note:** The text description lists `kind (request|response|error)` — 3 values. The migration implements 4 values (`retried` added for A2A-04 retry audit trail per 55-01-PLAN.md Section "Frozen kind vocabulary"). This is an intentional cross-plan coordination: A2A-04 requires `kind='retried'` rows; the migration bakes in the full vocabulary at schema time so no ALTER TABLE is needed later. The CHECK constraint is the authoritative source; the REQUIREMENTS.md description is a minor documentation shortfall (not a regression). REQUIREMENTS.md traceability table shows all 4 A2A IDs as "Pending" — stale checkboxes, a known pattern in this codebase (plan SUMMARY.md files mark each requirement as `requirements-completed`).

### SC2 — A2A-02: Capability Registry

- `services/agent_schema.py` field order confirmed: `['name', 'description', 'tools', 'color', 'memory', 'skills', 'capabilities', 'body_preamble', 'sections']` — capabilities is position 6 (0-indexed), after skills at position 5. Order invariant holds.
- `services/a2a_registry.py` exports all 3 public functions + `RegistryError`/`AgentNotFoundError`. 17 agents returned by `list_agents()`.
- `services/a2a_registry_cli.py` exists; `gsd-tools.cjs` has exactly 1 `case 'a2a':` dispatch block.
- CLI round-trip: `node get-shit-done/bin/gsd-tools.cjs a2a capabilities gsd-reviewer --json` returns `{"schema_version": "1.0", "agent": "gsd-reviewer", "capabilities": []}` — valid JSON, correct keys.
- Phase 52 byte-match canary: `node --test tests/agents-compile-claude-target-byte-match.test.cjs` exits 0 with 1/1 pass (17/17 agent byte-match). The `capabilities` field addition to `AgentDefinition` did not alter any compiled `agents/*.md` output because (a) it is optional with `default_factory=list`, and (b) no AGENT.yaml received a non-empty `capabilities:` value.
- 18 tests pass: 6 in `test_agent_schema_capabilities.py` + 12 in `test_a2a_registry.py`.

### SC3 — A2A-03: Send/Receive Client

The Risk §2 correction (response rows must use a new UUID as `correlation_id` PK and link back via `parent_correlation_id`) was applied correctly:

- `parent_correlation_id` appears 24 times in `services/a2a_client.py`
- `_poll_once` filters `WHERE parent_correlation_id = %s::uuid AND kind IN ('response','error')` — confirmed
- `send_response` parameter is named `parent_correlation_id` (not `correlation_id`) for clarity
- `POLL_INTERVAL_S: float = 0.1` — typed PEP-526 annotation, value 0.1 confirmed at runtime
- All 4 error tokens (`a2a_timeout`, `unknown_capability`, `agent_unavailable`, `payload_invalid`) found as string literals in source
- `services/amauta-daemon.py` unchanged (0 diff lines vs SHA 95888e6)
- 19 structural tests pass without PG; 3 PG-integration tests correctly skip when `GSD_PG_INTEGRATION` unset

**Note on VC4 grep pattern (documented by executor, confirmed by validator):** The plan's VC4 pattern `POLL_INTERVAL_S[[:space:]]*[:=][[:space:]]*0\.1` does not match `POLL_INTERVAL_S: float = 0.1` because `float` intervenes between `:` and `=`. The value is correct (runtime assertEqual passes). This is a plan documentation shortfall, not a code defect.

### SC4 — A2A-04: Retry + Error Vocabulary

**55-04 deviation confirmed as correct design:** The executor added pre-flight `_validate_payload(payload)` + `_check_capability(to, capability)` calls at the top of `send_request_with_retry`, before the retry loop. This ensures non-retryable errors (`A2APayloadInvalidError`, `A2AUnknownCapabilityError`, `A2AAgentUnavailableError`) fail immediately without consuming retry budget. This aligns precisely with the must_have "Non-retryable errors fail fast" and is confirmed by 4 passing tests: `test_payload_invalid_does_not_retry`, `test_string_payload_does_not_retry`, `test_unknown_capability_not_retried`, `test_agent_unavailable_not_retried`. This is NOT a regression — it is a structural improvement consistent with the plan's intent.

Retry constants via VC2 aliases (importable as specified):
- `RETRY_BASE = 2` ✓
- `RETRY_INITIAL_S = 1` (alias for `RETRY_INITIAL_DELAY_S = 1.0`) ✓
- `RETRY_CAP_S = 8` ✓
- `RETRY_JITTER_PCT = 0.2` (alias for `RETRY_JITTER_RANGE = (0.8, 1.2)`) ✓
- `RETRY_MAX = 2` (alias for `MAX_RETRIES = 2`) ✓

`_send_retried_row` SQL: `VALUES (%s, %s, %s, %s::jsonb, 'retried', 'retried')` — writes `kind='retried'`, `status='retried'` as required.

6 test classes present: `TestRetryConstants`, `TestFrozenErrorVocabulary`, `TestExponentialBackoffFormula`, `TestRetryBehaviorSimulated`, `TestSendRetriedRowStructure`, `TestRetryPGIntegration`. 25 test methods. 24 pass, 1 skips (PG-gated).

### SC5 — Requirement ID Coverage

| Req ID | Plan | Out-of-Scope IDs Leaked |
|--------|------|------------------------|
| A2A-01 | 55-01 | None |
| A2A-02 | 55-02 | None |
| A2A-03 | 55-03 | None |
| A2A-04 | 55-04 | None |

No A2A-05/06/07, MARK-*, or PUB-* IDs appear in any Phase 55 plan frontmatter.

### SC6 — Cross-Plan Dependencies

- 55-03 `depends_on: [55-01, 55-02]` — confirmed in plan frontmatter
- 55-04 `depends_on: [55-03]` — confirmed in plan frontmatter
- Commit ordering verified via `git log`:
  - Wave 1: `ca30aa9` (55-01-01), `66b8966` (55-01-02), `d8849b3` (55-01-03)
  - Wave 1 concurrent: `f489756` (55-02-01), `f9d5d98` (55-02-02), `02ea4c1` (55-02-03), `50b581f` (55-02-04)
  - Wave 2: `658d1f7` (55-03-01), `6ce493c` (55-03-02)
  - Wave 3: `78ed59e` (55-04-01), `d9b5dbd` (55-04-02)
  - All 55-01/55-02 commits precede 55-03; all 55-03 commits precede 55-04. Dependency order preserved.

### SC7 — Aggregate Test Run (No Regressions)

```
pytest tests/test_a2a_migration.py tests/test_a2a_registry.py tests/test_agent_schema_capabilities.py tests/test_a2a_client.py tests/test_a2a_retry_error_vocab.py -q

71 passed, 4 skipped in 0.96s
```

4 skipped = `TestA2AClientPGIntegration` (3 tests) + `TestRetryPGIntegration` (1 test) — all gated by `GSD_PG_INTEGRATION` env var. Correct behavior; no live PG required for CI.

---

## Divergence Pre-Gate Scan

Scanned `.planning/milestones/` for divergence reports:
- `.planning/milestones/52-agent-compilation/divergence-reports/` — directory exists but empty (no JSON files)
- `.planning/milestones/v2.2-phases/13.1-orchestrator-hardening-divergence-protocol/divergence-reports/` — older milestone, not Phase 55 scope

No unresolved divergence reports for Phase 55 or its active milestone. Gate floor: unaffected.

---

## Non-Gap Observations

1. **REQUIREMENTS.md checkboxes stale:** All 4 A2A rows (`A2A-01..04`) still show `[ ]` (unchecked) in both the requirement list and the traceability table (shows "Pending"). This is a paperwork gap, not a functional gap. Each plan SUMMARY.md marks `requirements-completed: [A2A-0X]`. The traceability table notes "Pending" but the traceability row correctly maps each ID to Phase 55. Recommend orchestrator flip to `[x]` / `Complete` as a follow-on close-out commit.

2. **A2A-01 description vs migration: `retried` 4th kind value:** REQUIREMENTS.md A2A-01 text lists `kind (request|response|error)` — 3 values. The migration correctly implements all 4 values (`request|response|error|retried`) as required by A2A-04. This is a documentation shortfall in REQUIREMENTS.md, not a code defect. The CHECK constraint is authoritative.

3. **`POLL_INTERVAL_S` PEP-526 typed annotation:** `POLL_INTERVAL_S: float = 0.1` does not match the plan's VC4 grep pattern. Value is correct (runtime-verified). Not a defect; documented by executor in 55-03 SUMMARY.

---

## Artifacts Verified

| File | Status | Notes |
|------|--------|-------|
| `migrations/024-a2a-messages.sql` | EXISTS | 10 columns, CHECK constraint, IF NOT EXISTS, BEGIN/COMMIT |
| `migrations/024-a2a-messages-DOWN.sql` | EXISTS | DROP TABLE IF EXISTS a2a_messages CASCADE |
| `tests/test_a2a_migration.py` | EXISTS | 10 structural tests, all pass |
| `services/agent_schema.py` | MODIFIED | capabilities as 7th LOCKED field after skills |
| `services/a2a_registry.py` | NEW | get_capabilities, list_agents, all_capabilities, SCHEMA_VERSION='1.0' |
| `services/a2a_registry_cli.py` | NEW | argparse CLI, exit 0/1/2 discipline |
| `get-shit-done/bin/gsd-tools.cjs` | MODIFIED | case 'a2a': dispatch block (1 occurrence) |
| `tests/test_agent_schema_capabilities.py` | NEW | 6 structural tests |
| `tests/test_a2a_registry.py` | NEW | 12 structural + CLI round-trip tests |
| `services/a2a_client.py` | NEW + MODIFIED | send_request, await_response, send_response, 4 error classes, send_request_with_retry, _send_retried_row, 5 retry constants + 3 aliases |
| `tests/test_a2a_client.py` | NEW | 22 test methods (19 structural pass, 3 PG-gated skip) |
| `tests/test_a2a_retry_error_vocab.py` | NEW | 25 test methods (24 pass, 1 PG-gated skip) |
| `services/amauta-daemon.py` | UNCHANGED | 0 diff lines vs SHA 95888e6 |

**Total: 71 tests pass, 4 skipped (PG-gated). Phase 52 17/17 byte-match LOCK preserved. All 4 A2A requirements (A2A-01..A2A-04) delivered.**

---

*Validated by: gsd-validator*
*Validated at: 2026-05-14*
*Phase: 55-a2a-protocol-foundation*
*Verdict: passed*

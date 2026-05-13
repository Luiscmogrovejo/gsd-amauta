# Phase 50: Party Mode Foundation - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning
**Source:** Direct from PROJECT.md + ROADMAP.md §Phase 50 + REQUIREMENTS.md (PARTY-01..02) + Phase 30/38/41/47 patterns

<domain>
## Phase Boundary

Multi-agent collaboration session backed by the existing Phase 38 `agent_findings` blackboard, with a NEW `party_sessions` PG table tracking session identity + participants + lifecycle state. Sessions are persistent: pause + resume reconstructs full context by replaying findings filtered by `session_id`. A session state machine enforces `created → active → paused → active → terminated`. Phase 50 ships substrate only — Phase 51 ships decision records + operator CLI.

Out of scope: structured decision records (Phase 51 PARTY-03), operator inspection CLI (Phase 51 PARTY-04), turn-taking enforcement at the LLM level (PROJECT.md Out of Scope — operator-supervised turns are deterministic), cross-machine session distribution (v3.3+ DIST-01).

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Migration 021: `party_sessions` table

FROZEN DDL (mirrors Phase 47 migration 020 + Phase 42 migration 018 conventions):

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS party_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status VARCHAR(16) NOT NULL DEFAULT 'created',  -- created|active|paused|terminated
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["gsd-planner","gsd-checker",...]
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paused_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,
  CONSTRAINT party_sessions_status_chk CHECK (status IN ('created','active','paused','terminated'))
);

CREATE INDEX IF NOT EXISTS idx_party_sessions_status_recent
  ON party_sessions (status, updated_at DESC);

COMMENT ON TABLE party_sessions IS
  'Phase 50 PARTY-01: multi-agent collaboration session anchor. Findings reference session_id via agent_findings.session_id column added by this migration.';

ALTER TABLE agent_findings
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES party_sessions(session_id);

CREATE INDEX IF NOT EXISTS idx_agent_findings_session
  ON agent_findings (session_id, created_at)
  WHERE session_id IS NOT NULL;

COMMIT;
```

DOWN file drops both indexes, the column, the table, all with `IF EXISTS`.

`session_id` is a `UUID` (Postgres native type). Other tables reference via FK.

### Area 2 — Session state machine (FROZEN)

Allowed transitions ONLY:
- `created → active` (start)
- `active → paused` (pause)
- `paused → active` (resume)
- `active → terminated` (terminate from active)
- `paused → terminated` (terminate from paused)

INVALID transitions return a structured error and do NOT mutate the row. Tested explicitly:
- `terminated → active` → error
- `terminated → paused` → error
- `created → paused` → error (must go through active first)
- `created → terminated` → error
- `paused → created` → error
- Any same-state transition (e.g., `active → active`) → error

State machine lives in new `services/party_session.py` exporting:
- `class PartySession` (Pydantic model)
- `start(session_id) → PartySession` — created→active, sets `updated_at`
- `pause(session_id) → PartySession` — active→paused, sets `paused_at` + `updated_at`
- `resume(session_id) → PartySession` — paused→active, clears `paused_at`, sets `updated_at`
- `terminate(session_id) → PartySession` — active|paused→terminated, sets `terminated_at` + `updated_at`
- `get(session_id) → PartySession | None`
- `create(participants: list[str]) → PartySession` — INSERT with status='created'

Pure functions take an injectable PG connection (mirror Phase 47 `_get_conn` pattern via `services/pg_store.py`).

### Area 3 — Findings tagged with session_id

`agent_findings` gains `session_id UUID NULL` column (migration 021 adds it). Existing rows have `session_id = NULL` (broadcast findings, not session-scoped). Backward compatible with Phase 38+47 queries.

Helper in `services/party_session.py`:
- `post_finding(session_id, agent_name, finding_type, content, confidence=0.8, recipient_agent=None, severity=None) → finding_id` — INSERT into agent_findings with the session_id

Query helper:
- `list_findings(session_id) → list[dict]` — `SELECT * FROM agent_findings WHERE session_id = $1 ORDER BY created_at ASC`. Stable ordering for replay.

NO turn-taking enforcement in Phase 50. Order is recorded; gating is Phase 51.

### Area 4 — Persistence + resume contract

`resume(session_id)`:
1. Calls state machine `resume()` (paused → active)
2. Returns the session row + full ordered findings list via `list_findings(session_id)`

Test scenario (SC4): start → post 3 findings → pause → simulate daemon restart by reopening PG connection → call `resume()` → verify findings list count, order, and content match pre-pause state. Persistence is PG itself; no Valkey cache in Phase 50.

### Area 5 — CLI surface (minimal in Phase 50)

Phase 50 ships a FOUNDATION CLI for development + tests; Phase 51 expands it.

```
node get-shit-done/bin/gsd-tools.cjs party create --participants "gsd-planner,gsd-checker"   # INSERT, returns session_id
node get-shit-done/bin/gsd-tools.cjs party start <session_id>                                # created→active
node get-shit-done/bin/gsd-tools.cjs party pause <session_id>                                # active→paused
node get-shit-done/bin/gsd-tools.cjs party resume <session_id> [--json]                      # paused→active, prints findings replay
node get-shit-done/bin/gsd-tools.cjs party terminate <session_id>                            # active|paused→terminated
node get-shit-done/bin/gsd-tools.cjs party get <session_id> [--json]                         # read-only
```

`top-level `npx gsd-amauta party ...` via bin/cli.cjs dispatch (mirror Phase 48/49 module dispatch).

Exit codes (FROZEN):
- 0 = success
- 1 = invalid state transition OR session not found OR validation error
- 2 = file/PG I/O error

`--json` emits the structured PartySession dict (with `schema_version: "1.0"`); default = human summary.

### Area 6 — FROZEN PartySession dict shape

```python
{
  "schema_version": "1.0",
  "session_id": str,        # UUID as string
  "status": "created" | "active" | "paused" | "terminated",
  "participants": list[str],
  "created_at": str,        # ISO8601
  "updated_at": str,        # ISO8601
  "paused_at": str | None,
  "terminated_at": str | None,
  "findings": list[dict] | None,  # populated by resume() and get(), null otherwise
}
```

### Area 7 — Reuse Phase 30/38/41/47 patterns (DO NOT reinvent)

- Phase 38 `agent_findings` table + `agent_messages` → Phase 50 extends `agent_findings` with `session_id` column
- Phase 41 `step_handoffs` append-only persistence model → `party_sessions` mutates row in place (lifecycle); `agent_findings` stays append-only
- Phase 47 migration 020 → migration 021 mirrors the same `IF NOT EXISTS` discipline + DOWN file + index strategy
- Phase 47 `_get_conn()` context manager via `services/pg_store.py` → Phase 50 helpers use the same
- Phase 47 `_HAS_PG` import-safety fallback → mandatory for `services/party_session.py`
- Phase 48 `case 'module':` dispatch pattern in gsd-tools.cjs → Phase 50 adds `case 'party':` with same `args[1]` action / `args.slice(2)` rest convention

### Claude's Discretion

- Whether `services/party_session.py` uses Pydantic v2 model_validator (recommend matching Phase 41 StepHandoff style — what `services/step-orchestrator.py` uses)
- Exact JSON serialization for participants (recommend `json.dumps(sorted_list)` for determinism — same as Phase 43 SKILL.md `allowed-tools` ordering)
- Whether `party get` shows findings count by default or only with `--with-findings`/`--json` (executor's call; recommend lightweight default — header only — with `--json` returning everything)
- `--from-finding <id>` resume option for partial replay (DEFER — Phase 51 if needed)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 50 requirement source
- `.planning/REQUIREMENTS.md` §"Party Mode (Multi-Agent Collaboration)" — PARTY-01, PARTY-02
- `.planning/ROADMAP.md` §"Phase 50: Party Mode Foundation" — 4 success criteria
- `.planning/PROJECT.md` §"Current Milestone: v3.2 The Federation"

### Phase 38 base (REUSE)
- `migrations/014-agent-findings.sql` — `agent_findings` schema; Phase 50 ADDS `session_id` column via migration 021
- `services/amauta-daemon.py` — agent_findings INSERT pattern (look up line ~1700 for the existing pattern)

### Phase 47 inheritance (recent migration + helper precedent)
- `migrations/020-agent-findings-hydration.sql` — migration UP/DOWN pattern; Phase 50 migration 021 mirrors
- `services/pg_store.py` `_get_conn()` line 404 — context manager; Phase 50 helpers use this
- `services/agent_hydrator.py` — `_HAS_PG` import-safety pattern; mirror as is

### Phase 41 inheritance (Pydantic model + persistence)
- `services/step-orchestrator.py` `StepHandoff` — Pydantic v2 pattern for state-machine-backed model

### Phase 48 inheritance (CLI dispatch)
- `get-shit-done/bin/gsd-tools.cjs` `case 'module':` ~L3629 — `args[1]` action / `args.slice(2)` rest indexing locked. Phase 50 adds `case 'party':` mirroring this exact convention.
- `bin/cli.cjs` — top-level `npx gsd-amauta <cmd>` dispatch

### Phase 49 alignment (in-flight, completes before Phase 50 execution)
- Phase 49 sets the operator-CLI conventions for `gsd-tools.cjs` (action vocabulary, exit codes, `--json` mode). Phase 50 follows the same conventions.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 38 `agent_findings` table — Phase 50 EXTENDS with `session_id` column
- Phase 47 `migrations/020-*.sql` — UP/DOWN template
- Phase 47 `services/pg_store.py` `_get_conn()` — connection pattern
- Phase 47 `_HAS_PG` import-safety — mirror in `services/party_session.py`
- Phase 41 `services/step-orchestrator.py` — Pydantic StepHandoff pattern; Phase 50's `PartySession` follows
- Phase 48 `get-shit-done/bin/gsd-tools.cjs` `case 'module':` — dispatch convention

### Established Patterns
- Frozen schema_version "1.0" (Phase 45/47/48/49)
- `_HAS_PG` import-safety (Phase 42/43/45/46/47/48/49)
- Migration `IF NOT EXISTS` + DOWN file (Phase 18-47 cadence)
- gsd-tools.cjs case dispatch (Phase 45/47/48/49)
- Pydantic + `_HAS_PYDANTIC` fallback (Phase 41/43/47/48)

### Integration Points
- `migrations/021-party-sessions.sql` + DOWN — NEW migration
- `services/party_session.py` — NEW module (state machine + helpers)
- `services/party_session_cli.py` — NEW CLI entry (argparse + exit codes)
- `get-shit-done/bin/gsd-tools.cjs` `case 'party':` — NEW dispatch
- `bin/cli.cjs` — top-level `npx gsd-amauta party ...` shortcut

</code_context>

<specifics>
## Specific Ideas

- Migration 021: `party_sessions` table + ADD `session_id` column to `agent_findings` + 2 indexes. DOWN drops in reverse order.
- State machine FROZEN: 5 allowed transitions, 6+ explicitly forbidden ones tested
- Session UUID as PG `gen_random_uuid()` default (Phase 38 precedent)
- `session_id` FK on `agent_findings` — NOT a CASCADE; deletion semantics deferred
- 4-plan structure suggested: 50-01 migration 021 + PartySession Pydantic + state machine, 50-02 helpers (post_finding/list_findings) + Python tests, 50-03 CLI dispatch in gsd-tools.cjs + bin/cli.cjs shortcut, 50-04 E2E (SC4: pause → daemon restart → resume → verify replay) + canary
- 4 plans, ~16-20 tasks total — each plan ≤ 6 tasks (well under 10-cap)

</specifics>

<deferred>
## Deferred Ideas

- Structured decision records (PARTY-03) → Phase 51
- Operator inspection CLI `party status/inspect/kill` → Phase 51
- Turn-taking enforcement at LLM level → out of scope (operator-supervised)
- Cross-machine session distribution → v3.3+ DIST-01
- Real-time WebSocket notifications of session state changes → future
- LLM-driven session orchestration → out of scope per PROJECT.md
- Session archival / cold storage → future operational phase

</deferred>

---

*Phase: 50-party-mode-foundation*
*Context gathered: 2026-05-13*

# Phase 51: Party Mode Decisions + Operator CLI - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning
**Source:** Direct from PROJECT.md + ROADMAP.md §Phase 51 + REQUIREMENTS.md (PARTY-03..04) + Phase 50 substrate

<domain>
## Phase Boundary

Build the structured decision layer on top of Phase 50's `party_sessions` substrate. Agents in a session can record decisions with frozen vocabulary `propose | agree | dissent | block` and supporting reasoning. The operator gets a CLI surface (`gsd-tools party status | inspect | kill`) to list active sessions, view ordered turn history with decision trail, and terminate sessions with an audit trail. Consensus and dissent are BOTH first-class — dissent does NOT auto-rollback (PROJECT.md Out of Scope).

Out of scope: LLM-driven turn-taking (operator-supervised — PROJECT.md), auto-rollback on dissent (PROJECT.md), web UI for inspection, real-time websocket notifications, cross-machine session distribution (v3.3+ DIST-01).

</domain>

<decisions>
## Implementation Decisions

### Area 1 — `decision_type` field on agent_findings

Phase 50 ADDED `session_id UUID` column to `agent_findings`. Phase 51 ADDS one more column via migration 023:

```sql
ALTER TABLE agent_findings
  ADD COLUMN IF NOT EXISTS decision_type VARCHAR(16);
-- nullable: not all findings are decisions; only when posted as a decision via party_session.post_decision()
```

FROZEN vocabulary (no CHECK constraint enforced at DB level for backward compat with existing rows; enforced at write site in `post_decision()`):
- `propose` — agent A puts forward a course of action
- `agree` — agent B accepts agent A's proposal
- `dissent` — agent B disagrees but does NOT block; surfaced to operator
- `block` — agent B blocks; session continues, but the proposal is marked blocked in the trail

Index for trail queries:
```sql
CREATE INDEX IF NOT EXISTS idx_agent_findings_session_decision
  ON agent_findings (session_id, decision_type, created_at)
  WHERE decision_type IS NOT NULL;
```

DOWN file drops index + column with `IF EXISTS`.

### Area 2 — `services/party_session.py` extension

Phase 50 has `post_finding(session_id, agent_name, finding_type, content, ...)`. Phase 51 adds:

```python
DECISION_TYPES = ("propose", "agree", "dissent", "block")  # FROZEN

def post_decision(
    session_id: str,
    agent_name: str,
    decision_type: str,    # MUST be in DECISION_TYPES
    content: str,          # reasoning / proposal text
    confidence: float = 0.8,
    finding_type: str = "decision",   # default to 'decision'; can override for sub-categorization
    conn=None,
) -> str:
    """Post a structured decision. Returns finding_id (UUID)."""
    if decision_type not in DECISION_TYPES:
        raise ValueError(f"decision_type must be in {DECISION_TYPES}, got {decision_type!r}")
    # delegates to post_finding() with decision_type set in the INSERT

def list_decisions(session_id: str, conn=None) -> list[dict]:
    """All decisions (decision_type IS NOT NULL) for a session, ordered by created_at ASC."""
    # SELECT * FROM agent_findings
    # WHERE session_id = $1 AND decision_type IS NOT NULL
    # ORDER BY created_at ASC

def summarize_decisions(session_id: str, conn=None) -> dict:
    """Counts per decision_type for status display.
    Returns: {propose: int, agree: int, dissent: int, block: int}"""
```

`post_finding()` also extended to accept optional `decision_type` parameter for direct INSERT path (used by tests and external callers).

### Area 3 — Operator CLI: 3 new actions

Extends Phase 50's `case 'party':` in gsd-tools.cjs with 3 new actions (alongside existing create/start/pause/resume/terminate/get):

```
node gsd-tools.cjs party status [--json]                    # list ALL sessions with summary
node gsd-tools.cjs party inspect <session_id> [--json]      # ordered turn history + decision trail
node gsd-tools.cjs party kill <session_id> [--reason "..."]  # terminate with audit trail
```

`args[1]` action / `args.slice(2)` rest convention (Phase 48 Issue 1 fix preserved). `case 'party':` block grows from 6 to 9 actions — Phase 50 content for the existing 6 stays byte-identical (51-04 canary mandates).

**Exit codes (FROZEN, mirror Phase 48/49/50)**:
- 0 = success
- 1 = session not found OR validation error
- 2 = file/PG I/O error

`bin/cli.cjs` party branch already exists (Phase 50); it forwards all `party <action>` args via `process.argv.slice(3)` rewrite. Phase 51 adds no new bin/cli.cjs changes — the 3 new actions inherit dispatch automatically.

### Area 4 — `status` output shape

`party status` lists sessions with summary; `party status --json` returns:

```python
{
  "schema_version": "1.0",
  "sessions": [
    {
      "session_id": str,
      "status": "created" | "active" | "paused" | "terminated",
      "participant_count": int,
      "decisions": {"propose": int, "agree": int, "dissent": int, "block": int},
      "created_at": str,   # ISO8601
      "updated_at": str,
    },
    ...
  ]
}
```

Sorted by `updated_at DESC` (most recent first). Empty `sessions: []` when no sessions exist.

### Area 5 — `inspect` output shape (FROZEN)

`party inspect <session_id> --json` returns:

```python
{
  "schema_version": "1.0",
  "session": {
    # full PartySession dict from Phase 50 (9 keys: schema_version, session_id, status,
    # participants, created_at, updated_at, paused_at, terminated_at, findings)
  },
  "decision_trail": [
    {
      "finding_id": str,
      "agent_name": str,
      "decision_type": "propose" | "agree" | "dissent" | "block",
      "content": str,
      "confidence": float,
      "created_at": str,   # ISO8601
    },
    ...
  ],
  "decision_summary": {"propose": int, "agree": int, "dissent": int, "block": int},
}
```

`decision_trail` is the FILTERED subset of findings with `decision_type IS NOT NULL`, ordered by `created_at ASC`. The full ordered turn history (all findings, decision and non-decision) is `session.findings` (Phase 50's resume() pattern). `decision_summary` is the same as `party status` row's `decisions` field.

### Area 6 — `kill` action with audit trail

`party kill <session_id> [--reason "..."]`:

1. Calls Phase 50 `terminate()` (state machine: active|paused → terminated). Sets `terminated_at`.
2. Posts a special finding via `post_finding()` with:
   - `agent_name = "operator"`
   - `finding_type = "kill"`
   - `content = "Session killed by operator. Reason: <reason or 'no reason given'>"`
   - `decision_type = NULL` (kill is not a decision — it's an audit row)
   - `severity = "info"` (Phase 47 vocabulary; not load-bearing)
3. Returns the terminated PartySession + the audit finding_id in JSON output.

`--reason` is optional but recommended; defaults to "no reason given".

Exit code 0 on success; 1 if session not found or already terminated (state machine error). NO auto-rollback of in-flight decisions (PROJECT.md Out of Scope item).

### Area 7 — Dissent does NOT auto-rollback (SC3 lock)

Test in 51-02: posts a `propose` decision, posts a `dissent` decision, verifies:
- Session status remains `active` (no auto-state change)
- Other agents' findings remain unchanged
- The propose decision is NOT marked rolled-back or revoked in the DB row
- `decision_trail` contains BOTH propose AND dissent (visibility to operator preserved)

This matches REQUIREMENTS.md Out of Scope "Auto-rollback on Party Mode dissent" verbatim.

### Area 8 — Reuse Phase 50 surface

- `services/party_session.py` (Phase 50) — extend with `post_decision`, `list_decisions`, `summarize_decisions`. Do NOT modify Phase 50 functions (`post_finding`, `list_findings`, `create`, `start`, `pause`, `resume`, `terminate`, `get`).
- `services/party_session_cli.py` (Phase 50) — extend argparse with 3 new subcommands (status, inspect, kill). Existing 6 subcommands unchanged.
- `get-shit-done/bin/gsd-tools.cjs` `case 'party':` — extend with 3 new actions; existing 6 actions byte-identical.
- `migrations/021-party-sessions.sql` (Phase 50) — UNTOUCHED; migration 023 is additive.

### Claude's Discretion

- Whether `party kill` audit row uses `finding_type="kill"` (recommend yes) or a new `kill_log` table (recommend NO — agent_findings is the audit substrate; reuse it)
- Pydantic v2 model for `DecisionTrailEntry` (optional — could just return dicts from list_decisions)
- `--reason` shorthand `-r` flag (executor's call)
- `summarize_decisions` SQL: GROUP BY decision_type vs multiple separate counts (recommend GROUP BY for efficiency on large sessions)
- Display formatting for non-`--json` mode of `party inspect` (executor's call; recommend ANSI-free Markdown table for readability)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 51 requirement source
- `.planning/REQUIREMENTS.md` §"Party Mode (Multi-Agent Collaboration)" — PARTY-03, PARTY-04
- `.planning/ROADMAP.md` §"Phase 51: Party Mode Decisions + Operator CLI" — 4 success criteria
- `.planning/PROJECT.md` §"Current Milestone: v3.2 The Federation"

### Phase 50 substrate (REUSE, don't reinvent)
- `migrations/021-party-sessions.sql` — `party_sessions` table + `agent_findings.session_id` FK
- `services/party_session.py` — `post_finding`, `list_findings`, `create/start/pause/resume/terminate/get`, `VALID_TRANSITIONS`, `SCHEMA_VERSION`
- `services/party_session_cli.py` — argparse pattern; Phase 51 adds 3 subcommands
- `get-shit-done/bin/gsd-tools.cjs` `case 'party':` at L3712 — extend; preserve existing 6 actions byte-identical
- `bin/cli.cjs` party branch at L114 — UNCHANGED (already forwards all args via slice(3))

### Phase 49 patterns (mirror)
- `services/module_lifecycle_cli.py` argparse with `if __name__ == "__main__":` — Phase 51's status/inspect/kill subcommand pattern mirrors
- Phase 49 exit code 0/1/2 mapping — Phase 51 follows same

### Phase 47 patterns (mirror)
- `migrations/020-agent-findings-hydration.sql` — recent migration UP/DOWN template
- `services/agent_hydrate_cli.py.render_markdown()` — Markdown output formatting reference for `party inspect` non-JSON mode (optional)

### Out-of-Scope lock
- `.planning/REQUIREMENTS.md` §"Out of Scope" → "Auto-rollback on Party Mode dissent" — SC3 test enforces this verbatim

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 50 `services/party_session.py` — extend with `post_decision/list_decisions/summarize_decisions`
- Phase 50 `services/party_session_cli.py` — extend with `status/inspect/kill` argparse subcommands
- Phase 50 `gsd-tools.cjs case 'party':` — extend with 3 new actions
- Phase 47 `migrations/020-*.sql` — UP/DOWN template
- Phase 49 `services/module_lifecycle_cli.py` — argparse pattern reference

### Established Patterns
- Frozen vocabulary in module-level tuple (Phase 49 INSTALL_STEPS, Phase 48 manifest fields, Phase 50 VALID_TRANSITIONS)
- Schema versioning (`schema_version: "1.0"`) for all structured outputs
- Operator CLI exit codes 0/1/2 (Phase 48/49/50)
- Migration UP/DOWN with `IF NOT EXISTS` / `IF EXISTS` guards
- `_HAS_PG` import-safety (already in services/party_session.py from Phase 50)
- `args[1]` + `args.slice(2)` dispatch convention (Phase 48 Issue 1 fix)

### Integration Points
- `migrations/023-party-decisions.sql` + DOWN — NEW migration (slot 022 used by Phase 49, slot 023 free)
- `services/party_session.py` — EXTENDED (3 new functions + 1 module-level constant)
- `services/party_session_cli.py` — EXTENDED (3 new argparse subcommands)
- `get-shit-done/bin/gsd-tools.cjs` — EXTENDED (`case 'party':` block grows from 6 to 9 actions)

</code_context>

<specifics>
## Specific Ideas

- Migration slot 023 confirmed free (021=party-sessions, 022=module-installs).
- `DECISION_TYPES` module-level tuple in party_session.py — grep-verified in tests
- Kill audit uses `agent_name="operator"` + `finding_type="kill"` + `decision_type=NULL`
- 4-plan structure suggested: 51-01 migration 023 + post_decision/list_decisions/summarize_decisions extensions, 51-02 SC3 dissent-no-rollback + decision_trail unit tests, 51-03 CLI dispatch (status/inspect/kill) + bin/cli.cjs no-changes verification + CLI tests, 51-04 E2E + canary
- 4 plans, ~14 tasks total; each plan ≤ 6 tasks
- 51-04 canary: 16 protected paths (13 from Phase 50 + 3 Phase 50 outputs: services/party_session.py [Phase 50 baseline content preserved for the create/start/pause/resume/terminate/get functions], services/party_session_cli.py [existing 6 subcommands preserved], gsd-tools.cjs `case 'party':` existing 6 actions byte-preserved)

</specifics>

<deferred>
## Deferred Ideas

- LLM-driven turn-taking → Out of Scope (operator-supervised model is the v3.2 design)
- Auto-rollback on dissent → Out of Scope (SC3 explicitly tests the no-rollback contract)
- Web UI for session inspection → CLI-first; web layer is separate product surface
- Real-time WebSocket session-event notifications → future
- Per-participant decision permissions (which agents can post which decision_types) → defer; v3.2 trusts all participants
- Decision retraction (agent reverses own propose) → use `dissent` from same agent as soft retraction; explicit retraction defer
- Decision diffs / merge resolution → future
- Cross-session decision references (decision in session A references decision in session B) → defer

</deferred>

---

*Phase: 51-party-mode-decisions-operator-cli*
*Context gathered: 2026-05-13*

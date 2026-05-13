# Phase 47: Agent Dynamic Hydration - Context

**Gathered:** 2026-05-12
**Status:** Ready for planning
**Source:** Direct from PROJECT.md + ROADMAP.md §Phase 47 + REQUIREMENTS.md (HYDRA-01..02) + Phase 42/43/45/46 patterns (no discuss-phase per user directive — docs sufficient)

<domain>
## Phase Boundary

Add a `gsd-tools agent-hydrate <agent_name>` subcommand that queries 4 data sources (PG memory, blackboard `agent_findings`, Valkey cache, security pipeline) in parallel and produces an agent-specific `## Current context` block. The operator (gsd-amauta.cjs / Task spawning code) calls this BEFORE spawning any subagent and prepends the rendered block to the agent's .md content. Phase 46's `_render_agent(name, hydration=None)` MCP resource helper is the canonical consumer. Hydration query p95 < 500ms.

Out of scope: rewriting agent .md frontmatter format; changing agent skill assignments; replacing the existing `## Role & identity` body; building a new agent registry (filesystem-only per Phase 43); compiling agents to per-IDE formats (deferred to v3.2+ COMPILE-01); cross-agent context sharing beyond what the 4 sources already provide.

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Brownfield: agent .md files stay; injection happens at spawn time

- **Do NOT add template markers inside agent .md files.** HYDRA-01 says "Agent .md files become templates with dynamic sections," but the cleanest implementation is to leave the 17 agents in `agents/*.md` untouched and inject the `## Current context` block at SPAWN TIME via the operator. This preserves the Phase 30+ standardized 10-section format and avoids 17 file edits.
- **Phase 46 already structured the injection point**: `_render_agent(name, hydration=None)` in `services/amauta-mcp.py`. When `hydration` is provided, the helper prepends `## Current context\n\n{hydration}\n\n` BEFORE the agent body. Phase 47 produces the `hydration` payload; the wiring already exists.
- **Operator-side spawn hook:** `bin/cli.cjs` / `get-shit-done/bin/gsd-amauta.cjs` calls `gsd-tools agent-hydrate <agent_name> --task-id <id> --json` BEFORE the Task() invocation. The returned Markdown block becomes a `<current_context>` segment in the agent prompt OR (for MCP-consumed agents) gets passed via the `_render_agent` hydration parameter.

### Area 2 — `gsd-tools agent-hydrate` subcommand

- **New subcommand** in `get-shit-done/bin/gsd-tools.cjs` (Node-side; matches Phase 45 `bearings` pattern — operator's primary CLI). Signature:
  ```
  node get-shit-done/bin/gsd-tools.cjs agent-hydrate <agent_name> [--task-id <id>] [--json] [--terse] [--budget <tokens>]
  ```
- **Output:** rendered Markdown block by default; `--json` emits the structured payload (Phase 45 schema_version pattern reused — `schema_version: "1.0"` for the hydration object too, separate from bearings' 1.0).
- **Default budget:** 800 tokens (per-agent context can be denser than the cross-cutting bearings block). `--terse` halves to 400.
- **Required `<agent_name>`** — single positional argument. Optional `--task-id` adds task-scoped findings; without it, returns the general agent context.
- **Logic home:** Node side, but the heavy queries shell out to Python helpers (`services/pg_store.py`, the existing daemon endpoints if available, or direct PG via Phase 46 `MCPDatabase`-style pool). New Python helper: `services/agent_hydrator.py` exposing `hydrate(agent_name, task_id=None) -> dict`. `_HAS_PG` import-safety mandatory.

### Area 3 — 4 data sources queried in parallel (p95 < 500ms)

Each source contributes one section in the rendered block. Queried CONCURRENTLY via `asyncio.gather` (Python helper) or `Promise.all` (Node side; pass-through to helper).

1. **PG memory — agent-relevant learnings.** Hybrid BM25 + pgvector over the memory table; query string = `agent_name + " " + agent_role_summary` (role pulled from agent .md frontmatter). Top-K=3, cosine_floor=0.6 (matches Phase 43 defaults). Returns recent memories tagged or implicitly relevant to the agent.

2. **Blackboard findings.** PG query: `SELECT id, finding_type, summary, severity, created_at FROM agent_findings WHERE (recipient_agent = $1 OR recipient_agent IS NULL) [AND task_id = $2 if provided] ORDER BY created_at DESC LIMIT 5`. Reuses `migrations/014-agent-findings.sql` schema (verified 3 references to `recipient_agent` in that migration). 5 most recent broadcasts and direct messages to this agent.

3. **Valkey cache.** Read the `agent:{name}:recent_activity` key (set by daemon/MCP when this agent last ran). Returns: last spawn timestamp, last task_id, last RPETD phase, last validator verdict. If Valkey unavailable: `(unavailable — Valkey not reachable)` row. Server stays up.

4. **Security pipeline.** Query the `agent_findings` table again filtered on `finding_type IN ('security_alert', 'lint_violation', 'circuit_breaker_open')` for the last 24 hours (no agent filter — security alerts are global until cleared). Limit 3. If no security pipeline data exists yet (early-project), section renders `(no security alerts in last 24h)` cleanly. NOT a separate table — security data lives in agent_findings with a `finding_type` discriminator. Mirrors Phase 30+ blackboard pattern.

### Area 4 — Rendered `## Current context` block

Frozen Markdown template (executor implements verbatim):

```markdown
## Current context

_Generated: <ISO8601> · Agent: <agent_name> · Task: <task_id or "general"> · Sources: 4/4_

### Recent memory for <agent_name>
- [memory_id_or_tag] <one-line summary> _(score: <cosine>, age: <days>d)_
- ... up to 3 entries

### Blackboard findings
- [finding_id] <severity> · <finding_type> · <summary> _(<age>)_
- ... up to 5 entries
- _(none if empty)_

### Recent activity
Last spawn: <timestamp> · Last task: <task_id> · Last verdict: <pass|fail|n/a>
_(unavailable — Valkey not reachable)_

### Security alerts (24h)
- [finding_id] <severity> · <finding_type> · <summary>
- ... up to 3 entries
- _(no security alerts in last 24h)_

---
```

The trailing `---` separates hydration from the existing agent body. The operator/MCP places the agent body immediately below.

### Area 5 — Per-agent + per-task differentiation contract

SC2 says "content is verifiably different per agent and per task." Test must prove:
- Same agent + different task_ids → different `Blackboard findings` section
- Different agents + same task_id → different `Recent memory` section
- Two consecutive calls with identical `(agent_name, task_id)` produce byte-identical output IF the source data hasn't changed (determinism mirroring Phase 45 bearings; mutation in PG/Valkey between calls is the only thing that should change output)

### Area 6 — Performance budget (p95 < 500ms)

- All 4 source queries run concurrently (`asyncio.gather`).
- PG queries use the Phase 46 `MCPDatabase`-style connection pool. Each query is indexed (existing indexes on `agent_findings.recipient_agent`, `agent_findings.task_id`, `agent_findings.created_at`).
- Valkey is sub-ms when reachable.
- Memory similarity search is the slowest leg — Phase 43 retrieve_similar shape with top-K=3 and a 90-day recency filter typically returns in 50-150ms.
- Test target: `tests/test_agent_hydrator_perf.py` measures `p95 < 500` across 20 invocations against a populated test fixture. Skip gracefully when PG empty (PG-down → returns degraded result fast, test still passes the timing).

### Area 7 — Graceful degradation

Per-source error handling (same as Phase 45 bearings):
- PG down → memory + blackboard + security sections render `(unavailable — PG not reachable)`; Valkey may still work
- Valkey down → recent activity section renders `(unavailable — Valkey not reachable)`; PG sections render normally
- agent .md not found → operator decides whether to abort or use a default — `agent-hydrate` itself returns exit 1 with `{"error": "agent_not_found", "detail": "..."}` JSON when `--json` is given
- empty results → `_(none if empty)` placeholder for each section
- Server NEVER crashes on a missing source

### Area 8 — Test surface

- `tests/test_agent_hydrator.py` (Python) — unit tests for `services/agent_hydrator.py.hydrate()`: 4-source parallel execution, per-source degradation, per-agent differentiation, schema shape
- `tests/agent-hydrate-cli.test.cjs` (Node) — CLI integration: `gsd-tools agent-hydrate gsd-planner --json` returns the schema, exit 0
- `tests/agent-hydrate-perf.test.cjs` — p95 < 500ms over 20 runs, skip if no PG fixture
- `tests/agent-hydrate-render.test.cjs` — Markdown template assertions: `## Current context` header present, all 4 section headers present, `---` separator at end, no template literals left behind

### Claude's Discretion

- Exact Python helper function name in `services/agent_hydrator.py` (`hydrate(agent_name, task_id=None)` is the recommendation; executor's call if it needs splitting)
- Whether `_render_agent` in Phase 46's amauta-mcp.py grows a `task_id` parameter or stays at `(name, hydration=None)` with the operator pre-computing hydration (the second is simpler and matches Phase 46's structuring intent — recommend keeping `_render_agent` unchanged, pre-compute hydration upstream)
- Specific Valkey key naming (`agent:{name}:recent_activity` is the suggested seed)
- SQL for `agent_findings` query: use `recipient_agent IS NULL OR recipient_agent = $1` form to capture broadcasts AND direct messages
- Whether `agent-hydrate` auto-invokes when no `--task-id` is provided or just returns general context. Default: returns general context (no error)
- Color/formatting of the rendered block (Markdown only; no ANSI escapes — output is consumed by both terminal humans and agent prompts)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 47 requirement source
- `.planning/REQUIREMENTS.md` §"Agent Dynamic Hydration" — HYDRA-01, HYDRA-02 verbatim
- `.planning/ROADMAP.md` §"Phase 47: Agent Dynamic Hydration" — goal + 2 success criteria + dependency (Phase 42 + Phase 43)
- `.planning/PROJECT.md` — v3.1 portability + synthesis-over-accumulation core value

### Phase 46 hook (consume the existing injection point)
- `services/amauta-mcp.py` `_render_agent(name, hydration=None)` — already structured for Phase 47. Phase 47 produces the hydration block; consumer passes it as the `hydration` arg.
- `.planning/phases/46-standalone-mcp-server/46-CONTEXT.md` §Area 5 — locks the helper signature and renderer contract

### Established patterns to reuse (DO NOT reinvent)
- `services/pg_store.py` `generate_embedding()` voyage-code-3 1024-dim + `_get_conn()` context manager + `store_memory()` — memory source for hydration
- `services/skill_invocation_store.py` `retrieve_similar` (Phase 43) — hybrid BM25 + pgvector + RRF retrieval; pattern reused for agent-memory query
- `services/complexity_scorer.py` `_load_similar_completions` (Phase 42) — pgvector K-NN with cosine floor; same shape
- `services/amauta_daemon_redis.py` — Valkey/Redis client init (Phase 28 BEHAV-02)
- `migrations/014-agent-findings.sql` — agent_findings schema with `recipient_agent` column (verified by 3 refs in migration)
- Phase 45 `gsd-tools bearings` subcommand — operator-side CLI surface pattern (subcommand in gsd-tools.cjs that shells to Python heavy lifting where appropriate, returns structured JSON with `schema_version`)
- Phase 46 `MCPDatabase` (SimpleConnectionPool) — connection pool pattern; agent-hydrate can reuse or share singleton if the hydrator runs in MCP process; otherwise short-lived connections
- Phase 30+ `agent_findings` blackboard — both blackboard + security sources come from this table with `finding_type` filter

### Agent definitions (FILESYSTEM source, do NOT mutate)
- `agents/gsd-{planner,researcher,executor-*,checker,validator,operator,roadmapper,debugger,architect,security,reviewer,qa,tester}.md` — 17 standardized .md files with YAML frontmatter (name, description, tools, color, skills); 10-section format from Phase 30 FORMAT-01
- `agents/shared/` — shared rule files referenced by agents; do NOT touch in Phase 47
- `agents/changelog/` — agent version history; do NOT touch

### Out-of-scope adjacent surfaces
- Phase 45 `gsd-tools bearings` — different output, different consumer. Hydration is PER-AGENT; bearings is CROSS-CUTTING project state. Both exist independently.
- COMPILE-01 (v3.2+) — agent compilation to per-IDE formats. Phase 47 does NOT pre-empt this.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `services/pg_store.py` `_get_conn()`, `generate_embedding()`, `store_memory()`, hybrid retrieval helpers
- `services/skill_invocation_store.py` `retrieve_similar()` — Phase 43 RRF pattern; reuse for agent-memory query
- `services/amauta_daemon_redis.py` — Valkey init
- `services/amauta-mcp.py` `MCPDatabase` (Phase 46) — connection pool reusable if Phase 47 Python helper runs in MCP process
- Phase 46 `_render_agent(name, hydration=None)` — pre-wired consumer for the hydration payload
- `migrations/014-agent-findings.sql` — agent_findings schema for blackboard + security queries
- `get-shit-done/bin/gsd-tools.cjs` subcommand dispatcher — Phase 47 adds `case 'agent-hydrate':`

### Established Patterns
- **Parallel source queries (new in Phase 47):** asyncio.gather over 4 helpers; total wall-clock dominated by slowest source. Test budget 500ms p95.
- **Per-source graceful degradation (v2.5+, Phase 44, Phase 45, Phase 46):** each source reports `unavailable` independently; the block still renders the other sections.
- **Frozen schema_version (Phase 45):** hydration JSON gets `schema_version: "1.0"` for forward compatibility (Phase 46 MCP consumer + future MCP tools can guard on it).
- **Filesystem-only registries (Phase 43 Area 8):** agent definitions live on disk; hydrator reads them via fs.
- **`_HAS_PG` import-safety (Phase 42/43/45/46):** mandatory for `services/agent_hydrator.py`.

### Integration Points
- **`bin/cli.cjs` / `get-shit-done/bin/gsd-amauta.cjs` spawn hook** — operator calls `gsd-tools agent-hydrate` before constructing the Task() prompt. The rendered Markdown becomes a `<current_context>` block in the agent prompt or is passed via Phase 46 `_render_agent` for MCP consumers.
- **MCP `amauta://agent/{name}` resource** — Phase 46 ships the helper; Phase 47 just produces the hydration block. NO modification to `_render_agent` needed.
- **Task() invocation sites** — `get-shit-done/workflows/execute-phase/steps/step-*.md` files spawn agents. Adding a pre-spawn hydration call is OPTIONAL in v3.1 — operator-side gsd-amauta.cjs can populate the hydration env var or pre-render the block; downstream uses are Phase 48+ work.

</code_context>

<specifics>
## Specific Ideas

- **Hydration JSON schema (frozen, schema_version: "1.0"):**
  ```json
  {
    "schema_version": "1.0",
    "generated_at": "<ISO8601>",
    "agent_name": "gsd-planner",
    "task_id": "TK-1234" | null,
    "sources_status": {"memory": "ok|unavailable", "blackboard": "...", "valkey": "...", "security": "..."},
    "memory": [{"id","summary","cosine","age_days"}, ...],
    "blackboard": [{"id","severity","finding_type","summary","age"}, ...],
    "recent_activity": {"last_spawn","last_task","last_verdict"} | null,
    "security": [{"id","severity","finding_type","summary"}, ...]
  }
  ```
- **`recipient_agent` SQL convention** (verbatim): `WHERE recipient_agent IS NULL OR recipient_agent = $1` — captures both broadcasts and direct messages
- **Top-K + recency filters:** memory = top 3 cosine ≥ 0.6 within 90 days; blackboard = 5 most recent; security = 3 most recent within 24h
- **Valkey key:** `agent:{name}:recent_activity` (JSON-encoded value with timestamps)
- **`security_alert` / `lint_violation` / `circuit_breaker_open`** — finding_type values queried for the security section (matches Phase 30+ BEHAV-04 vocabulary)
- **800-token default budget, 400 token --terse** — per-agent context is denser than bearings (which is 600/400)

</specifics>

<deferred>
## Deferred Ideas

- **Pre-spawn hydration auto-invocation across all workflows** — Phase 47 ships the CLI + helper; threading the call into every Task() spawn site is gradual. Workflow-by-workflow integration is Phase 48+ work.
- **Agent .md template markers** — if a future use case demands inline template variables, add them then. Phase 47 keeps agent .md files pristine.
- **Cross-agent context sharing beyond blackboard** — agent A reading agent B's last-private-memory is out of scope. Blackboard findings already serve this case.
- **MCP tool: `amauta/agent-hydrate`** — Phase 46 didn't add it; Phase 47 doesn't either. If MCP clients need hydration, they call the CLI via subprocess or invoke `_render_agent` directly. Plan as Phase 48 if demand surfaces.
- **Streaming hydration** — the 800-token block is small enough to deliver in one shot. Streaming is a perf optimization for later.
- **Caching hydration across spawns** — premature; 500ms is fast enough. Add Valkey cache layer only if profiling shows a hotspot.
- **Per-task budget tracking (compute hydration cost into the orchestrator's overall context budget)** — Phase 47 doesn't enforce a global token budget. Workflow-level accounting is Phase 48+ work.
- **Security data source schema upgrade** — if security findings need a dedicated table separate from agent_findings, that's a migration. v3.1 uses the discriminator approach.

</deferred>

---

*Phase: 47-agent-dynamic-hydration*
*Context gathered: 2026-05-12*

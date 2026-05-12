# Phase 46: Standalone MCP Server - Context

**Gathered:** 2026-05-12
**Status:** Ready for planning
**Source:** Direct from PROJECT.md + ROADMAP.md §Phase 46 + REQUIREMENTS.md (MCP-01..03) + Phase 43/44/45 patterns (no discuss-phase per user directive — docs are complete enough)

<domain>
## Phase Boundary

Refactor the existing `services/amauta-mcp.py` (17KB, currently a thin HTTP wrapper over `amauta-daemon` at port 18799) into a **standalone MCP service** with direct PG connection pool and direct Valkey client. After Phase 46, the MCP server does NOT require `amauta-daemon` to be running. Adds the missing `amauta/complexity-score` tool (the other 5 tools already wired via daemon — convert each to direct-DB calls). Adds 3 MCP resources (`amauta://context/{task_id}/{phase}`, `amauta://agent/{agent_name}`, `amauta://findings/{task_id}`). Two transports: stdio (default, IDE-spawned) and SSE on port 18800 (`--sse` flag — already supported in current file).

Out of scope: replacing amauta-daemon (daemon continues to exist for REST API consumers; MCP just becomes peer to it, not dependent on it). New embedding model. New MCP tools beyond the 6 in MCP-02. Authentication/auth on SSE port (lan-only assumption per v3.1 portability constraint).

</domain>

<decisions>
## Implementation Decisions

### Area 1 — Brownfield invert: HTTP-wrapper → direct DB client

- **Extend `services/amauta-mcp.py` in place.** Same file, same entry point (`python3 services/amauta-mcp.py [--sse]`). Replace every `_call_daemon(...)` with direct PG/Valkey access via reusable helpers. Existing tool definitions (`amauta/search-code`, `memory-store`, `memory-search`, `memory-distill`, `research`) stay; their handler bodies are rewritten to talk to PG/Valkey directly.
- **NO daemon dependency for normal operation.** When PG is reachable, MCP runs standalone. When PG is down, the server still starts (stdio + SSE come up); each tool/resource returns structured errors matching the v2.5+ degradation pattern (`{"error": "pg_unavailable", "detail": "..."}`); the server does NOT crash.
- **Daemon-fallback REMOVED**, not retained. MCP-01 is explicit: "Does NOT require daemon." Keeping a fallback re-introduces the coupling the requirement deletes. If a downstream consumer needs daemon-backed behavior, they can call the daemon REST API directly.
- **`amauta/complexity-score` tool added** — missing from the current MCP surface. Calls `services/complexity_scorer.py` `score()` directly (Phase 42 SCALE-01 entry point).

### Area 2 — Direct PG client (connection pool)

- **Use psycopg2 with a SimpleConnectionPool** (matches `services/pg_store.py` + `services/amauta-daemon.py` patterns). MIN=1, MAX=8 connections by default. Configurable via env `MCP_PG_POOL_MIN` / `MCP_PG_POOL_MAX`.
- **Connection URL resolution** identical to daemon: env `GSD_POSTGRES_URL` first; otherwise `services/infra_detect.py` cascade (Phase 44 reuse — local PG → Docker PG → SQLite).
- **SQLite fallback supported** at the pool level — when `infra_detect` returns `backend=sqlite`, MCP uses sqlite3 (no pool needed) via a thin adapter that exposes the same query interface as the psycopg2 cursor.
- **`_HAS_PG` import-safety fallback** mirroring Phase 42/43/45 pattern. Module imports cleanly without psycopg2 installed (tool calls return `pg_unavailable` error).
- **Reuse `services/pg_store.py` `generate_embedding()`** for any tool needing voyage-code-3 1024-dim embeddings (`memory-search`, `search-code`). No new embedding code.

### Area 3 — Direct Valkey client

- **Reuse `services/amauta_daemon_redis.py` pattern** (Phase 28 BEHAV-02). Same connection-init shape: read `VALKEY_URL`/`REDIS_URL` env; `redis.from_url(...)` (redis-py talks to Valkey). Singleton client per server process.
- **Valkey is OPTIONAL.** When unavailable, tools that touch it (cache layer for `memory-search`, `research`) skip the cache and hit PG directly. Server keeps running. Structured warn entry in logs.

### Area 4 — Six MCP tools (MCP-02 verbatim)

Every tool keeps its existing schema (where one exists) and routes to a direct-DB handler. Tool surface (frozen names from MCP-02):

1. **`amauta/search-code`** — hybrid BM25 + pgvector retrieval. Reuses `services/skill_invocation_store.py` `retrieve_similar` pattern (Phase 43) but queries the broader code-embedding table from v2.9 (`code_embeddings` if it exists; otherwise `task_completions` text fields). Top-K=5 default, configurable per call.
2. **`amauta/memory-store`** — write to PG memory table. Uses `services/pg_store.py` `store_memory()` or equivalent. Generates voyage-code-3 embedding on write.
3. **`amauta/memory-search`** — hybrid BM25 + pgvector over PG memory. Same retrieval shape as `search-code`. Top-K=3, cosine_floor=0.6 (matches Phase 43 defaults).
4. **`amauta/memory-distill`** — distillation/summary of similar memories. Reuses existing logic via direct PG SELECT.
5. **`amauta/research`** — Memory → SKB → WebFetch chain (per current MCP file comment: "Full 5-step chain requires gsd-researcher agent invocation" — MCP version is the implementable 3-step subset). NO new research scope here.
6. **`amauta/complexity-score`** — calls `services/complexity_scorer.py` `score()` with the input task descriptor. Returns the 0-100 score + the per-dimension breakdown. NEW in Phase 46 (was missing).

**Tool error contract (frozen):** every tool returns either a successful result object OR `{"error": "<error_code>", "detail": "<message>"}`. Error codes: `pg_unavailable`, `valkey_unavailable`, `invalid_input`, `not_found`, `internal_error`. Server NEVER exits because a tool failed.

### Area 5 — Three MCP resources (MCP-03 verbatim)

1. **`amauta://context/{task_id}/{phase}`** — returns the RPETD phase content (R/P/E/T/D) for a given task+phase. PG query: `SELECT content FROM rpetd_phases WHERE task_id = $1 AND phase = $2`. Returns `text/markdown`.
2. **`amauta://agent/{agent_name}`** — returns the agent definition .md file content. Filesystem read: `agents/<agent_name>.md` or `~/.claude/agents/<agent_name>.md` (fallback). Returns `text/markdown`.
3. **`amauta://agent/{agent_name}` HYDRATION (Phase 47 hook):** Phase 47 HYDRA-02 will prepend `## Current context` to this resource's output. Phase 46 ships the BASE resource — Phase 47 wraps. Note: resource handler in Phase 46 must be structured so the hydration injection point is obvious (e.g., a `_render_agent(name, hydration=None)` helper where Phase 47 passes the hydration block).
4. **`amauta://findings/{task_id}`** — returns blackboard findings for a task. PG query against `agent_findings` table (Phase 30+ blackboard schema). Returns JSON.

**Resource error contract:** unresolvable URI → MCP-spec-compliant error response with `code: -32602` (invalid params). Empty result (no rows) → success response with empty array/null content + a metadata field indicating empty.

### Area 6 — Transport modes (MCP-01 verbatim)

- **stdio** (default): `python3 services/amauta-mcp.py`. Spawned by IDE clients (Claude Code, Cursor, OpenCode). Existing code already supports this.
- **SSE**: `python3 services/amauta-mcp.py --sse` on port 18800. Existing code already supports this — keep the port choice (matches MCP-01 verbatim).
- **No HTTP/REST transport** added in Phase 46 — that's the daemon's job. MCP stays MCP.

### Area 7 — Test surface

- **Per-tool unit tests** in `tests/test_amauta_mcp_<tool>.py` (Python — matches Phase 42/43/44 test home for Python code). Each tool tested in isolation with mocked PG cursor + mocked Valkey client.
- **Per-resource unit tests** in `tests/test_amauta_mcp_resources.py`. Each URI pattern resolved + error cases (not_found, malformed URI) covered.
- **stdio integration test** in `tests/test_amauta_mcp_stdio.py` — spawn the MCP process, send a list-tools request, assert the 6 tool names come back. Skipped gracefully if `mcp` Python package not installed.
- **SSE integration test** in `tests/test_amauta_mcp_sse.py` — start `--sse`, GET `http://127.0.0.1:18800/sse`, assert a valid SSE stream + tool list. Skipped if port 18800 in use.
- **PG-down resilience test**: run a tool call with `GSD_POSTGRES_URL=postgresql://invalid:1/none`; assert tool returns `{"error": "pg_unavailable", ...}`; server does NOT crash.

### Claude's Discretion

- Exact psycopg2 pool size defaults (1-8 is sane; executor can tune if benchmarks indicate).
- Specific SQL for `agent_findings` query (schema already defined by Phase 30; pick the right table name from migrations).
- Whether the SSE transport gets a startup banner or stays silent.
- How `infra_detect` is invoked: subprocess call vs Python import. Import is cleaner; subprocess matches the current daemon pattern. Executor's call.
- Logging format/destination (stderr by default; respect `MCP_LOG_LEVEL` env if helpful).
- Whether the `_call_daemon` helper is deleted outright or marked `@deprecated` for one release. Deletion is simpler given the explicit "Does NOT require daemon" requirement.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 46 requirement source
- `.planning/REQUIREMENTS.md` §"Standalone MCP Server" — MCP-01..03 verbatim
- `.planning/ROADMAP.md` §"Phase 46: Standalone MCP Server" — goal + 3 success criteria + dependencies
- `.planning/PROJECT.md` — v3.1 portability constraint (no daemon dependency for MCP)

### Brownfield surface (modify in place)
- `services/amauta-mcp.py` — existing 17KB MCP server, currently HTTP-wrapper over daemon. Phase 46 refactors handlers to direct PG/Valkey. Keep entry point, transport options, tool definitions; rewrite handler bodies.
- `bin/mcp-server.cjs` — Node-side MCP launcher (referenced from `bin/cli.cjs`). Should be checked but likely no change needed if it just spawns the Python file.

### Direct-DB reuse (DO NOT reinvent)
- `services/pg_store.py` — `generate_embedding()` (voyage-code-3 1024-dim), `store_memory()`, hybrid retrieval helpers. Reuse verbatim.
- `services/amauta_daemon_redis.py` — Valkey client init pattern, `VALKEY_URL`/`REDIS_URL` env handling.
- `services/infra_detect.py` — PG cascade (local → Docker → SQLite). MCP uses this at startup to resolve connection URL.
- `services/complexity_scorer.py` — Phase 42 SCALE-01 `score()` entry point for the new `amauta/complexity-score` tool.
- `services/skill_invocation_store.py` — Phase 43 hybrid retrieval pattern (RRF + cosine floor + 90-day recency). `amauta/memory-search` should follow this shape (cosine_floor=0.6, k=3, RRF k=60).

### Phase 47 integration hook (in scope to STRUCTURE, not to ship)
- `amauta://agent/{agent_name}` resource handler must accept an optional hydration injection point so Phase 47 HYDRA-02 can prepend `## Current context`. Phase 46 ships the base resource only.

### Established patterns
- `_HAS_PG` import-safety fallback — Phase 42 + Phase 43 + Phase 45 all use this. Phase 46 mandatory.
- Graceful degradation per-source — Phase 44 `buildStepResult` warn/skip pattern. Phase 46's tool error contract is the MCP-side equivalent.
- Pydantic models for structured returns — Phase 41 step-orchestrator + Phase 43 skill_schema. If new structured types are needed for resources/tools, use Pydantic with `_HAS_PYDANTIC` fallback.
- Test home — Python tests in `tests/test_*.py`, JS tests in `tests/*.test.cjs`. Phase 46 is mostly Python (MCP server is Python).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `services/amauta-mcp.py` lines 1-50 already handle env loading + stdio/SSE transport setup. Keep.
- `services/amauta-mcp.py` tool DEFINITIONS (Tool objects with name/description/schema) — keep verbatim; only handler bodies change.
- `services/pg_store.py` — embedding generation + memory ops + helper functions.
- `services/complexity_scorer.py` `score()` — direct call for new tool.
- `services/amauta_daemon_redis.py` — Valkey init pattern.

### Established Patterns
- **Two-transport MCP server (stdio + SSE):** already in current amauta-mcp.py.
- **Hybrid BM25 + pgvector retrieval with RRF (Phase 43):** reused for memory-search + search-code.
- **`_HAS_PG` fallback (Phase 42/43/45):** reused for any new helper.
- **infra_detect cascade (Phase 44):** reused for connection URL resolution.
- **Filesystem-only registry (Phase 43 Area 8):** agent definitions live on disk; resource handler reads them via fs.

### Integration Points
- `bin/cli.cjs` MCP dispatcher — unchanged (still spawns the same Python process).
- `bin/init.cjs` install step (Phase 44) — already installs `amauta-mcp.py` as part of the runtime. No change.
- Phase 47 HYDRA — hooks into the `amauta://agent/{name}` resource handler. Phase 46 must leave this injection point clean.

</code_context>

<specifics>
## Specific Ideas

- **Tool error code vocabulary (frozen):** `pg_unavailable`, `valkey_unavailable`, `invalid_input`, `not_found`, `internal_error`. No other codes in v3.1. Match MCP server's MCP-error-spec mapping (-32602 invalid_params, -32603 internal_error) for resource errors.
- **Connection pool defaults:** psycopg2 SimpleConnectionPool MIN=1 MAX=8. Environment-tunable via `MCP_PG_POOL_MIN` / `MCP_PG_POOL_MAX`.
- **SSE port 18800** (verbatim from MCP-01). Daemon stays on 18799. No port collision possible.
- **Resource URI scheme** `amauta://...` (verbatim from MCP-03).
- **PG-down behavior:** server starts, transport comes up, every tool/resource returns structured error. Test verifies this is non-crashing.

</specifics>

<deferred>
## Deferred Ideas

- **Authentication on SSE transport** — v3.1 assumes LAN-only. Add auth in a later phase if multi-tenant exposure becomes relevant.
- **MCP tool: `amauta/bearings`** — wraps Phase 45's `gsd-tools bearings`. NOT in MCP-02 scope; Phase 46 doesn't add it. Plan as a follow-up if MCP clients ask for it.
- **MCP tool: skill invocation** — Phase 43 `/api/skills/invoke` and `/api/skills/complete` daemon endpoints aren't in MCP-02 scope; defer to a later phase if needed.
- **Schema versioning of MCP responses** — Phase 45 schema_version:"1.0" pattern could apply to MCP tools/resources. Skip for v3.1; revisit when the surface stabilizes and we have a real consumer asking for it.
- **Daemon-side `/api/research-cache` POST route** — current MCP file has a TODO about this. Out of MCP scope; that's a daemon concern.
- **Hot-reload of agent definitions** — `amauta://agent/{name}` resource reads from disk at every call. Caching would help; defer until profiling shows it matters.

</deferred>

---

*Phase: 46-standalone-mcp-server*
*Context gathered: 2026-05-12*

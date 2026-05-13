---
plan_id: "46-01"
phase: 46
status: complete
completed_at: "2026-05-12"
agent: executor-backend
tasks_completed: 9
tests_added: 23
tests_failed: 0
files_modified:
  - services/amauta-mcp.py
files_created:
  - tests/test_amauta_mcp_db_helpers.py
  - tests/test_amauta_mcp_tools.py
  - .planning/phases/46-standalone-mcp-server/46-01-SUMMARY.md
files_deleted: []
commits:
  - "feat(46-01-01+02): add MCPDatabase + MCPValkey helpers; _HAS_PG + _HAS_REDIS import-safety"
  - "feat(46-01-03): add tests/test_amauta_mcp_db_helpers.py — MCPDatabase + MCPValkey unit tests"
  - "feat(46-01-04): rewrite memory-store + memory-search handlers — direct PGStore calls"
  - "feat(46-01-05): rewrite search-code handler; delete _call_rlm (dead code)"
  - "feat(46-01-06): rewrite memory-distill + research handlers — direct PGStore + Valkey cache"
  - "feat(46-01-07): add amauta/complexity-score tool — 6th tool, Phase 42 SCALE-01 scorer"
  - "feat(46-01-08): delete _call_daemon + _check_daemon_health; zero daemon coupling"
  - "feat(46-01-09): add tests/test_amauta_mcp_tools.py — 17 per-tool unit tests for all 6 tools"
requirements_satisfied:
  - MCP-01
  - MCP-02
---

# Plan 46-01 Summary: Direct PG + Valkey Foundation; 6 MCP Tools Refactored

## What Was Built

Refactored `services/amauta-mcp.py` from a 17KB HTTP-wrapper over `amauta-daemon` (port 18799) into a standalone MCP service with direct PostgreSQL connection pool and optional Valkey client. The server no longer requires `amauta-daemon` to be running.

### Core Infrastructure Added

**MCPDatabase** (`services/amauta-mcp.py`):
- psycopg2 `SimpleConnectionPool` with `MIN=1, MAX=8` defaults (env-tunable via `MCP_PG_POOL_MIN`/`MCP_PG_POOL_MAX`)
- Connection URL resolution: `GSD_POSTGRES_URL` env first; otherwise `services/infra_detect.py` cascade (local PG → Docker PG → SQLite)
- SQLite adapter for non-PG backends (same `getconn()`/`putconn()` interface)
- `available()` returns `False` without raising when init fails; `_init_error` records reason
- `_HAS_PG` import-safety fallback (mirrors `skill_invocation_store.py` pattern)

**MCPValkey** (`services/amauta-mcp.py`):
- `redis.from_url()` with `VALKEY_URL`/`REDIS_URL` env; `_HAS_REDIS` import-safety
- `ping()` at init; `available()` caches result; never pings on every call
- `get()`/`setex()` swallow all exceptions; return `None`/`False` on failure
- Valkey is fully optional — server starts and all tools work without it

**Module-level singletons**: `_get_pg_store()` (lazy PGStore) + `_get_mcp_valkey()` (lazy MCPValkey)

**Frozen constants**:
- `_MCP_ERROR_CODES = ("pg_unavailable", "valkey_unavailable", "invalid_input", "not_found", "internal_error")`
- `MCP_SSE_PORT = 18800` (unchanged)

### Tools Refactored (5 existing + 1 new)

| Tool | Handler Change |
|------|---------------|
| `amauta/search-code` | Removed `_call_rlm()`. Direct PG: tries `code_embeddings` table via `store._get_conn()`; falls back to `memory_semantic_search()`. Post-filters `file_filter`/`directory` after DB call. Top-K=5 default (Phase 46 CONTEXT Area 4). |
| `amauta/memory-store` | Removed `_call_daemon("POST","/api/memory/store")`. Direct `store.memory_store_with_embedding()`. Validates `text` non-empty. Returns `{"id":..., "stored":True}` or dedup dict. |
| `amauta/memory-search` | Removed `_call_daemon("POST","/api/memory/semantic-search")`. Direct `store.memory_semantic_search()`. Unwraps `(results, method)` tuple. |
| `amauta/memory-distill` | Removed `_call_daemon("GET","/api/memory/distill-status")`. Direct `store.memory_count()`; `needs_distill = total >= 500`; threshold literal 500. |
| `amauta/research` | Removed all 4 `_call_daemon()` calls. New: Valkey GET cache → `memory_semantic_search()` → `skb_search()` → DuckDuckGo WebFetch (verbatim) → Valkey SETEX(ttl=3600). |
| `amauta/complexity-score` | **NEW.** Lazy import of `services.complexity_scorer`. Validates `task_meta` is dict. Calls `extract_features(plan_path, task_meta, project_root)` then `score_features(features)`. Returns `{"score": int, "features": {...7 keys...}}`. |

### Dead Code Removed
- `_call_daemon()` function — 0 occurrences
- `_call_rlm()` function — 0 occurrences
- `_check_daemon_health()` function — 0 occurrences
- `DAEMON_URL` constant — 0 occurrences
- `RLM_URL` constant — 0 occurrences
- `AMAUTA_DAEMON_URL` constant — 0 occurrences

### Resource Handlers Updated
- `list_resources()`: now queries `rpetd_phases` table directly (no daemon); returns empty list on PG error
- `read_resource()`: now queries `rpetd_phases WHERE task_id=? AND phase=?` directly

### Tests Added

**`tests/test_amauta_mcp_db_helpers.py`** (6 tests):
- `test_module_imports_without_psycopg2`: `_HAS_PG` is bool; MCPDatabase/MCPValkey classes exist
- `test_mcpdatabase_unavailable_when_url_invalid`: bad PG URL → `available()=False`, `_init_error` set
- `test_mcpdatabase_does_not_raise_on_bad_url`: constructor must not raise
- `test_mcpvalkey_unavailable_when_url_missing`: no URL → `available()=False`, methods safe
- `test_mcpvalkey_unavailable_when_url_invalid`: bad URL → ping fails gracefully
- `test_constants_frozen`: `MCP_SSE_PORT==18800`; all 5 error codes in `_MCP_ERROR_CODES`

**`tests/test_amauta_mcp_tools.py`** (17 tests):
- All 6 tools tested with mocked `_get_pg_store()` + `_get_mcp_valkey()`
- `test_list_tools_exposes_six_frozen_names`: exact set match
- memory-store: invalid_input / happy_path / pg_unavailable
- memory-search: pg_unavailable / invalid_input / happy_path
- search-code: post-filter-directory / pg_unavailable
- memory-distill: threshold_500 / below_threshold
- research: valkey_cache_hit / valkey_unavailable_skips_cache / invalid_input
- complexity-score: invalid_input / not_dict / happy_path (score 0-100, 7 features)

**All 23 tests pass. 0 failures. No regression in existing 27 complexity_scorer tests.**

## Deviations from Plan

None. All 9 tasks executed in DAG order, each committed atomically. All acceptance criteria satisfied.

**One observation (non-divergence):** The daemon code at `amauta-daemon.py:1707` shows `conn = store._get_conn()` without `with` — this is a local variable assignment, not a context manager usage (the actual `with conn.cursor()` follows). The correct pattern used throughout `pg_store.py` and in the new MCP handlers is `with store._get_conn() as conn:`. The new handlers use the correct context manager pattern.

## Applied Learnings

- `feedback_fastapi_asyncpg_migration_drift_fix.md`: guarded PGStore init with try/except; `_get_pg_store()` returns None without raising
- `feedback_ioredis_mock_shared_state.md` (analog): MCPValkey tests use fresh instances per test class; no shared state
- `no applicable prior learnings specific to MCP+psycopg2+Valkey pattern` — this is a new pattern; stored as a new learning

## Requirements Satisfied

- **MCP-01**: Server starts without daemon; stdio + SSE 18800 transports preserved; PG-down tools return structured errors; server never crashes on tool failure
- **MCP-02**: All 6 frozen tool names exposed verbatim; every handler body talks to PG/Valkey directly; no `_call_daemon` references remain

---
phase: 46
verified: 2026-05-12
status: passed
validator: gsd-validator
plans_verified: [46-01, 46-02]
requirements: [MCP-01, MCP-02, MCP-03]
tests_pass: 50
tests_skip: 2
tests_fail: 0
commits: 17
---

# Phase 46 Verification: Standalone MCP Server

## Pre-Gate: Divergence Scan

Scanned `.planning/milestones/v3.1-the-gathering/divergence-reports/` and
`.planning/phases/46-standalone-mcp-server/divergence-reports/`. Neither directory
exists. Result: **0 unresolved divergence reports**. No floor applied.

---

## SC1: MCP-01 — Standalone, no daemon

### MCPDatabase with SimpleConnectionPool

PASS.

- `class MCPDatabase` at line 80.
- `from psycopg2.pool import SimpleConnectionPool` at line 58.
- Pool constructed at line 130: `SimpleConnectionPool(minconn=min_conn, maxconn=max_conn, dsn=url)`.
- `MCP_PG_POOL_MIN` at line 128, `MCP_PG_POOL_MAX` at line 129 — env-configurable defaults (MIN=1, MAX=8).

### MCPValkey class

PASS.

- `class MCPValkey` at line 177.
- `redis.from_url()` with `VALKEY_URL`/`REDIS_URL` env resolution.
- `available()` caches ping result; `get()`/`setex()` swallow exceptions.

### _call_daemon removed

PASS.

```
$ grep -c "_call_daemon" services/amauta-mcp.py
0
```

Zero occurrences. Also confirmed absent: `_call_rlm`, `_check_daemon_health`, `DAEMON_URL`, `RLM_URL`, `AMAUTA_DAEMON_URL`.

### _HAS_PG import-safety fallback

PASS.

- Line 59: `_HAS_PG = True` (psycopg2 present path).
- Line 61: `_HAS_PG = False` (except block).
- Used at line 127 to guard `SimpleConnectionPool` construction.

### Transports: stdio + SSE 18800

PASS.

- stdio: `from mcp.server.stdio import stdio_server` at line 48; `async def _run_stdio()` at line 778.
- SSE: `MCP_SSE_PORT = int(os.environ.get("AMAUTA_MCP_PORT", "18800"))` at line 65.
- Both documented in module docstring (lines 6, 10-11); `--sse` flag dispatches to SSE path.

### PG-down test: server doesn't crash

PASS.

- `test_amauta_mcp_pg_down.py` (5 tests): spawns server with `GSD_POSTGRES_URL=postgresql://invalid:1/none`.
- `test_pg_down_server_starts_and_lists_tools` PASS — all 6 frozen tool names returned.
- `test_pg_down_tool_call_returns_pg_unavailable` PASS — `{"error":"pg_unavailable"}` structured response.
- `test_pg_down_process_does_not_exit` PASS — `proc.poll() is None` after 2s.
- `test_pg_down_complexity_score_still_works` PASS — pure-function tool returns `score` field with PG down.

---

## SC2: MCP-02 — 6 Tools

### All 6 frozen tool names

PASS (all 6 found verbatim in `services/amauta-mcp.py`):

| Tool | Line (definition) | Line (handler dispatch) |
|------|-------------------|-------------------------|
| `amauta/search-code` | 319 | 404 |
| `amauta/memory-store` | 333 | 468 |
| `amauta/memory-search` | 348 | 494 |
| `amauta/memory-distill` | 362 | 518 |
| `amauta/research` | 372 | 537 |
| `amauta/complexity-score` | 388 | 608 |

`test_list_tools_exposes_six_frozen_names` PASS (exact set match).

### _MCP_ERROR_CODES 5-tuple with "not_found"

PASS.

```python
_MCP_ERROR_CODES = (
    "pg_unavailable",
    "valkey_unavailable",
    "invalid_input",
    "not_found",
    "internal_error",
)
```

All 5 codes present including `"not_found"`. Confirmed by `test_constants_frozen` PASS.

### complexity-score Phase 42 two-step API

PASS.

- Line 610: `from services.complexity_scorer import extract_features, score_features`.
- Line 621: `features = extract_features(plan_path, task_meta, project_root)`.
- Line 622: `score = score_features(features)`.
- Returns `{"score": int, "features": {...7 keys...}}`.
- `test_complexity_score_happy_path` PASS — score in 0-100, 7 features dict.

### Per-tool tests pass

PASS. `tests/test_amauta_mcp_tools.py` — 17 tests, 0 failures.

---

## SC3: MCP-03 — 3 Resources

### All 3 resource URIs verbatim

PASS (all 3 found in `services/amauta-mcp.py`):

| URI Template | Line (list_resources) | Line (read_resource dispatch) |
|--------------|-----------------------|-------------------------------|
| `amauta://context/{task_id}/{phase}` | 640 | 692 |
| `amauta://agent/{agent_name}` | 646 | 712 |
| `amauta://findings/{task_id}` | 652 | 725 |

### _render_agent(name, hydration=None) exact signature

PASS.

```python
def _render_agent(name: str, hydration=None):  # line 275
```

`test_render_agent_hydration_kwarg_default_is_none` PASS — contract locked via `inspect.signature`.

### Context resource uses rpetd_context_get (not rpetd_phases)

PASS.

- Line 702: `row = store.rpetd_context_get(task_id, phase)`.
- No `rpetd_phases` table in `read_resource()` dispatch.

### Findings resource queries agent_findings table

PASS.

- Line 740: `"FROM agent_findings WHERE task_id = %s ORDER BY created_at DESC"`.

### Resource tests pass

PASS. `tests/test_amauta_mcp_resources.py` — 16 tests, 1 skip (hydration block skipped when agent file absent in CI), 0 failures.

---

## Cross-Cutting Checks

### Atomic commits

PASS. 17 total (1 context doc + 8 feat/46-01 tasks + 2 46-01 chore commits + 6 feat/46-02 tasks + 1 46-02 chore commit). All messages carry `feat(46-01-XX)` / `feat(46-02-XX)` tags. Known deviation: 46-01-01+02 combined in one commit (noted in SUMMARY.md as acceptable — task-level atomicity preserved by message tagging).

### SUMMARY.md files

PASS.

- `46-01-SUMMARY.md` — complete, no "Self-Check: FAILED".
- `46-02-SUMMARY.md` — complete, no "Self-Check: FAILED".

### STATE.md + ROADMAP.md mark Phase 46 complete

PASS.

- `STATE.md` line 6: `stopped_at: Phase 46 COMPLETE — both 46-01 and 46-02 done`.
- `ROADMAP.md` line 56: `- [x] **Phase 46: Standalone MCP Server** ... COMPLETE 2026-05-12`.

### All 6 test files present

PASS.

| File | Tests | Result |
|------|-------|--------|
| `test_amauta_mcp_db_helpers.py` | 6 | 6 pass |
| `test_amauta_mcp_tools.py` | 17 | 17 pass |
| `test_amauta_mcp_resources.py` | 16 | 15 pass, 1 skip |
| `test_amauta_mcp_stdio.py` | 4 | 4 pass |
| `test_amauta_mcp_sse.py` | 4 | 3 pass, 1 skip |
| `test_amauta_mcp_pg_down.py` | 5 | 5 pass |
| **Total** | **52** | **50 pass, 2 skip, 0 fail** |

Terminal output from validator run:
```
$ python3 -m pytest tests/test_amauta_mcp_db_helpers.py tests/test_amauta_mcp_tools.py \
    tests/test_amauta_mcp_resources.py tests/test_amauta_mcp_stdio.py \
    tests/test_amauta_mcp_sse.py tests/test_amauta_mcp_pg_down.py -v --tb=short

======================== 50 passed, 2 skipped in 6.03s =========================
```

The 2 skips are expected (see Known Deviations):
- `test_sse_get_sse_path_returns_event_stream` — SSE event-stream body blocked at `http.client` level (port accepts, event-stream skipped).
- `test_render_agent_prepends_hydration_block` — agent `.md` file absent in test environment.

---

## Known Deviations — Accepted

1. Wave 2 mid-execution API error after 46-02-04: ACCEPTED. Tasks 05+06+closeout completed in continuation agent; all 6 Wave 2 commits (df30652..5963336) present with correct tags.
2. 46-01-01+02 combined commit: ACCEPTED. Message `feat(46-01-01+02)` preserves task traceability.
3. Amauta TK dedup-block during planning: ACCEPTED. Execution proceeded from PLAN.md files directly.
4. No VALIDATION.md / Nyquist Dimension 8: ACCEPTED. Research disabled in config — same trade-off as Phases 44/45.
5. Manifest-check (HARDEN-01) orchestrator spot-checked: ACCEPTED. Not a per-task tooled gate for this phase.
6. `mcp` package: installed in validator's test environment. Skip count (2) is below the maximum expected (0-4 per transport test file) — actual behavior is better than the conservative skip estimate.

---

## Gaps

None.

---

## Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|---------|
| MCP-01 | PASS | MCPDatabase + MCPValkey direct pool; `_call_daemon` = 0; stdio + SSE 18800; PG-down 5/5 tests |
| MCP-02 | PASS | 6 frozen tool names; `_MCP_ERROR_CODES` 5-tuple with `not_found`; Phase 42 two-step scorer; 17/17 tool tests |
| MCP-03 | PASS | 3 URI templates verbatim; `_render_agent(name, hydration=None)`; `rpetd_context_get`; `agent_findings`; 15/16 resource tests |

---

## Verdict

**PASSED.** All 3 requirements (MCP-01, MCP-02, MCP-03) verified against live code and test output. 50 tests pass, 2 skip gracefully, 0 fail. Phase 47 (HYDRA-02 injection point) unblocked.

---
phase: 56-a2a-orchestration
verified_by: gsd-validator
verified_at: "2026-05-14"
status: passed
requirement_ids: [A2A-05, A2A-06, A2A-07]
plans_verified: [56-01, 56-02, 56-03]
test_counts:
  test_a2a_breaker: "26 passed"
  test_a2a_threading: "9 passed, 5 skipped (PG-gated)"
  test_a2a_audit: "11 passed, 4 skipped (PG-gated)"
  test_a2a_tail_cli: "12 passed"
  combined_suite: "129 passed, 13 skipped"
---

# Phase 56 Verification Report

**Phase goal:** Add circuit-breaker protection per agent-pair, multi-turn conversation threading via
`parent_correlation_id` chains, and a daemon audit endpoint that gives operators full visibility into
every A2A exchange.

**Verdict: PASSED** — All 3 requirement IDs (A2A-05, A2A-06, A2A-07) verified against codebase.
Full Phase 55 + 56 test suite: 129 passed, 13 skipped (all skips are PG-gated integration tests
that require `GSD_PG_INTEGRATION=1`), 0 failed.

---

## Divergence Pre-Gate Scan

No `divergence-reports/` directory exists under `.planning/phases/56-a2a-orchestration/`. The only
divergence-report directories in this repo are under
`.planning/milestones/52-agent-compilation/divergence-reports/` (which is empty) and
`.planning/milestones/v2.2-phases/13.1-.../divergence-reports/` — both from prior milestones,
not Phase 56. No unresolved divergence reports apply to Phase 56. Verdict floor: unconstrained.

---

## Verdict Summary Table

| Check | Result | Notes |
|-------|--------|-------|
| A2A-05 circuit breaker — services/a2a_breaker.py exists | PASS | File present, 272 lines |
| A2A-05 — 4 frozen constants (import assert) | PASS | `python3 -c "from services.a2a_breaker import ..."` exits 0 |
| A2A-05 — 3 state tokens present | PASS | `closed`, `open`, `half_open` in source |
| A2A-05 — SETNX probe lock present | PASS | `set(...nx=True...)` count >= 1 in a2a_breaker.py |
| A2A-05 — `_check_breaker` before PG INSERT | PASS | Line 388 (after `_check_capability` at 387, before `def _run` at 390 / INSERT at 395) |
| A2A-05 — `record_a2a_failure` in except A2ATimeoutError ONLY | PASS | Line 701 in `except A2ATimeoutError` block; not in payload_invalid/unknown_capability paths |
| A2A-05 — fail-open on Valkey down | PASS | All Valkey calls wrapped in try/except returning STATE_CLOSED or True |
| A2A-05 — 26 tests pass (no live Valkey) | PASS | `26 passed in 0.11s` |
| A2A-06 — THREAD_DEFAULT_DEPTH_LIMIT == 10 | PASS | `python3 -c "from services.a2a_client import get_thread, THREAD_DEFAULT_DEPTH_LIMIT; assert THREAD_DEFAULT_DEPTH_LIMIT==10; print('ok')"` |
| A2A-06 — WITH RECURSIVE CTE present | PASS | `grep -c "WITH RECURSIVE"` = 2 (once in docstring diagram, once in live SQL) |
| A2A-06 — ORDER BY created_at ASC | PASS | Count = 2 (docstring + live SQL) |
| A2A-06 — empty list on stale root (no exception) | PASS | Test `test_get_thread_returns_list_on_missing_pg` + bare-except contract |
| A2A-06 — depth_limit default 10, overridable | PASS | `inspect.signature` test + constant binding |
| A2A-06 — 9 structural tests pass (no PG) | PASS | `9 passed, 5 skipped in 0.21s` |
| A2A-07 — `/a2a/exchanges` handler in daemon | PASS | `grep -c '"/a2a/exchanges"'` = 1 at L1886 |
| A2A-07 — schema_version, exchanges, next_cursor keys | PASS | All 3 keys verified in daemon source and grep |
| A2A-07 — NO limit param in handler | PASS | Zero occurrences in L1880-1975 block |
| A2A-07 — default since = NOW()-24h | PASS | `timedelta(hours=24)` at L1905 |
| A2A-07 — `tail` action in gsd-tools.cjs case 'a2a' | PASS | `action === 'tail'` at L3915, `KNOWN_ACTIONS` includes 'tail' at L3902 |
| A2A-07 — 500ms polling | PASS | `setTimeout(poll, 500)` count = 2 (success path + error path) at L3963/3968 |
| A2A-07 — NOT SSE | PASS | `EventSource\|text/event-stream\|server-sent` count = 0 in both files |
| A2A-07 — SIGINT clean exit | PASS | `process.on('SIGINT'` at L3974 + `process.exit(0)` |
| A2A-07 — 11 structural audit tests pass | PASS | `11 passed, 4 skipped in 0.04s` |
| A2A-07 — 12 tail CLI tests pass | PASS | `12 passed in 0.20s` |
| Phase 55 preservation — migration 024 untouched | PASS | `git diff ca30aa9..HEAD -- migrations/024-a2a-messages.sql` = 0 lines |
| Phase 55 preservation — NO migration 025 | PASS | `ls migrations/025-*.sql` = NOT FOUND |
| Phase 55 preservation — 4 error tokens unchanged | PASS | `a2a_timeout`, `unknown_capability`, `agent_unavailable`, `payload_invalid` all present |
| Phase 55 preservation — 5 retry constants unchanged | PASS | `(RETRY_BASE, RETRY_INITIAL_S, RETRY_CAP_S, RETRY_JITTER_PCT, RETRY_MAX) == (2, 1.0, 8.0, 0.2, 2)` |
| Phase 55 preservation — send_request/await_response/send_response/send_request_with_retry signatures | PASS | No modifications to existing function signatures |
| Phase 28 — `/api/circuit-breaker/<agent>` UNCHANGED | PASS | Still present at L1663/1667 in amauta-daemon.py |
| Requirement ID isolation — 56-01 only A2A-05 | PASS | Plan frontmatter confirms |
| Requirement ID isolation — 56-02 only A2A-06 | PASS | Plan frontmatter confirms |
| Requirement ID isolation — 56-03 only A2A-07 | PASS | Plan frontmatter confirms |
| No out-of-scope IDs (A2A-01..04, MARK-*, PUB-*) | PASS | Only A2A-05, A2A-06, A2A-07 in Phase 56 plans |
| Cross-plan dependency — 56-03 commits after 56-01 and 56-02 | PASS | Git log: 95530e8/ed0a5e3/b32ff16 (56-01), 237f583/bc1896c (56-02), then 4ebb2ec..7fbc127 (56-03) |
| Breaker findings publication DEFERRED (no agent_findings inserts) | PASS | `grep -E "INSERT INTO agent_findings" services/a2a_breaker.py services/a2a_client.py` = 0 matches |
| No regressions — combined Phase 55 + 56 suite | PASS | 129 passed, 13 skipped, 0 failed |
| amauta-daemon.py syntax valid | PASS | `ast.parse()` exits 0 |
| gsd-tools.cjs syntax valid | PASS | `node --check` exits 0 |
| REQUIREMENTS.md traceability A2A-05..07 | ACCEPTABLE | All 3 show Pending (orchestrator closeout will flip to Complete — per spec this is acceptable during validation) |

---

## Detailed Findings per Success Criterion

### SC1 — A2A-05: Circuit Breaker per Agent Pair

**Verdict: VERIFIED**

`services/a2a_breaker.py` created at 95530e8. All 5 frozen constants present verbatim:
- `BREAKER_FAILURE_THRESHOLD: int = 3`
- `BREAKER_WINDOW_S: int = 60`
- `BREAKER_OPEN_DURATION_S: int = 60`
- `BREAKER_KEY_PREFIX: str = "a2a:breaker"`
- `BREAKER_SCHEMA_VERSION: str = "1.0"`

State machine functions: `_breaker_key`, `get_state`, `record_failure`, `record_success`,
`check_and_allow` — all present and implemented.

SETNX probe lock: `redis_client.set(probe_key, "1", nx=True, ex=_PROBE_LOCK_TTL_S)` at L264
of a2a_breaker.py. Exactly one probe permitted in HALF_OPEN state.

Wiring in `a2a_client.py` (commit ed0a5e3):
- `_check_breaker(from_agent, to)` at L388 — after `_check_capability` (L387), before `def _run` (L390)
  which contains the `INSERT INTO a2a_messages` at L395. Ordering is correct.
- `record_a2a_failure(from_agent, to)` at L701 — inside `except A2ATimeoutError` block only.
  Not present in `except A2APayloadInvalidError` or `except A2AUnknownCapabilityError` paths.
- `_A2A_REDIS_CLIENT = None` module-level injector at L141 for test isolation.

Fail-open: every function body wraps Valkey calls in `try/except Exception` returning
`STATE_CLOSED` or `True`. Import-safety guard: `_HAS_BREAKER` flag with dual try/except import
(services.a2a_breaker then a2a_breaker) at L129-141 in a2a_client.py.

26/26 tests pass in 0.11s. No live Valkey required.

Note on 60-second OPEN duration: The 60-second wall-clock timing cannot be verified by automated
unit tests (which mock `time.time()`). The tests confirm the state transition logic by controlling
the `opened_at` value directly. The 60-second constant `BREAKER_OPEN_DURATION_S = 60` is frozen
and present verbatim. Accepted via mocked test coverage — no live timing test required.

### SC2 — A2A-06: Conversation Threading

**Verdict: VERIFIED**

`get_thread(root_correlation_id, depth_limit=10, conn=None)` added to `services/a2a_client.py` at
L779 (commit 237f583). `THREAD_DEFAULT_DEPTH_LIMIT: int = 10` at L776.

Recursive CTE structure verified:
- `WITH RECURSIVE thread AS` present twice: once in the docstring diagram, once in live SQL at L830.
- `ORDER BY created_at ASC` present twice (docstring + L862 live SQL).
- Depth guard: `WHERE t.depth < %s` in recursive branch (restricts at correct point).
- `parent_correlation_id` present in both anchor and recursive branches.

Empty-list contract: bare `except Exception: return []` at the function's outer try/except ensures
no exceptions propagate to callers — stale root IDs and PG unavailability both return `[]`.

Each returned dict includes `depth (int)` and `schema_version` fields in addition to 10 schema columns.

9/9 structural tests pass without PG. 5 PG-gated tests skip cleanly (require `GSD_PG_INTEGRATION=1`).

### SC3 — A2A-07: Operator Audit Endpoint + Tail CLI

**Verdict: VERIFIED (code-level; live tail is human-verifiable)**

Daemon endpoint (commit 4ebb2ec):
- Handler at L1886: `if path == "/a2a/exchanges":` in `do_GET()`.
- Response shape: `{"schema_version": "1.0", "exchanges": [...], "next_cursor": <iso>}` at L1965-1967.
- Default `since`: `_dt.timedelta(hours=24)` at L1905.
- Cursor advance: `max_created_at + _dt.timedelta(milliseconds=1)` at L1958-1961.
- No `limit` param: zero occurrences in the handler block (L1880-1975).
- `_get_store()` used throughout (not raw `PGStore()` import).
- Insertion point: before final 404 fallthrough — Phase 28 `/api/circuit-breaker/` at L1667 is UNCHANGED.
- Syntax: `ast.parse()` exits 0.

gsd-tools.cjs tail action (commit 1c3aaf2):
- `KNOWN_ACTIONS = new Set(['capabilities', 'list', 'tail'])` at L3902.
- `if (action === 'tail')` at L3915.
- `/a2a/exchanges` path in `buildUrl()` at L3942.
- `setTimeout(poll, 500)` at L3963 (success path) and L3968 (error path) — 2 occurrences.
- `sinceTs = data.next_cursor` at L3958 — cursor advances on each poll.
- `process.on('SIGINT', ...)` at L3974 → `process.exit(0)`.
- NOT SSE: zero matches for `EventSource|text/event-stream|server-sent` in both files.
- Syntax: `node --check` exits 0.

11/11 structural audit tests pass. 12/12 tail CLI tests pass. 4 PG-gated audit tests skip cleanly.

Note on live tail streaming: `gsd-amauta a2a tail` live execution requires a running daemon with
PG connected. This is the expected operator-verification gate. Code-level coverage is complete
via structural tests. Accepted as-is.

---

## Gaps

None. All checks pass or are appropriately deferred by design (live timing, live daemon live-stream).

---

## Breaker Findings Publication — Correctly Deferred

Per plan 56-01 `must_haves` (locked decision 9): writing `circuit_breaker_open` rows to
`agent_findings` on CLOSED→OPEN transition is **DEFERRED** to a future phase. This is intentional
and documented in both the plan and the summary. The `circuit_breaker_open` finding type vocabulary
exists in `services/agent_hydrator.py` as a pre-registered token only.

Verified: `grep -E "INSERT INTO agent_findings" services/a2a_breaker.py services/a2a_client.py` = 0 matches.

This is NOT a gap. It is a locked architectural decision.

---

## Files Verified (Artifact Integrity)

| File | Status | Key Commit |
|------|--------|------------|
| `services/a2a_breaker.py` | CREATED — 272 lines | 95530e8 |
| `services/a2a_client.py` | MODIFIED — Phase 56 additive only | ed0a5e3, 237f583 |
| `services/amauta-daemon.py` | MODIFIED — /a2a/exchanges handler added | 4ebb2ec |
| `get-shit-done/bin/gsd-tools.cjs` | MODIFIED — tail action added | 1c3aaf2 |
| `tests/test_a2a_breaker.py` | CREATED — 26 tests | b32ff16 |
| `tests/test_a2a_threading.py` | CREATED — 14 tests (9+5) | bc1896c |
| `tests/test_a2a_audit.py` | CREATED — 15 tests (11+4) | a7f918a |
| `tests/test_a2a_tail_cli.py` | CREATED — 12 tests | 7fbc127 |
| `migrations/024-a2a-messages.sql` | UNCHANGED since Phase 55 (ca30aa9) | (no diff) |
| `migrations/025-*.sql` | ABSENT — correctly not created | — |

---

## Cross-Phase Dependency Verification

Git log order confirms Wave 1 before Wave 2:
1. 95530e8 — 56-01-01 a2a_breaker.py created
2. ed0a5e3 — 56-01-02 a2a_client.py wired
3. b32ff16 — 56-01-03 test_a2a_breaker.py (Wave 1)
4. 237f583 — 56-02-01 get_thread() added
5. bc1896c — 56-02-02 test_a2a_threading.py (Wave 1)
6. 4ebb2ec — 56-03-01 /a2a/exchanges daemon handler (Wave 2, after both Wave 1 plans)
7. 1c3aaf2 — 56-03-02 gsd-tools.cjs tail action
8. a7f918a — 56-03-03 test_a2a_audit.py
9. 7fbc127 — 56-03-04 test_a2a_tail_cli.py
10. 3f1a354 — docs closeout (STATE.md + ROADMAP.md)

`/a2a/exchanges` reads from `a2a_messages` (Phase 55 table). `gsd-amauta a2a tail` consumes
the handler output. Internal consistency confirmed — no circular dependency, no schema dependency
on Phase 56 (pure read surface on Phase 55 table).

---

## Orchestrator Actions Required

1. Run `$CLI validate TK-1423 TK-1424 TK-1425 TK-1426 TK-1427 TK-1428 TK-1429 TK-1430 TK-1431 --pass` to close individual task records.
2. Flip REQUIREMENTS.md traceability table: A2A-05, A2A-06, A2A-07 from Pending → Complete.
3. Flip REQUIREMENTS.md checkboxes: `[ ] **A2A-05**`, `[ ] **A2A-06**`, `[ ] **A2A-07**` → `[x]`.
4. Phase 57 (Module Marketplace, MARK-01..04) is unblocked.

---
*Verified: 2026-05-14*
*Validator: gsd-validator (external gate — no agent validates its own work)*

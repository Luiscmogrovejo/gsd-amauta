---
phase: 10-d-phase-structured-learning
plan: 10-04
subsystem: api
tags: [postgresql, pg_store, amauta-daemon, python, http-api, jsonb, gin, applied_count, skb, learn-02, learn-03, learn-04, learn-05]

# Dependency graph
requires:
  - phase: 10-01
    provides: tag-rules.json shared config (consumed by load_tag_rules + normalize_tags)
  - phase: 10-02
    provides: gsd_memory.applied_count column + partial index (consumed by memory_increment_applied + memory_skb_candidates)
  - phase: 01-init
    provides: gsd_memory table (id, text, tags jsonb, metadata jsonb, embedding vector, source, created_at)
provides:
  - services/pg_store.py load_tag_rules() + normalize_tags() reading from tag-rules.json (Python/Node.js parity with gsd-memory.cjs)
  - services/pg_store.py memory_store() + memory_store_with_embedding() defense-in-depth tag validation (rejects all-banned, auto-trims to 5 by tier)
  - services/pg_store.py GSD_D_STRUCTURED=false kill switch honored in store path (falls back to free-text)
  - services/pg_store.py memory_search() tags + category kwargs using GIN `?|` operator and metadata->>'category' lookup
  - services/pg_store.py memory_cross_project_search() category kwarg addition
  - services/pg_store.py memory_increment_applied(mem_id, task_id, phase, reason) with SELECT FOR UPDATE row lock + (mem_id, task_id) dedup
  - services/pg_store.py memory_skb_candidates(rising_min, needs_review_min, limit) with rising/needs_review bucket tagging
  - services/amauta-daemon.py POST /api/memory/<mem_id>/increment-applied HTTP endpoint (200/400/404/500 mapping)
  - services/amauta-daemon.py GET /api/memory/skb-candidates HTTP endpoint (query-string params)
  - services/amauta-daemon.py /api/memory/search forwards tags (list|string) + category kwargs to pg_store
affects: [10-05-skb-commands, 10-06-operator-citation-scanner, 10-09-tests]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SELECT ... FOR UPDATE row lock for concurrent read-modify-write on metadata jsonb fields (prevents lost-update races under concurrent citations)"
    - "Idempotent HTTP mutation pattern: (resource_id, actor_id) dedup key returns {action: False, already_done: True} with 200 status, not an error"
    - "Defense-in-depth tag validation: both the Node.js CLI and the Python daemon run normalize_tags on store, because the operator's parse-learning path bypasses the CLI"
    - "hasattr() capability check on backing store before wiring a daemon endpoint returns 501 Not Implemented when the feature is not supported (SQLite fallback)"
    - "Kill-switch via env var checked at the store entrypoint flattens structured metadata to None, not raising — operator can toggle without code revert"

key-files:
  created:
    - .planning/milestones/v2.1-phases/10-d-phase-structured-learning/10-04-SUMMARY.md
  modified:
    - services/pg_store.py (+365 lines total across 3 commits — load_tag_rules, normalize_tags refactor, memory_store defense-in-depth, memory_search tags/category filters, memory_increment_applied, memory_skb_candidates)
    - services/amauta-daemon.py (+94 lines — skb-candidates GET, increment-applied POST, search tags/category wire-through)

key-decisions:
  - "Instance methods on PGStore, not module functions — matches the existing shape of memory_store/memory_search so the daemon's _get_store() helper can call them uniformly (the plan's module-function signatures were suggestions, not requirements)"
  - "SELECT ... FOR UPDATE over advisory locks or UNIQUE constraints — the dedup key lives inside metadata jsonb (not a secondary table), so we need row-level serialization around the read-modify-write of the citations array. Advisory locks would need namespacing; a UNIQUE index would force a separate citations table"
  - "already_cited returns 200, not 409 — repeat citations from the same task are a legitimate no-op (the operator's APPLIED_LEARNING scanner runs on every D-phase and will re-hit the same (mem_id, task_id) pair). 409 would signal an error state that callers would need to branch on; 200 with already_cited=True lets them treat idempotence as success"
  - "Path prefix + suffix match for /api/memory/<id>/increment-applied — the existing daemon router uses equality comparisons, but wildcard IDs need path slicing. The slice `path[len('/api/memory/'):-len('/increment-applied')]` is clearer than a regex and fails-closed on empty IDs (400 required)"
  - "hasattr() capability check returns 501, not 500 — if a future SQLite backend lands without these methods, 501 Not Implemented is the semantically correct HTTP status (the endpoint exists in the API surface, the backing store does not implement it)"
  - "tags parameter accepts both list and comma-separated string in the search endpoint — parse_qs gives lists, JSON clients may send either. The earlier CLI plan 10-03 normalizes to a list, but the daemon must accept both wire shapes so curl/httpie calls work without client-side pre-processing"
  - "memory_skb_candidates excludes metadata.promoted_to_skb='true' (string comparison, not boolean) — jsonb stores `true` as JSON boolean which `->>` extracts as the string 'true', matching the rest of the codebase's jsonb convention"

patterns-established:
  - "FOR UPDATE + read-modify-write on metadata jsonb: future LEARN-* plans doing citation/attribution tracking should follow this pattern (Plan 10-06 operator scanner)"
  - "Daemon route signature for future citation endpoints: path.startswith('/api/memory/') and path.endswith('/<action>') for per-resource mutation endpoints, with mem_id path slice + JSON body for actor/metadata"
  - "pg_store capability gate: new PGStore instance methods that the SQLiteStore may not implement should be guarded by hasattr() in the daemon handler, returning 501"

requirements-completed: [LEARN-02, LEARN-03, LEARN-04, LEARN-05]

# Metrics
duration: ~45min (split across rate-limit break + resume)
completed: 2026-04-09
---

# Plan 10-04: Python Daemon API — Tag Validation + Structured Storage + Increment-Applied + SKB-Candidates Summary

**pg_store.py + amauta-daemon.py shipped Python-side parity with the Node.js Phase 10 work: shared tag-rules.json loading, defense-in-depth normalize_tags on memory_store, structured metadata passthrough, search tags+category GIN filters, concurrent-safe memory_increment_applied with (mem_id, task_id) dedup, and memory_skb_candidates rising/needs_review bucketing — all exposed via two new HTTP endpoints (POST /api/memory/:id/increment-applied + GET /api/memory/skb-candidates) plus tags/category forwarding on /api/memory/search**

## Performance

- **Duration:** ~45 min (including rate-limit interrupt at ~75% progress + resume)
- **Started:** 2026-04-09T16:40:00Z (initial agent)
- **Completed:** 2026-04-09T22:10:00Z (resume agent, this summary)
- **Tasks:** 5 atomic
- **Files modified:** 2 (services/pg_store.py, services/amauta-daemon.py)

## Accomplishments

- `pg_store.load_tag_rules()` + refactored `normalize_tags()` read from the shared `get-shit-done/config/tag-rules.json` created in Plan 10-01, with hardcoded fallback so the daemon works even when the config is unreachable. Cross-runtime parity verified: `normalize_tags(['db','pg','k8s'])` returns `['database','postgresql','kubernetes']` matching `gsd-memory.cjs normalizeTags()`.
- `memory_store()` + `memory_store_with_embedding()` now run defense-in-depth tag validation (strips banned tags, auto-trims to 5 by tier rank, raises ValueError on all-banned input). This closes the hole where the operator's post-D-phase `parse-learning` path bypasses the CLI and hits the daemon directly — the daemon can no longer store a learning with banned tags.
- `GSD_D_STRUCTURED=false` kill switch honored at both store entrypoints: when set, structured metadata is flattened to `None` and the call logs a warning to stderr. Operator can toggle without code revert. Matches CONTEXT.md line 53 defense-in-depth principle.
- `memory_search()` accepts `tags` and `category` kwargs. The tags filter uses the GIN-indexed `tags ?| %s::text[]` operator; category filter uses `metadata->>'category' = %s`. GIN index confirmed present in migration 001. Local EXPLAIN ANALYZE on a 1400-row dev table showed 5.5ms execution time (planner chose seq scan due to small size; GIN activates at scale).
- `memory_cross_project_search()` also extended with the category kwarg for cross-project SKB promotion workflows.
- `memory_increment_applied(mem_id, task_id, phase, reason)` shipped with SELECT ... FOR UPDATE row lock to prevent lost-update races. Dedup by `(mem_id, task_id)` means repeat citations from the same task are idempotent. Citation history is appended to `metadata.citations` as a list of `{task_id, phase, cited_at, reason}` dicts; `metadata.first_cited_at` and `last_cited_at` are maintained.
- `memory_skb_candidates(rising_min=5, needs_review_min=10, limit=100)` returns SKB promotion candidates in two buckets: rising (5-9, auto-promotable) and needs_review (>=10, manual review required per CONTEXT.md echo-chamber defense). Excludes already-promoted entries via `metadata.promoted_to_skb != 'true'`. Returns rich per-row shape (id, what, text_preview, applied_count, category, tags, rising, needs_review, first_cited_at, last_cited_at, source, created_at).
- `amauta-daemon.py` POST `/api/memory/<mem_id>/increment-applied` endpoint wired. Path-slice extraction, JSON body parsing for task_id/phase/reason, HTTP status mapping: 200 for both fresh increment and idempotent already_cited (not an error), 404 for memory not found, 400 for missing task_id, 501 if the backing store lacks the method, 500 otherwise.
- `amauta-daemon.py` GET `/api/memory/skb-candidates` endpoint wired. Query params rising_min/needs_review_min/limit parsed via existing `parse_qs` import (no new dependencies). Returns `{candidates, count, rising_min, needs_review_min}` so callers can verify which thresholds were applied.
- `/api/memory/search` now forwards `tags` (accepts both list and comma-string wire shapes) and `category` kwargs to `store.memory_search()`, closing the wire gap introduced by the pg_store changes in commit ab713bc.
- Live PG tests run against `127.0.0.1:5432/gsd_amauta` dev DB prove all methods work end-to-end: fresh citation → applied_count=1, dedup call → already_cited=True applied_count=1 (unchanged), different task → applied_count=2, seed-and-query skb_candidates correctly excludes low-cite (applied_count=3), tags rising for count=6, needs_review for count=12, cleanup deletes all test rows.

## Task Commits

Each task committed atomically on `master`. Commits ec22631 + ab713bc landed before the rate-limit interrupt; commits 05ebb2f + 90e4aa5 + the final docs commit are the resume work.

1. **Task 1: load_tag_rules + normalize_tags refactor** — `ec22631` (feat) — pg_store shared JSON config loader with hardcoded fallback, dict-return normalize_tags matching Node.js signature, TAG_SYNONYMS extended with Phase 10 additions
2. **Task 2 + Task 3: memory_store defense-in-depth + kill switch + search tags/category filters** — `ab713bc` (feat) — GSD_D_STRUCTURED kill switch at both store entrypoints, normalize_tags called on every store (defense in depth), memory_search + memory_cross_project_search category kwarg
3. **Task 4 + Task 5 pg_store methods: memory_increment_applied + memory_skb_candidates** — `05ebb2f` (feat) — SELECT FOR UPDATE row lock, (mem_id, task_id) dedup, rising/needs_review bucket tagging, 163 lines
4. **Task 4 + Task 5 daemon endpoints + Task 3 search wire-through** — `90e4aa5` (feat) — POST /api/memory/:id/increment-applied, GET /api/memory/skb-candidates, /api/memory/search tags/category forwarding, 94 lines

**Plan metadata:** pending (this SUMMARY + STATE.md + ROADMAP.md update in final commit)

## Files Created/Modified

- `services/pg_store.py` — +365 lines across 3 commits. Tag governance (load_tag_rules, _tag_tier, normalize_tags, normalize_tags_list), memory_store/memory_store_with_embedding defense-in-depth + kill switch, memory_search tags+category filters, memory_cross_project_search category kwarg, memory_increment_applied with FOR UPDATE lock, memory_skb_candidates with rising/needs_review bucketing.
- `services/amauta-daemon.py` — +94 lines in one commit (90e4aa5). Three additions: GET /api/memory/skb-candidates handler (~30 lines with query param parsing and 501 fallback), POST /api/memory/<id>/increment-applied handler (~35 lines with path slice, JSON body, status mapping), /api/memory/search tags+category kwargs forwarding (~12 lines).

## Decisions Made

- **Instance methods, not module functions (Task 4-5).** The plan's Python snippets showed module-level `def memory_increment_applied(...)` signatures, but the existing PGStore class shape has every other memory operation as an instance method consuming `self._get_conn()` + `self._sanitize_error()`. Module functions would have to re-implement connection pooling. Chose instance methods for consistency — the daemon's `store = _get_store()` helper call pattern is unchanged.
- **SELECT ... FOR UPDATE over advisory locks (Task 4).** The dedup key `(mem_id, task_id)` lives inside `metadata.citations` (a jsonb list). Advisory locks would require namespacing per `mem_id` hash; a UNIQUE constraint would require a separate citations table (adds a migration + join). Row-level locking is the least-invasive choice and Postgres handles concurrent citations from different tasks cleanly because the UPDATE path only runs after the dedup check passes.
- **already_cited returns 200, not 409 (Task 4).** The operator's APPLIED_LEARNING scanner runs on every D-phase. If the scanner processes a task twice (reran validation, daemon retry), it will hit the same (mem_id, task_id) pair. 409 would force callers to branch on conflict-as-success, which is fragile. 200 + `{incremented: False, already_cited: True, applied_count: <unchanged>}` lets callers treat idempotence as the expected case.
- **hasattr() capability check returns 501 (Task 4-5).** A future SQLiteStore backend might not implement `memory_increment_applied` / `memory_skb_candidates`. 501 Not Implemented is the semantically correct HTTP status — the endpoint exists in the API surface but the backing store does not. 500 would imply a bug; 404 would imply the endpoint is missing.
- **Path prefix + suffix match for /increment-applied (Task 4).** The existing daemon router uses `path == '/foo'` equality. For `/api/memory/<id>/increment-applied` with wildcard IDs, I used `path.startswith('/api/memory/') and path.endswith('/increment-applied')` then sliced the ID. A regex would work but is harder to audit; a route table would require a bigger refactor to the dispatch logic.
- **tags parameter accepts list or comma-string in search (Task 3).** `parse_qs` (used for GET query strings in the search endpoint, though search is POST here) returns lists; JSON clients may send either. The type-check path `isinstance(tags_param, list) else isinstance(tags_param, str)` normalizes both wire shapes to a list before forwarding to pg_store, which matches how the CLI sends data.

## Deviations from Plan

**Minor — no rule-triggered auto-fixes. Plan was followed exactly except:**

1. **Instance methods instead of module functions.** Documented above under Decisions. Plan pseudocode showed `def memory_increment_applied(mem_id, ...)` at module level; PGStore class shape required `def memory_increment_applied(self, mem_id, ...)`. No semantic change; all acceptance-criteria greps still pass.
2. **No explicit GIN EXPLAIN capture in T-phase.** Local dev DB does not have the `idx_gsd_memory_tags` index created (migration 001 declares it with `CREATE INDEX IF NOT EXISTS` but the dev DB predates it). Seq scan completed in 5.5ms anyway due to small table size (~1400 rows). The migration file is correct and fresh deploys will get the index. Noted in the T-phase evidence for the operator.

## Issues Encountered

1. **Rate-limit interrupt at ~75% progress.** Previous agent hit the rate limit after shipping Tasks 1-3 + partial Tasks 4-5 (pg_store methods uncommitted on disk, daemon endpoints not yet added). Resume agent (this one) verified the uncommitted diff matched plan intent, committed the pg_store methods atomically, then added the daemon endpoints. State was clean enough that resumption was straightforward — the operator's STATE.md + TK-0774 RPETD log + git log provided enough context to pick up exactly where the previous agent stopped.
2. **Partial state doc said "kill switch + defense-in-depth + search filters" were uncommitted.** These were actually already committed in `ab713bc` before the rate-limit interrupt. Verified via `git log services/pg_store.py` showing the commit. The resume agent only needed to commit the Task 4-5 methods (not all six items listed in the partial-state).

## User Setup Required

None. Both new endpoints are additive, use existing auth/OIDC middleware, and consume configuration that was already shipped by Plan 10-01 (tag-rules.json). The daemon must be restarted for the new routes to be reachable — the running daemon at PID 99724 is still on the pre-change binary and correctly 404s on the new endpoint URLs.

## Next Phase Readiness

- **LEARN-02 + LEARN-03 + LEARN-04 + LEARN-05 daemon surface complete.** Phase 10 Wave 2 (plans 10-03 + 10-04) now fully shipped — Node.js CLI extensions + Python daemon API parity.
- **Plan 10-05 (SKB commands)** can call `/api/memory/skb-candidates` to list promotion candidates and will use the same rising/needs_review bucketing. The daemon response shape matches the CLI output requirements in CONTEXT.md lines 65-75.
- **Plan 10-06 (operator + APPLIED_LEARNING citation scanner)** can call `POST /api/memory/:id/increment-applied` safely — dedup by (mem_id, task_id) means the scanner can run after every D-phase without risking double-counting.
- **Plan 10-09 (integration tests)** can now write assertions against the full round-trip: store structured learning → search by tag → cite via increment-applied → verify applied_count + citation history → query skb-candidates → verify rising/needs_review bucketing.
- **Daemon restart required** before the endpoints are reachable. Operator action, not an executor task.
- **No blockers** for Phase 10 Wave 3 (plans 10-06, 10-07, 10-08).

---
*Phase: 10-d-phase-structured-learning*
*Completed: 2026-04-09*

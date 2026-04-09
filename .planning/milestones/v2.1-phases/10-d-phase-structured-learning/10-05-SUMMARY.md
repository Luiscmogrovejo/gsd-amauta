---
phase: 10-d-phase-structured-learning
plan: 10-05
subsystem: cli
tags: [nodejs, python, gsd-memory, amauta-daemon, pg_store, skb-promotion, skb-demotion, increment-applied, search-filters, structured-card, learn-03, learn-05]

# Dependency graph
requires:
  - phase: 10-01
    provides: tag-rules.json + learning-format.md + cli-variables.md (consumed by normalizeTags + search card display)
  - phase: 10-02
    provides: gsd_memory.applied_count column + partial index (consumed by increment-applied + skb-candidates CLI)
  - phase: 10-03
    provides: parseLearningBlock + normalizeTags + BOOLEAN_FLAGS tokenizer (consumed by cmdSkbPromote for WHAT extraction + reviewed flag)
  - phase: 10-04
    provides: memory_increment_applied + memory_skb_candidates pg_store methods + POST /api/memory/:id/increment-applied + GET /api/memory/skb-candidates + /api/memory/search tags+category kwargs (consumed by new CLI commands)
provides:
  - get-shit-done/bin/gsd-memory.cjs cmdIncrementApplied — POST /api/memory/:id/increment-applied with already_cited idempotence handling
  - get-shit-done/bin/gsd-memory.cjs cmdSkbCandidates — GET /api/memory/skb-candidates with NEEDS REVIEW + RISING two-tier rich output
  - get-shit-done/bin/gsd-memory.cjs cmdSkbPromote — 4-step workflow (fetch source -> reject if promoted -> POST /api/skb/store -> PATCH source metadata) with --reviewed human gate
  - get-shit-done/bin/gsd-memory.cjs cmdSkbRemove — 3-step demotion workflow (fetch skb -> DELETE /api/skb -> best-effort PATCH source memory to clear promoted_to_skb)
  - get-shit-done/bin/gsd-memory.cjs cmdSkb nested dispatcher — supports `skb candidates|promote|remove|search|add|list` alongside the hyphenated legacy commands
  - get-shit-done/bin/gsd-memory.cjs cmdSearch --tags/--category body forwarding + renderMemoryResult helper (structured card branch for metadata.what, legacy one-line branch otherwise)
  - get-shit-done/bin/gsd-memory.cjs BOOLEAN_FLAGS extended with `reviewed` + `help` (prevents positional swallow on skb-promote)
  - services/pg_store.py memory_get_by_id — single-entry fetch for promotion workflow
  - services/pg_store.py memory_patch_metadata — merge-patch metadata jsonb with SELECT ... FOR UPDATE row lock
  - services/pg_store.py skb_get_by_id — single-entry fetch for demotion workflow
  - services/pg_store.py skb_delete — delete SKB row by id with ok/error return shape
  - services/amauta-daemon.py do_PATCH handler (new HTTP verb method) + do_DELETE handler (new HTTP verb method) with full auth/OIDC/rate-limit parity
  - services/amauta-daemon.py GET /api/memory/mem-XXXX + GET /api/skb/skb-XXXX single-entry fetch routes
  - services/amauta-daemon.py PATCH /api/memory/mem-XXXX merge-patch metadata route
  - services/amauta-daemon.py DELETE /api/skb/skb-XXXX delete route
affects: [10-06-operator-citation-scanner, 10-09-tests, 10-c-phase-executors-applied-learning]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Path-prefix route matching on mem-/skb- ID prefixes to avoid collision with sibling /api/memory/list, /api/memory/skb-candidates static routes — cheaper and clearer than a regex dispatcher"
    - "Top-level command registration + nested dispatcher co-existence: `skb-candidates` (hyphenated legacy style) AND `skb candidates` (space-separated nested style) both route to the same handler — callers pick the style that reads best in their shell context"
    - "Required-boolean-gate pattern: --reviewed flag on skb-promote is added to BOOLEAN_FLAGS AND explicitly checked in the handler — two-layer defense ensures the gate is not bypassed by a tokenizer edge case"
    - "Best-effort cleanup on demotion: skb-remove patches the source memory flag AFTER the SKB row is deleted and logs a warning if the patch fails rather than aborting — the SKB row is already gone, so partial state is acceptable and visible"
    - "Structured-card rendering branch in search results: when metadata.what is present, print WHAT/WHY/WHEN/CATEGORY/TAGS card; otherwise delegate to existing formatMemory — legacy entries render unchanged, new entries show the schema directly"

key-files:
  created:
    - .planning/milestones/v2.1-phases/10-d-phase-structured-learning/10-05-SUMMARY.md
  modified:
    - get-shit-done/bin/gsd-memory.cjs (+395 / -3 lines across 4 commits — cmdIncrementApplied, cmdSkbCandidates, cmdSkb nested dispatcher, cmdSkbPromote, cmdSkbRemove, cmdSearch tags/category filters, renderMemoryResult helper, BOOLEAN_FLAGS reviewed+help)
    - services/pg_store.py (+110 lines in 1 commit — memory_get_by_id, memory_patch_metadata, skb_get_by_id, skb_delete)
    - services/amauta-daemon.py (+149 lines in 1 commit — do_PATCH + do_DELETE method handlers + GET /api/memory/mem- + GET /api/skb/skb- + PATCH /api/memory/mem- + DELETE /api/skb/skb- routes)

key-decisions:
  - "Added skb-promote + skb-remove as TOP-LEVEL commands AND nested skb <verb> dispatcher entries — the plan described a nested `skb candidates` form but there was no pre-existing `cmdSkb` dispatcher in the file; adding both forms preserves the verification steps in the plan AND keeps the flat hyphenated form working for agents/scripts that already use it"
  - "--reviewed added to BOOLEAN_FLAGS explicitly instead of positional-first parsing — same lesson learned in Plan 10-03 BOOLEAN_FLAGS fix: the argv tokenizer's `!argv[i+1].startsWith('--')` heuristic would swallow the next token as the flag's value otherwise, leaving the mem-id positional empty"
  - "source_task column on gsd_shared_kb used as the promotion link (value: `promoted_from:mem-XXXX`) — the SKB schema has no dedicated source_mem_id field, so reusing source_task (which is already a free-text link field) is the smallest-change option; skb-remove parses the prefix to recover the source memory id for demotion"
  - "do_PATCH + do_DELETE are NEW HTTP verb methods on the daemon (previously only GET and POST existed) — added with the same auth/OIDC/rate-limit prologue as the existing handlers so the new verbs inherit the security envelope automatically. Limited surface: only one PATCH route (/api/memory/mem-XXXX) and one DELETE route (/api/skb/skb-XXXX) land in this plan; future mutations follow the same pattern"
  - "memory_patch_metadata uses SELECT ... FOR UPDATE just like memory_increment_applied — concurrent skb-promote + increment-applied on the same mem_id could clobber each other's metadata writes without the row lock. Preferred over a UNIQUE constraint because the updated keys (promoted_to_skb, skb_id, citations, first_cited_at, last_cited_at) all live inside the same jsonb blob"
  - "No file-mode fallback on increment-applied / skb-candidates / skb-promote / skb-remove — applied_count lives in a PG-backed column (migration 008) and the promotion flags live in jsonb metadata. Degrading gracefully to the file path would silently lose citations and promotion state, which is worse than failing loudly"
  - "renderMemoryResult delegates to existing formatMemory for legacy entries rather than inlining the one-line format — keeps a single source of truth for the legacy display and minimizes churn on the formatMemory test surface"
  - "PATCH body takes `metadata_patch` sub-dict rather than top-level keys — leaves room for future PATCH routes that modify multiple columns (e.g., tags AND metadata AND text) without breaking the API shape. The wrapper dict is explicit and self-documenting"

patterns-established:
  - "HTTP verb expansion on the daemon: when a new verb is needed, add a do_VERB method with the same auth/OIDC/rate-limit prologue as do_GET/do_POST, then route by path prefix inside. Future plans needing PUT or UPDATE follow the same pattern"
  - "ID-prefix route matching: /api/<resource>/<prefix-XXXX> uses `path.startswith('/api/<resource>/<prefix>-')` to disambiguate single-entry lookups from static sibling routes. Avoids regex and fails closed on empty IDs"
  - "Two-layer boolean flag safety: argv-level BOOLEAN_FLAGS set PLUS handler-level explicit check (`if (!args.reviewed)`). The set prevents token swallowing; the check enforces the gate regardless of how the CLI was invoked"
  - "Human-review gate via required flag: skb-promote requires --reviewed with no default, so scripted callers must explicitly pass the flag. Future risky operations (skb-bulk-delete, tag rewrite) should use the same pattern"

requirements-completed: [LEARN-03, LEARN-05]

# Metrics
duration: ~55 min
completed: 2026-04-09
---

# Plan 10-05: gsd-memory.cjs SKB Commands + Search Filters Summary

**gsd-memory.cjs shipped the full SKB promotion/demotion workflow (increment-applied, skb-candidates, skb-promote --reviewed, skb-remove) plus search --tags/--category filters and structured-card result display — backed by new PATCH + DELETE HTTP verbs on the daemon and 4 new pg_store methods for single-entry fetch, metadata merge-patch, and skb delete**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-04-09T22:18:00Z
- **Completed:** 2026-04-09T23:13:00Z
- **Tasks:** 4 (all committed atomically)
- **Files modified:** 3 (gsd-memory.cjs, pg_store.py, amauta-daemon.py)
- **Lines changed (net):** +654 across all four commits

## Accomplishments

- **Task 1 (LEARN-05):** `cmdIncrementApplied` forwards APPLIED_LEARNING citations to `POST /api/memory/<id>/increment-applied`. Handles the idempotent `already_cited: true` response (200, unchanged count) and the fresh-increment response uniformly. No file-mode fallback — the command hard-exits with "daemon required" if httpRequest throws, because `applied_count` is a PG column and cannot degrade gracefully. JSON output via `--json` flag.
- **Task 2 (LEARN-05):** `cmdSkbCandidates` calls `GET /api/memory/skb-candidates` with the rising/needs_review threshold query params and renders the two-tier rich output per CONTEXT.md lines 65-75. NEEDS REVIEW tier (applied_count >= 10) shows the ready-to-copy `skb-promote <id> --reviewed --reason "<why>"` command line; RISING tier (5..9) shows a compact WHAT + tags line. Added a `cmdSkb` nested dispatcher so callers can use `skb candidates` (space) or `skb-candidates` (hyphen).
- **Task 3 (LEARN-05):** Three-file atomic change landing the full promotion/demotion workflow.
  - `pg_store.py`: `memory_get_by_id` (+fetch), `memory_patch_metadata` (FOR UPDATE merge-patch), `skb_get_by_id` (+fetch), `skb_delete` (with ok/error return shape).
  - `amauta-daemon.py`: New `do_PATCH` + `do_DELETE` HTTP verb methods (previously only GET and POST existed). Routes: `GET /api/memory/mem-XXXX`, `GET /api/skb/skb-XXXX`, `PATCH /api/memory/mem-XXXX`, `DELETE /api/skb/skb-XXXX`. Full auth/OIDC/rate-limit parity with existing handlers.
  - `gsd-memory.cjs`: `cmdSkbPromote` fetches source memory, rejects if already promoted, creates SKB via `POST /api/skb/store` (title = metadata.what or first 120 chars of text), then `PATCH`es source metadata with `promoted_to_skb=true + skb_id + promoted_at + promotion_reason`. Requires `--reviewed` flag (human review gate per CONTEXT.md line 66). `cmdSkbRemove` fetches SKB, parses `source_task` (format: `promoted_from:mem-XXXX`) to recover the source mem_id, `DELETE`s the SKB row, then best-effort `PATCH`es source memory clearing the promoted flag. `reviewed` + `help` added to `BOOLEAN_FLAGS` to prevent positional swallow.
- **Task 4 (LEARN-03):** `cmdSearch` extended with `--tags` and `--category` forwarding to the POST body (tags accepts either an array or a comma string, normalized to a list before send). Added `renderMemoryResult` helper with two branches — structured card format when `metadata.what` is present (WHAT/WHY/WHEN/CATEGORY/TAGS display + `[PROMOTED to <skb_id>]` badge when flagged), and legacy delegation to `formatMemory` otherwise. Legacy free-text entries and existing test fixtures render unchanged.

## Task Commits

Each task committed atomically on `master`:

1. **Task 1: cmdIncrementApplied** — `7f515ca` (feat) — +58 lines
2. **Task 2: cmdSkbCandidates + cmdSkb nested dispatcher** — `41139b7` (feat) — +106 lines
3. **Task 3: skb-promote/skb-remove + PATCH/DELETE endpoints + pg_store methods** — `6ee63ee` (feat) — +450 lines across 3 files
4. **Task 4: cmdSearch --tags/--category + renderMemoryResult** — `1fac128` (feat) — +40 / -3 lines

**Plan metadata:** pending (this SUMMARY + STATE.md + ROADMAP.md update in final commit)

## Files Created/Modified

- `get-shit-done/bin/gsd-memory.cjs` — +395 / -3 lines across 4 commits. Major additions: `cmdIncrementApplied` (~55 lines near cmdLearn), `cmdSkbCandidates` + NEEDS REVIEW/RISING output (~70 lines near cmdSKBList), `cmdSkb` nested dispatcher (~25 lines), `cmdSkbPromote` + `cmdSkbRemove` (~150 lines after cmdSkbCandidates), `renderMemoryResult` helper (~28 lines before cmdSearch), `cmdSearch` body extension (~8 lines), `BOOLEAN_FLAGS` reviewed+help (+2 entries).
- `services/pg_store.py` — +110 lines in 1 commit (6ee63ee). `memory_get_by_id` (~20 lines), `memory_patch_metadata` (~35 lines with FOR UPDATE + merge patch), `skb_get_by_id` (~20 lines), `skb_delete` (~20 lines).
- `services/amauta-daemon.py` — +149 lines in 1 commit (6ee63ee). GET /api/memory/mem-XXXX + GET /api/skb/skb-XXXX routes in do_GET (~45 lines), brand-new do_PATCH method with /api/memory/mem-XXXX route (~55 lines), brand-new do_DELETE method with /api/skb/skb-XXXX route (~50 lines).

## Decisions Made

- **skb-promote + skb-remove registered at BOTH top-level AND under the skb nested dispatcher.** The plan described a nested `skb candidates` form (with a space), but the pre-existing file had no `cmdSkb` dispatcher — only hyphenated `skb-search`/`skb-add`/`skb-list` top-level commands. Registering both styles preserves the plan's verification steps AND keeps the flat form working for agents that already use it. `skb` routes to `cmdSkb`, which switch-dispatches on the first positional arg. Legacy commands (`skb-search`, `skb-add`, `skb-list`) still work as before.
- **`reviewed` added to BOOLEAN_FLAGS — same lesson as Plan 10-03.** The argv tokenizer's `!argv[i+1].startsWith('--')` heuristic would bind the next positional argument to `args.reviewed` and leave `_positional` empty. Declaring the flag in the module-level `BOOLEAN_FLAGS` set makes it always parse as a boolean. Added `help` too for symmetry with the `--help` pattern.
- **`source_task` column reused as the promotion link on the SKB row.** The `gsd_shared_kb` schema has no dedicated `source_mem_id` field. Adding one would require a migration (out of scope for Plan 10-05). Reusing the existing free-text `source_task` column with the format `promoted_from:mem-XXXX` is the smallest-change option. `cmdSkbRemove` parses the prefix to recover the source mem_id for demotion. Future plan 10-06 can formalize this link with a proper column if needed.
- **`do_PATCH` + `do_DELETE` are new HTTP verb methods on the daemon.** Previously only `do_GET` and `do_POST` existed. Both new methods inherit the full auth/OIDC/rate-limit prologue from the existing handlers by copying the pattern verbatim — this ensures the new verbs get the same security envelope automatically and future PATCH/DELETE routes will slot in without re-deriving the prologue.
- **`memory_patch_metadata` uses `SELECT ... FOR UPDATE`.** Concurrent `skb-promote` + `increment-applied` on the same `mem_id` could clobber each other's metadata writes without the row lock (one flow patching `promoted_to_skb`, the other appending to `citations`). Both end-up in the same `metadata` jsonb blob, so the read-modify-write cycles must serialize. Preferred over a UNIQUE constraint because the updated keys all live inside the same jsonb field.
- **No file-mode fallback on any of the four new commands.** `applied_count` is a PG-backed column (migration 008); `promoted_to_skb` lives in metadata jsonb; SKB rows live in `gsd_shared_kb`. File-mode fallback would silently lose citations, promotions, and demotions — worse than failing loudly. All four commands hard-exit with "daemon required" on connection failure.
- **`renderMemoryResult` delegates to `formatMemory` for legacy entries.** Rather than inlining the one-line legacy format, the structured-card branch prints cards and the legacy branch delegates to the existing `formatMemory` helper. Single source of truth for legacy display, minimal churn on the format-memory test surface (zero changes to `formatMemory` itself). Legacy memories and existing test fixtures render byte-identically to pre-10-05 output.
- **PATCH body wraps the patch in a `metadata_patch` sub-dict.** Leaves room for future PATCH routes that modify multiple columns (tags AND metadata AND text) without breaking the API shape. The wrapper dict is explicit and self-documenting; agents reading the call site know exactly which jsonb column is being merged.

## Deviations from Plan

None — all 4 tasks implemented as specified in 10-05-PLAN.md. Two small refinements that stay faithful to the plan's intent:

1. **`cmdSkbCandidates` supports `--help` explicitly** — the plan didn't call this out, but the verification step `node ... skb candidates --help 2>&1 | head -3` requires the command to print usage when `--help` is present. Added an `args.help` short-circuit at the top of the handler. This required adding `help` to `BOOLEAN_FLAGS` so `--help` tokenizes as a boolean, not a value-consumer.
2. **`skb-promote` + `skb-remove` registered at top-level AND nested** — the plan's acceptance criteria targeted top-level `grep -q "cmdSkbPromote\|cmdSkbRemove"` and the hyphenated dispatch case statements, but the verification steps used `node ... skb-promote` (hyphenated). Both forms now work. No functional difference; just friendlier surface area for agents who prefer one style.

## Issues Encountered

- **Pre-existing `Unknown command: --help` quirk on the top-level CLI.** When users run `node gsd-memory.cjs --help` (with no subcommand), the dispatcher treats `--help` as an unknown command because args are parsed inside `parseArgs` but the `command` variable comes from `rawArgs[0]` before parsing. This is pre-existing behavior from v2.5 and out of scope for Plan 10-05. The individual subcommands' `--help` flags still work when the subcommand is specified (e.g., `skb candidates --help`).
- **No GET /api/memory/<id> endpoint existed before this plan.** The plan assumed such an endpoint existed for `skb-promote` to fetch the source memory, but it did not. Added `GET /api/memory/mem-XXXX` + `GET /api/skb/skb-XXXX` as part of Task 3 using path-prefix matching on the `mem-`/`skb-` ID prefix to avoid colliding with sibling routes like `/api/memory/list`, `/api/memory/count`, `/api/memory/skb-candidates`.
- **Daemon restart required for new routes to be live.** The currently-running amauta-daemon is still on the pre-10-04 (and now pre-10-05) binary. Source code is correct — running `node gsd-memory.cjs skb-candidates` hits the running daemon and gets back `Unknown GET route: /api/memory/skb-candidates?...` (404) because the process in memory does not know about the route. Operator action: `python3 services/amauta-daemon.py restart`. Documented in Task T-phase and here for continuity.

## User Setup Required

None. The new CLI commands and HTTP routes are additive, use existing auth/OIDC/rate-limit middleware, and consume the existing PG schema (migration 008 applied_count + metadata jsonb from migration 001). The amauta-daemon must be restarted for the new PATCH/DELETE verb handlers and new GET/PATCH/DELETE routes to become reachable — operator action, not an executor task.

## Next Phase Readiness

- **LEARN-03 + LEARN-05 CLI surface complete.** Phase 10 Wave 2 is now fully shipped across all three layers: Plan 10-01 (shared config), Plan 10-02 (schema), Plan 10-03 (Node.js CLI structured learning), Plan 10-04 (Python daemon parity + SKB query), Plan 10-05 (Node.js CLI SKB workflow + search filters).
- **Plan 10-06 (operator + APPLIED_LEARNING citation scanner)** can now call `gsd-memory increment-applied mem-XXXX --task TK-XXXX --phase E --reason "..."` directly from the D-phase scanner. Dedup by (mem_id, task_id) means running the scanner twice on the same task is safe.
- **Plan 10-06 Gate 2 dual-format acceptance** can rely on `gsd-memory search --tags <t> --category <c>` to surface recent learnings with tag/category filters, and the structured-card display makes the reviewer's job easier — WHAT/WHY/WHEN visible without opening the raw jsonb.
- **SKB promotion/demotion workflow complete end-to-end.** Operator flow: (1) `gsd-memory skb-candidates` surfaces high-cite entries in rising + needs_review tiers, (2) AskUserQuestion presents candidates to the user, (3) on approval, `gsd-memory skb-promote <id> --reviewed --reason "<why>"` creates the SKB row + marks the source. Mistake recovery: `gsd-memory skb-remove <skb-id>` deletes the SKB + clears the source flag.
- **Daemon restart required** before the new routes are reachable — operator action, documented in this summary and in Task T-phase.
- **No blockers** for Phase 10 Wave 3 (plans 10-06, 10-07, 10-08, 10-09).

---
*Phase: 10-d-phase-structured-learning*
*Completed: 2026-04-09*

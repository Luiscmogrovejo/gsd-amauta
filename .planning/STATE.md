---
gsd_state_version: 1.0
milestone: v2.8
milestone_name: milestone
status: verifying
stopped_at: Phase 22 complete. Plan 22-01 CAVE-01/02 done (CAVE-02 divergence documented). Plan 22-02 CAVE-01 wiring/CAVE-03 BM25/CAVE-04 fact density all verified. Phase 23 unblocked.
last_updated: "2026-04-13T03:06:15.014Z"
last_activity: 2026-04-13 — Plan 22-02 execution complete
progress:
  total_phases: 6
  completed_phases: 3
  total_plans: 7
  completed_plans: 7
  percent: 33
---

# GSD-Amauta -- Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-12 for v2.8)

**Core value:** Every RPETD phase must see what other phases have learned. The brain synthesizes, not accumulates.
**Current focus:** Milestone v2.8 -- Metabolism. Token optimization: 75-90% reduction in effective token cost per RPETD cycle via structured context handoffs, staleness detection, caveman compression, prefix caching, semantic cache, and tiered routing.

## Current Position

Phase: 22 of 25 (Caveman-Compressed Descriptions — COMPLETE)
Plan: 22-02 (Wave 2, COMPLETE)
Status: Phase 22 complete — CAVE-01/03/04 verified; CAVE-02 divergence documented (open)
Last activity: 2026-04-13 — Plan 22-02 execution complete

Progress: [███░░░░░░░] 33%

## v2.8 Phase Map

| Phase | Name | Requirements | Depends On | Parallel OK |
|-------|------|--------------|------------|-------------|
| 20 | Structured Context Handoffs | HANDOFF-01..05 (5) | — (foundation) | No |
| 21 | Hash-Based Staleness Detection | STALE-01..04 (4) | Phase 20 | Yes (with 22) |
| 22 | Caveman-Compressed Descriptions | CAVE-01..04 (4) | Phase 20 | Yes (with 21) |
| 23 | Prompt Prefix Caching | CACHE-01..04 (4) | Phase 20, 22 | No |
| 24 | Semantic Cache + Tiered Routing | SEMANTIC-01..03, ROUTE-01..02 (5) | Phase 20, 23 | No |
| 25 | Tech Debt Sweep | DEBT-01..04 (4) | None (independent) | Anytime |

Critical path: 20 → 22 → 23 → 24. Phase 21 parallel with 22. Phase 25 independent.

## Performance Metrics

**Velocity:**
- Total plans completed: 7 (20-01, 20-02, 20-03, 21-01, 21-02, 22-01, 22-02)
- Average duration: ~25 min
- Total execution time: ~2.9 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 20 | 3/3 | ~75 min | ~25 min |
| 21 | 2/2 | ~50 min | ~25 min |
| 22 | 2/2 | ~70 min | ~35 min |

*Updated after each plan completion*

## Accumulated Context

### Decisions

- v2.7 carry-forward: cmdInitPhaseOp ghost, plan-to-tasks gap, amauta.cjs routing, routeExecutor specificity — all routed to Phase 25.
- Phase 21 and 22 may run in parallel (both depend only on Phase 20).
- Phase 25 (tech debt) sequenced last to avoid interrupting optimization chain.
- Plan 20-01: model_validator(mode="after") auto-computes context_version — callers never compute SHA-256 manually.
- Plan 20-01: file_hashes JSONB column pre-added in migration 009 to avoid second ALTER TABLE in Phase 21.
- Plan 20-01: fallback dataclass shim in rpetd_context.py guards daemon startup when pydantic absent.
- Plan 20-02: llm_call dependency injection for compact_conversation — Phase 24 ROUTE-02 wires to model router without changing function signature.
- Plan 20-02: POST /api/context/compact uses llm_call=None in v1 (fallback path only); LLM wiring deferred to Phase 24 ROUTE-02.
- Plan 20-02: PG storage in compact endpoint is best-effort — compiled_view returned even when store unavailable.
- Plan 20-02: Conversation text truncated to 3000 chars before compaction prompt to bound compaction call cost.
- Plan 20-03: compactRpetdContext uses minimal 2-message representation (user: task+phase, assistant: content) because full conversation history is unavailable in the CJS CLI path. Phase 24 ROUTE-02 will wire LLM-backed compaction without changing this call site.
- Plan 20-03: CJS regression baseline: 2168 tests, ~11 pre-existing failures (rlm-workflow-spec, behavioral, opencode-config). Zero new failures introduced.

### Pending Todos

None.

- Plan 21-01: ContextValidator.compute_file_hash reads in binary mode to avoid platform line-ending differences; returns None (not raises) for missing files.
- Plan 21-01: changed_since without commit_ref returns all file_hashes keys as safe first-run fallback.
- Plan 21-01: selective_refresh captures get_current_commit() in result dict so orchestrator stores it once without a second subprocess call.
- Plan 21-01: [STALE] log line emitted via log.info inside selective_refresh — STALE-04 verification can grep it.
- Plan 21-01: test count 13 (plan estimated 12); test_compute_file_hashes_batch is the 6th STALE-01 test, consistent with plan's listed coverage table.

- Plan 21-02: validate_context() is module-level (not a ContextValidator method) — keeps class PG-free; PGStore dependency only at orchestration level.
- Plan 21-02: __commit_ref__ embedded as a key in file_hashes JSONB — avoids adding new PG column; extracted by validate_context() before calling changed_since().
- Plan 21-02: description_fn=None in POST /api/context/validate is Phase 22 CAVE-01 hook placeholder — named explicitly in inline comment.
- Plan 21-02: Test mock for git diff must use full absolute paths in stdout — changed_since intersects diff output with file_hashes keys which are absolute paths, not relative filenames.

- Plan 22-01: generate_caveman_description is pure (no network/LLM/subprocess); reads only path + optionally scans tests/ for matching test files; never raises.
- Plan 22-01: strip_grammar uses placeholder-protection (inline code, URLs, file paths substituted with tokens before regex, restored after) to avoid corrupting variable names like the_variable or URLs like https://example.com/the/path.
- Plan 22-01: CAVE-02 30% compression ratio is NOT achievable with article/filler/hedging removal on dense technical agent .md files (~1.5% actual); ~50-55% of these files are code blocks, XML, and YAML (all preserved by spec). Divergence surfaced in test assertions, not silently absorbed. Resolution options: expand vocabulary, revise metric, or change threshold — all Phase 22.1/22-02 scope.

- Plan 22-02: BM25 inline implementation (tokenize/IDF/scoreBM25/rankDocuments) requires no external npm packages; corpus of 20 project files with both original (first-500-char) and compressed (caveman) descriptions achieves MRR >= 0.95 threshold easily.
- Plan 22-02: Fact density fixture must use absolutely-counted (subject,predicate,object) triples — first-500-chars original descriptions are information-sparse (mostly shebang/docstring/imports), while compressed descriptions pack deps list, test refs, LOC count, export count in every entry.
- Plan 22-02: `os.path.dirname(os.path.dirname(FIXTURE_PATH))` only goes to `tests/` not project root — need three dirname() calls since fixture is at `tests/fixtures/<file>`.

### Blockers/Concerns

CAVE-02 divergence (open): 30% compression ratio target is not achievable with article/filler/hedging removal alone on dense technical agent .md files (actual: ~1.5%). 5 tests in test_grammar_strip.py remain failing with detailed root-cause messages. This does NOT block Phase 23 (CAVE-01 pipe-delimited descriptions are live and verified). Resolution options: expand vocabulary, revise metric, or change threshold — Phase 22.1 scope.

## Session Continuity

Last session: 2026-04-13
Stopped at: Phase 22 complete. Plan 22-01 CAVE-01/02 done (CAVE-02 divergence documented). Plan 22-02 CAVE-01 wiring/CAVE-03 BM25/CAVE-04 fact density all verified. Phase 23 unblocked.
Resume file: None


## Learnings
















- [learning] 2026-04-13T02:55:23.974Z: BM25 inline benchmark: tokenize+IDF+score (no external npm). Fact density fixtures at tests/fixtures/ need 3 dirname() calls to reach project root from test file. Original 500-char file descriptions are sparse (shebang+docstring+imports), compressed pipe-delimited are dense (deps/tests/loc/exports) — 1.4x fact density ratios are achievable even for small files.
- [learning] 2026-04-13T02:48:41.975Z: legacy regression test: free text learning
- [learning] 2026-04-13T02:46:27.820Z: legacy regression test: free text learning
- [learning] 2026-04-13T02:33:13.313Z: When grammar-stripping dense technical markdown (agent .md files with 50%+ code blocks, XML, and YAML), article/filler/hedging removal yields only ~1.5% char reduction — not 30%. Measure processable fraction early and surface as divergence before writing compression-ratio tests. Resolution: expand vocabulary, change metric to processable-text-only, or revise threshold.
- [learning] 2026-04-13T01:49:44.208Z: validate_context() is module-level (not a ContextValidator method) to keep the class PG-free; __commit_ref__ is embedded as a key inside file_hashes JSONB dict — avoids new PG column; test mocks for changed_since must use absolute paths in git diff stdout output, not relative filenames
- [learning] 2026-04-13T01:43:44.280Z: legacy regression test: free text learning
- [learning] 2026-04-13T01:35:22.005Z: ContextValidator uses @staticmethod-only class with binary-mode chunked reads for SHA-256 hashing; changed_since intersects git diff --name-only output with file_hashes keys (not filesystem); selective_refresh captures get_current_commit() in result dict so orchestrator stores it once; [STALE] log line emitted inside selective_refresh, not at call site
- [learning] 2026-04-13T01:30:55.773Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:58:43.023Z: compactRpetdContext in gsd-amauta.cjs uses minimal 2-message array (user: task+phase, assistant: content[:2000]) because full conversation is unavailable in the CJS CLI path; daemon fallback extractor handles this gracefully; Phase 24 ROUTE-02 will wire LLM compaction without changing the call site
- [learning] 2026-04-13T00:52:07.931Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:42:14.221Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:39:01.825Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:36:50.801Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:27:00.814Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:24:57.175Z: legacy regression test: free text learning
- [learning] 2026-04-13T00:15:18.995Z: Pydantic model_validator(mode='after') auto-computes derived fields like SHA-256 context versions; callers never set them manually. Pre-adding future columns (e.g., file_hashes for Phase 21) in the current migration avoids a second ALTER TABLE. PGStore new method groups belong between domain-matching section dividers.

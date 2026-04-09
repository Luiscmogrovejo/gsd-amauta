---
phase: 10-d-phase-structured-learning
plan: 10-03
subsystem: cli
tags: [nodejs, gsd-memory, parse-learning, structured-learning, tag-governance, learn-02, learn-04, kill-switch]

# Dependency graph
requires:
  - phase: 10-01
    provides: tag-rules.json (banned/synonyms/tiers vocabulary) + learning-format.md (WHAT/WHY/WHEN length caps + CATEGORY enum) + cli-variables.md (CLI env var reference)
provides:
  - gsd-memory.cjs loadTagRules() helper with two-candidate path resolution and hardcoded fallback
  - gsd-memory.cjs normalizeTags() returning {tags, warnings, error} — banned strip + synonym expand + 5-tag auto-trim by tier ranking (domain > technique > scope > meta)
  - gsd-memory.cjs normalizeTagsList() backward-compat wrapper for legacy array-returning call sites
  - gsd-memory.cjs parseLearningBlock() + splitLearningBlocks() + validateLengthCaps() parser suite (CATEGORY_SET, MAX_WHAT=120, MAX_WHY=200, MAX_WHEN=80)
  - gsd-memory.cjs parse-learning subcommand — standalone CLI that parses a text block into JSON, honors GSD_D_STRUCTURED=false kill switch, truncates over-cap fields rather than dropping
  - gsd-memory.cjs learn --structured hybrid CLI — named-flag branch (--what/--why/--when/--category/--tags) OR text-block branch (parses the first LEARNING: block from positional arg), enforces length caps, normalizes tags, delegates to cmdStore with structured metadata payload (structured:true, structured_version:'1.0')
  - gsd-memory.cjs BOOLEAN_FLAGS tokenizer fix — prevents `--structured "LEARNING: ..."` from binding the text block to args.structured
  - gsd-memory.cjs cmdStore file-mode fallback warning — "File-mode fallback: structured metadata dropped, saved as flat text" when daemon is unreachable and body.metadata.structured is true
  - gsd-memory.cjs cmdDistill guard — skips entries whose metadata.what is set, preventing merge from destroying WHAT/WHY/WHEN/TAGS schema
affects: [10-04-daemon-api, 10-05-skb-commands, 10-06-operator-citation-scanner, 10-08-learning-block-template]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Runtime config load with two-candidate path + module cache (loadTagRules): local install dir first, ~/.claude fallback second, hardcoded defaults last — never crashes"
    - "Tier-ranked auto-trim: when a tag list exceeds a cap, sort by tier (domain=0 > technique=1 > scope=2 > meta=3) and keep the most-specific N — preserves retrieval value over meta noise"
    - "Hybrid CLI command: named-flag branch AND text-block branch in the same handler, selected by which inputs are present; avoids two parallel subcommands for the same intent"
    - "BOOLEAN_FLAGS set for argv tokenizer: declare boolean flags explicitly so the lookahead does not swallow the next positional as a value"
    - "Kill-switch fall-through (not kill-switch abort): GSD_D_STRUCTURED=false warns and routes the call through the legacy free-text path, rebuilding the text body from named fields when no positional was supplied — structured callers still land a memory"
    - "Structured metadata passthrough: cmdLearn sets args.metadata = {structured, structured_version, what, why, when, category} as a plain object; cmdStore branches on typeof args.metadata to forward either a parsed object or a JSON string to the daemon"

key-files:
  created: []
  modified:
    - get-shit-done/bin/gsd-memory.cjs

key-decisions:
  - "BOOLEAN_FLAGS set declared outside parseArgs() and reused — cheap, testable, and makes the boolean flag list the single source of truth for the tokenizer"
  - "learn --structured text-block parse failure falls back to free-text storage (with a warning) instead of aborting — preserves the learning rather than dropping it"
  - "Kill switch path rebuilds text body from --what/--why/--when (joined with ' — ') when no positional is provided — a kill-switched structured call must not error-out on usage; it must land the memory as free-text"
  - "CATEGORY-defaulted warning gated on both `!args.category` AND `parsed.category_defaulted !== false` — only fires when the caller supplied no category signal in either path, avoiding noise when the block already set CATEGORY: pattern explicitly"
  - "cmdStore file-mode fallback logs 'File-mode fallback: structured metadata dropped' only when body.metadata.structured is true — legacy free-text stores remain silent, no new warnings for existing callers"
  - "cmdDistill guard placed immediately inside the merge candidate loop (before similarity scoring) — structured entries never enter the candidate set, so no wasted embedding lookups"
  - "normalizeTags returns {tags, warnings, error} as a record not a throwing error — callers (parse-learning, learn --structured) surface the error message directly to stderr; legacy callers use normalizeTagsList() which unwraps to an array and drops warnings"
  - "Length caps enforced in cmdLearn AND cmdParseLearning, but cmdLearn hard-rejects (process.exit) while cmdParseLearning truncates + flags truncated:true — cmdLearn is the user-facing store path (fail fast), cmdParseLearning is the inspection path (preserve learnings)"

patterns-established:
  - "Config-file-backed normalization with graceful fallback: future governance/policy configs should follow the loadTagRules() pattern (two-candidate path, cache, hardcoded defaults, warn-once on miss)"
  - "Structured command variant via --structured flag rather than new subcommand: preserves backward compat and keeps the command hierarchy flat. Phase 10 SKB commands (10-05) should consider the same pattern when adding structured SKB entries"
  - "Kill switch semantics: fall-through with warning is preferred over hard abort. Env var off = feature disabled, not command disabled"
  - "cmdDistill skip-by-metadata guard: any future 'don't merge these' class of entries should add its own check in the same guard block — central place, single audit point"

requirements-completed: [LEARN-02, LEARN-04]

# Metrics
duration: ~45min (across two sessions — first session hit rate limit mid-execution, this session resumed and landed Task 3 + Task 4)
completed: 2026-04-09
---

# Plan 10-03: gsd-memory.cjs parse-learning + learn --structured + normalizeTags Summary

**gsd-memory.cjs now parses LEARNING blocks, stores structured learnings via `learn --structured` (hybrid named-flag OR text-block CLI), and enforces tag governance via tag-rules.json with banned-strip + 5-tag auto-trim by tier ranking — GSD_D_STRUCTURED=false kill switch falls through to free-text storage**

## Performance

- **Duration:** ~45 min across two sessions
- **Session 1:** Research, plan, Task 1 (loadTagRules + normalizeTags refactor, commit `b5e06de`) and Task 2 (parse-learning subcommand + parser suite, commit `1eac6ab`) — agent hit rate limit before Tasks 3 and 4
- **Session 2:** Task 3 (cmdLearn structured path + BOOLEAN_FLAGS tokenizer fix) and Task 4 (cmdDistill guard) landed atomically as commit `31088df`
- **Tasks:** 4 (all committed atomically)
- **Files modified:** 1 (get-shit-done/bin/gsd-memory.cjs)
- **Lines changed (net):** +302 / -45 across all three commits

## Accomplishments

- **Task 1 (LEARN-04):** `loadTagRules()` reads `get-shit-done/config/tag-rules.json` at runtime with two-candidate path resolution + hardcoded fallback. `normalizeTags()` refactored to return `{tags, warnings, error}` — strips banned tags, applies synonyms (db→database, pg→postgresql, k8s→kubernetes, etc.), and auto-trims over-5 lists by tier ranking. `normalizeTagsList()` backward-compat wrapper keeps legacy callers (cmdStore, cmdAutoCapture, cross-project tags path) on a flat-array contract. `tagTier()` classifier exposed for testing.
- **Task 2 (LEARN-02):** `parseLearningBlock()` extracts WHAT/WHY/WHEN/CATEGORY/TAGS from a structured block with header-line fallback for WHAT. `splitLearningBlocks()` splits on `\nLEARNING:` (newline-prefixed) per RISK-5 to avoid mid-sentence splits. `validateLengthCaps()` enforces WHAT ≤120 / WHY ≤200 / WHEN ≤80 with specific fix messages. `CATEGORY_SET` locks to the 9 valid categories. `cmdParseLearning` CLI dispatch honors `GSD_D_STRUCTURED=false` kill switch, truncates over-cap fields instead of dropping, applies normalizeTags per block, and surfaces warnings in the JSON output.
- **Task 3 (LEARN-02):** `cmdLearn` extended with `--structured` hybrid CLI. Named-flag branch builds the structured object from `--what`/`--why`/`--when`/`--category`/`--tags`. Text-block branch parses the first LEARNING: block from the positional arg, falling back to free-text storage if the parser returns null. Length caps hard-reject, banned tags hard-reject, kill switch falls through to legacy path. cmdStore forwards `args.metadata` object directly to the daemon jsonb column. File-mode fallback warns `[warn] File-mode fallback: structured metadata dropped, saved as flat text` when the daemon is unreachable. BOOLEAN_FLAGS tokenizer fix prevents `--structured "LEARNING: ..."` from binding the block text to `args.structured` and leaving `_positional` empty.
- **Task 4 (LEARN-02):** `cmdDistill` guard skips entries whose `metadata.what` is set — structured entries are already concise (≤120 char WHAT) and merging would destroy their schema. DEBUG env var logs which entries were skipped.

## Task Commits

Each task was committed atomically on `master`:

1. **Task 1: loadTagRules + normalizeTags refactor** — `b5e06de` (feat)
2. **Task 2: parse-learning subcommand + structured block parser** — `1eac6ab` (feat)
3. **Tasks 3 + 4: learn --structured hybrid path + BOOLEAN_FLAGS + distill guard** — `31088df` (feat)

_Note: Tasks 3 and 4 were committed together because Task 4 is a 10-line guard that naturally belongs with the cmdLearn structured path work — the test coverage for "distill doesn't destroy structured entries" only becomes meaningful once structured entries can exist, which requires Task 3._

## Files Created/Modified

- `get-shit-done/bin/gsd-memory.cjs` — +302 / -45 net across the three commits. Major additions: `loadTagRules()` + `tagTier()` + refactored `normalizeTags()` + `normalizeTagsList()` (~150 lines around line 55). `parseLearningBlock()` + `splitLearningBlocks()` + `validateLengthCaps()` + `CATEGORY_SET`/`MAX_*` constants (~80 lines around line 280). `cmdParseLearning()` (~60 lines around line 697). `BOOLEAN_FLAGS` set + parseArgs branch (~12 lines around line 504). `cmdLearn` structured path rewrite (~120 lines replacing the 40-line legacy body around line 760). `cmdStore` file-mode metadata-dropped warning (~5 lines around line 664). `cmdDistill` structured-skip guard (~10 lines around line 1663).

## Decisions Made

- **BOOLEAN_FLAGS as a module-level Set (not inline in parseArgs):** The tokenizer fix for `--structured` needed to run before the learn handler sees any args. Declaring the set outside parseArgs makes the boolean flag contract explicit, testable, and easy to extend when other subcommands add boolean flags (dry-run, use-llm, include-noise already included preemptively).
- **Kill switch fall-through semantics:** `GSD_D_STRUCTURED=false` with `learn --structured --what "x"` must still land the memory as free-text. The legacy free-text path rebuilds the text body from `--what`/`--why`/`--when` joined with ` — ` when no positional was supplied. The alternative (abort with usage error) would surprise agents that set the env var for experimentation and lose learnings.
- **CATEGORY-defaulted warning gated on both flag and parse signals:** `parseLearningBlock` sets `category_defaulted: false` when the block provides a valid CATEGORY. The warning condition is `!args.category && parsed.category_defaulted !== false` — only fires when the caller supplied no category signal in either path. Without this refinement, text-block users would see the warning even when their block explicitly sets `CATEGORY: pattern`.
- **Text-block parse failure falls back to free-text, not hard reject:** Agent D-phase content frequently contains LEARNING: markers inside less-structured prose. Hard-rejecting parse failures would lose those learnings entirely. The fallback path delegates to the legacy daemon POST + fileLearn() flow with a `[warn] Structured parse failed, falling back to free-text storage` notice.
- **cmdDistill guard is client-side, not server-side:** Plan 10-03 owns the Node.js layer only. Plan 10-04 adds the daemon-side query filter (`exclude_structured=true`). The client-side guard is the primary defense; the query param is a secondary efficiency improvement. Landing both layers in separate plans isolates rollback impact.
- **normalizeTagsList() created to minimize churn:** The `normalizeTags()` API changed from returning an array to returning `{tags, warnings, error}`. Rather than migrate 3 legacy call sites to destructure, `normalizeTagsList()` is a thin wrapper that unwraps to an array. Legacy callers stay unchanged; new structured callers use `normalizeTags()` directly.

## Deviations from Plan

None — all four tasks implemented as specified in 10-03-PLAN.md. The only spec refinement was adding the `categoryImplicit` logic in Task 3 (CATEGORY-defaulted warning only fires when the caller supplied no signal in either path), which is an obvious improvement over the plan's `!args.category` check once you realize it produces a false warning on text-block paths that set CATEGORY explicitly.

**Auto-fix during Session 2:** The kill switch test initially failed because the legacy path printed a usage error when `--structured` was active with no positional. I added the `text = parts.join(' — ')` fallback so kill-switched structured calls still land a memory. This is faithful to the plan's "should warn and fall through" semantics — falling through to an error would not be a functional fall-through.

## Issues Encountered

- **Session 1 rate limit:** Previous agent completed Tasks 1 and 2 but hit a token budget limit before Tasks 3 and 4. Partial state analysis in Session 2 found two uncommitted guard/tokenizer diffs on disk (BOOLEAN_FLAGS + cmdDistill skip). The description in the resume prompt mentioned "164 lines on disk" but the actual pending diff was ~30 lines — the bulk of the cmdLearn rewrite had not been started. Session 2 implemented the full cmdLearn structured path from scratch using the plan spec.
- **pg_store.py uncommitted diff from a concurrent plan:** The initial `git status` showed an uncommitted `services/pg_store.py` file containing plan 10-05 (`memory_increment_applied`, `memory_skb_candidates`) work. I left it untouched — it's out of scope for plan 10-03. The two new commits (`ab713bc` and `90e4aa5` and `05ebb2f`) landing 10-04 and 10-05 work during Session 2 confirm another executor was working in parallel. Git stash / stash pop cycle during a debugging step landed those commits cleanly.
- **Pre-existing `Stored undefined` cosmetic bug:** When the daemon dedups a stored entry, the response shape is `{stored: false, dedup_skipped: true, existing_id: N}` with no top-level `id`. The legacy free-text output prints `Stored undefined`. This bug exists on master before my changes (verified via `git stash`). Not in scope for 10-03, noted for a future tech-debt pass.

## User Setup Required

None — no external service configuration. The tag-rules.json config file was already shipped by Plan 10-01.

## Next Phase Readiness

- **LEARN-02 complete** on the Node.js side. Plan 10-06 (operator + APPLIED_LEARNING citation scanner) can now produce LEARNING blocks that will round-trip cleanly through `parse-learning` and `learn --structured`.
- **LEARN-04 complete** on the Node.js side. Plan 10-06 Gate 2 dual-format acceptance can rely on `normalizeTags()` catching banned-only tag lists before they reach the daemon.
- **Plan 10-04 (pg_store.py + daemon API) is already landed** as commits `ec22631`, `ab713bc`, `90e4aa5`, `05ebb2f` — the Python layer mirrors the Node.js tag governance via `normalize_tags()` and the daemon /api/memory/store endpoint forwards structured metadata to the jsonb column. The Node.js + Python layers now agree on tag rules (both read tag-rules.json).
- **Plan 10-05 (SKB commands) is ready to land** — it depends on 10-04 (which shipped) and can reuse `normalizeTagsList()` + `parseLearningBlock()` exports.
- **Kill switch verified end-to-end:** `GSD_D_STRUCTURED=false` disables both `parse-learning` and `learn --structured` paths with the canonical warning. Rollback plan in ROADMAP.md is proven functional.
- **No blockers** for Phase 10 wave-3 (plans 10-06, 10-07, 10-08).

---
*Phase: 10-d-phase-structured-learning*
*Completed: 2026-04-09*

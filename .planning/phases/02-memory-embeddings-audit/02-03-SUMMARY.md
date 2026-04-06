---
phase: 02-memory-embeddings-audit
plan: 02-03
subsystem: memory
tags: [ollama, llm, distillation, summarization, node, child_process]

# Dependency graph
requires:
  - phase: 02-01
    provides: distill-status bug fix (MEM-01) — needed before adding LLM path to distill

provides:
  - isOllamaAvailable() helper: detects ollama binary via which
  - selectOllamaModel() helper: picks qwen3:8b > llama3.2:3b > first available
  - llmSummarize(entries, model) helper: runs ollama run with 30s timeout, 800-char entry truncation
  - --use-llm flag wired into cmdDistill with graceful fallback to concatenation
  - distill_strategy and distill_model metadata fields in merged entries for provenance tracking
  - 26 tests in tests/test_distill_llm.cjs (code-structure + runtime with execSync injection)

affects: [02-04, 03-02, memory-distill]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - LLM-optional CLI flag pattern: --use-llm is opt-in, not default; guards behind availability check
    - execSync injection for unit testing: Function constructor with custom require stub to test child_process callers
    - require.main !== module guard for CLI tools: enables module to export test helpers without triggering main()

key-files:
  created:
    - tests/test_distill_llm.cjs
  modified:
    - get-shit-done/bin/gsd-memory.cjs

key-decisions:
  - "execSync via child_process inside helper functions (not at module load) — needed Function-constructor injection approach in tests"
  - "main() gated behind require.main !== module else branch — lets test files require the module without triggering process.exit(0)"
  - "LLM path is opt-in (--use-llm flag) with two fallback messages: no ollama binary + no models available"
  - "26 tests instead of 8 (plan minimum) — added runtime tests via Function-based execSync injection to validate actual behavior"
  - "distill_model set to null (not omitted) when concatenation strategy is used — consistent metadata shape"

patterns-established:
  - "Function-based execSync injection: extract function source from file, eval in Function() with fake require — avoids module cache manipulation complexity"
  - "require.main !== module else guard: CLI tools that need test exports should gate main() with else, not a separate if"

requirements-completed: [MEM-02]

# Metrics
duration: 35min
completed: 2026-04-06
---

# Plan 02-03: LLM Summarization for Distillation Summary

**Ollama-based LLM summarization added to gsd-memory distill via --use-llm flag with qwen3:8b preference, graceful concatenation fallback, and distill_strategy/distill_model provenance metadata**

## Performance

- **Duration:** 35 min
- **Started:** 2026-04-06T20:15:00Z
- **Completed:** 2026-04-06T20:50:00Z
- **Tasks:** 3 (T1, T2, T3)
- **Files modified:** 2

## Accomplishments

- Three LLM helper functions added to gsd-memory.cjs: `isOllamaAvailable`, `selectOllamaModel`, `llmSummarize`
- `--use-llm` flag wired into `cmdDistill` merge loop with two-tier fallback (no ollama binary + no models)
- Provenance metadata (`distill_strategy`, `distill_model`) added to every merged entry alongside existing `merged_from`/`original_count`
- 26 passing tests in `tests/test_distill_llm.cjs` using code-structure checks + runtime Function-constructor execSync injection

## Task Commits

Each task was committed atomically:

1. **T1: helpers + --use-llm help text** - `f47a951` (feat)
2. **T2: merge loop wiring + test exports** - `a97ad4c` (feat)
3. **T3: 26 tests + gate main() on require.main** - `0b5df7e` (feat/test)

## Files Created/Modified

- `get-shit-done/bin/gsd-memory.cjs` — added 3 LLM helpers, wired --use-llm into merge loop, added provenance metadata, gated main() on require.main, added test exports
- `tests/test_distill_llm.cjs` — 26 tests: 16 code-structure + 10 runtime via Function execSync injection

## Decisions Made

- **execSync injection via Function constructor**: module cache patching failed because helper functions call `require('child_process')` at runtime (not load time), so the cache was already restored by the time the test called the helper. Used Function() constructor to eval the extracted function source with a custom require stub instead.
- **main() gated with require.main !== module else**: original `main()` called unconditionally; adding exports requires gating. Used `else` branch (not a second `if`) so the intent is explicit.
- **26 tests (plan required >= 8)**: added runtime tests on top of code-structure checks to verify actual helper logic, not just presence.

## Deviations from Plan

### Auto-fixed Issues

**1. main() process.exit(0) killed test runner**
- **Found during:** T3 (test creation)
- **Issue:** `gsd-memory.cjs` calls `main()` unconditionally at the bottom; when required by tests with no CLI args, `main()` calls `process.exit(0)`, killing the test process before tests could run.
- **Fix:** Gated `main()` call behind `require.main !== module` else branch.
- **Files modified:** `get-shit-done/bin/gsd-memory.cjs`
- **Verification:** `node get-shit-done/bin/gsd-memory.cjs` still prints usage; `node --test tests/test_distill_llm.cjs` runs all 26 tests.
- **Committed in:** `0b5df7e` (T3 commit)

**2. Module cache patching approach for execSync mocking failed**
- **Found during:** T3 (first test run)
- **Issue:** Patching `require.cache[cpCacheKey]` and loading the module worked, but the loaded functions captured `require` as a closure — when called, they re-called the real `require('child_process')`, ignoring the patch.
- **Fix:** Switched to Function-constructor extraction: parse the function source directly from the file, eval with a custom require stub that returns a fake child_process for the test.
- **Committed in:** `0b5df7e` (T3 commit)

---

**Total deviations:** 2 auto-fixed (1 process.exit side-effect, 1 mock strategy change)
**Impact on plan:** Both fixes necessary for test correctness. No scope creep.

## Issues Encountered

- Node.js module cache manipulation for stubbing `require('child_process')` is fragile when functions call `require()` lazily at invocation time. The Function-constructor approach is more reliable for this pattern.

## Next Phase Readiness

- MEM-02 complete. `--use-llm` opt-in LLM distillation available with Ollama.
- Phase 2 remaining: 02-05 (embedding cache) deferred to Phase 4 per STATE.md decision.
- Ready to proceed to Phase 3 (RLM improvements) in parallel.

---
*Phase: 02-memory-embeddings-audit*
*Completed: 2026-04-06*

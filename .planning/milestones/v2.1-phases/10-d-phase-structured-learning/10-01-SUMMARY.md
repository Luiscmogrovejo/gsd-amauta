---
phase: 10-d-phase-structured-learning
plan: 10-01
subsystem: config
tags: [tag-rules, learning-format, cli-variables, json, reference-files]

# Dependency graph
requires:
  - phase: 9-tech-debt-sweep
    provides: green baseline (npm test + pytest 0 failures)
provides:
  - tag-rules.json config with banned/synonyms/vocabulary/tiers for both Node and Python parsers
  - learning-format.md WHAT/WHY/WHEN/TAGS template with 4 agent-category examples
  - cli-variables.md shared shell block for runtime Read dedup (5 vars + 2 artifact paths)
affects: [10-02, 10-03, 10-04, 10-05, 10-06, 10-07, 10-08, 10-09, 11, 12, 13, 14]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dual-runtime JSON config (Node require() + Python json.load() read same file)"
    - "Runtime Read for shared references (NOT @ include — agents use Read tool)"
    - "Tier-ranked tag governance (domain > technique > scope > meta)"

key-files:
  created:
    - get-shit-done/config/tag-rules.json
    - get-shit-done/references/learning-format.md
    - get-shit-done/references/cli-variables.md
  modified: []

key-decisions:
  - "tag-rules.json lives in new get-shit-done/config/ directory (not references/) — machine-readable config is separate from human docs"
  - "Synonym map expanded to 18 entries (beyond the 8 required) — covers db, k8s, ts, js, py, ci, cd, pg, postgres, auth, oidc, sso, tf, fe, be, e2e, perf, mem"
  - "12 vocabulary domains seeded with 10-13 specific tags each — advisory not strict; free-form tags still accepted if not banned"
  - "Tiers array pre-populated with ~80 specific tags across domain/technique/scope/meta — enables downstream auto-trim logic to work without cold-start"
  - "cli-variables.md ships with 5 tool vars (CLI, RLM, MEM, RESEARCH, TOOLS) + 2 artifact paths (LEARNING_FORMAT, TAG_RULES) — TOOLS added for Phase 14 readiness"
  - "learning-format.md includes 4 agent-category examples (executor, planner, researcher, validator) instead of one generic example — models the structure for each persona"

patterns-established:
  - "JSON config at get-shit-done/config/ — first file in a new directory; Node and Python both parse"
  - "Shell-assignable reference blocks — agents Read the file and paste the bash block directly"
  - "Fallback comment blocks — every runtime Read pattern ships with a graceful-degradation fallback"

requirements-completed: [LEARN-01, LEARN-04, LEARN-07]

# Metrics
duration: ~15min
completed: 2026-04-09
---

# Plan 10-01: Foundation Config + Reference Files Summary

**tag-rules.json + learning-format.md + cli-variables.md — the 3 foundation files every downstream Phase 10 plan reads from**

## Performance

- **Duration:** ~15 min (file creation + verification + atomic commits)
- **Completed:** 2026-04-09
- **Tasks:** 3
- **Files created:** 3

## Accomplishments

- `get-shit-done/config/tag-rules.json` — 50 lines, parses from both Node.js and Python, 4 banned tags, 18 synonyms, 12 vocabulary domains, 4 tier buckets with ~80 specific tags
- `get-shit-done/references/learning-format.md` — 166 lines, WHAT/WHY/WHEN/TAGS template with hard length caps (WHAT<=120, WHY<=200, WHEN<=80, TAGS max 5), 9-category fixed set, 4 per-persona examples, APPLIED_LEARNING citation format, GSD_D_STRUCTURED kill switch documented
- `get-shit-done/references/cli-variables.md` — 67 lines, 5 shell vars + 2 artifact paths, runtime-Read pattern with fallback block, variable reference table, agent integration instructions

## Task Commits

Each task was committed atomically on master:

1. **Task 1: tag-rules.json** — `6f10983` feat(10-01): add tag-rules.json config (LEARN-04)
2. **Task 2: learning-format.md** — `b6faa13` feat(10-01): add learning-format.md reference (LEARN-01)
3. **Task 3: cli-variables.md** — `d03dd89` feat(10-01): add cli-variables.md reference (LEARN-07)

## Files Created/Modified

- `get-shit-done/config/tag-rules.json` (new) — dual-runtime tag governance config, 4 banned/18 synonyms/12 domains/4 tier buckets
- `get-shit-done/references/learning-format.md` (new) — structured LEARNING template + 4 examples + category matrix + APPLIED_LEARNING citation spec
- `get-shit-done/references/cli-variables.md` (new) — shared CLI/RLM/MEM/RESEARCH/TOOLS vars + LEARNING_FORMAT/TAG_RULES artifact paths + fallback block

## Verification Output

Dual-runtime JSON parse:
```
node:   4 banned, 18 synonyms, 12 domains
python: 4 banned, 18 synonyms, 12 domains
```

Acceptance criteria (all pass):
- `banned` == `['best-practice', 'general', 'insight', 'lesson']`
- `vocabulary` keys == 12 (api, authentication, backend, caching, database, deployment, frontend, infrastructure, monitoring, performance, security, testing)
- `tiers` keys == `['domain', 'meta', 'scope', 'technique']`
- `synonyms['pg']` == `'postgresql'`, `synonyms['k8s']` == `'kubernetes'`
- `'postgresql'` in `tiers['domain']`, `'pattern'` in `tiers['meta']`
- learning-format.md: 7 `^## ` sections, 4 `^### Example` blocks
- cli-variables.md: CLI/RLM/MEM/RESEARCH/TOOLS appear twice (main block + fallback), LEARNING_FORMAT/TAG_RULES appear twice

## Decisions Made

None beyond plan — executed exactly as specified in 10-01-PLAN.md. The plan itself made concrete decisions on vocabulary tags per domain and tier membership; execution was pure file creation.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. All three files landed cleanly in atomic commits. On re-entry to this plan (for SUMMARY.md + STATE/ROADMAP updates), all acceptance criteria were re-verified and passed.

## Next Phase Readiness

Plan 10-01 unblocks every downstream Phase 10 plan:
- **10-02..10-04** (gsd-memory.cjs, pg_store.py extensions) can now `require()` / `json.load()` the tag-rules.json
- **10-05** (migration 008 applied-count) is independent — already shipped in commits 6307d93 + 72ff620
- **10-06..10-08** (operator + agent + workflow updates) can now Read cli-variables.md and learning-format.md at runtime
- **10-09** (tests) can reference the canonical JSON fixtures

No blockers. Phase 10 Wave 1 first deliverable complete.

---
*Phase: 10-d-phase-structured-learning*
*Plan: 10-01*
*Completed: 2026-04-09*

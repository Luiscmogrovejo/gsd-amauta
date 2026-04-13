---
phase: 23-prompt-prefix-caching
plan: 23-01
subsystem: agents
tags: [prefix-caching, cache-breakpoint, agent-prompts, audit-script, nodejs]

requires:
  - phase: 22-caveman-compressed-descriptions
    provides: completed agent .md file work, established test patterns in tests/

provides:
  - CACHE_BREAKPOINT marker in all 11 agent .md files separating stable prefix from variable suffix
  - scripts/audit-prefix-stability.cjs validating 6 structural checks per agent file
  - tests/23-prefix-stability.test.cjs with 10 test cases for CACHE-01 and CACHE-03

affects: [24-semantic-cache, 25-tech-debt-sweep]

tech-stack:
  added: []
  patterns:
    - "<!-- CACHE_BREAKPOINT --> as machine-parseable anchor between stable-prefix and variable-suffix in agent .md files"
    - "Stable prefix: frontmatter + role + patterns + domain + rpetd + prerequisites sections"
    - "Variable suffix: runtime_read blocks (session-specific content) only"

key-files:
  created:
    - scripts/audit-prefix-stability.cjs
    - tests/23-prefix-stability.test.cjs
  modified:
    - agents/gsd-executor-backend.md
    - agents/gsd-executor-frontend.md
    - agents/gsd-executor-infra.md
    - agents/gsd-executor-general.md
    - agents/gsd-checker.md
    - agents/gsd-researcher.md
    - agents/gsd-operator.md
    - agents/gsd-planner.md
    - agents/gsd-validator.md
    - agents/gsd-debugger.md
    - agents/gsd-roadmapper.md

key-decisions:
  - "audit script was already created (5747fa5) at plan start — skipped recreation, committed as-is"
  - "4 executor agents (backend/frontend/infra/general) already had CACHE_BREAKPOINT from prior work — discovered via git diff"
  - "Breakpoint placed at end of file for agents without <runtime_read> blocks (checker, researcher, operator, planner, validator, debugger, roadmapper)"
  - "For executor agents with <runtime_read>, the block was relocated after the breakpoint to form variable suffix"
  - "Test 10 (prefix >= 50% of file) validates breakpoint is not placed too early; all agents 90%+ stable content"

patterns-established:
  - "CACHE_BREAKPOINT placement rule: all static sections above, any runtime_read blocks below"
  - "Audit script checks 6 properties per agent: breakpoint exists (count=1), no volatile patterns in prefix, frontmatter before breakpoint, role before breakpoint, patterns before breakpoint, runtime_read not in prefix"
  - "Test pattern: it() inside describe() with node:test runner, assert/strict module"

requirements-completed:
  - CACHE-01
  - CACHE-03

duration: 25min
completed: 2026-04-12
---

# Plan 23-01: Agent Prompt Restructuring + Prefix Stability Audit Script

**CACHE_BREAKPOINT markers added to all 11 agent .md files; audit script (6 checks/agent) and 10-test stability suite ship together, all passing**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-12
- **Completed:** 2026-04-12
- **Tasks:** 5 (23-01-01 through 23-01-05)
- **Files modified:** 13 (11 agents + 1 audit script + 1 test file)

## Accomplishments
- All 11 agent .md files now have exactly one `<!-- CACHE_BREAKPOINT -->` marker separating stable prefix from variable suffix
- `scripts/audit-prefix-stability.cjs` validates 6 structural checks per agent, exits 0 on all 11 agents
- `tests/23-prefix-stability.test.cjs` passes 10/10 test cases covering CACHE-01 and CACHE-03 requirements
- Zero regressions in existing `tests/06-01-agent-definitions.test.cjs` (20/20 pass)
- No volatile patterns (`datetime.now`, `Date.now`, `Math.random`) in any agent file

## Task Commits

Each task was committed atomically:

1. **Task 23-01-01: Create audit-prefix-stability.cjs** - `5747fa5` (feat — already committed at plan start)
2. **Task 23-01-02: Restructure 6 executor/specialist agents** - `677f856` (feat)
3. **Task 23-01-03: Restructure 5 orchestrator/specialist agents** - `64f66fb` (feat)
4. **Task 23-01-04: Prefix stability test suite** - `c8f1ba1` (feat)
5. **Task 23-01-05: Regression check + full audit** - (no new commit — verification task only)

## Files Created/Modified
- `scripts/audit-prefix-stability.cjs` - Audit script: 6 checks per agent, exits 0 when all pass
- `tests/23-prefix-stability.test.cjs` - 10 test cases: CACHE-01 structure + CACHE-03 determinism
- `agents/gsd-executor-backend.md` - runtime_read relocated after CACHE_BREAKPOINT
- `agents/gsd-executor-frontend.md` - runtime_read relocated after CACHE_BREAKPOINT
- `agents/gsd-executor-infra.md` - runtime_read relocated after CACHE_BREAKPOINT
- `agents/gsd-executor-general.md` - runtime_read relocated after CACHE_BREAKPOINT
- `agents/gsd-checker.md` - CACHE_BREAKPOINT appended at end (no runtime_read)
- `agents/gsd-researcher.md` - CACHE_BREAKPOINT appended at end (no runtime_read)
- `agents/gsd-operator.md` - CACHE_BREAKPOINT appended at end (no runtime_read)
- `agents/gsd-planner.md` - CACHE_BREAKPOINT appended at end (no runtime_read)
- `agents/gsd-validator.md` - CACHE_BREAKPOINT appended at end (no runtime_read)
- `agents/gsd-debugger.md` - CACHE_BREAKPOINT appended at end (no runtime_read)
- `agents/gsd-roadmapper.md` - CACHE_BREAKPOINT appended at end (no runtime_read)

## Decisions Made
- Audit script was already present at `5747fa5` — treated as done, verified acceptance criteria, committed as-is without re-creating.
- For executor agents (backend/frontend/infra/general), the `<runtime_read>` block needed relocation from before `<role>` to after the breakpoint. The 4 executor agents had this already done in the working tree before this session.
- For 7 agents without `<runtime_read>` blocks, the breakpoint was appended at the end of all stable content — minimal diff, no semantic changes.

## Deviations from Plan
None — plan executed exactly as written, except that tasks 23-01-01 and partial 23-01-02 were already completed in a prior session (discovered via git log and audit script output).

## Issues Encountered
None.

## Next Phase Readiness
- Phase 23 Plan 23-02 (Wave 2) can proceed — CACHE-01 and CACHE-03 requirements met
- All 11 agents structured for maximum Claude Code prefix caching: stable content first, variable content (runtime_read) after breakpoint
- `scripts/audit-prefix-stability.cjs` can be added to CI to prevent regression

---
*Phase: 23-prompt-prefix-caching*
*Completed: 2026-04-12*

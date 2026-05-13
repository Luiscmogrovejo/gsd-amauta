---
phase: 52-agent-compilation
plan: "01"
subsystem: agent-compilation
tags: [pydantic, agent-schema, yaml, converter, python, nodejs]

# Dependency graph
requires:
  - phase: 43-skills-architecture
    provides: "_HAS_PYDANTIC/_HAS_YAML import-safety pattern, skill_schema.py structure"
  - phase: 48-module-system-foundation
    provides: "Pydantic locked field order discipline (module_schema.py)"

provides:
  - "services/agent_schema.py — AgentDefinition Pydantic model with 6-field locked frontmatter + 10-key sections + body_preamble"
  - "scripts/agent-md-to-yaml.cjs — one-shot agents/*.md → AGENT.yaml converter with HEADING_TO_KEY bidirectional map"
  - "tests/test_agent_schema.py — 16 Python unittest tests covering schema validation + round-trip"
  - "tests/agent-md-to-yaml.test.cjs — 8 node:test tests covering converter + batch + body_preamble"

affects:
  - 52-agent-compilation
  - future phases consuming AgentDefinition or AGENT.yaml outputs

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AgentDefinition: 6-field locked frontmatter (name→description→tools→color→memory→skills) + body_preamble + 10-key sections dict"
    - "_HAS_PYDANTIC/_HAS_YAML import-safety (mirrors skill_schema.py Phase 43)"
    - "SECTION_KEY_ORDER tuple at module scope — consumers iterate for ordered emit/check"
    - "HEADING_TO_KEY bidirectional map in .cjs converter (9 headings + 1 synthetic metadata)"
    - "Custom YAML block-literal emitter (no yaml-js dep) for multi-line section bodies"

key-files:
  created:
    - services/agent_schema.py
    - scripts/agent-md-to-yaml.cjs
    - tests/test_agent_schema.py
    - tests/agent-md-to-yaml.test.cjs
  modified: []

key-decisions:
  - "body_preamble field added to AgentDefinition (Optional[str] = None) to handle 16/17 agents with # Agent: H1 and 1 exception (gsd-executor-data.md with null)"
  - "HEADING_TO_KEY maps 9 .md headings → snake_case keys (e.g. 'Behavioral rules' → 'patterns_and_practices'); metadata synthesized from '## version: 3.0.0' line"
  - "Custom YAML emitter in agent-md-to-yaml.cjs (no external deps) using block-literal | style for multi-line section bodies"
  - "NEVER writes to get-shit-done/agents/ from test files — Wave 2 owns canonical conversion"

patterns-established:
  - "AgentDefinition field order lock: name < description < tools < color < memory < skills (grep-verifiable)"
  - "SECTION_KEY_ORDER tuple: 10 locked snake_case section keys in declaration order"
  - "Comma-separated inline tools field (tools: Read, Write, Edit) split on /\\s*,\\s*/ only for tools key"

requirements-completed:
  - COMPILE-01

# Metrics
duration: 45min
completed: 2026-05-13
---

# Phase 52 Plan 01 Summary

**AgentDefinition Pydantic schema with 6-field locked frontmatter + 10-section dict, one-shot agents/*.md → AGENT.yaml converter, and 24 tests (16 Python + 8 Node)**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-05-13
- **Completed:** 2026-05-13
- **Tasks:** 4
- **Files created:** 4

## Accomplishments

- `services/agent_schema.py`: AgentDefinition with locked 6-field frontmatter (name→description→tools→color→memory→skills), `body_preamble: Optional[str] = None` for H1 preamble handling, 10-key `sections` dict keyed by `SECTION_KEY_ORDER`, `_HAS_PYDANTIC`/`_HAS_YAML` import-safety fallbacks, field validators, fallback `__init__`, and `load_agent_definition()` loader
- `scripts/agent-md-to-yaml.cjs`: Converter with `HEADING_TO_KEY` (9 headings + 1 synthetic metadata), `parseAgentFrontmatter()`, `convert()`, `convertBatch()`, custom block-literal YAML emitter, CLI entrypoint with `--batch`/`--dry-run`/`--help`. Converts all 17 agents successfully.
- `tests/test_agent_schema.py`: 16 Python unittest tests — SECTION_KEY_ORDER tuple lock, valid/invalid frontmatter, body_preamble null/non-null, load round-trip, pydantic extra=forbid
- `tests/agent-md-to-yaml.test.cjs`: 8 node:test tests — HEADING_TO_KEY completeness, gsd-planner round-trip, 10-section keys, metadata version, unknown heading rejection, batch 17 agents, code-fence whitespace, body_preamble H1/null

## Task Commits

1. **Task 52-01-01: services/agent_schema.py** — `46d594f` (feat)
2. **Task 52-01-02: tests/test_agent_schema.py** — `3cdea28` (feat)
3. **Task 52-01-03: scripts/agent-md-to-yaml.cjs** — `e04b1b2` (feat)
4. **Task 52-01-04: tests/agent-md-to-yaml.test.cjs** — `a18ea66` (feat)

## Files Created

- `services/agent_schema.py` — AgentDefinition Pydantic model (416 lines)
- `tests/test_agent_schema.py` — 16 Python tests (269 lines)
- `scripts/agent-md-to-yaml.cjs` — md→yaml converter (564 lines)
- `tests/agent-md-to-yaml.test.cjs` — 8 Node tests (305 lines)

## Decisions Made

- `body_preamble` added as `Optional[str] = None` per Phase 52 critical constraint — 16/17 agents have `# Agent: <name>` H1 between frontmatter `---` and first `## ` heading; gsd-executor-data.md has none
- `HEADING_TO_KEY` maps the actual heading strings from the 17 real .md files: `'Behavioral rules' → 'patterns_and_practices'`, `'Tool access & guidance' → 'workflow_and_process'`, etc. (not the context doc names which had slight differences)
- Custom YAML block-literal emitter in .cjs file (no yaml-js dep requirement) — mirrors `loadPlatformCodes()` minimal parser approach from skill-compiler.cjs
- test names use `test('single-quote')` form to satisfy plan AC `grep -c "test('" file` literal grep check

## Deviations from Plan

None — plan executed as specified. Task 52-01-03 is labeled `<agent>executor-general</agent>` in the plan XML but the objective brief assigns all 4 tasks to executor-backend; delivered all 4 per the objective.

## Issues Encountered

None. All 17 agents convert cleanly. Batch smoke test (17 files → 17 AGENT.yaml) passes on first run.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `services/agent_schema.py` + `SECTION_KEY_ORDER` ready for Wave 2 (scripts/agent-compiler.cjs)
- `scripts/agent-md-to-yaml.cjs` ready for Wave 2 batch conversion (get-shit-done/agents/<name>/AGENT.yaml)
- All 24 tests pass; no regressions to existing test suite

---
*Phase: 52-agent-compilation*
*Completed: 2026-05-13*

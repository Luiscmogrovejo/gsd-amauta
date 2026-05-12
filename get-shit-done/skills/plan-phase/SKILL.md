---
name: plan-phase
description: "Convert phase CONTEXT.md into PLAN.md files with Wave-grouped tasks, run plan-to-tasks auto-registration, and prepare phase for execute-phase handoff."
category: workflow
version: 1.0.0
security_class: read-write
allowed-tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Bash
depends_on: []
---

# Plan Phase Skill

Skill entry-point for the sharded plan-phase workflow.

## Router

The workflow body lives at: `get-shit-done/workflows/plan-phase/workflow.md`

Read the router fully and follow its 5-step orchestration. The router enforces
StepHandoff persistence and HALT boundaries after each step.

## Invocation contract

- Input: phase identifier (e.g. `43-skills-architecture`)
- Output: PLAN.md files in `.planning/phases/<phase>/` with Wave frontmatter,
  and registered tasks in PG via `gsd-tools plan-to-tasks`.

## Tool boundary

This skill is `security_class: read-write`. Writes are constrained to
`.planning/phases/<phase>/**/PLAN.md`, `.planning/STATE.md`, and PG via daemon
endpoints. Semgrep enforcement (Plan 43-03) validates the boundary.

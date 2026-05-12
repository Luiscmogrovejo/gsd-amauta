---
name: discuss-phase
description: "Run discuss-phase workflow to elicit user decisions and produce CONTEXT.md before plan-phase. Resumable across sessions via StepHandoff."
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

# Discuss Phase Skill

Skill entry-point for the sharded discuss-phase workflow.

## Router

The workflow body lives at: `get-shit-done/workflows/discuss-phase/workflow.md`

Read the router fully and follow its 4-step orchestration. The router enforces
StepHandoff persistence and HALT boundaries after each step.

## Invocation contract

- Input: phase identifier (e.g. `43-skills-architecture`)
- Output: CONTEXT.md in `.planning/phases/<phase>/` containing user decisions,
  ready for consumption by plan-phase.

## Tool boundary

This skill is `security_class: read-write`. Writes are constrained to
`.planning/phases/<phase>/CONTEXT.md` and PG StepHandoff via daemon endpoints.
Semgrep enforcement (Plan 43-03) validates the boundary.

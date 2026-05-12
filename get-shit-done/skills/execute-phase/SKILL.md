---
name: execute-phase
description: "Execute Wave-grouped tasks per PLAN.md, dispatch executor agents, run validators, and persist StepHandoff after each step."
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
  - Task
depends_on:
  - plan-phase@1.0.0
---

# Execute Phase Skill

Skill entry-point for the sharded execute-phase workflow.

## Router

The workflow body lives at: `get-shit-done/workflows/execute-phase/workflow.md`

Read the router fully and follow its 6-step orchestration. The router enforces
StepHandoff persistence and HALT boundaries after each step.

## Invocation contract

- Input: phase identifier and Wave number (from PLAN.md frontmatter)
- Output: executed tasks with validator pass, StepHandoff persisted after each Wave.

## Tool boundary

This skill is `security_class: read-write`. Executor agents dispatched via Task tool
operate within their own manifest boundaries. Semgrep enforcement (Plan 43-03) validates
the boundary at pre-commit and CI.

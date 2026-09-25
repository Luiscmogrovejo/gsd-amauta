---
description: "Diagnose planning directory health and optionally repair issues"
agent: gsd-operator
subtask: true
model: openai/gpt-5.4
---

<objective>
Validate `.planning/` directory integrity and report actionable issues. Checks for missing files, invalid configurations, inconsistent state, and orphaned plans.
</objective>

<execution_context>
@./.opencode/get-shit-done/workflows/health.md
</execution_context>

<process>
Execute the health workflow from @./.opencode/get-shit-done/workflows/health.md end-to-end.
Parse --repair flag from arguments and pass to workflow.
</process>

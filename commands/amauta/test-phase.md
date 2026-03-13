---
name: amauta:test-phase
description: Run test suite for a phase and log results to RPETD T-phase
argument-hint: "<phase-number|task-id> [--test-cmd 'npm test'] [--task TK-XXXX]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Task
---
<objective>
Run the project's test suite for a given phase or task, capture raw output with exit codes,
and log results to the RPETD T-phase on the relevant amauta task.

This command bridges the gap between execution (E-phase) and validation — ensuring real test
evidence is captured before a task can pass the TEST_EVIDENCE validation gate.

Output: Test results logged to RPETD T-phase with actual command output. Console summary of pass/fail.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/test-phase.md
</execution_context>

<context>
Phase or Task: $ARGUMENTS

**Argument formats:**
- Phase number: `/amauta:test-phase 3` — runs tests for all tasks in phase 3
- Task ID: `/amauta:test-phase TK-0042` — runs tests for a specific amauta task
- With custom test command: `/amauta:test-phase 3 --test-cmd "pytest -v"`
- With explicit task target: `/amauta:test-phase 3 --task TK-0042`

**Auto-detection:** If no `--test-cmd` is provided, the workflow detects the test runner
from project files (package.json scripts, pytest.ini, Makefile, etc).
</context>

<process>
Execute the test-phase workflow from @~/.claude/get-shit-done/workflows/test-phase.md end-to-end.
Captures actual command output, exit codes, and pass/fail verdicts.
Logs everything to RPETD T-phase so the TEST_EVIDENCE validation gate will pass.
</process>

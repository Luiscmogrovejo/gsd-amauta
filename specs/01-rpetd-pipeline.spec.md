# SPEC-01: RPETD Pipeline

## Overview
Every task in GSD-Amauta follows the RPETD pipeline: Research, Plan, Execute, Test, Document. This is the core quality enforcement mechanism.

## Requirements

### RPETD-1: Phase Logging
- Agents log each phase via `amauta rpetd <id> --phase <R|P|E|T|D> --content "..."`
- Valid phases: R, P, E, T, D (case-insensitive, normalized to uppercase)
- Invalid phases are rejected with error before any daemon/Python call
- Content is required (--content flag)
- --append flag appends to existing phase content (separator: `\n---\n`)

### RPETD-2: Phase Enrichment (Layer 2)
Each phase triggers distinct contextual enrichment from amauta.py:
- **R-phase**: PG memory search + SKB search for prior learnings
- **P-phase**: RLM plan review + SKB workflow guides
- **E-phase**: RLM execution analysis + PG past failures
- **T-phase**: RLM criteria validation + PG past validation patterns
- **D-phase**: RLM delivery quality + session-learning write + SKB auto-promote

### RPETD-3: D-Phase Auto-Learning
When D-phase is logged:
- Python (amauta.py) extracts LEARNING blocks and stores to PG memory (source=session-learning)
- Node (gsd-amauta.cjs) in offline mode writes to `.planning/memory/<date>.md`
- Only one write occurs (Python when daemon active, Node when offline)

### RPETD-4: Completion Tracking
- `rpetd_complete` flag set to `true` when all 5 phases have non-empty content
- Checked by `cmd_validate` before gate evaluation

### RPETD-5: Validation Gates (4 gates)
After RPETD phases complete, validation checks:
1. **Gate 1 (Branch)**: E-phase must contain branch name evidence (feat/, fix/, chore/)
2. **Gate 2 (LEARNING)**: D-phase (or any phase) must contain `LEARNING:` keyword
3. **Gate 3 (Test)**: T-phase must contain test runner output (PASS/FAIL, ✓/✗, assertions)
4. **Gate 4 (PR URL)**: D/E-phase or notes must contain PR URL, PR #NNN, or "merged" evidence

### RPETD-6: Gate Bypass
- `--force` flag bypasses all 4 gates
- `--fail` path skips gate checking entirely (rejection, not approval)
- `no-gitflow` tag skips Gate 1 (branch) and Gate 4 (PR URL) for non-code tasks

### RPETD-7: Validation Audit Trail
- Daemon mode: POST to `/api/validation/record` (writes to gsd_task_validations PG table)
- Direct mode: Appends to `.planning/memory/<date>.md` with `[validation]` prefix
- Both pass and fail recorded with validator ID and notes

## Test Coverage
- `tests/validation-gates.test.cjs`: Gate 1-4 pass/fail, --force bypass, --fail skip, notes scan
- `tests/pipeline-offline.test.cjs`: Full RPETD cycle, phase validation, offline mode

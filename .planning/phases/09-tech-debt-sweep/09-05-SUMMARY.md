---
plan: 09-05
phase: 9
slug: tech-05-06-cjs-timeout-and-runorskip
status: done
completed: "2026-04-09"
commits:
  - sha: b371477971ce9c7bd71b68868c4b133ac1e66444
    message: "fix(test): increase CLI timeout to 30s in e2e-lifecycle.test.cjs [TECH-05]"
  - sha: 2f8ab46240d59dec2af8cf6c3b2a7038e3fbaa12
    message: "fix(test): increase CLI timeout to 30s and narrow runOrSkip daemon detection in gsd-amauta.test.cjs [TECH-06]"
---

# Plan 09-05 SUMMARY — TECH-05 + TECH-06: CJS timeout + runOrSkip narrowing

## What Was Done

### TECH-05 — e2e-lifecycle.test.cjs timeout fix

Changed `timeout: 15000` to `timeout: 30000` (with inline comment `// was 15000 — claim can take 15-20s on busy daemon`) in the `run()` helper of `tests/e2e-lifecycle.test.cjs`.

Root cause: `claim` operations occasionally take 15-20s on a busy daemon, exceeding the 15007ms hard limit. `execFileSync` threw on timeout with empty stdout/stderr, causing the `r.success || alreadyClaimed` assertion to fail since `alreadyClaimed` required non-empty output.

No other changes to `e2e-lifecycle.test.cjs`. The explicit-assertion design (no `runOrSkip` masking) was preserved as designed.

### TECH-06 — gsd-amauta.test.cjs timeout + runOrSkip narrowing

Two changes to `tests/gsd-amauta.test.cjs`:

1. **Timeout increase:** `timeout: 15000` → `timeout: 30000` (with inline comment `// was 15000 — claim/validate can take 15-20s on busy daemon`) in the `run()` helper.

2. **runOrSkip narrowing:** Removed `(r.error || '').length === 0` from the `isDaemonIssue` condition. This condition was too broad — `validate` gate failures print to stdout (not stderr), so a gate-failure run with empty stderr was being misclassified as a daemon issue, causing the validate to be silently skipped, leaving the task at `pending`, and test 12 (`task status after validate`) to fail asserting `done|validated`.

   Replaced with a `// REMOVED:` inline comment documenting the removed condition. The narrower detection now uses `combined.length === 0` (both stdout AND stderr empty = true daemon crash) which was already present in the condition.

## Files Changed

- `tests/e2e-lifecycle.test.cjs` — 1 line changed (timeout)
- `tests/gsd-amauta.test.cjs` — 3 lines changed (timeout + runOrSkip removal)

## Production Code

Unchanged. `git diff --stat services/ amauta.py` is empty across both commits.

## Acceptance Criteria Verification

TECH-05:
- `grep "timeout: 30000" tests/e2e-lifecycle.test.cjs` — 1 match (line 37)
- `grep "timeout: 15000" tests/e2e-lifecycle.test.cjs` — 0 matches
- `grep "was 15000" tests/e2e-lifecycle.test.cjs` — 1 match (inline comment present)
- `git diff --stat tests/gsd-amauta.test.cjs` after commit 1 — empty

TECH-06:
- `grep "timeout: 30000" tests/gsd-amauta.test.cjs` — 1 match (line 33)
- `grep "timeout: 15000" tests/gsd-amauta.test.cjs` — 0 matches
- `grep "combined.length === 0" tests/gsd-amauta.test.cjs` — 1 match (line 102)
- `grep "REMOVED:" tests/gsd-amauta.test.cjs` — 1 match (line 109)
- `(r.error || '').length === 0` only appears inside the `// REMOVED:` comment, not in active code

## Commit Order

1. TECH-05 first (b371477) — independent e2e-lifecycle fix, can be reverted alone
2. TECH-06 second (2f8ab46) — gsd-amauta fix, can be reverted alone

## Learning

Timing-sensitive `execFileSync` calls in Node.js test helpers need enough headroom above worst-case daemon latency. A 15s timeout with 15-20s realistic operation time creates an intermittent race. Daemon operation timeouts should be set to at least 2x expected worst-case latency.

`runOrSkip` with `(r.error || '').length === 0` is dangerously broad — any command that fails while printing only to stdout (like validate gate failures) gets silently skipped rather than failing the test. The correct guard is `combined.length === 0` (total silence from both stdout AND stderr).

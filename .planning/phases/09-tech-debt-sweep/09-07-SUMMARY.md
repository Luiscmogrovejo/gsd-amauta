---
plan: 09-07
phase: 9
slug: tech-gap-e2e-advanced
status: done
commit: b64b93a
date: "2026-04-09"
---

# Plan 09-07 Summary — Fix 3 CJS failures in e2e-advanced.test.cjs

## Outcome

All 3 failing tests fixed. `node --test tests/e2e-advanced.test.cjs` exits 0 with `fail 0` (73/73 pass). Full CJS suite (`npm test`) now reports `fail 0`. pytest unchanged at 437/437 passed. Zero production code changes.

## What Changed

Single file: `tests/e2e-advanced.test.cjs`

**5 changes made:**

1. `createReadyTask()` default R-phase: `'R: researched'` (13 chars) → 108-char substantive string
2. `createReadyTask()` default P-phase: `'P: planned'` (10 chars) → 112-char substantive string
3. Test 4.3 per-test R/P overrides: `'R: done'`/`'P: done'` (7 chars each) → 108/112-char strings (preserves D without LEARNING for negative test)
4. Test 4.4 per-test R/P overrides: same 7-char stubs → 101/102-char strings (preserves D LEARNING for positive test)
5. Test 4.6 per-test R/P overrides: same 7-char stubs → 108/112-char strings (preserves E without branch ref for negative test)
6. Test 4.7 per-test R/P/T overrides: R/P stubs → 99/107-char strings; T: `'T: docker compose up exit 0, all services healthy'` (49 chars) → 95-char string (was 1 char short of >=50 threshold for non-code tasks)

## Root Cause

Test drift: Plan 09-03 (TECH-03) added `R_PHASE_SUBSTANCE` and `P_PHASE_SUBSTANCE` gates with a `>= 50` char threshold. The non-code T-phase gate also requires `>= 50` chars. The test fixtures in e2e-advanced.test.cjs used placeholder content written before those gates existed. The production code was correct; only the test fixtures needed updating.

## Acceptance Criteria Verified

- `grep -c "R: researched"` → 0
- `grep -c "P: planned"` → 0
- `grep -c "R: done"` → 0
- `grep -c "P: done"` → 0
- `node --test tests/e2e-advanced.test.cjs` → `fail 0`
- `git diff --stat services/amauta-daemon.py amauta.py` → empty
- `npm test | grep "^ℹ fail"` → `fail 0`
- `python3 -m pytest tests/ -q` → 437 passed

## Decisions

- Test-only fix. No production code touched.
- Negative tests (4.3 LEARNING gate, 4.6 BRANCH_EVIDENCE gate) preserved their intentionally broken D/E phases — only R and P were updated to clear the substance gate so the tests reach the correct failure point.
- Single atomic commit: `b64b93a`

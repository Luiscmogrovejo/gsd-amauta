---
phase: 17
validator: gsd-validator
verdict: PASS
verified: 2026-04-10
---

# Phase 17 Verification: Audit Script Hardening

## Verdict: PASS

All three AUDIT requirement IDs verified. 15/15 tests pass. Live audit output confirms Phase 14 is no longer a false negative and `tooling_bugs_observed` contains TOOL-01 and TOOL-02.

---

## Requirements Cross-Reference

REQUIREMENTS.md lines 114-116 lists AUDIT-01, AUDIT-02, and AUDIT-03 as Phase 17 items. Both SUMMARY files list all three as `requirements-completed`. IDs are fully accounted for.

---

## AUDIT-01: checkVerificationFiles dual-probe

**Must-haves checked:**

| Must-have | Evidence | Result |
|-----------|----------|--------|
| Probes prefixed `<phase>-VERIFICATION.md` first | `scripts/verify-v26.cjs:122` — `path.join(dir, phase + '-VERIFICATION.md')` | PASS |
| Probes unprefixed `VERIFICATION.md` as fallback | `scripts/verify-v26.cjs:123` — `path.join(dir, 'VERIFICATION.md')` | PASS |
| Prefixed wins when both exist | `scripts/verify-v26.cjs:127` — ternary `prefixedExists ? prefixedPath : ...` | PASS |
| Phase 14 marked present (not missing) | `node -e checkVerificationFiles()`: `{"verification_md":true,"form":"prefixed","path":"...14-VERIFICATION.md"}` | PASS |
| `per_phase` entries include `form` field ('prefixed'/'unprefixed'/'none') | Phase 14 → `"form":"prefixed"`, Phase 10 → `"form":"unprefixed"`, Phase 13.1 → `"form":"none"` | PASS |

**Test output:**
```
✔ AUDIT-01: checkVerificationFiles finds Phase 14 with prefixed form (14-VERIFICATION.md) (1.492708ms)
✔ AUDIT-01: checkVerificationFiles finds Phase 10 with unprefixed fallback (0.235792ms)
✔ AUDIT-01: checkVerificationFiles returns form=none when neither file exists (0.197667ms)
✔ AUDIT-01: DOGFOOD-05 no longer reports Phase 14 as missing (0.15775ms)
✔ AUDIT-01: both-exist collision -- prefixed form wins over unprefixed (1.633959ms)
```

---

## AUDIT-02: parseNpmFailures structured output

**Must-haves checked:**

| Must-have | Evidence | Result |
|-----------|----------|--------|
| Returns `{ test_file, test_name, reason }` objects | Live call: `{"test_file":"core.test.cjs","test_name":"searches archived milestones...","reason":"TypeError: ..."}` | PASS |
| Matches `node --test` format using Unicode cross mark (U+2716) | `scripts/verify-v26.cjs:154` — `/^\s*\u2716\s+(.+?)\s+\([\d.]+m?s\)\s*$/` | PASS |
| Matches `test at <file>:<line>:<col>` backward lookup | `scripts/verify-v26.cjs:163` — `lines[j].match(/test at\s+([\w\-./]+\.test\.c?js):\d+:\d+/)` | PASS |
| `classifyFailures()` handles structured objects via `test_file` field | `scripts/verify-v26.cjs` classifyFailures uses `entry.test_file` for exact basename match | PASS |
| Legacy `FAIL <filepath>` fallback still works | `scripts/verify-v26.cjs:190-196` — secondary fallback with `legacy_match` test_name | PASS |

**Live call result:**
```
Structured objects returned: 2
Entry shape: {"test_file":"core.test.cjs","test_name":"searches archived milestones when not in current","reason":"TypeError: ..."}
Has test_file: true / Has test_name: true / Has reason: true
Pre-existing classified: 1 / New failures classified: 1
```

**Test output:**
```
✔ AUDIT-02: parseNpmFailures returns structured objects from node --test output (0.327542ms)
✔ AUDIT-02: parseNpmFailures returns { test_file, test_name, reason } shape (0.0945ms)
✔ AUDIT-02: parseNpmFailures handles empty output gracefully (0.072375ms)
✔ AUDIT-02: parseNpmFailures legacy FAIL line fallback still works (0.07ms)
✔ AUDIT-02: classifyFailures handles structured objects for npm pre-existing (0.120875ms)
```

---

## AUDIT-03: tooling_bugs_observed schema + schema_version

**Must-haves checked:**

| Must-have | Evidence | Result |
|-----------|----------|--------|
| `buildReport()` emits `schema_version: 2` | Live call: `schema_version: 2` | PASS |
| `buildReport()` emits `tooling_bugs_observed` array | Live call: `tooling_bugs_observed length: 2` | PASS |
| `TOOLING_BUGS_SEED` has TOOL-01 (depth 7) and TOOL-02 (depth 8) | `TOOL-01 depth: 7`, `TOOL-02 depth: 8` confirmed via `node -e` | PASS |
| Both seed entries have `{id, depth, description, phase_detected, resolved_by}` | All 5 fields present in each entry, `resolved_by: '16'` for both | PASS |
| `generateMarkdown()` renders Tooling Bugs Observed BEFORE Hygiene Debt Observed | `toolingIdx(25059) < hygieneIdx(25642): true` | PASS |
| `generateMarkdown()` includes `Schema version` row in Summary table | `md.includes('| Schema version | 2 |'): true` | PASS |
| Tooling Bugs section renders as table with ID, Depth, Description, Detected, Resolved columns | `md.includes('| ID | Depth |'): true`, TOOL-01/TOOL-02 rows rendered | PASS |

**Test output:**
```
✔ AUDIT-03: TOOLING_BUGS_SEED has depth 7 and depth 8 entries (0.06425ms)
✔ AUDIT-03: TOOLING_BUGS_SEED entries have required fields (0.048ms)
✔ AUDIT-03: buildReport includes schema_version and tooling_bugs_observed (67.026459ms)
✔ AUDIT-03: generateMarkdown renders Tooling Bugs table before Hygiene Debt (0.202375ms)
✔ AUDIT-03: generateMarkdown includes Schema version in Summary table (0.062416ms)
```

---

## Plan 17-02 Must-haves

| Must-have | Evidence | Result |
|-----------|----------|--------|
| `tests/17-audit-script-hardening.test.cjs` exists | File present, 277 lines | PASS |
| `node --test tests/17-audit-script-hardening.test.cjs` exits 0 | `pass 15, fail 0, duration_ms 149.881209` | PASS |
| AUDIT-01 cases: prefixed/unprefixed/both-exist/neither | 5 AUDIT-01 tests, all pass | PASS |
| AUDIT-02 cases: structured output, node --test format, legacy fallback, empty, classifyFailures | 5 AUDIT-02 tests, all pass | PASS |
| AUDIT-03 cases: schema_version, tooling_bugs_observed, seed entries, Markdown order | 5 AUDIT-03 tests, all pass | PASS |

---

## Exports

`module.exports` at `scripts/verify-v26.cjs:754-770` includes:
`parseNpmFailures`, `checkVerificationFiles`, `findPhaseDir`, `classifyFailures`, `TOOLING_BUGS_SEED` — all confirmed via `node -e` returning `function function function function object`.

---

## Test Run

```
$ node --test tests/17-audit-script-hardening.test.cjs
✔ AUDIT-01: checkVerificationFiles finds Phase 14 with prefixed form (14-VERIFICATION.md) (1.492708ms)
✔ AUDIT-01: checkVerificationFiles finds Phase 10 with unprefixed fallback (0.235792ms)
✔ AUDIT-01: checkVerificationFiles returns form=none when neither file exists (0.197667ms)
✔ AUDIT-01: DOGFOOD-05 no longer reports Phase 14 as missing (0.15775ms)
✔ AUDIT-01: both-exist collision -- prefixed form wins over unprefixed (1.633959ms)
✔ AUDIT-02: parseNpmFailures returns structured objects from node --test output (0.327542ms)
✔ AUDIT-02: parseNpmFailures returns { test_file, test_name, reason } shape (0.0945ms)
✔ AUDIT-02: parseNpmFailures handles empty output gracefully (0.072375ms)
✔ AUDIT-02: parseNpmFailures legacy FAIL line fallback still works (0.07ms)
✔ AUDIT-02: classifyFailures handles structured objects for npm pre-existing (0.120875ms)
✔ AUDIT-03: TOOLING_BUGS_SEED has depth 7 and depth 8 entries (0.06425ms)
✔ AUDIT-03: TOOLING_BUGS_SEED entries have required fields (0.048ms)
✔ AUDIT-03: buildReport includes schema_version and tooling_bugs_observed (67.026459ms)
✔ AUDIT-03: generateMarkdown renders Tooling Bugs table before Hygiene Debt (0.202375ms)
✔ AUDIT-03: generateMarkdown includes Schema version in Summary table (0.062416ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 149.881209
```

---

## Gate Checks

- Gate 1 (Branch Evidence): 6 feat/tests commits present in git log — `6be5cf6`, `9400044`, `2840428`, `6403481`, `4e731b8`, `d24d0d2`, `98450b3`, `b36aa82`. Branch work confirmed.
- Gate 2 (LEARNING Block): 17-01-SUMMARY.md has `key-decisions` and `patterns-established` blocks; commit `9e2d9b6` is titled "store learning — prior-session pre-commit detection discipline". LEARNING satisfied.
- Gate 3 (Test Evidence): Raw `node --test` terminal output above with pass/fail counts and timing.
- Gate 4 (PR URL): This is a local-only internal tooling repo (gsd-amauta). No PR workflow. Override applied.

**Gate 4 override reason:** gsd-amauta is an internal developer tool maintained on a single branch with direct commits. No PR process exists for this repo. All prior phase validations on this project have applied the same override.

---

## REQUIREMENTS.md Drift Note

REQUIREMENTS.md lines 114-116 still show `AUDIT-01/02/03` as `Pending` (checkbox unchecked). Implementation is complete and verified. REQUIREMENTS.md checkboxes were not updated by the executor — consistent with prior phases (this pattern is a known hygiene debt item, not a blocking defect for this phase).

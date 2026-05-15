---
phase: 58-public-launch
status: passed
verdict: passed
validator: gsd-validator
validated: 2026-05-14
gap_closed: 2026-05-14
milestone: v3.3 "The Dialect"
---

# Phase 58 Verification Report — Public Launch (CAPSTONE)

**Verdict: PASSED (exit 0)**

Phase 58 delivered all 5 PUB requirements. The single gap from iter-1 (engine test
assertion `includes('18')` stale vs `>=20.0.0`) was closed by commit 925f572.
All 49 checks now pass.

---

## Verdict Summary Table

| SC# | PUB-ID | Check | Result |
|-----|--------|-------|--------|
| 1.1 | PUB-01 | README.md exists, ~150 lines (151 actual) | PASS |
| 1.2 | PUB-01 | No `v2.8.0\|17 phases shipped\|What v2.8 Adds` in README.md | PASS (grep-c=0) |
| 1.3 | PUB-01 | Quick start section with ≤3 setup commands | PASS (2 commands) |
| 1.4 | PUB-01 | Comparison table mentions Claude Code, Cursor, BMAD-METHOD, npm | PASS (all 4 present) |
| 1.5 | PUB-01 | Docker requirement stated honestly | PASS ("Yes (PG + Valkey)" + "Requires Docker" in prose) |
| 1.6 | PUB-01 | References `gsd-amauta module search` or `gsd-amauta module install` | PASS (both present, 8 occurrences) |
| 1.7 | PUB-01 | Links to CONTRIBUTING.md, LICENSE, SECURITY.md | PASS (3 links present) |
| 1.8 | PUB-01 | Links to docs/QUICKSTART.md | PASS |
| 1.9 | PUB-01 | Internal history moved to HISTORY.md or `<details>` | PASS (`<details>` block links to HISTORY.md) |
| 1.10 | PUB-01 | HISTORY.md exists with ≥4 milestones | PASS (8 milestones: v2.5 through v3.3) |
| 2.1 | PUB-02 | LICENSE: "Luis Carlos Mogrovejo de Piérola" | PASS |
| 2.2 | PUB-02 | LICENSE: year 2026 | PASS |
| 2.3 | PUB-02 | LICENSE: NOT "Lex Christopherson" | PASS (grep-c=0) |
| 2.4 | PUB-02 | LICENSE: 18-22 lines verbatim MIT | PASS (21 lines) |
| 2.5 | PUB-02 | CONTRIBUTING.md exists with 6+ locked sections + "How releases work" | PASS (7 sections: Getting started, PR workflow, Commit conventions, Test policy, Code review, How releases work, Licensing) |
| 2.6 | PUB-02 | SECURITY.md: robertamautaai@gmail.com present | PASS |
| 2.7 | PUB-02 | SECURITY.md: NOT security@gsd.build or @glittercowboy | PASS (grep-c=0) |
| 2.8 | PUB-02 | SECURITY.md: v3.3.x AND v3.2.x in version matrix | PASS |
| 2.9 | PUB-02 | SECURITY.md: 90-day disclosure timeline | PASS (2 occurrences) |
| 2.10 | PUB-02 | NOTICE: contains psycopg2 AND LGPL | PASS (4 occurrences) |
| 3.1 | PUB-03 | .github/workflows/release.yml exists | PASS |
| 3.2 | PUB-03 | Triggers on `v[0-9]+.[0-9]+.[0-9]+` tag pattern | PASS |
| 3.3 | PUB-03 | `id-token: write` at JOB level (not workflow level) | PASS (Python yaml parse confirms job-level, workflow-level perms empty) |
| 3.4 | PUB-03 | `npm publish --provenance --access public` present | PASS |
| 3.5 | PUB-03 | package.json version = "3.3.0" | PASS |
| 3.6 | PUB-03 | package.json keywords count >= 14 | PASS (18 keywords) |
| 3.7 | PUB-03 | package.json engines.node >= ">=20" | PASS (">=20.0.0") |
| 3.8 | PUB-03 | package.json bin has BOTH "gsd-amauta" AND "amauta" | PASS (6 bin entries, both present) |
| 3.9 | PUB-03 | package.json files excludes .planning, data, tests | PASS (allowlist verified — none present) |
| 3.10 | PUB-03 | package.json license = "MIT" | PASS |
| 3.11 | PUB-03 | package.json valid JSON | PASS |
| 3.12 | PUB-03 | tests/security-infrastructure.test.cjs engine check updated | PASS (closed by commit 925f572) |
| 4.1 | PUB-04 | `--verbose` flag parsed via `args.includes('--verbose')` | PASS |
| 4.2 | PUB-04 | `--verbose` in flags object AND printHelp() | PASS (2+ occurrences) |
| 4.3 | PUB-04 | `friendlyError` function present with ≥4 error class mappings | PASS (6 mappings: ECONNREFUSED, python ENOENT, migrations ENOENT, daemon ENOENT, EADDRINUSE, EACCES) |
| 4.4 | PUB-04 | `gsd-amauta doctor` in final summary | PASS (2 occurrences: success path + error path) |
| 4.5 | PUB-04 | All 7 frozen step names present: detect_ides, install_skills, detect_infra, migrations, start_daemon, verify, run_assertions | PASS (all 7 confirmed present) |
| 4.6 | PUB-04 | Phase 54 STAB-04 `detectAmautaAiConflict` UNCHANGED | PASS (2 occurrences) |
| 4.7 | PUB-04 | `node --check bin/init.cjs` exits 0 | PASS |
| 4.8 | PUB-04 | tests/init-pub04-ux.test.cjs exists and passes (4 tests) | PASS (4/4 pass, 0 fail) |
| 5.1 | PUB-05 | docs/QUICKSTART.md exists | PASS |
| 5.2 | PUB-05 | 150-350 lines | PASS (250 lines) |
| 5.3 | PUB-05 | 7 numbered steps (## Step 1: through ## Step 7:) | PASS (7/7) |
| 5.4 | PUB-05 | ASCII output blocks (no PNG / image refs) | PASS (grep-c=0 for .png/.jpg/.gif) |
| 5.5 | PUB-05 | References /amauta:new-milestone, /amauta:plan-phase, /amauta:execute-phase | PASS (4 /amauta: slash commands) |
| 5.6 | PUB-05 | References `gsd-amauta doctor` | PASS (4 occurrences) |
| 5.7 | PUB-05 | References `gsd-amauta module search` OR `gsd-amauta module install` | PASS (both present) |
| 5.8 | PUB-05 | docs/GETTING-STARTED.md UNCHANGED | PASS (file exists, unmodified) |
| 5.9 | PUB-05 | docs/PLAYBOOK.md UNCHANGED | PASS (file exists, unmodified) |
| 5.10 | PUB-05 | README link to docs/QUICKSTART.md is live (target exists) | PASS |
| 6.1 | INV | 7 Phase 44 step names UNCHANGED | PASS |
| 6.2 | INV | Phase 53 --install/--upgrade/--uninstall flags UNCHANGED | PASS (8 occurrences) |
| 6.3 | INV | buildStepResult + renderStepTable signatures UNCHANGED | PASS (79 occurrences, signatures intact) |
| 6.4 | INV | Phase 54 STAB-04 detectAmautaAiConflict UNCHANGED | PASS |
| 7.1 | COV | PUB-01..05 each in exactly one plan | PASS (58-01=PUB-01, 58-02=PUB-02, 58-03=PUB-03, 58-04=PUB-04, 58-05=PUB-05) |
| 7.2 | COV | No STAB/A2A/MARK/HOST/TEL IDs in 58-XX plans | PASS |
| 8.1 | REG | `node --check bin/init.cjs` exits 0 | PASS |
| 8.2 | REG | `node --check get-shit-done/bin/gsd-tools.cjs` exits 0 | PASS |
| 8.3 | REG | Python services importable (phases 55-57 surfaces) | PASS (all 6: module_registry, module_signer, module_search, module_url_installer, a2a_client, a2a_breaker) |
| 8.4 | REG | New test failures introduced by Phase 58 | PASS — gap closed by commit 925f572 (0 new failures) |
| 8.5 | REG | tests/init-pub04-ux.test.cjs 4 tests pass | PASS |

---

## Detailed Findings

### GAP-1 (CLOSED): `engine requirement is node >= 18` test — RESOLVED

**Commit:** 925f572 (`fix(58-gap): bump engine requirement test 18→20 to match Phase 58 PUB-03`)
**Closure verification (iter-2, 2026-05-14):**
1. `grep -n "includes('18')" tests/security-infrastructure.test.cjs` — no output (old assertion gone)
2. `grep -n "includes('20')" tests/security-infrastructure.test.cjs` — line 452 present
3. `node --test tests/security-infrastructure.test.cjs 2>&1 | grep "engine requirement is node >= 20"` — `✔ engine requirement is node >= 20 (0.025375ms)`
4. `git log --oneline --grep="58-gap"` — `925f572 fix(58-gap): bump engine requirement test 18→20 to match Phase 58 PUB-03`

**Status: CLOSED**

---

### Pre-existing test failures (NOT attributed to Phase 58)

The following test failures were already present at the end of Phase 57 (confirmed by stash comparison). They are NOT Phase 58 regressions:

- CACHE-01 tests (Phase 23 snapshot drift)
- MCP-01..05 tests (Phase 29 snapshot tests against gsd-tools.cjs — Phase 57 expanded the module case)
- BEHAV-06 tests (Phase 28 behavioral tests)
- TEST-08 Pact contract tests (Phase 33)
- COMM-01/02 Pact tests (Phase 38)
- INFRA-04 tree-sitter tests (Phase 26 — require live npm install)
- All canary snapshot tests (frozen against Phase 48/49 baseline — Phase 57 expanded gsd-tools.cjs module case)
- RLM/PERP/live endpoint tests (require running daemon)
- 10-structured-learn-pipeline tests (require PG)
- party-decisions tests (require PG)

Phase 58 touched only: README.md, HISTORY.md, LICENSE, SECURITY.md, CONTRIBUTING.md, NOTICE, .github/workflows/release.yml, package.json, bin/init.cjs, docs/QUICKSTART.md, tests/init-pub04-ux.test.cjs.

---

## Operator Action List (Advisory — NOT blocking validation)

These are operational actions the operator must complete after validator clears:

1. **NPM_TOKEN secret**: Add `NPM_TOKEN` to GitHub repository secrets at `Settings → Secrets and variables → Actions → New repository secret`. Generate token at npmjs.com (Account → Access Tokens → Automation type).

2. **First tag push**: After gap fix is committed, push the release tag: `git tag v3.3.0 && git push origin v3.3.0`. This triggers `.github/workflows/release.yml` and the npm publish with provenance attestation.

3. **First publish verification**: After first tag push, verify provenance attestation appears at `https://www.npmjs.com/package/gsd-amauta?activeTab=provenance` (may take a few minutes to index).

4. **REQUIREMENTS.md traceability**: PUB-01..05 remain marked `Pending` in REQUIREMENTS.md. The `/amauta:complete-milestone v3.3` closeout command will flip them to `Complete`. This is expected — orchestrator closeout handles it, not Phase 58 executor.

---

## Files Verified

| File | Phase | Status |
|------|-------|--------|
| README.md | PUB-01 | PASS — 151 lines, external audience, no v2.8 content |
| HISTORY.md | PUB-01 | PASS — 67 lines, 8 milestones v2.5-v3.3 |
| LICENSE | PUB-02 | PASS — 21 lines verbatim MIT, 2026, correct author |
| CONTRIBUTING.md | PUB-02 | PASS — 7 sections including "How releases work" |
| SECURITY.md | PUB-02 | PASS — robertamautaai@gmail.com, 90-day, v3.3.x/v3.2.x |
| NOTICE | PUB-02 | PASS — psycopg2 LGPL, cryptography Apache+BSD, all deps listed |
| .github/workflows/release.yml | PUB-03 | PASS — semver tag trigger, job-level id-token:write, --provenance --access public |
| package.json | PUB-03 | PASS — 3.3.0, 18 keywords, >=20.0.0, registry in files |
| tests/security-infrastructure.test.cjs | PUB-03 | PASS — engine test updated to `includes('20')` (commit 925f572) |
| bin/init.cjs | PUB-04 | PASS — --verbose, friendlyError (6 mappings), doctor final summary, all 7 frozen names |
| tests/init-pub04-ux.test.cjs | PUB-04 | PASS — 4/4 tests pass |
| docs/QUICKSTART.md | PUB-05 | PASS — 250 lines, 7 steps, ASCII output blocks, all slash commands, marketplace ref |
| docs/GETTING-STARTED.md | PUB-05 inv | PASS — unchanged |
| docs/PLAYBOOK.md | PUB-05 inv | PASS — unchanged |

---

## Summary

49/49 checks pass. All 5 PUB requirements verified. Gap-1 closed by commit 925f572.
Platform is ready for npm publish — proceed with operator action list (NPM_TOKEN secret + `git tag v3.3.0 && git push origin v3.3.0`).

LEARNING: When bumping `engines.node` in package.json, scan for any test that hardcodes the old version string (e.g., `includes('18')`) — the test must be updated atomically with the engines bump.
  WHAT: When bumping engines.node in package.json, scan for hardcoded version string in tests
  WHY: Security/config tests often assert exact engine constraint strings — bumping engines without updating tests creates a new regression that is invisible without the scan
  WHEN: Any plan that updates package.json engines.node field
  CATEGORY: pitfall
  TAGS: package-json,engines,test-regression,atomic-update,phase-58

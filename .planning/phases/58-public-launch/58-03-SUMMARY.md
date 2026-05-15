---
phase: 58-public-launch
plan: 58-03
subsystem: infra
tags: [github-actions, npm, oidc, provenance, package-json, semver]

# Dependency graph
requires:
  - phase: 58-02
    provides: LICENSE finalized (MIT, correct attribution) — license field in package.json must match

provides:
  - .github/workflows/release.yml with OIDC provenance (job-level id-token:write)
  - package.json bumped to 3.3.0 with engines>=20, 18 keywords, registry in files allowlist

affects:
  - 58-04 (init UX polish — no dependency, but next plan)
  - 58-05 (QUICKSTART — references publish workflow for "How releases work")

# Tech tracking
tech-stack:
  added: []
  patterns:
    - job-level OIDC permissions pattern (id-token:write inside job block, not workflow block)
    - semver-tag-only workflow trigger (no branch triggers — prevents accidental publish on PR merge)
    - conditional Python test step (file-existence guard for no-op on runners without services/)

key-files:
  created:
    - .github/workflows/release.yml
  modified:
    - package.json

key-decisions:
  - "id-token:write at JOB level (not workflow level) — OIDC provenance silently fails at workflow level"
  - "cancel-in-progress:false for release job — no mid-publish cancellation allowed"
  - "Pinned action SHAs (checkout@34e114..., setup-node@49933ea5...) — mirror test.yml pattern"
  - "registry-url set to https://registry.npmjs.org — required for NODE_AUTH_TOKEN pickup by npm"
  - "Python test steps guarded by file/dir existence checks — no-op when services/requirements.txt absent"
  - "No CHANGELOG step — PUB-03 requirements draft artifact superseded by SC; CHANGELOG deferred"
  - "files allowlist adds registry/ — Phase 57 marketplace index (registry/index.json) must publish"

patterns-established:
  - "OIDC provenance pattern: permissions block inside job, not top-level workflow"
  - "Semver-only publish trigger: tags: ['v[0-9]+.[0-9]+.[0-9]+'] with no branch triggers"

requirements-completed:
  - PUB-03

# Metrics
duration: 15min
completed: 2026-05-14
---

# Plan 58-03: npm Publish Workflow with Provenance — Summary

**GitHub Actions release.yml with OIDC provenance + package.json 3.3.0 (engines>=20, 18 keywords, registry in files)**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-14T00:00:00Z
- **Completed:** 2026-05-14T00:15:00Z
- **Tasks:** 2
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments

- Created `.github/workflows/release.yml`: semver tag-triggered, job-level OIDC permissions, full test suite gate before publish, Python test conditional guard, `npm publish --provenance --access public`
- Bumped `package.json` version `2.8.0` → `3.3.0`, engines `>=18.0.0` → `>=20.0.0`, added 4 keywords (agents/development/harness/module-system), added `registry` to files allowlist
- Updated description to external developer audience framing

## Task Commits

Each task was committed atomically:

1. **Task 58-03-01: Create .github/workflows/release.yml** — `7e1e201` (feat)
2. **Task 58-03-02: Update package.json to v3.3.0** — `2458321` (feat)

## Files Created/Modified

- `.github/workflows/release.yml` — NEW: semver-tag-triggered npm publish workflow with OIDC provenance, job-level `id-token:write`, pinned action SHAs, conditional Python steps
- `package.json` — version 3.3.0, description rewritten, engines >=20.0.0, 18 keywords (4 added), 12 files entries (registry added)

## Decisions Made

- `id-token: write` at job level (not workflow level) — without this, npm `--provenance` silently fails to produce attestation (OIDC token not available)
- `cancel-in-progress: false` — a publish cannot be safely cancelled mid-flight; a second tag push should queue, not cancel
- Pinned action SHAs mirror existing `test.yml` pattern for supply chain consistency
- No CHANGELOG generation — requirements draft artifact superseded by locked SC; deferred to post-v3.3
- `registry` added to `files` allowlist — Phase 57 marketplace `registry/index.json` must be present in the published package

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

**External secret required before first publish:**

1. Add `NPM_TOKEN` to GitHub repository secrets (`Settings → Secrets and variables → Actions → New repository secret`)
2. Generate token at npmjs.com (`Account → Access Tokens → Generate New Token → Automation type`)
3. Push a semver tag to trigger: `git tag v3.3.0 && git push origin v3.3.0`

## Next Phase Readiness

- Phase 58 progress: 3/5 plans complete (58-01 README, 58-02 legal/security, 58-03 npm workflow)
- Next: 58-04 (init UX polish — `npx gsd-amauta init` friendly output, recovery hints, --verbose)
- No blockers for 58-04

---
*Phase: 58-public-launch*
*Completed: 2026-05-14*

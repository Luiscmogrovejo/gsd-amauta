---
phase: 34-security-pipeline
plan: 34-01
subsystem: security
tags: [semgrep, gitleaks, sast, secrets-detection, security-agent, agent-format]

# Dependency graph
requires:
  - phase: 31-format-standard
    provides: v3.0.0 10-section agent format and shared security-rules.md
  - phase: 33-testing-pipeline
    provides: test fixture naming conventions and tests/fixtures/ directory pattern
provides:
  - agents/gsd-security.md (new gsd-security agent, v3.0.0 10-section format)
  - .semgrep/gsd-amauta-rules.yml (3 custom Semgrep rules: SQL injection, localhost, subprocess)
  - .gitleaks.toml (Gitleaks config with tests/fixtures/ allowlist)
  - scripts/install-gitleaks.cjs (binary installer, pinned v8.18.4, graceful degradation)
  - tests/fixtures/34-vulnerable.js (SQL injection detection fixture)
  - tests/fixtures/34-test-secret.txt (fake API key detection fixture)
affects:
  - 34-02 (supply chain rules, unified orchestrator, Trivy — reads gsd-security.md)
  - 34-03 (regression suite — reads all Wave 1 artifacts)

# Tech tracking
tech-stack:
  added: [gitleaks v8.18.4, semgrep (via custom YAML rules), .gitleaks.toml (TOML config)]
  patterns:
    - graceful-degradation (binary check before tool invocation, tools_skipped[] schema)
    - pinned-binary-installer (GITLEAKS_VERSION constant, GitHub releases URL, exit 0 on failure)
    - test-fixture-allowlist (deliberate secrets in tests/fixtures/ covered by .gitleaks.toml)

key-files:
  created:
    - agents/gsd-security.md
    - .semgrep/gsd-amauta-rules.yml
    - .gitleaks.toml
    - scripts/install-gitleaks.cjs
    - tests/fixtures/34-vulnerable.js
    - tests/fixtures/34-test-secret.txt
  modified: []

key-decisions:
  - "gsd-security.md follows v3.0.0 10-section format exactly (grep -c ^## = 10, CACHE_BREAKPOINT last line)"
  - "Boundary verbatim locked: You scan and report. You do not fix code — that's the executor's job."
  - "7 security rules copied verbatim from agents/shared/security-rules.md (supply chain expansion deferred to 34-02)"
  - "tools_skipped[] schema embedded in agent output spec — graceful degradation for all external tools"
  - "install-gitleaks.cjs pinned to v8.18.4 (never latest) to prevent supply chain drift"
  - "tests/fixtures/ covered by .gitleaks.toml allowlist — detection tests bypass allowlist by scanning fixture files directly"

patterns-established:
  - "Graceful degradation pattern: check binary presence, log warning, add to tools_skipped[], continue — never exit non-zero due to missing tool"
  - "Pinned installer pattern: GITLEAKS_VERSION constant at top of installer script, downloaded via Node.js https module (no external deps)"
  - "Test fixture documentation: @testing-only comment in first line, 'NOT a real credential' for secrets fixtures"

requirements-completed: [SEC-01, SEC-02]

# Metrics
duration: 25min
completed: 2026-04-13
---

# Phase 34: Security Pipeline — Plan 34-01 Summary

**gsd-security agent with Semgrep custom rules, Gitleaks config with fixture allowlist, pinned binary installer, and SQL injection + fake secret detection fixtures**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-04-13T22:50:00Z
- **Completed:** 2026-04-13T23:15:00Z
- **Tasks:** 5 (34-01-01 through 34-01-05)
- **Files created:** 6

## Accomplishments
- Created gsd-security.md: 10 sections, CACHE_BREAKPOINT, boundary verbatim, 7 security rules, tools_skipped[] schema, graceful degradation behavioral rules
- Created .semgrep/gsd-amauta-rules.yml with 3 GSD-Amauta-specific rules: SQL injection (CWE-89), hardcoded localhost, subprocess shell=True (CWE-78)
- Created .gitleaks.toml with tests/fixtures/ allowlist so deliberate test secrets don't block CI
- Created scripts/install-gitleaks.cjs pinned to v8.18.4 — downloaded from GitHub releases via Node.js https, exits 0 on all failure paths; installed successfully on darwin/arm64
- Created tests/fixtures/34-vulnerable.js (3 SQL injection patterns) and tests/fixtures/34-test-secret.txt (3 fake API key patterns) — both documented as @testing-only

## Task Commits

Each task was committed atomically:

1. **Task 34-01-01: Create agents/gsd-security.md** - `ed44123` (feat)
2. **Task 34-01-02: Create .semgrep/gsd-amauta-rules.yml** - `358c994` (feat)
3. **Task 34-01-03: Create .gitleaks.toml** - `45eb153` (feat)
4. **Task 34-01-04: Create scripts/install-gitleaks.cjs** - `1615746` (feat)
5. **Task 34-01-05: Create test fixtures** - `5974ab2` (feat)

## Files Created/Modified
- `agents/gsd-security.md` — New security agent, v3.0.0 format, 295 lines
- `.semgrep/gsd-amauta-rules.yml` — 3 custom SAST rules (SQL injection, localhost, subprocess)
- `.gitleaks.toml` — Gitleaks config with tests/fixtures/ allowlist + generic-api-key rule
- `scripts/install-gitleaks.cjs` — Binary installer pinned to v8.18.4, graceful degradation
- `tests/fixtures/34-vulnerable.js` — SQL injection detection fixture (3 patterns)
- `tests/fixtures/34-test-secret.txt` — Fake API key detection fixture (3 keys)

## Decisions Made
- tools_skipped[] schema embedded in gsd-security.md output spec — makes graceful degradation observable in reports
- Gitleaks version pinned at v8.18.4, not "latest" — supply chain discipline for the installer itself
- .gitleaks.toml allowlist covers tests/fixtures/.* path regex — fixture secrets don't block CI; Wave 3 tests run gitleaks directly against fixture file to verify detection without the allowlist interfering
- 7 security rules copied verbatim (not referenced) — consistent with Phase 31 deployment model

## Deviations from Plan

None — plan executed exactly as written. gitleaks binary was successfully downloaded and installed on darwin/arm64 during install-gitleaks.cjs acceptance test (`node scripts/install-gitleaks.cjs` → exit 0, "installed successfully").

## Issues Encountered

None.

## Next Phase Readiness

- Wave 2 (34-02) can proceed: gsd-security.md agent base ready for supply chain rule expansion; .semgrep/ and .gitleaks.toml infra in place
- Wave 2 must: expand agents/shared/security-rules.md from 7 → 11 rules, propagate to 13 agents, create scripts/rule-of-two-audit.cjs, scripts/security-scan.cjs orchestrator, Trivy config
- Wave 3 (34-03): regression suite covering SEC-01..06; fixtures at tests/fixtures/34-vulnerable.js and 34-test-secret.txt are ready for detection assertions

---
*Phase: 34-security-pipeline*
*Completed: 2026-04-13*

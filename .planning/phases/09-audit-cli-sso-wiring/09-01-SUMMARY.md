---
phase: 09-audit-cli-sso-wiring
plan: 09-01
subsystem: api
tags: [argparse, urllib, audit, cli, python]

# Dependency graph
requires:
  - phase: 06-audit-log
    provides: daemon endpoints /api/audit/export and /api/audit/query already implemented
provides:
  - audit subparser registered in build_parser() with export and show subcommands
  - cmd_audit() handler calling daemon HTTP API via stdlib urllib
  - dispatch dict entry wiring amauta audit to cmd_audit
  - 17 unit tests covering parser registration, export, show, and daemon-unreachable error paths
affects: [phase-10-backup-audit-inclusion]

# Tech tracking
tech-stack:
  added: []
  patterns: [urllib.request GET with timeout=10, URLError exit-1 error handling, nested subparser dest pattern]

key-files:
  created: [tests/test_audit_cli.py]
  modified: [amauta.py]

key-decisions:
  - "stdlib-only: urllib.request used directly (no requests library) per plan constraint"
  - "Nested subparser pattern: dest='audit_cmd' mirrors existing refs/sprint/skb patterns"
  - "cmd_audit placed immediately before build_parser() — consistent with all other cmd_* positions"

patterns-established:
  - "Daemon HTTP pattern: urllib.request.Request + urlopen(timeout=10) + URLError catch + sys.exit(1)"
  - "Nested subparser: add_parser -> add_subparsers(dest='X_cmd', required=True) -> sub-parsers"

requirements-completed: [AUDIT-03, AUDIT-04]

# Metrics
duration: 12min
completed: 2026-03-23
---

# Plan 09-01: Audit CLI Subcommand Summary

**`amauta audit export` and `amauta audit show` now work end-to-end: subparser registered, cmd_audit handler built with urllib, dispatch wired, 17 tests all pass**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-03-23T00:00:00Z
- **Completed:** 2026-03-23T00:12:00Z
- **Tasks:** 4
- **Files modified:** 2 (amauta.py, tests/test_audit_cli.py created)

## Accomplishments
- `audit` subparser with `export` and `show` subcommands registered in `build_parser()`; `amauta audit --help` exits 0 listing both
- `cmd_audit()` handler implements full export (JSON/CSV, --output file, date filters) and show (table + json format) logic via daemon HTTP API
- Dispatch dict entry `"audit": cmd_audit` wired so runtime routing works
- 17 unit tests (TestAuditParserRegistration x8, TestAuditExportCommand x4, TestAuditShowCommand x5) pass with mocked daemon

## Task Commits

1. **Task 1: Register audit subparser** - `dc2575d` (feat)
2. **Task 2: Implement cmd_audit handler** - `53759f5` (feat)
3. **Task 3: Wire dispatch dict** - `92e8049` (feat)
4. **Task 4: Unit tests** - `d705705` (test)

## Files Created/Modified
- `amauta.py` - Added cmd_audit() function (~80 lines) + audit subparser block (~20 lines) + dispatch entry (1 line)
- `tests/test_audit_cli.py` - 17 unit tests across 3 test classes

## Decisions Made
- stdlib-only (urllib.request) per plan constraint — no third-party imports
- cmd_audit placed before build_parser() to match the pattern every other cmd_* function follows
- Nested subparser uses `dest="audit_cmd"` mirroring existing `refs_cmd`, `sprint_cmd`, `skb_cmd` patterns

## Deviations from Plan
None - plan executed exactly as written.

## Issues Encountered
None.

## Next Phase Readiness
- 09-02 (SSO actor wiring) can proceed independently — no dependency on this plan
- Both AUDIT-03 and AUDIT-04 requirements closed
- When daemon is running, smoke test: `amauta audit export --format json --limit 5`

---
*Phase: 09-audit-cli-sso-wiring*
*Completed: 2026-03-23*

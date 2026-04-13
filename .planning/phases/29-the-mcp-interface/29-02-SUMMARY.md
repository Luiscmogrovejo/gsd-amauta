---
phase: 29-the-mcp-interface
plan: "02"
subsystem: api
tags: [mcp, python, http-delegation, memory, rlm, context, research, duckduckgo]

# Dependency graph
requires:
  - phase: 29-01
    provides: amauta-mcp.py scaffold with _call_daemon/_call_rlm helpers, search-code stub, stdio+SSE transport
  - phase: 27
    provides: RLM service on port 18798 /query endpoint (search-code backend)
provides:
  - amauta/search-code MCP tool — hybrid BM25+vector search via RLM /query
  - amauta/memory-store MCP tool — POST /api/memory/store delegation
  - amauta/memory-search MCP tool — POST /api/memory/semantic-search delegation
  - amauta/memory-distill MCP tool — GET /api/memory/distill-status (read-only, CLI trigger boundary)
  - amauta://context/{task_id}/{phase} MCP resource — list_resources + read_resource via /api/context
  - amauta/research MCP tool — Memory->SKB->WebFetch chain with sha256 semantic cache read-through
  - REQUIREMENTS.md MCP-02/MCP-05 corrected (ghost /api/rlm/search removed, 5-step chain scoped down)
affects: [phase-30, testing-29, validator]

# Tech tracking
tech-stack:
  added: [hashlib (stdlib), urllib.parse (stdlib)]
  patterns:
    - read-through cache (GET only, no POST write back)
    - distill as status reporter (MCP reports needs_distill; trigger stays in CLI)
    - resource URI regex validation (^amauta://context/([^/]+)/([RPETD])$)
    - WebFetch best-effort (DuckDuckGo instant answer, 5s timeout, empty on error)

key-files:
  created: []
  modified:
    - services/amauta-mcp.py
    - .planning/REQUIREMENTS.md

key-decisions:
  - "TK-29-02-01 was already delivered in Wave 1 (29-01) — search-code tool fully present at plan start"
  - "memory-distill is read-only: GET /api/memory/distill-status only; no POST distill route exists in daemon"
  - "research cache is read-through: GET /api/research-cache check on entry; no POST write (daemon has no POST route)"
  - "WebFetch uses DuckDuckGo instant answer API (no API key, best-effort, timeout-safe)"
  - "Cache key = sha256(query.strip().lower()) — normalized for case/whitespace invariance"
  - "REQUIREMENTS.md /api/rlm/search ghost: replaced claim with negation note ('daemon has no /api/rlm/search proxy') — plan acceptance criterion 'returns 0 matches' conflicts with its own replacement text which contains the string"

patterns-established:
  - "Daemon delegation boundary: all MCP tools use _call_daemon() or _call_rlm(); no subprocess or shared import"
  - "Resource URI parsing: re.match with explicit phase character class [RPETD] — raises ValueError on bad URI"
  - "Tool handlers validate required args early and return structured error JSON (not exceptions)"
  - "list_resources extracts TK-XXXX IDs from daemon text output via re.findall, generates 5 resources per task"

requirements-completed: [MCP-02, MCP-03, MCP-04, MCP-05]

# Metrics
duration: 35min
completed: 2026-04-13
---

# Plan 29-02: MCP Tool and Resource Handlers — Summary

**Five MCP tools and resources implemented in amauta-mcp.py: search-code (was Wave 1), memory-store/search/distill, context resource, and Memory->SKB->WebFetch research chain with sha256 cache read-through**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-04-13T22:00:00Z
- **Completed:** 2026-04-13T22:35:00Z
- **Tasks:** 5 (TK-29-02-01 through TK-29-02-05)
- **Files modified:** 2 (services/amauta-mcp.py, .planning/REQUIREMENTS.md)

## Accomplishments
- TK-29-02-01 already delivered in Wave 1 — search-code tool confirmed present at plan start (no work needed)
- TK-29-02-02: Three memory tools added — store/search/distill with correct daemon endpoint delegation
- TK-29-02-03: Context resource handlers — list_resources parses TK-XXXX IDs from daemon text output, read_resource validates URI via regex and delegates to /api/context/{task_id}/{phase}
- TK-29-02-04: Research tool with sha256 cache key, Memory->SKB->WebFetch chain, DuckDuckGo best-effort WebFetch
- TK-29-02-05: REQUIREMENTS.md MCP-02 ghost endpoint removed, MCP-05 scoped to implementable subset

## Task Commits

Each task was committed atomically:

1. **TK-29-02-01: amauta/search-code** — already delivered in Wave 1 (commit `4cd5a96` in 29-01)
2. **TK-29-02-02: memory-store, memory-search, memory-distill** — `2a3030c` (feat)
3. **TK-29-02-03: amauta://context resource** — `8336466` (feat)
4. **TK-29-02-04: amauta/research tool** — `a7022b9` (feat)
5. **TK-29-02-05: REQUIREMENTS.md MCP-02/MCP-05 fixes** — `5ecda5e` (fix)

## Files Created/Modified
- `services/amauta-mcp.py` — All 5 tool/resource handlers; added hashlib + urllib.parse imports
- `.planning/REQUIREMENTS.md` — MCP-02 ghost endpoint clarified, MCP-05 chain scope corrected

## Decisions Made
- memory-distill is intentionally read-only: daemon has no POST /api/memory/distill route. MCP returns distill-status; trigger stays with gsd-memory CLI.
- Research cache is read-through only: GET /api/research-cache on entry; no POST write back (daemon has no POST /api/research-cache route).
- WebFetch uses DuckDuckGo instant answer API — no API key needed, best-effort, 5s timeout, returns empty list on any error.
- Cache key = sha256(query.strip().lower()) for case/whitespace normalization.

## Deviations from Plan

### Observation: TK-29-02-01 already complete

- **Found during:** Pre-task file read (TK-29-02-01)
- **Issue:** Plan assumed search-code was a stub; Wave 1 (29-01) had already fully implemented it
- **Handling:** Verified acceptance criteria all pass (grep matches, syntax clean), proceeded to TK-29-02-02 without changes
- **Impact:** Zero — no scope expansion, no rework needed

### Observation: REQUIREMENTS.md acceptance criterion contradiction

- **Found during:** TK-29-02-05
- **Issue:** Acceptance criterion `grep "api/rlm/search" .planning/REQUIREMENTS.md returns 0 matches` conflicts with the plan's own replacement text which says "daemon has no /api/rlm/search proxy" — a string that contains `/api/rlm/search`
- **Handling:** Implemented the plan's stated replacement text exactly. The ghost endpoint CLAIM is removed; the negation note remains. Flagged to operator for validation.
- **Impact:** The old text `Results match HTTP /api/rlm/search output` (the false claim) is gone. The new text accurately documents why the route does not exist.

---

**Total deviations:** 2 observations (0 auto-fixes, 2 surfaced to operator)
**Impact on plan:** Both observations are non-blocking. Implementation matches plan intent on all counts.

## Issues Encountered
- `.planning/REQUIREMENTS.md` is gitignored but tracked — required `git add -f` for staging (pre-existing pattern from Wave 1)

## Next Phase Readiness
- All 5 MCP-01..05 capabilities implemented in amauta-mcp.py
- Phase 29 complete pending validator sign-off and TDD tests (separate test plan)
- Phase 30 (Observability + Security) can begin — no blockers from Phase 29

---
*Phase: 29-the-mcp-interface*
*Completed: 2026-04-13*

# Phase 36: Data Engineering Agent - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Create a new `agents/gsd-executor-data.md` (~350-400 lines) — the 5th executor agent specializing in the data layer. Writes safe expand-and-contract migrations, analyzes query performance statically, generates data quality checks, and understands the GSD-Amauta schema. Uses v3.0.0 10-section format with engineering standards and security rules embedded. Full RPETD executor routed by operator.

</domain>

<decisions>
## Implementation Decisions

### Migration Safety Model (DATA-01)
- Adaptive pattern (same as frontend stack enforcement) — warn and suggest safer expand-and-contract alternative, don't hard-block
- Destructive operations that trigger warning: DROP COLUMN, DROP TABLE, ALTER TYPE (data loss risk), RENAME COLUMN (breaks callers)
- Agent generates safe 3-step alternative automatically:
  1. **Expand:** Add new column/table alongside old. Both coexist. Purely additive.
  2. **Migrate:** Backfill data from old to new. Application code updated to write to both, read from new.
  3. **Contract:** Remove old column/table. Only after confirming new is fully populated and all reads migrated.
- Each step is a separate migration file with its own rollback (DOWN migration)
- If user explicitly confirms "yes, drop it" — agent proceeds with single migration but adds `-- DESTRUCTIVE: confirmed by user` comment
- ALTER TYPE with safe casts (int → bigint) gets warning but not 3-step treatment

### Schema Awareness (DATA-04)
- Agent file embeds a SUMMARY of existing schema (~50-80 lines in domain knowledge section)
- NOT full SQL of all 13 migrations — just table names, key columns, relationships, migration sequence number
- Format: "migrations 001-013, tables: memories(id, content, embedding), tasks(id, status, agent), skb(id, key, value), rpetd_context(id, task_id, phase, context), rlm_chunks(id, file_path, content, embedding), semantic_cache(id, query_hash, result), agent_metrics(id, agent_name, task_id)..."
- Agent reads actual migration files at runtime when it needs details (read-before-edit pattern)
- For greenfield projects: agent works fine — generates migration 001 instead of 014. Schema summary is GSD-Amauta-specific context, not a hard dependency.

### Migration Numbering
- Agent reads `migrations/` directory, finds highest number, increments by 1
- Format: `NNN-description.sql` (e.g., `014-agent-findings.sql`)
- Agent NEVER hardcodes the next number — always discovers dynamically

### Query Analysis (DATA-02)
- STATIC analysis only — agent does NOT connect to a live database
- Analyzes SQL strings in source code for:
  - Sequential scan patterns: `SELECT *` without `WHERE` on known-large tables
  - N+1 patterns: query inside a loop
  - Missing JOIN conditions: cartesian products
  - Missing indexes: `WHERE` on non-indexed columns based on schema knowledge
- Agent RECOMMENDS running `EXPLAIN ANALYZE` and includes the command in output, but doesn't execute it
- Keeps agent portable — no database connection required
- Commit metadata includes: `{query_analysis: [{file, line, query_pattern, risk, suggestion}]}`

### Agent Type (Full Executor)
- This IS a full executor — follows RPETD protocol, gets routed by operator
- Routing: file pattern match on `*.sql`, `migrations/`, AND explicit plan assignment for data-layer tasks
- 5th executor alongside backend, frontend, infra, general
- General executor is fallback if executor-data's circuit breaker opens
- Boundary: "You own the data layer — migrations, schemas, queries, data quality. You do not write application logic, API endpoints, or UI components — that's other executors' territory."

### Data Quality Checks (DATA-03)
- For each new migration, agent generates corresponding test file: `tests/migrations/NNN-description.test.cjs`
- Tests verify: NOT NULL constraints hold, foreign keys reference existing tables, unique constraints enforced, enum values valid, default values sensible
- Pattern: insert valid data (passes), insert violating data (fails with expected constraint error)

### Few-Shot Examples
Four examples:
  (a) Safe column addition — single additive migration, straightforward
  (b) Column rename — 3-step expand-and-contract with backfill
  (c) Query optimization — identifies N+1 pattern, suggests batch query with EXPLAIN recommendation
  (d) New table with relationships — migration + foreign keys + data quality test generation

### Wave Structure
- Wave 1: Create `agents/gsd-executor-data.md` with schema summary, expand-and-contract rules, query analysis rules, 4 examples
- Wave 2: Test fixtures (safe migration, destructive migration, N+1 query) + unit tests + integration tests + regression suite

### Claude's Discretion
- Exact wording of behavioral rules (thresholds and patterns are locked)
- Tool access section specifics (which RLM queries useful for data work)
- Error handling section details
- Exact schema summary formatting (table list content is locked)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Agent Format
- `agents/gsd-executor-backend.md` — Reference executor format (10-section, RPETD, full behavioral rules)
- `agents/gsd-reviewer.md` — Recently created agent (Phase 35) — reference for new agent creation pattern
- `agents/shared/security-rules.md` — 12 security rules to embed verbatim
- `agents/shared/engineering-standards.md` — 5 engineering standard categories to embed verbatim

### Prior Art
- `.planning/phases/35-code-review-agent/35-CONTEXT.md` — Phase 35 new agent creation pattern (closest precedent)
- `.planning/phases/31-format-standard/31-CONTEXT.md` — 10-section format definition
- `.planning/phases/32-frontend-rebuild/32-CONTEXT.md` — Executor rebuild pattern (stack enforcement, adaptive warning)

### Requirements
- `.planning/REQUIREMENTS.md` — DATA-01 through DATA-04 definitions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `agents/gsd-executor-backend.md` — Base executor pattern (RPETD, tool paths, task management)
- `agents/gsd-reviewer.md` — Newest agent creation (Phase 35), fresh reference for format
- `agents/shared/security-rules.md` — 12 rules, embed verbatim
- `agents/shared/engineering-standards.md` — 17 rules, embed verbatim

### Established Patterns
- Phase 35: New agent creation pattern (single Wave 1 task creates agent, Wave 2 creates tests)
- Phase 32: Adaptive warning for stack enforcement (same pattern for migration safety)
- Phase 34: "scan and report" boundary — executor-data is different (it writes code), but the boundary concept applies
- Test fixture pattern: tests/fixtures/ directory for known-good/bad samples

### Integration Points
- Operator routes to `gsd-executor-data` for `*.sql`, `migrations/` file patterns
- Follows same RPETD protocol as other executors
- General executor is fallback

</code_context>

<specifics>
## Specific Ideas

- The expand-and-contract pattern is the core behavioral rule — it's what makes this agent valuable vs just using backend executor for SQL
- Static query analysis without database connection keeps the agent portable (same portability constraint that cancelled Phase 30's K3s)
- Schema summary in domain knowledge is GSD-Amauta-specific but not a hard dependency — agent works on any project
- Migration numbering is always dynamic discovery, never hardcoded

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 36-data-engineering-agent*
*Context gathered: 2026-04-14*

# Roadmap: GSD-Amauta v2

**Milestone:** v2.0 — Self-Upgrade
**Phases:** 5
**Requirements:** 26

| # | Phase | Goal | Requirements | Plans |
|---|-------|------|--------------|-------|
| 1 | Setup & Onboarding | One-command install that detects and configures the best available backend | SETUP-01 through SETUP-05 | 1/2 In Progress |
| 2 | RPETD Enforcement | Strict quality gates that prevent tasks from completing without evidence | RPETD-01 through RPETD-05 | 0 |
| 3 | Memory & RLM | Reliable memory across backends with auto-start RLM and incremental indexing | MEM-01 through MEM-05, RLM-01 through RLM-04 | 0 |
| 4 | Task Management | Robust task state machine with dependency enforcement and rich board view | TASK-01 through TASK-04 | 0 |
| 5 | Distribution | MCP server facade and npm package for easy discovery and installation | DIST-01 through DIST-03 | 0 |

## Phase Details

### Phase 1: Setup & Onboarding
**Goal:** Any developer runs `npx gsd-amauta init` and gets a working system in 60 seconds
**Dependencies:** None
**Success Criteria:**
1. `npx gsd-amauta init` works on a machine with only Node.js installed
2. Local PostgreSQL detected and used when available (no Docker needed)
3. Docker PostgreSQL auto-started when local PG unavailable but Docker present
4. SQLite fallback works when neither PG nor Docker available
5. `amauta status` shows backend, features, counts, and health

### Phase 2: RPETD Enforcement
**Goal:** Quality gates actually block bad work instead of being advisory
**Dependencies:** Phase 1 (database must work)
**Success Criteria:**
1. Task cannot reach "done" status without all RPETD phases having content
2. E-phase rejects tasks without branch/commit evidence
3. T-phase rejects "tests pass" without actual test output
4. D-phase rejects missing LEARNING blocks
5. `amauta validate` shows clear pass/fail per gate

### Phase 3: Memory & RLM
**Goal:** Knowledge persists reliably across sessions and backends with smart code context
**Dependencies:** Phase 1 (SQLite must work for memory)
**Success Criteria:**
1. `gsd-memory store/search/list` works identically on PG and SQLite
2. Session learnings auto-captured before context compaction
3. RLM starts with daemon, indexes incrementally
4. Cross-project search handles tag synonyms
5. `gsd-memory status` shows complete system state

### Phase 4: Task Management
**Goal:** Robust task lifecycle with dependency enforcement and visibility
**Dependencies:** Phase 1 (database), Phase 2 (RPETD gates)
**Success Criteria:**
1. Dual-write handles PG failures without data loss
2. Invalid state transitions rejected with clear error
3. Dependent tasks block completion automatically
4. `amauta board` shows RPETD phase progress per task

### Phase 5: Distribution
**Goal:** GSD-Amauta discoverable and installable like any MCP server
**Dependencies:** Phases 1-4 (core must be solid before distribution)
**Success Criteria:**
1. MCP server responds to memory/task/RPETD tool calls
2. `claude mcp add gsd-amauta` installs and works
3. npm package installs globally with correct bin entries

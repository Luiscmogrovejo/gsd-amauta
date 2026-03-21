# Requirements: GSD-Amauta v2 Self-Upgrade

**Defined:** 2026-03-21
**Core Value:** Zero-config quality pipeline for any developer in under 60 seconds

## v1 Requirements

### Setup & Onboarding

- [x] **SETUP-01**: `npx gsd-amauta init` installs agents, commands, skills, and configures database without manual steps
- [x] **SETUP-02**: System auto-detects local PostgreSQL and uses it without Docker
- [x] **SETUP-03**: System auto-starts Docker PostgreSQL when no local PG is found and Docker is available
- [x] **SETUP-04**: System falls back to SQLite when neither PG nor Docker is available
- [ ] **SETUP-05**: `amauta status` shows backend type, feature availability, memory count, task count, service health

### RPETD Enforcement

- [ ] **RPETD-01**: Task cannot move to "done" without all required RPETD phases logged
- [ ] **RPETD-02**: E-phase gate checks for branch/commit evidence with clear error messages
- [ ] **RPETD-03**: T-phase gate validates real test output (rejects "tests pass" without evidence)
- [ ] **RPETD-04**: D-phase gate validates LEARNING block presence and quality
- [ ] **RPETD-05**: Validation summary shows which gates passed/failed before marking task done

### Memory System

- [ ] **MEM-01**: Memory works with SQLite backend (FTS5 search, no embeddings)
- [ ] **MEM-02**: Memory auto-captures session learnings when context is about to be compacted
- [ ] **MEM-03**: Memory distillation runs automatically when count exceeds threshold
- [ ] **MEM-04**: Cross-project search handles tag variations (postgres vs postgresql)
- [ ] **MEM-05**: `gsd-memory status` shows backend, count, latest entries, embedding availability

### RLM & Context

- [ ] **RLM-01**: RLM service starts automatically when daemon starts
- [ ] **RLM-02**: RLM indexes incrementally (only changed files since last index)
- [ ] **RLM-03**: Context passing between agents includes RLM results and memory search automatically
- [ ] **RLM-04**: RLM fallback provides useful file references when service is unavailable

### Task Management

- [ ] **TASK-01**: Task dual-write (JSON + PG) handles failures gracefully with retry
- [ ] **TASK-02**: Task state machine prevents invalid transitions (e.g., pending → done without in-progress)
- [ ] **TASK-03**: Task dependencies block completion if deps are incomplete
- [ ] **TASK-04**: `amauta board` shows rich kanban view with RPETD phase indicators

### Distribution

- [ ] **DIST-01**: MCP server exposes memory search, task status, and RPETD logging as tools
- [ ] **DIST-02**: MCP server installable via `claude mcp add gsd-amauta`
- [ ] **DIST-03**: Package published to npm with correct bin entries and postinstall

## v2 Requirements

### Advanced Memory
- **MEM-06**: Embedding-based semantic search via Voyage AI or OpenAI
- **MEM-07**: Automatic embedding backfill for historical memories
- **MEM-08**: Memory export/import for backup and migration

### Advanced RLM
- **RLM-05**: Tree-sitter based AST parsing for more accurate chunking
- **RLM-06**: Git hook triggers incremental re-indexing on commit

### Agent Intelligence
- **AGENT-01**: Agent performance metrics tracked and used for routing optimization
- **AGENT-02**: Automatic agent selection based on file change patterns in PR

## Out of Scope

| Feature | Reason |
|---------|--------|
| Web dashboard | CLI-first; would add frontend complexity |
| Multi-user/team support | Single developer tool; team features later |
| Cloud sync | Everything local; users control their data |
| VS Code extension | Claude Code CLI only for now |
| Cursor/Windsurf integration | Different AI tools, different architecture |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SETUP-01 | Phase 1 | Done (01-01) |
| SETUP-02 | Phase 1 | Done (01-01) |
| SETUP-03 | Phase 1 | Done (01-01) |
| SETUP-04 | Phase 1 | Done (01-01) |
| SETUP-05 | Phase 1 | Pending |
| RPETD-01 | Phase 2 | Pending |
| RPETD-02 | Phase 2 | Pending |
| RPETD-03 | Phase 2 | Pending |
| RPETD-04 | Phase 2 | Pending |
| RPETD-05 | Phase 2 | Pending |
| MEM-01 | Phase 3 | Pending |
| MEM-02 | Phase 3 | Pending |
| MEM-03 | Phase 3 | Pending |
| MEM-04 | Phase 3 | Pending |
| MEM-05 | Phase 3 | Pending |
| RLM-01 | Phase 3 | Pending |
| RLM-02 | Phase 3 | Pending |
| RLM-03 | Phase 3 | Pending |
| RLM-04 | Phase 3 | Pending |
| TASK-01 | Phase 4 | Pending |
| TASK-02 | Phase 4 | Pending |
| TASK-03 | Phase 4 | Pending |
| TASK-04 | Phase 4 | Pending |
| DIST-01 | Phase 5 | Pending |
| DIST-02 | Phase 5 | Pending |
| DIST-03 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-21*

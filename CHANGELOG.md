# Changelog — GSD-Amauta

All changes from vanilla GSD to GSD-Amauta.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — GSD-Amauta Fork

### Added

#### Services (Python)
- `services/amauta-daemon.py` — HTTP daemon on :18799 wrapping amauta.py task manager
- `services/pg_store.py` — PostgreSQL connection pool, memory/SKB/validation operations
- `services/rlm-service.py` — RLM context engine HTTP service on :18798

#### CLI Tools (Node.js)
- `get-shit-done/bin/gsd-amauta.cjs` — Task management CLI (1064 lines, 17+ commands)
- `get-shit-done/bin/gsd-memory.cjs` — Memory + SKB CLI (900+ lines, 14 commands including cross-project search, tag inference, distill)
- `get-shit-done/bin/gsd-rlm.cjs` — RLM context CLI (540+ lines)
- `get-shit-done/bin/gsd-research.cjs` — Perplexity-first research chain (580+ lines, with dedup)

#### Agent Definitions (10 agents, replacing 12)
- `agents/gsd-operator.md` — Master orchestrator (replaced old gsd-orchestrator)
- `agents/gsd-executor-frontend.md` — Frontend specialist
- `agents/gsd-executor-backend.md` — Backend specialist
- `agents/gsd-executor-infra.md` — Infrastructure specialist
- `agents/gsd-executor-general.md` — General executor
- `agents/gsd-planner.md` — Planning specialist (memory-first, Given/When/Then)
- `agents/gsd-checker.md` — Quality checker (pre/post modes)
- `agents/gsd-validator.md` — External validator (no self-validation)
- `agents/gsd-researcher.md` — Research specialist (4 modes)
- `agents/gsd-debugger.md` — Debug specialist (memory-backed)

#### Docker / Database
- `docker/docker-compose.yml` — PostgreSQL 16 with pgvector on port 5433
- `migrations/001-init.sql` — Schema: gsd_memory, gsd_shared_kb, gsd_task_validations, gsd_agents (4 tables, 15 indexes, 3 triggers)

#### Workflows
- `get-shit-done/workflows/test-phase.md` — T-phase evidence capture (237 lines)
- `commands/gsd/test-phase.md` — /gsd:test-phase slash command

#### References
- `references/agentic-patterns.md` — 20 agentic AI design patterns mapped to 10 agents

#### Tests
- `tests/gsd-amauta.test.cjs` — CLI unit tests (17 tests)
- `tests/e2e-lifecycle.test.cjs` — E2E lifecycle tests (22 tests)
- `tests/degradation.test.cjs` — Graceful degradation tests (11 tests)

#### Core
- `amauta.py` — Task manager CLI (3920 lines, from Amauta project)
- `data/tasks.json` — Project task board

### Changed

#### Installer
- `bin/install.js` — Added `installAmauta()` function for Docker PG, Python deps, daemon startup

#### Workflows
- `get-shit-done/workflows/execute-phase.md` — RPETD hooks, amauta task registration, auto_validate_tasks step (604 lines)
- `get-shit-done/workflows/new-project.md` — Epic + phase story creation in amauta, cross-project learning (Step 8.5)
- `get-shit-done/workflows/resume-project.md` — PG memory context loading

#### Configuration
- `get-shit-done/templates/config.json` — Added amauta settings, rlm_fallback_to_full_files
- `package.json` — Renamed to gsd-amauta, added pg dep, daemon scripts
- `.gitignore` — Added data/, *.pid, .env exclusions

### Removed (Superseded)

The following vanilla GSD agents are superseded by the new 10-agent roster:
- `gsd-orchestrator.md` — replaced by `gsd-operator.md`
- `gsd-executor.md` — replaced by 4 specialized executors
- `gsd-codebase-mapper.md` — functionality absorbed by operator + RLM
- `gsd-project-researcher.md` — replaced by `gsd-researcher.md`
- `gsd-research-synthesizer.md` — merged into researcher
- `gsd-verify-work.md` — replaced by `gsd-validator.md`
- `gsd-plan-checker.md` — merged into `gsd-checker.md`
- `gsd-post-check.md` — merged into `gsd-checker.md`

### New Dependencies

- **Runtime**: psycopg2-binary (Python), Docker
- **Dev**: none (uses Node.js built-in test runner)
- **Infrastructure**: PostgreSQL 16 with pgvector extension

### Breaking Changes from Vanilla GSD

1. **Agent names changed** — All 10 agents have new names. Custom references to old agent names will not resolve.
2. **Task management via daemon** — Tasks are managed through HTTP daemon, not directly via files.
3. **RPETD enforcement** — Validation gates require branch evidence (E-phase), test evidence (T-phase), and LEARNING block (D-phase). Use `--force` to bypass.
4. **Memory system** — STATE.md is supplemented (not replaced) by PG memory. Both coexist.
5. **Port usage** — Three localhost ports used: 5433 (PG), 18798 (RLM), 18799 (daemon).

# Changelog — GSD-Amauta

All changes from vanilla GSD to GSD-Amauta.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — GSD-Amauta Fork

### Added

#### Services (Python)
- `services/amauta-daemon.py` — HTTP daemon on :18799 wrapping amauta.py task manager
- `services/pg_store.py` — PostgreSQL connection pool, memory/SKB/validation operations (730+ lines)
- `services/rlm-service.py` — RLM context engine HTTP service on :18798

#### CLI Tools (Node.js)
- `get-shit-done/bin/gsd-amauta.cjs` — Task management CLI (1064 lines, 17+ commands)
- `get-shit-done/bin/gsd-memory.cjs` — Memory + SKB CLI (1300+ lines, 17 commands including semantic search, backfill, embedding stats)
- `get-shit-done/bin/gsd-rlm.cjs` — RLM context CLI (540+ lines)
- `get-shit-done/bin/gsd-research.cjs` — Perplexity-first research chain (580+ lines, with dedup)

#### Agent Definitions (11 agents, replacing 12)
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
- `agents/gsd-roadmapper.md` — Roadmap/milestone planning specialist

#### Docker / Database
- `docker/docker-compose.yml` — PostgreSQL 16 with pgvector on port 5433
- `migrations/001-init.sql` — Schema: gsd_memory, gsd_shared_kb, gsd_task_validations, gsd_agents (4 tables, 15 indexes, 3 triggers)
- `migrations/002-embedding-index.sql` — HNSW index for pgvector cosine similarity search

#### Semantic Search (pgvector)
- `pg_store.py`: `generate_embedding()`, `memory_store_with_embedding()`, `memory_semantic_search()`, `memory_backfill_embeddings()`, `memory_embedding_stats()` — 5 new methods
- `amauta-daemon.py`: `/api/memory/semantic-search`, `/api/memory/backfill-embeddings`, `/api/memory/embedding-stats` — 3 new routes + auto-embedding on `/api/memory/store`
- `gsd-memory.cjs`: `semantic-search`, `backfill-embeddings`, `embedding-stats` — 3 new CLI commands
- **Multi-provider embeddings**: Voyage AI `voyage-code-3` (recommended, Anthropic partner) or OpenAI `text-embedding-3-small`
- Auto-detects provider: `VOYAGE_API_KEY` preferred, `OPENAI_API_KEY` fallback, `GSD_EMBEDDING_PROVIDER` override
- Standardized on 1024 dimensions (both providers support flexible dims)
- Voyage AI uses `input_type` hints (`"query"` for search, `"document"` for storage) for better retrieval
- HNSW index with `m=16, ef_construction=128` for fast cosine similarity
- Auto-embeds on store when API key is set; falls back to text search otherwise
- `migrations/003-embedding-1024.sql` — Dimension migration from 1536 to 1024

#### Workflows
- `get-shit-done/workflows/test-phase.md` — T-phase evidence capture (237 lines)
- `commands/gsd/test-phase.md` — /gsd:test-phase slash command

#### References
- `references/agentic-patterns.md` — 20 agentic AI design patterns mapped to 11 agents

#### Tests
- `tests/gsd-amauta.test.cjs` — CLI unit tests (17 tests)
- `tests/e2e-lifecycle.test.cjs` — E2E lifecycle tests (22 tests)
- `tests/degradation.test.cjs` — Graceful degradation tests (11 tests)
- `scripts/run-tests.cjs` — Custom test runner with stable ordering (LAST_TESTS array for integration tests)
- All 583 tests pass across 19 test files

#### Core
- `amauta.py` — Task manager CLI (3920 lines, from Amauta project)
- `data/tasks.json` — Project task board

### Changed

#### Agent Name Migration (161 references across 42 files)
- **All 14 workflow files** updated from old agent names (gsd-executor, gsd-verifier, gsd-phase-researcher, gsd-project-researcher, gsd-research-synthesizer, gsd-plan-checker, gsd-integration-checker, gsd-codebase-mapper, gsd-nyquist-auditor) to new 11-agent roster
- **All 4 command files** updated (plan-phase, research-phase, map-codebase, quick)
- **All agent frontmatter** fixed — added `skills:` field, `# hooks:` pattern, and anti-heredoc instruction where required
- **Spawn types** fixed — `subagent_type="general"` replaced with proper agent names (e.g., `subagent_type="gsd-validator"`)
- `get-shit-done/bin/lib/core.cjs` — MODEL_PROFILES rewritten for 11-agent roster
- `get-shit-done/bin/lib/init.cjs` — 14 model resolution calls updated to new agent names
- `bin/install.js` — CODEX_AGENT_SANDBOX rewritten for 11 agents
- `get-shit-done/templates/context.md` — Agent references updated
- `get-shit-done/references/model-profiles.md` — Rebuilt for 11-agent roster
- `docs/USER-GUIDE.md` — All agent names updated
- 4 test files updated (codex-config, core, commands, gemini-config)

#### Installer
- `bin/install.js` — Added `installAmauta()` function for Docker PG, Python deps, daemon startup

#### Workflows
- `get-shit-done/workflows/execute-phase.md` — RPETD hooks, amauta task registration, auto_validate_tasks step (604 lines)
- `get-shit-done/workflows/new-project.md` — Epic + phase story creation in amauta, cross-project learning (Step 8.5)
- `get-shit-done/workflows/resume-project.md` — PG memory context loading

#### Configuration
- `get-shit-done/templates/config.json` — Added amauta settings, rlm_fallback_to_full_files, **rlm_enabled: true** (RLM on by default)
- `package.json` — Renamed to gsd-amauta, added pg dep, daemon scripts
- `.gitignore` — Added data/, *.pid, .env exclusions

#### Test Infrastructure
- `scripts/run-tests.cjs` — Added `LAST_TESTS` array for stable test ordering (integration tests run last to avoid PG data conflicts)

### Removed (Superseded)

The following vanilla GSD agents are superseded by the new 11-agent roster:
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
- **Optional APIs**: Voyage AI (`VOYAGE_API_KEY`) or OpenAI (`OPENAI_API_KEY`) for semantic search embeddings; Perplexity (`PERPLEXITY_API_KEY`) for research chain

### Breaking Changes from Vanilla GSD

1. **Agent names changed** — All 11 agents have new names. Custom references to old agent names will not resolve.
2. **Task management via daemon** — Tasks are managed through HTTP daemon, not directly via files.
3. **RPETD enforcement** — Validation gates require branch evidence (E-phase), test evidence (T-phase), and LEARNING block (D-phase). Use `--force` to bypass.
4. **Memory system** — STATE.md is supplemented (not replaced) by PG memory. Both coexist.
5. **Port usage** — Three localhost ports used: 5433 (PG), 18798 (RLM), 18799 (daemon).
6. **RLM enabled by default** — `config.json` ships with `rlm_enabled: true`. Agents use RLM for context retrieval instead of full file injection.

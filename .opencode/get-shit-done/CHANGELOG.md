# Changelog — GSD-Amauta

All changes from vanilla GSD to GSD-Amauta.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.5.0] — 2026-04-06 — "Smarter Brain"

8 phases, 49 requirements, ~479 new tests. Total test count: ~2479 (61 CJS + 31 Python files).

### Added

#### Infrastructure & Reliability (Phase 1)
- `_kill_port_holder()` and `_port_is_free()` in RLM service -- fixes zombie process leak (orphaned PID, stderr suppressed, counter never resets)
- API key validation on daemon startup with `/health` exposure
- Startup service inventory banner with `[OK]`/`[!!]`/`[XX]` markers per service

#### Memory & Embeddings (Phase 2)
- `distill-status` excludes `source='distilled'` entries from threshold count
- LLM distillation via Claude CLI (`claude --print --model sonnet/haiku`) > Ollama > concatenation fallback
- `web_search_result` gets 180-day retention tier
- Recency decay guard tests for all code paths

#### RLM Engine Improvements (Phase 3, MIT Paper Audit)
- BM25 TF: word-boundary tokenization replaces substring `.count()` for accurate term frequency
- Query-length normalization removed (standard BM25 does not normalize)
- `RLM_POSITION_DECAY` env var for configurable position decay (default 5%, was 10%)
- BM25 `b` parameter tuned 0.75 -> 0.6 for code chunk length variance
- Default chunk size 8000 -> 4000 chars (`RLM_MAX_CHUNK_CHARS`)
- Label boost reduced 2.0 -> 1.5x with 3.0*idf cap
- Cache hit/miss counters + `/cache/stats` endpoint
- `--fresh` flag for cache bypass on RLM queries

#### Token Efficiency & Caching (Phase 4)
- Perplexity citation markers stripped (`[1]`, `[2]`, etc.)
- Perplexity response cache: 6h TTL temp-file + `--no-cache` bypass
- Query embedding cache: 1h TTL, 500 max, query-only (SHA-256 keys)
- Phase-specific enrichment reduction: T=none, D=writes-only, E=RLM-only (~1950 chars/lifecycle saved)
- `PGStore.rerank()` wired into semantic search (voyage-rerank-2.5, guard len>=3)

#### Redis Caching Layer (Phase 5)
- Redis 7-alpine added to `docker/docker-compose.yml` (ephemeral cache, no persistence)
- Daemon manages Redis lifecycle (watchdog, auto-start, health) -- mirrors RLM pattern
- `GSD_REDIS_URL` and `GSD_REDIS_ENABLED` env vars
- Redis L2 embedding cache (`gsd:emb:` prefix, 3600s TTL) wraps Phase 4 L1 dict cache
- Perplexity cache via `/api/research-cache` daemon endpoint (file cache fallback)
- `/health` reports `pipeline_status` (healthy/degraded/critical), `service_errors[]`, `cache_metrics{}`
- `[DATA FLOW ERROR]` alerts in `gsd-rlm.cjs` and `gsd-research.cjs`
- Bridge module `services/amauta_daemon_redis.py` solves circular import

#### Multi-Agent & RPETD Audit (Phase 6)
- 11 agent definitions audited -- checker/validator boundary blocks added
- Routing extracted to shared `gsd-tools.cjs routeExecutor()` (was copy-pasted in 2 files)
- `get-shit-done/agent-capabilities.json` -- single source of truth for 11 agents
- Infra regex tightened (path-anchored, eliminates false positives)
- `pass_rate` normalization handles both 0-1 and 0-100 formats
- R/P substance gates >=50 chars, T threshold raised to >=50
- Phase-order soft warning in `cmd_rpetd`
- `force_reason` persisted to task notes + validation metadata
- Error classification: TRANSIENT / GATE_FAIL / CAPABILITY_MISMATCH / SYSTEMIC
- Recovery routing table + auto-escalation at 3 failures
- Mandatory external validation enforced in execute-phase workflow

#### Task Manager & Research Chain Audit (Phase 7)
- `archive` and `reconcile` added to daemon `command_map` + `EXEC_ALLOWLIST` (was dead code)
- `GSD_STALE_INTERVAL` env var for configurable watchdog check interval (default 300s)
- `dep_pressure` cache key: content hash replaces `id()` (was rebuilding every call)
- `cmd_next` tie-breaking by `created_at`
- Research cascade requires >=2 results before stopping (`GSD_RESEARCH_MIN_RESULTS`, was >0)
- Empty `_search_q` guard prevents unconditional research chain invocation
- 3 new preamble patterns ("Of course", "I'd be happy", "As an AI")
- Perplexity 429 exponential backoff (1s, 2s, 4s, max 3 retries)
- `TECH_SHORT_WORDS` whitelist preserves 2-char terms (ai, db, js, go, etc.)
- Dedup similarity logging for threshold tuning

#### Integration Testing & Baseline Measurement (Phase 8)
- Token measurement: 39.4% Layer 2 enrichment reduction confirmed
- 24 regression benchmark tests
- Consolidated `AUDIT-SUMMARY.md`

### Changed
- Perplexity `max_tokens` reduced 4096 -> 1000 (was paying 10x actual usage)
- `PERPLEXITY_MODEL=auto` with sonar/sonar-pro complexity routing via `selectPerplexityModel()`
- Voyage AI `input_type` asymmetric encoding audited correct
- HNSW `m=16 / ef_construction=128` confirmed optimal for <10K rows
- Context7 marked as additive provider (no longer blocks Perplexity cascade)
- Preamble stripping loops until stable (handles compound preambles)
- Daemon search `project_id` routing fix
- Claude CLI distillation used automatically in Claude Code sessions (no API key needed)

### Fixed
- RLM zombie process (orphaned PID, stderr suppressed, counter never resets)
- Enrichment dedup window (300s) audited correct
- Daemon `archive`/`reconcile` were dead code (not in command_map)
- `dep_pressure` used Python `id()` as cache key (rebuilt every call)
- Research cascade stopped at >0 results (should be >=2)
- Unconditional research chain invocation when `_search_q` was empty

### Metrics
- **Test count:** ~2479 total (was ~2000 pre-audit)
- **Token reduction:** 39.4% Layer 2 enrichment, 24% total lifecycle, 75.6% Perplexity per-call
- **New infrastructure:** Redis L2 cache, agent capability index, error recovery pipeline, mandatory validation

---

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
5. **Port usage** — Four localhost ports used: 5433 (PG), 6379 (Redis, optional), 18798 (RLM), 18799 (daemon).
6. **RLM enabled by default** — `config.json` ships with `rlm_enabled: true`. Agents use RLM for context retrieval instead of full file injection.

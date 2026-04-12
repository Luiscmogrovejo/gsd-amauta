# Changelog — GSD-Amauta

All changes from vanilla GSD to GSD-Amauta.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.7.0] — 2026-04-12 — "Steady Hands"

4 phases, 7 requirements, 47 new tests. Hardening milestone closing loops from v2.6 dogfood audit.

### Added

#### Init Resolver Fix (Phase 16, RESOLVE-01/02)
- `config.json::current_milestone` field — single source of truth for milestone identity
- `findPhaseInternal()` scoped to current milestone only (was first-match across all `v*-phases/` dirs)
- `--phase-dir <path>` override on all 4 phase-aware init subcommands (`execute-phase`, `plan-phase`, `verify-work`, `phase-op`)
- `validatePhaseDirOverride()` with existence check, empty-dir detection, sibling suggestion
- Atomic config writes via temp+rename in `cmdConfigSet`
- `getMilestoneInfo()` reads `config.json` as primary source, ROADMAP.md as fallback
- `tests/16-init-resolver.test.cjs` — 11 tests replaying dogfood depths 7/8/10

#### Audit Script Hardening (Phase 17, AUDIT-01/02/03)
- `checkVerificationFiles()` dual-probe: `<phase>-VERIFICATION.md` (prefixed) + `VERIFICATION.md` (fallback), prefixed wins
- `parseNpmFailures()` rewritten for `node --test` format (`test at <file>` + Unicode cross mark), returns `{ test_file, test_name, reason }`
- `classifyFailures()` handles structured objects with backward-compat string guard
- `TOOLING_BUGS_SEED` constant: TOOL-01 (depth 7, ghost directory) + TOOL-02 (depth 8, resolver recurrence)
- `buildReport()` emits `tooling_bugs_observed` (structured) and `schema_version: 2`
- `generateMarkdown()` renders Tooling Bugs Observed table before Hygiene Debt, Schema version in Summary
- `tests/17-audit-script-hardening.test.cjs` — 15 tests

#### Sampling Pool Expansion (Phase 18, SAMPLE-01)
- `queryDaemonTaskIds()` — shell-out to `gsd-amauta.cjs`, parses `{"output": "<ANSI>"}` envelope via JSON.parse + regex
- `sampleCompletedTasks()` rewritten: daemon query primary, SUMMARY.md scraping fallback
- Module-scoped `_lastSamplingHealth` state captured in `buildReport()`
- `sampling_health` top-level field: `{daemon_available, pool_source, fallback_used, pool_size, limitations_observed}`
- `schema_version` bumped to 3
- `generateMarkdown()` renders `## Sampling Health` section
- `tests/18-sampling-pool.test.cjs` — 13 tests (dual-path: daemon-available + daemon-unavailable via spawnSync hijack)

#### Dynamic Ledger Schema (Phase 19, SCHEMA-01)
- `scanDogfoodLedgerDepths(memoryDir, ledgerPath)` — two-source union: ledger table parse + memory dir scan
- Three-tier degradation cascade: full union → ledger-only → memory-only → static fallback
- Gap identification via set difference `{0..max} \ captured`
- Static fallback updated to `[0,1,2,4,5,6,7,8,9,10,11]`
- `schema_version` bumped to 4
- `generateMarkdown()` adds "Scan source:" line to Dogfood Ledger Status
- `tests/19-ledger-scan.test.cjs` — 8 tests

### Changed
- `schema_version` field now present in audit JSON (absent = v1, Phase 17 set 2, Phase 18 set 3, Phase 19 set 4)
- `pre_existing_failures_verified` entries are structured objects (was flat strings)
- `dogfood_ledger_depths_captured` dynamically populated at audit runtime (was static Wave-1 list)

---

## [2.6.0] — 2026-04-10 — "Sight Beyond Sight"

7 phases, 46 requirements, ~150 new tests. RPETD intelligence upgrade — every phase sees what other phases learned.

### Added
- D-Phase Structured Learning (Phase 10, LEARN-01..07): WHAT/WHY/WHEN/CATEGORY/TAGS format, 9 categories, curated tag vocabulary, GIN index
- E-Phase Research-Informed Execution (Phase 11, EXEC-01..08): PRE_EXECUTION_EVIDENCE block, Gate 6 advisory
- T-Phase QA + Spec Inheritance (Phase 12, QA-01..08): EDGE_CASES + REGRESSION blocks, parent verification
- R-Phase Creative Research (Phase 13, CREATIVE-01..05): task-type-gated creative variants
- HARDEN-01 Manifest Enforcement (Phase 13.1): deterministic `files_expected` check via `git diff --name-status`
- Divergence Protocol v1.1.0 (HARDEN-02): detect → STOP → `divergence_report` JSON → exit 87
- Validator Vocabulary Lock (HARDEN-04): `--pass`/`--fail`/`--gaps-found` exit 0/1/2
- Plan-to-Tasks Auto-Registration (Phase 14, PLAN-01..07): `gsd-tools plan-to-tasks`, `metadata.plan_local_id`
- End-to-End Dogfood Verification (Phase 15, DOGFOOD-01..05): `scripts/verify-v26.cjs`, `audit-rpetd-intelligence.cjs`
- Dogfood Ledger: `docs/v2.6-dogfood-ledger.md` — 9 captured depths, 706 lines

---

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

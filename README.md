# GSD-Amauta

**Quality-enforced multi-agent AI development for Claude Code.**

GSD-Amauta extends the [GSD](https://github.com/get-shit-done/get-shit-done) framework with a behaviorally-enforced 5-phase development pipeline (RPETD), a BM25 code context engine, a PostgreSQL + pgvector persistent memory system with automatic distillation, 11 specialist agents with file-pattern routing, a 5-step research chain, deterministic per-task manifest enforcement, a formal divergence protocol that turns plan-vs-reality mismatches from silent scope expansion into first-class observations, and a complete downgrade path where every feature has a graceful fallback when its infrastructure is unavailable.

```
v2.7.0 "Steady Hands" -- 11 phases shipped (v2.6+v2.7) -- ~2591 tests passing -- 11 agents -- 5 CLI tools -- 4 services -- 8 SQL migrations -- 9 specs -- 20 AI design patterns -- divergence protocol v1.1.0 -- 11 dogfood ledger depths captured -- schema v4 audit reports
```

---

## Table of Contents

1. [What v2.6 Adds Over v2.5](#what-v26-adds-over-v25)
2. [What Amauta Adds Over GSD](#what-amauta-adds-over-gsd)
3. [System Architecture](#system-architecture)
4. [Installation](#installation)
5. [Quick Start — First Task End-to-End](#quick-start--first-task-end-to-end)
6. [The RPETD Pipeline](#the-rpetd-pipeline)
7. [The 11 Specialist Agents](#the-11-specialist-agents)
8. [The RLM Context Engine](#the-rlm-context-engine)
9. [The PostgreSQL + pgvector Memory System](#the-postgresql--pgvector-memory-system)
10. [Memory Distillation — How It Works](#memory-distillation--how-it-works)
11. [The 5-Step Research Chain](#the-5-step-research-chain)
12. [The Divergence Protocol (v1.1.0)](#the-divergence-protocol-v110)
13. [HARDEN-01 Manifest Enforcement](#harden-01-manifest-enforcement)
14. [Validator Vocabulary Lock (HARDEN-04)](#validator-vocabulary-lock-harden-04)
15. [Plan-to-Tasks Auto-Registration (Phase 14)](#plan-to-tasks-auto-registration-phase-14)
16. [The v2.6 Dogfood Ledger](#the-v26-dogfood-ledger)
17. [Validation Gates](#validation-gates)
18. [Auto-Learning Feedback Loop](#auto-learning-feedback-loop)
19. [The 20 Agentic AI Design Patterns](#the-20-agentic-ai-design-patterns)
20. [Graceful Degradation](#graceful-degradation)
21. [Token Efficiency](#token-efficiency)
22. [Daemon API Routes](#daemon-api-routes)
23. [Configuration](#configuration)
24. [Health Dashboard](#health-dashboard)
25. [CLI Reference](#cli-reference)
26. [Testing](#testing)
27. [Project Structure](#project-structure)
28. [Contributing](#contributing)
29. [License](#license)

---

## What v2.7 Adds Over v2.6

v2.7 "Steady Hands" is a hardening milestone — no new RPETD intelligence upgrades, no new kill switches. It closes the loops that the v2.6 dogfood audit opened: the tooling bugs that fired repeatedly during v2.6 execution.

| Capability | v2.6 | v2.7 |
|---|---|---|
| Phase directory resolution | First-match-by-numeric-prefix across all `v*-phases/` dirs — ghost directories from archived milestones returned for current-milestone queries (depths 7, 8, 10) | Milestone-scoped via `config.json::current_milestone` — searches only the active milestone's dir. `--phase-dir` override for bootstrap/escape scenarios (RESOLVE-01/02, Phase 16) |
| Verification file discovery | Hard-coded `VERIFICATION.md` — Phase 14's `14-VERIFICATION.md` missed (false negative) | Dual-probe: `<phase>-VERIFICATION.md` first, `VERIFICATION.md` fallback. Prefixed form wins on collision (AUDIT-01, Phase 17) |
| npm failure parsing | Regex for `FAIL tests/foo.test.cjs` — doesn't match `node --test` runner's `test at` + Unicode cross mark format | Structured `{ test_file, test_name, reason }` objects parsed from actual `node --test` output. Legacy `FAIL` regex retained as fallback (AUDIT-02, Phase 17) |
| Audit report schema | `hygiene_debt_observed` only. No field for tooling-level bugs. Schema version implicit. | `tooling_bugs_observed` (structured objects with provenance: id, depth, description, phase_detected, resolved_by). `schema_version` field (bumped per phase: 2→3→4). `sampling_health` field with degradation tracking (AUDIT-03 + SAMPLE-01 + SCHEMA-01, Phases 17-19) |
| DOGFOOD-01 sampling | Scraped `TK-\d+` from SUMMARY.md text — collapsed to n=1 because only Phase 10's SUMMARY happened to cite a task ID | Queries amauta daemon for `status=done` tasks via `gsd-amauta.cjs` shell-out, with SUMMARY.md scraping as graceful fallback. `sampling_health` reports data source and limitations (SAMPLE-01, Phase 18) |
| Dogfood depth tracking | Static `[0,1,2,4,5,6,7]` array authored at Wave 1 time — depths 8+9 discovered during execution orphaned from JSON | Runtime `scanDogfoodLedgerDepths()`: parses dogfood ledger table (depths 0-9) + memory dir scan (depths 10+), computes gaps via set difference. Three-tier degradation cascade (SCHEMA-01, Phase 19) |

**4 phases | 8 plans | 21 tasks | 47 new tests | 7/7 requirements**

---

## What v2.6 Adds Over v2.5

v2.6 "Sight Beyond Sight" is the milestone where every RPETD phase gained the ability to *see* what the other phases have already learned. Where v2.5 optimized the retrieval path and added a Redis cache layer, v2.6 hardened the behavioral surface that the retrieval feeds — forcing executors to declare their file footprint up front, forcing the validator to speak in three mutually exclusive verdicts, and forcing agents that encounter plan-vs-reality mismatches to stop and write a report instead of silently widening scope.

| Capability | v2.5 | v2.6 |
|---|---|---|
| Task file footprint | Declared in prose, enforced by honor system | `files_expected: {modify, create, delete}` block on every task, deterministically checked via `git diff --name-status` after each executor commit (HARDEN-01) |
| Divergence handling | Agents noticed and silently fixed → drift accumulated | Behavioral protocol v1.1.0: detect → STOP → write `divergence_report` JSON → exit non-zero → orchestrator picks one of four reconciliation options |
| Validator vocabulary | `--pass` and `--fail`, severity-tagged failures | Three mutually exclusive verdicts — `--pass` (exit 0), `--fail` (exit 1), `--gaps-found` (exit 2) — with a locked `gaps_report.json` schema and a `non_gaps_observations[]` pressure-release valve (HARDEN-04) |
| D-phase learning format | Free text | Structured WHAT/WHY/WHEN/CATEGORY/TAGS block with 9 fixed categories, curated tag vocabulary, banned-tag stripping, synonym normalization, 5-tag cap, GIN index, <50ms tag+category search (LEARN-01..07, Phase 10) |
| E-phase evidence | Branch name in notes | Mandatory `PRE_EXECUTION_EVIDENCE` block with past failure citations, SKB best-practice refs, existing style, and a security checklist — parsed by the validator as a Gate 6 advisory warning in v2.6 (EXEC-01..08, Phase 11) |
| T-phase evidence | Test output in notes | `inherited_success_criteria` verification + `EDGE_CASES` block (≥ 2 edge cases per happy-path criterion) + `REGRESSION` block with before/after counts (QA-01..08, Phase 12) |
| R-phase research | Single query path | Task-type-gated creative research variants via `gsd-research --creative` flag; conservative default for implementation tasks (CREATIVE-01..05, Phase 13) |
| P-phase planning | Prose plans parsed ad hoc | Structured XML `<story>`/`<task>` blocks with `files_expected` and `acceptance_criteria`; `gsd-tools plan-to-tasks` auto-registers them into Amauta with `metadata.plan_local_id` identity contract (PLAN-01..07, Phase 14) |
| Orchestrator hardening | Implicit discipline | 5 hardening measures: manifest check + divergence protocol + agent prompt updates + validator `--gaps-found` verdict + synthetic behavioral test suite (HARDEN-01..05, Phase 13.1) |
| End-to-end verification | Manual walkthrough | `verify-v26.cjs` structural audit + `15-AUDIT-REPORT.json` deterministic report + behavioral test suite gated by `ANTHROPIC_API_KEY` (DOGFOOD-01..05, Phase 15) |
| Documentation of discipline | Post-hoc essays | `docs/v2.6-dogfood-ledger.md` — human-readable transcription of 9 captured depths of the divergence protocol firing in real v2.6 work (depths 0 through 9, depth 3 intentionally left open) |

Each addition exists because a specific failure mode — documented in the Phase 13 incident, in the Phase 15 dogfood ledger, or in the v2.4/v2.5 pitfall analyses — demonstrated that the previous generation's honor-system enforcement was insufficient. The v2.6 additions do not replace the old honor system; they add a deterministic floor underneath it so that when the honor system drifts (and it will), the drift is visible and recoverable.

---

## What Amauta Adds Over GSD

| Capability | Vanilla GSD | GSD-Amauta |
|---|---|---|
| Task state | Markdown files, no locking | PostgreSQL + JSON with TOCTOU-safe concurrent access |
| Memory | `STATE.md`, grows forever | PG memory + pgvector semantic search + distillation + tiered retention + recency decay |
| Code context | Full file injection into prompts | BM25-scored RLM chunk retrieval (10–50x context reduction) |
| Quality gate | Honor system | 5-phase RPETD pipeline with structured evidence and external validation |
| Validation | Self-marking (agents mark own work done) | External validation — no agent validates its own work |
| Research | WebFetch only | 5-step chain: Memory → SKB → Context7 → Perplexity → WebFetch |
| Learning | Manual notes | Auto-capture from every D-phase, cross-project transfer, SKB promotion after validation |
| Agents | Generic prompts | 11 specialists with file-pattern routing + performance tiebreaker fallback |
| Memory writes | Blind append, duplicates accumulate | Idempotent writes with Jaccard text dedup + embedding cosine similarity check |
| Memory lifecycle | No cleanup | Auto-distillation at configurable threshold, recency decay, tiered retention, source filtering |
| Token efficiency | No optimization | Enrichment dedup window, Perplexity output cap, RPETD phase-specific reduction |
| Caching | None | Redis L2 embedding cache, Perplexity response cache, RLM LRU cache with hit/miss stats |
| Error recovery | None | 4-category error classification (TRANSIENT / GATE_FAIL / CAPABILITY_MISMATCH / SYSTEMIC) with auto-escalation at 3 consecutive failures |
| Project isolation | None | `__test__` routing, `project_id` scoping on all memory and task queries |
| Scope discipline | Operator vigilance | v2.6: deterministic per-task `files_expected` manifest check + behavioral divergence protocol |
| Verdict vocabulary | Binary pass/fail | v2.6: three verdicts (`pass` / `fail` / `gaps-found`) with locked `gaps_report.json` schema |

---

## System Architecture

```mermaid
graph TB
    subgraph Claude["Claude Code Session"]
        CMD["Slash Commands (34)"]
        WF["Workflows (36 .md)"]
        AG["Agent Definitions (11)"]

        CMD --> CLI
        WF --> CLI
        AG --> CLI
    end

    subgraph CLI["Node.js CLI Layer"]
        AMAUTA["amauta.cjs<br/>Task Management"]
        MEM["gsd-memory.cjs<br/>PG Memory + Embeddings"]
        RLM_CLI["gsd-rlm.cjs<br/>Code Context"]
        RES["gsd-research.cjs<br/>Research Chain"]
        TOOLS["gsd-tools.cjs<br/>GSD Core + Manifest Check"]
    end

    subgraph Services["Background Services"]
        DAEMON["Amauta Daemon<br/>:18799 HTTP"]
        RLM_SVC["RLM Service<br/>:18798 HTTP"]
        REDIS["Redis 7<br/>L2 Cache :6379"]
    end

    subgraph Storage["PostgreSQL 16 + pgvector (8 migrations)"]
        GM["gsd_memory<br/>text + vector(1024)<br/>HNSW cosine index"]
        GS["gsd_shared_kb<br/>validated knowledge"]
        GT["gsd_tasks<br/>task state + RPETD log"]
        GV["gsd_task_validations<br/>audit trail"]
        GA["gsd_audit_log<br/>immutable events"]
        GP["gsd_agent_performance<br/>routing metrics"]
        GAC["gsd_applied_learnings<br/>APPLIED_LEARNING citations"]
    end

    subgraph APIs["External APIs"]
        VOY["Voyage AI<br/>voyage-code-3 (1024d)"]
        PPX["Perplexity<br/>sonar / sonar-pro"]
        C7["Context7 MCP<br/>Library Docs"]
    end

    AMAUTA --> DAEMON
    MEM --> DAEMON
    RLM_CLI --> RLM_SVC
    RES --> PPX
    RES --> C7
    DAEMON --> Storage
    DAEMON --> VOY
    DAEMON --> REDIS
    RLM_SVC -.->|"BM25 scoring<br/>LRU cache"| RLM_SVC
    REDIS -.->|"L2 embedding cache<br/>3600s TTL"| DAEMON
```

**Philosophy.** The architecture is built around a single assertion: every RPETD phase must see what the other phases have already learned. That assertion has three load-bearing consequences. First, memory must be cheap enough to query that phases don't skip retrieval (hence the Redis L2 cache wrapping the in-memory L1 dict). Second, the retrieved context must be small enough that injecting it doesn't blow the context budget (hence BM25 chunk retrieval over whole-file injection). Third, the stored memories must be high-signal enough that retrieval is worth the round trip (hence distillation, recency decay, tiered retention, and source-aware scoring). Each of those three is independently a graceful-degradation path — remove Redis and the L1 dict handles it; remove the RLM service and `@` file references handle it; remove PostgreSQL and a JSON file with text ILIKE handles it.

---

## Installation

Amauta installs as a Claude Code plugin (`~/.claude/`) and optionally as plugins for OpenCode, Gemini CLI, and Codex. The installer is non-destructive — local modifications to installed files are detected and preserved in `gsd-local-patches/` for manual merge, and any existing Claude Code configuration is updated in place rather than overwritten.

### Prerequisites

Required on any platform:

- **Node.js 18+** — CLI tools and installer
- **Python 3.9+** — Amauta daemon and RLM service
- **Claude Code CLI** — the runtime Amauta plugs into (`claude.ai/code`)

Optional, for the full feature set:

- **Docker** — enables the bundled PostgreSQL 16 + pgvector container and the bundled Redis 7 container via `docker compose`. Without Docker, Amauta falls back to SQLite + file-based caching.
- **Voyage AI API key** — enables semantic search via `voyage-code-3` embeddings (1024 dimensions, cosine similarity via pgvector HNSW index). Without it, search falls back to PostgreSQL full-text search + `ILIKE`.
- **Perplexity API key** — enables the external research cascade step. Without it, the research chain stops at the Context7 MCP step (or at WebFetch if no MCP).
- **OpenAI API key** — alternative embedding provider; `GSD_EMBEDDING_PROVIDER=openai` forces this path instead of Voyage.

No API keys are required for the core RPETD pipeline to function. Amauta's graceful degradation is not a marketing claim — every feature has a fallback path wired into the code and exercised by the test suite.

### Option 1 — One-Line Remote Install (Recommended)

This is the shortest path. It downloads the installer script, which in turn clones the repository into `~/.claude/gsd-amauta/`, runs `npm install`, and executes the self-installer.

```bash
curl -fsSL https://raw.githubusercontent.com/Luiscmogrovejo/gsd-amauta/master/scripts/install-remote.sh | bash
```

Your team installs Amauta with a single command — no `git clone`, no manual steps, no hand-editing of `~/.claude/settings.json`. The installer is idempotent; running it again updates to the latest version and preserves any local modifications.

### Option 2 — Clone + Install

Use this path when you want to develop on Amauta itself, or when you want the source tree in a location you control.

```bash
git clone https://github.com/Luiscmogrovejo/gsd-amauta.git ~/.claude/gsd-amauta
cd ~/.claude/gsd-amauta
npm install
```

`npm install` triggers the postinstall script (`bin/install.js`), which performs the installation steps described below. You can re-run the installer at any time via:

```bash
node bin/install.js              # Interactive, prompts for runtime selection
node bin/install.js --claude     # Claude Code only
node bin/install.js --all        # Claude + OpenCode + Gemini + Codex
node bin/install.js --uninstall  # Remove everything the installer wrote
```

### What the Installer Does (Step by Step)

When you run `node bin/install.js` (or the one-line remote script), it walks through the following steps in order. Each step is idempotent and the installer prints a `✓` on success, `⚠` on a recoverable skip, and `✗` on a hard error.

1. **Detects the target runtime.** If a flag like `--claude` or `--all` is passed, the installer uses it directly. Otherwise it prompts you interactively. In non-interactive terminals (CI, heredocs, piped stdin), it defaults to `--claude --global`, which installs to `~/.claude/`.

2. **Scans for local modifications.** Before writing anything, the installer compares every file it is about to install against the existing file on disk (if any). Any file whose hash differs is backed up to `gsd-local-patches/` with a note telling you how to reapply the patch. This is how Amauta protects your customizations during updates — the installer never silently overwrites your local tweaks. After installation, run `/amauta:reapply-patches` in Claude Code to merge them back, or merge manually by comparing the patched file to the new version.

3. **Writes 11 agent definitions** into `~/.claude/agents/` (or the equivalent directory for OpenCode, Gemini, Codex). The 11 agents are `gsd-operator`, `gsd-planner`, `gsd-researcher`, `gsd-checker`, `gsd-validator`, `gsd-debugger`, `gsd-roadmapper`, `gsd-executor-frontend`, `gsd-executor-backend`, `gsd-executor-infra`, `gsd-executor-general`. Each agent is a Markdown file with a YAML frontmatter block declaring its tool access, model profile, and persona. The `checker` and `validator` agents are installed as `read-only` in Codex — they cannot `Edit` or `Write` any file, which is the agent-level enforcement of the "no self-validation" rule.

4. **Writes 34 slash commands** into `~/.claude/commands/amauta/` and `~/.claude/commands/gsd/`. These are the `/amauta:*` and `/gsd:*` commands you invoke in the Claude Code prompt. Examples: `/amauta:new-project`, `/amauta:plan-phase`, `/amauta:execute-phase`, `/amauta:verify-work`, `/amauta:verify-v26` (added in v2.6 Phase 15).

5. **Writes 11 skills** into `~/.claude/skills/`. Skills are per-agent workflow definitions (`SKILL.md` files) that Claude Code auto-discovers and surfaces when the corresponding agent is active.

6. **Writes 3 hooks** (`~/.claude/hooks/*.sh`) — pre-commit, post-tool, and user-prompt-submit hooks that enforce Amauta's invariants at the harness level. Hooks are shell scripts so they run before Claude Code dispatches the next tool call.

7. **Copies the `get-shit-done/` tree** to `~/.claude/get-shit-done/`. This tree contains the CLI tools (`amauta.cjs`, `gsd-memory.cjs`, `gsd-rlm.cjs`, `gsd-research.cjs`, `gsd-tools.cjs`), the workflow reference files (`workflows/`, `references/`), the agent capability index (`agent-capabilities.json`), and the file manifest (`gsd-file-manifest.json` — the installer's record of what it wrote).

8. **Writes the VERSION file** (`~/.claude/get-shit-done/VERSION` = `2.6.0`) so agents and workflows can detect the installed Amauta version at runtime without parsing `package.json`.

9. **Registers the MCP server** in `~/.claude/mcp_servers.json`. Amauta ships with a native MCP server (`bin/mcp-server.cjs`) that exposes 6 tools to Claude Code via the Model Context Protocol. These tools are `gsd_task_create`, `gsd_task_claim`, `gsd_task_rpetd`, `gsd_task_validate`, `gsd_memory_search`, and `gsd_rlm_query`. If the MCP server is already registered under a different name, the installer updates the existing entry rather than adding a duplicate.

10. **Copies the Python backend** (`amauta.py`, `services/amauta-daemon.py`, `services/amauta_daemon_redis.py`, `services/pg_store.py`, `services/rlm-service.py`) to the install directory so the daemons can be launched without requiring the source tree.

11. **Detects existing infrastructure and starts services.** The installer runs `docker compose -f docker/docker-compose.yml up -d` to bring up PostgreSQL 16 + pgvector (on port 5433, not the default 5432, to avoid conflicting with a system PostgreSQL) and Redis 7 (on port 6379). If `docker compose` fails — for example because port 6379 is already bound by a different Redis instance on your machine — the installer reports the failure, tells you to resolve it manually, and proceeds. Amauta's daemon still starts even without Docker; it falls back to SQLite and to the in-memory L1 cache wrapped by file-based caching.

12. **Starts the Amauta daemon** (`services/amauta-daemon.py`) on port 18799 and the RLM service (`services/rlm-service.py`) on port 18798. Both daemons are managed lifecycle services — the installer checks if they're already running before attempting to start them, and it stores the PID files in `services/*.pid` for later `stop` and `restart` commands.

13. **Writes `config.json`** at `~/.claude/get-shit-done/config.json`. This file holds the per-command configuration (model profiles, parallelization flag, commit toggles, phase branching strategy). The installer merges with any existing config rather than overwriting.

14. **Prints a final summary** of what was installed, what was skipped, what was backed up to `gsd-local-patches/`, and the status of each background service (PostgreSQL, Redis, daemon, RLM service). If anything failed, the summary is the first place to look.

### Post-Install — Optional API Keys

Add any of the following to `~/.zshrc` or `~/.bashrc` and source the file (or open a new terminal). None are required for Amauta to function; each unlocks a specific optional feature.

```bash
# Optional: Voyage AI for semantic memory search (voyage-code-3, 1024d)
export VOYAGE_API_KEY="your-key-here"

# Optional: Perplexity for the research chain step 4
export PERPLEXITY_API_KEY="your-key-here"

# Optional: OpenAI as an alternative embedding provider
export OPENAI_API_KEY="your-key-here"

# Optional: force a specific embedding provider (default: auto-detect)
export GSD_EMBEDDING_PROVIDER="voyage"    # or "openai"
```

Without API keys, Amauta still works — semantic search falls back to PostgreSQL full-text + `ILIKE`, research uses local memory + SKB + Context7 MCP (if registered) + WebFetch. The feature degradation is logged to the daemon `/health` endpoint as `service_errors[]` entries, so you can see exactly which fallbacks are active at any moment.

### Verification

After installation, run these three commands to confirm every layer is healthy:

```bash
# 1. Amauta daemon health (detailed JSON)
curl -s http://127.0.0.1:18799/health | python3 -m json.tool

# 2. RLM service health
curl -s http://127.0.0.1:18798/health | python3 -m json.tool

# 3. Python test suite (should complete with 0 failures on a clean install)
python3 -m pytest tests/ -q
```

A healthy install shows:

- Daemon `status: ok`, `pipeline_status: ok` (or `degraded` if Redis/RLM are optional-down), `pg_available: true`
- RLM `status: ok`, `indexed_files` > 0 for your project root
- pytest passes (0 failures, ~466 tests as of v2.6)

If the daemon reports `pipeline_status: degraded`, check `service_errors[]` in the JSON output — it names exactly which fallback path is active. A degraded status is not a failure; it's Amauta telling you which optional feature it had to route around.

### Troubleshooting Common Install Issues

- **Port 6379 already bound** (Redis install skipped). Another Redis instance is already running on your system. Amauta will use it if it's reachable at `redis://127.0.0.1:6379/0`, or fall back to the in-memory L1 cache if authentication fails. To force Amauta to start its own Redis on a different port, edit `docker/docker-compose.yml` to change the port binding and set `GSD_REDIS_URL` to match.
- **Port 5433 already bound** (PostgreSQL container fails to start). You either have a previous Amauta PG container still running (`docker ps -a | grep gsd-postgres`, then `docker rm -f gsd-postgres`) or something else is using 5433. Amauta uses 5433 specifically to avoid colliding with system PostgreSQL on 5432.
- **`statusline already configured — use --force-statusline to replace`**. The installer detected an existing Claude Code status line and refused to overwrite it. Re-run with `node bin/install.js --force-statusline` if you want Amauta's status line to take over.
- **`Found N locally modified GSD file(s) — backed up to gsd-local-patches/`**. The installer found files you had modified locally. They're safe in `gsd-local-patches/`; run `/amauta:reapply-patches` in Claude Code to merge them into the new version, or compare manually.
- **`Context7 MCP not registered`**. Amauta does not bundle Context7 — it expects you to add it to your Claude Code MCP servers separately. Without it, the research chain skips the library-docs step and goes directly to Perplexity.

---

## Quick Start — First Task End-to-End

This walkthrough takes about 5 minutes and runs a real RPETD task end-to-end so you can confirm every layer is firing. It assumes you've completed installation and the daemon is healthy.

### 1. Create a task

```bash
amauta add task "Investigate how RLM BM25 scoring is tuned" --agent gsd-researcher
```

Output: `TK-XXXX created, status: pending, agent: gsd-researcher, project: <your-project>`. The task is now in the `gsd_tasks` PostgreSQL table and in `data/tasks.json` (dual-write).

### 2. Claim it

```bash
amauta claim TK-XXXX --agent gsd-researcher
```

Claiming does more than flip the status. At claim time, the daemon runs **Layer 1 enrichment**: it fires two RLM queries against your project root (seeded from the task title and description) and injects the top-scored chunks directly into the task's context block. This is the moment where "every phase sees what the others have learned" starts being true.

### 3. Log the Research phase

```bash
amauta rpetd TK-XXXX --phase R --content "Layer 1 RLM injected 2 chunks from get-shit-done/bin/gsd-rlm.cjs and services/rlm-service.py. Layer 2 R-phase query via HTTP returned 3 more chunks showing the k1=1.5, b=0.6 tuning in _bm25Score(). Memory search surfaced one past learning about the v2.5 BM25 audit. No external research needed."
```

The daemon enforces a ~500 char target for R-phase content. Over-cap is a warning, not a block. Content under 50 chars triggers the R/P substance gate as a warning.

### 4. Log the Plan phase

```bash
amauta rpetd TK-XXXX --phase P --content "Read bm25Score() in services/rlm-service.py lines 210-280. Document the k1/b values and the position-decay formula. Output: one-paragraph summary with file:line pointers. No code changes."
```

### 5. Log Execute, Test, Document

```bash
amauta rpetd TK-XXXX --phase E --content "Read services/rlm-service.py:210-280. Confirmed k1=1.5, b=0.6, position_decay=-0.05 per chunk position. Label boost 1.5x capped at 3.0*idf."
amauta rpetd TK-XXXX --phase T --content "Verified against RLM_POSITION_DECAY env var at line 45. pytest tests/test_rlm_bm25.py -q: 7 passed, 0 failed."
amauta rpetd TK-XXXX --phase D --content "Delivered: BM25 tuning documented. LEARNING: BM25 b parameter tuned from default 0.75 to 0.6 during the v2.5 audit to reduce length-normalization impact on code chunks, which vary more in length than natural-language documents."
```

The D-phase content MUST contain a `LEARNING:` line. The validator's Gate 3 checks for it literally. The LEARNING line will be auto-extracted by `gsd-memory` and stored with `source=auto_learning` (+3 boost) so future R-phases in any task can retrieve it.

### 6. Move to validation

```bash
amauta status TK-XXXX validation
```

The task is now waiting for an external validator. Amauta blocks self-validation at the CLI level — `claimed_by` must differ from `validated_by` or `amauta validate` exits non-zero.

### 7. Validate (as a different agent)

```bash
amauta validate TK-XXXX --pass --validator gsd-validator --notes "5 gates passed: branch evidence in E-log, test output in T-log, LEARNING block in D-log, no PR required (research task), P-phase success criteria met"
```

If any of the five gates fails, the validator runs `amauta validate TK-XXXX --fail --notes "reason"` and can optionally atomize the work into sub-tasks. If the verdict is ambiguous — the evidence doesn't cleanly map to pass or fail — the validator uses `--gaps-found` (exit code 2), which triggers the locked `gaps_report.json` schema (see [Validator Vocabulary Lock](#validator-vocabulary-lock-harden-04)).

### 8. Confirm the LEARNING landed in memory

```bash
gsd-memory search "BM25 tuning"
```

You should see your new learning appear in the results with `source: auto_learning` and a score boost of +3. Run it again in 30 days and recency decay will start pulling the score down (-0.5 per 30 days, capped at -3.0). Cite it in a future task's RPETD content as `APPLIED_LEARNING: mem-<id> -- used BM25 tuning reference in audit` and the operator will call `gsd-memory increment-applied` after task close, tracking how often the learning actually gets used.

That's the full loop. Every step of this walkthrough touched at least one of the four concepts the rest of this README expands on: RPETD (the pipeline), RLM (the Layer 1/Layer 2 enrichment), PostgreSQL memory (the learning store), and the validation gates (the external review).

---

## The RPETD Pipeline

Every task is forced through five phases. Validation gates block progress at each stage, and the validator (a different agent than the executor) reviews the combined evidence at the end.

```mermaid
flowchart LR
    CLAIM["Task Claimed"] --> R

    subgraph R["R -- Research"]
        R1["Query PG memory (pgvector semantic)"]
        R2["Query Shared KB"]
        R3["Auto-invoke research chain<br/>if less than GSD_RESEARCH_MIN_RESULTS local hits"]
    end

    R --> P

    subgraph P["P -- Plan"]
        P1["Given / When / Then criteria"]
        P2["Step-by-step approach"]
        P3["Success criteria + deliverables"]
        P4["files_expected manifest<br/>(modify/create/delete)"]
    end

    P --> E

    subgraph E["E -- Execute"]
        E1["Feature branch created"]
        E2["Code committed"]
        E3["PRE_EXECUTION_EVIDENCE block (v2.6)"]
        E4["Manifest check after each commit<br/>(HARDEN-01)"]
    end

    E --> T

    subgraph T["T -- Test"]
        T1["Run test suite"]
        T2["Capture raw output"]
        T3["inherited_success_criteria verified (v2.6)"]
        T4["EDGE_CASES + REGRESSION blocks (v2.6)"]
    end

    T --> D

    subgraph D["D -- Document"]
        D1["WHAT/WHY/WHEN/TAGS LEARNING block (v2.6)"]
        D2["Auto-store to PG memory"]
        D3["APPLIED_LEARNING citations collected"]
    end

    D --> V["External Validation<br/>5 gates + pre-gate divergence scan<br/>--pass / --fail / --gaps-found"]

    V -->|PASS| DONE["Done + SKB promotion"]
    V -->|FAIL| FIX["Sub-tasks created<br/>Re-route via recovery table"]
    V -->|GAPS_FOUND| GAPS["gaps_report.json written<br/>Re-plan by gsd-planner"]
    FIX --> CLAIM
    GAPS --> CLAIM

    style R fill:#e8f4fd,stroke:#1a73e8
    style P fill:#fef7e0,stroke:#f9ab00
    style E fill:#e6f4ea,stroke:#34a853
    style T fill:#fce8e6,stroke:#ea4335
    style D fill:#f3e8fd,stroke:#9334e6
```

### Why five phases, not four or six

The five phases are not arbitrary. Each exists because its absence produced a specific failure mode in pre-v2.0 operation:

- **R (Research) exists** because executors would otherwise write code against assumptions that were already documented to be wrong. In the old world, agents routinely re-implemented a broken pattern because they didn't query the learning store first. R-phase forces the query. The content is capped at ~500 chars so that the research itself doesn't become a full-text dump; the value is in *knowing* something was learned, not in pasting the raw source.

- **P (Plan) exists** because without a Given/When/Then acceptance criterion, there is no way for the validator to decide whether the work is done. The P-phase locks the success criteria before any code is written, so the executor can't redefine success mid-task to match what they produced. In v2.6, the P-phase also locks the `files_expected` manifest — the exact set of files the task will modify, create, or delete — which becomes the input to HARDEN-01's deterministic drift check.

- **E (Execute) exists** because code has to be written on a feature branch with a commit trail. The E-phase is the only RPETD phase where code changes are legal; R, P, T, and D phases that modify code are themselves protocol violations. In v2.6, the E-phase also requires a `PRE_EXECUTION_EVIDENCE` block citing past failure patterns, SKB best-practices, existing code style, and a security checklist — so that executors are demonstrably looking at the learning store *before* writing code, not after.

- **T (Test) exists** because the honor-system assertion "the tests pass" is not evidence. The T-phase requires captured raw test output with the exact pass/fail counts, and in v2.6 it also requires an `EDGE_CASES` block (≥ 2 edge cases per happy-path criterion) and a `REGRESSION` block with before/after test counts (`before: 2479p/0f, after: 2479p/0f`). This is the gate that catches executors who wrote a happy-path test, hit green, and declared victory.

- **D (Document) exists** because unless the learning is written down in a form the memory store can retrieve, the task just taught Amauta nothing. The D-phase requires a `LEARNING:` line (v2.5 format) or a full WHAT/WHY/WHEN/CATEGORY/TAGS block (v2.6 structured format, Phase 10). The daemon auto-extracts the LEARNING content, writes it to `gsd_memory` with `source=auto_learning` (+3 boost), auto-embeds it via Voyage AI (or falls back to text search), and — on validation pass — promotes the learning to the Shared KB for cross-project retrieval.

### Enrichment per phase (v2.5 phase-specific reduction)

Each RPETD phase has a different enrichment profile, calibrated to what that phase actually needs. The calibration was done in v2.5 after a token audit showed that injecting the same context into every phase was wasting ~1950 chars per task lifecycle.

| Phase | RLM Layer | Memory Enrichment | Soft Cap | v2.5 Change |
|---|---|---|---|---|
| Claim | Layer 1: 2 code-context queries injected into task | — | — | — |
| R | Layer 2: phase-specific RLM query via HTTP | Semantic search (pgvector) + Shared KB | ~500 chars | — |
| P | Layer 2 | — | ~300 chars | — |
| E | RLM-only (Layer 2) | Past failure patterns from memory | ~500 chars | Memory enrichment removed |
| T | None | — | ~300 chars | All enrichment removed |
| D | Writes-only | — | ~400 chars | Read enrichment removed |

Phase-specific reduction saves ~1950 chars per full RPETD lifecycle (39.4% Layer 2 reduction, 24% total lifecycle reduction). Enrichment deduplication ensures the same chunk is never injected twice within a 300-second window (`ENRICHMENT_DEDUP_WINDOW`) — if Layer 1 RLM fired at claim time and the R-phase runs within 300 seconds, Layer 2 R-phase skips re-injection.

### Concrete example — what the RPETD log looks like for a real task

```
TK-0774 "Implement PRE_EXECUTION_EVIDENCE parser" (gsd-executor-backend)

R: Layer 1 RLM injected 2 chunks from pg_store.py _checkRedGreenOrder. Layer 2 R-phase pulled 3 more from the validator. Memory search: 4 past learnings on evidence parsing. Research chain not invoked (2+ local hits).

P: Add parseEvidenceBlock() to gsd-amauta.cjs at line ~1400. Schema: { citations: [], sections: [pre_exec, sec_checklist], parse_warnings: [] }. Acceptance: parser handles missing blocks gracefully, emits PARSE_WARN:empty for under-50-char content. files_expected: {modify: [get-shit-done/bin/gsd-amauta.cjs], create: [tests/11-pre-exec-parser.test.cjs], delete: []}.

E: feat(11-02-01): implement parseEvidenceBlock() — commit a7032d6. PRE_EXECUTION_EVIDENCE block applied: cited TK-0712 (past parse-warning pattern), SKB entry on advisory validator gates, existing style from parseLearningBlock() at line 1155, security checklist: N/A for parser (no user input path).

T: npm run test tests/11-pre-exec-parser.test.cjs -- 8 passed, 0 failed. inherited_success_criteria: parser handles missing block (tested), under-50-char emits warning (tested). EDGE_CASES: empty string, only whitespace, citation with no text, block with no citations. REGRESSION: before 2479p/0f, after 2487p/0f (+8 new tests).

D: Delivered parseEvidenceBlock() + 8 tests. LEARNING: Advisory parsers should emit structured PARSE_WARN: prefixed warnings rather than throwing, so the validator can decide whether to surface them as gaps_found or non_gaps_observations per HARDEN-04.
```

That log is the full audit trail for a single task. Everything a future agent needs to understand *why* the parser exists, *what* it was called against, and *what* was learned is captured in those five phase blocks. When the task closes, the daemon promotes the LEARNING line to `gsd_memory`, increments `applied_count` for each cited prior learning, and (on validation pass) promotes eligible learnings to the Shared KB for cross-project retrieval.

---

## The 11 Specialist Agents

11 specialists, each with a defined role, tool access boundary, and file-pattern routing. The operator is the sole orchestrator; every other agent is spawned via a Task() call from the operator, executes its piece, and returns. No agent can write to `.planning/STATE.md`, `.planning/ROADMAP.md`, or `.planning/REQUIREMENTS.md` except the orchestrator — those files are in the `ORCHESTRATOR_OWNED` hard-halt list (see [HARDEN-01](#harden-01-manifest-enforcement)).

```mermaid
graph TB
    OP["gsd-operator<br/>Master Orchestrator<br/>P1 P2 P6 P8 P9 P14-P19"]

    OP --> PL["gsd-planner<br/>Given/When/Then specs<br/>P6 P14"]
    OP --> RS["gsd-researcher<br/>Memory + SKB + Perplexity<br/>P7 P20"]
    OP --> CK["gsd-checker<br/>Pre/post quality<br/>P5 P16"]
    OP --> VA["gsd-validator<br/>External validation<br/>P5 P16 P17"]
    OP --> DB["gsd-debugger<br/>Root cause + bisect<br/>P13 P15"]
    OP --> RM["gsd-roadmapper<br/>ROADMAP.md + milestones"]

    OP -->|"File-pattern routing"| ROUTE{{"*.tsx *.jsx *.css *.vue<br/>*.py *.sql *.go *.rs<br/>Dockerfile *.yml k8s/<br/>everything else"}}

    ROUTE --> EF["executor-frontend"]
    ROUTE --> EB["executor-backend"]
    ROUTE --> EI["executor-infra"]
    ROUTE --> EG["executor-general"]

    EF & EB & EI & EG -->|"RPETD complete"| VA

    style OP fill:#1a73e8,color:#fff
    style VA fill:#ea4335,color:#fff
    style ROUTE fill:#f9ab00,color:#000
```

### Agent roster

| Agent | Role | Tool Access | File Patterns | Primary Patterns |
|---|---|---|---|---|
| `gsd-operator` | Orchestration, routing, planning | Read-only | — | P1, P2, P3, P6, P8, P9, P14–P19 |
| `gsd-planner` | Given/When/Then specs + `<task>`/`<files_expected>` XML | Read-only | — | P1, P6, P13, P14 |
| `gsd-researcher` | Memory + SKB + Perplexity cascade | Read-only | — | P4, P7, P13, P20 |
| `gsd-checker` | Pre/post quality checks | Read-only | — | P5, P10, P16 |
| `gsd-validator` | External validation (5 gates + pre-gate divergence scan) | Read-only | — | P5, P10, P16, P17 |
| `gsd-debugger` | Root cause, bisect, scientific method | Full (Read/Write/Edit/Bash) | — | P4, P5, P7, P11, P13, P15 |
| `gsd-roadmapper` | `ROADMAP.md`, milestone layout | Full | `.planning/ROADMAP.md` | — |
| `gsd-executor-frontend` | Frontend code | Full | `.tsx`, `.jsx`, `.css`, `.scss`, `.html`, `.vue`, `.svelte` | P4, P7, P11, P12 |
| `gsd-executor-backend` | Backend code | Full | `.py`, `.js`, `.cjs`, `.mjs`, `.ts`, `.go`, `.rs`, `.java`, `.sql` | P4, P7, P11, P12 |
| `gsd-executor-infra` | Infrastructure code | Full | `Dockerfile`, `docker-compose*`, `.github/workflows/`, `terraform/`, `k8s/`, `nginx.conf` | P4, P7, P11, P12 |
| `gsd-executor-general` | Fallback, config files, docs, scaffolding | Full | Everything else | P4, P7, P11, P12 |

### Per-agent judgment surfaces

**`gsd-operator`** — the only orchestrator. It is the agent that decides which executor gets which task based on file patterns, which wave executes in parallel, when to halt a phase, and when to route a divergence report to a different agent. It is explicitly read-only — it does not write code — so that its judgment calls are legible in the task manager's audit log rather than scattered across file edits. Failure mode prevented: silent scope creep from an operator that also writes code, which Phase 13 demonstrated in the `gsd-amauta.cjs` refactor incident.

**`gsd-planner`** — the only agent that emits structured `<task>` / `<files_expected>` XML blocks. When a phase plan is handed off to execute-phase, `gsd-tools plan-to-tasks` parses those XML blocks, validates the `files_expected` schema (modify/create/delete — all three fields required, use `[]` for empty), cross-checks that the planner's `<agent>` assignment matches what `routeExecutor()` would compute from the file patterns, and creates Amauta tasks with `metadata.plan_local_id` set to the planner-emitted ID. Any drift between the planner's assignment and the routing rule is a `divergence_type: agent_assignment_conflict` (added in divergence protocol v1.1.0).

**`gsd-researcher`** — the only agent explicitly allowed to invoke Perplexity directly. Other agents query memory and SKB via `gsd-memory`, but only `gsd-researcher` runs the full 5-step cascade. It has four research modes (quick-check, deep-dive, architecture-review, pattern-search) that trade off depth vs token cost, and it has a dedicated `--creative` flag (added in Phase 13, CREATIVE-01..05) that unlocks task-type-gated creative variants for open-ended research questions. For implementation tasks the default is conservative: the flag is off and the researcher returns tight citation-grounded results.

**`gsd-checker`** — a read-only agent that runs pre-execution and post-execution quality checks. Pre-checks validate that a plan passes the planner quality gate (all `<task>` blocks have `<files_expected>`, `<acceptance_criteria>`, `<agent>`; no overly-broad globs; no duplicate task IDs). Post-checks run after executor commits but before validator dispatch, catching issues early enough that the validator doesn't have to deal with them. Failure mode prevented: validators getting overwhelmed with trivial issues, which drove up the false-positive rate of the `gaps_found` verdict in v2.5.

**`gsd-validator`** — the only agent allowed to emit `--pass`, `--fail`, or `--gaps-found` verdicts on a task. Read-only by design — it cannot Edit or Write any file, so the only way it can affect state is via `amauta validate --pass/--fail/--gaps-found`, each of which writes a structured audit record. In Codex runtime, the sandbox is enforced at the runtime level (`CODEX_AGENT_SANDBOX["gsd-validator"] = "read-only"`). The validator is explicitly forbidden from picking a "fix it" reconciliation option when it files its own divergence report; fixing is a re-plan task for `gsd-planner`.

**`gsd-debugger`** — the full-access specialist for root-cause work. It uses the scientific method (hypothesis → test → observe → conclude) tracked via a persistent debug-session format (`/amauta:debug`), so long debugging sessions survive context resets. The debugger queries memory for past failures at every hypothesis step, keeping the failure-pattern knowledge base live. Failure mode prevented: the "I'll just fix it and move on" path that leaves no audit trail for the next time the same bug surfaces.

**`gsd-roadmapper`** — the one agent allowed to edit `.planning/ROADMAP.md` outside the orchestrator. It exists to create phase breakdowns, derive requirement IDs, and produce phase-validation success criteria. Spawned only by `/amauta:new-project` and the milestone-related slash commands.

**`gsd-executor-{frontend,backend,infra,general}`** — the four code-writing executors. Each has a file-pattern scope (see the table above). The router (`gsd-tools.cjs routeExecutor`) computes the correct executor for a given set of files; if the planner's `<agent>` field disagrees with the router's output, the plan is rejected before execution starts. A performance tiebreaker applies: executors with a pass rate below 70% on 5+ completed tasks auto-fallback to `executor-general`. The fallback decision is logged to the task notes as `PERF_ROUTING_OVERRIDE` for audit.

### Performance routing

When multiple executors match a task's file patterns, the executor with the best historical pass rate wins the tiebreaker. Executors with a pass rate below 70% on 5+ completed tasks trigger automatic fallback to `gsd-executor-general`. Because `executor-general` is the fallback of last resort, it is never itself fallback-routed; if `executor-general` has sub-70% pass rate, the router stops at the primary executor rather than looping. The audit trail records every routing override as a task note, so a low-performing executor can be debugged rather than silently rerouted.

---

## The RLM Context Engine

RLM (Retrieval Language Model context engine) is Amauta's code search layer. It is based on the MIT CSAIL paper on retrieval-augmented code context (arXiv:2512.24601v1), adapted to Amauta's per-phase enrichment model. Agents retrieve relevant code chunks instead of having entire files injected into their prompts. No API keys are required — RLM is pure local BM25 retrieval against your project tree.

```mermaid
flowchart LR
    Q["Agent query:<br/>'How does auth middleware work?'"] --> RLM

    subgraph RLM["RLM Service :18798"]
        SCAN["1. SCAN<br/>Walk path, skip<br/>node_modules .git etc"]
        CHUNK["2. CHUNK<br/>Language-aware splitting<br/>Python: class/function<br/>JS/TS: function/class/export<br/>SQL: statement boundaries<br/>Markdown: headings"]
        CACHE["3. CACHE<br/>LRU keyed by<br/>(filepath, mtime)<br/>200 files"]
        SCORE["4. SCORE<br/>BM25 ranking<br/>camelCase splitting<br/>length normalization"]
        TOP["5. RETURN<br/>Top-K chunks<br/>file, lines, text, score"]

        SCAN --> CHUNK --> CACHE --> SCORE --> TOP
    end

    TOP --> AGENT["Agent receives<br/>relevant chunks only<br/>10-50x context reduction"]

    style RLM fill:#e8f4fd,stroke:#1a73e8
```

### Why retrieval beats whole-file injection

The problem RLM solves is the token budget vs accuracy tradeoff. Whole-file injection is easy (`@src/auth.ts` and you get the whole file) but wasteful: for a 500-line file where only 30 lines are relevant, you pay the context cost for all 500. Retrieval flips the economics — you pay a tiny up-front cost to score all the chunks in the file, then you inject only the top 5 chunks that actually match the query. The result in Amauta's workload is a 10–50x reduction in injected context for the same task performance.

The failure mode RLM prevents is context bloat causing cascade drift. When an agent's context window fills up with irrelevant file content, the *relevant* content gets compressed out during long conversations, and the agent starts making decisions based on what survived the compression rather than what the task actually needs. Retrieval keeps the relevant content dense and the irrelevant content out.

### BM25 in plain language

BM25 (Best Matching 25) is a ranking function that scores how well a document matches a query. In plain terms: for each word in the query, BM25 asks "how often does this word appear in this chunk, relative to how often it appears in other chunks, penalized if this chunk is much longer than average?" The formula has two knobs:

- **k1** (term frequency saturation, default 1.5 in Amauta) — how much credit a chunk gets for having a query word appear multiple times. Higher k1 = more credit for repetition. Amauta uses 1.5, slightly higher than the traditional 1.2, because code chunks often repeat identifiers naturally (a function that uses `user` in every line really is about users).

- **b** (length normalization, **tuned to 0.6 in Amauta**, lower than the traditional 0.75) — how much to penalize long chunks. Amauta's lower `b` reflects the reality that code chunks vary in length more than natural-language documents, and penalizing long chunks too aggressively causes the BM25 ranker to prefer trivial short chunks over meaty long ones. The 0.6 value was tuned during the v2.5 BM25 audit against a hand-labeled benchmark.

On top of the raw BM25 formula, Amauta's RLM adds three practical refinements:

- **Label boost (1.5x, capped at 3.0*idf).** Matches on function names, class names, and other code labels are ranked 1.5x higher than matches on the body text, because a match on the *name* of a function is a much stronger signal than a match on an incidental mention in the function body. The cap at 3.0*idf prevents ultra-rare labels from dominating.

- **Position decay (-5% per chunk position, configurable via `RLM_POSITION_DECAY`).** Later chunks in a file are penalized slightly. This reflects the observation that the first few chunks (imports, top-level declarations, main function) are usually the most semantically important, and penalizing later chunks balances the scoring against pathological files where one chunk buried at line 800 happens to have every query word.

- **Word-boundary tokenization.** v2.4 used substring `.count()` for term frequency calculation, which produced bogus scores — searching for `user` matched `database_user_id` as if it were three separate hits. v2.5 replaced this with regex word-boundary tokenization for accurate TF counts.

### camelCase and snake_case splitting

Identifiers are split before tokenization so that natural-language queries match code-style identifiers. The splitter runs before BM25 scores anything:

- `getUserProfile` becomes the tokens `get`, `user`, `profile`
- `parse_json_response` becomes `parse`, `json`, `response`
- `HTTPServer` becomes `http`, `server`

This is why a query for `user profile` matches a function named `getUserProfile` — the splitter made `user` and `profile` into first-class tokens. Without splitting, BM25 would treat `getUserProfile` as a single token and miss the match entirely.

### Cache layers

RLM has two cache layers to keep queries fast even on large project trees:

- **L1 (in-memory LRU, 200 files).** Keyed by `(filepath, mtime)`. An unchanged file is parsed and chunked once per RLM service lifetime; subsequent queries hit the LRU. Configurable via `RLM_CACHE_SIZE`.
- **L2 (Redis).** The embedding cache (used by the memory system, not RLM itself) wraps the in-memory L1 dict. 3600s TTL, SHA-256 query keys, 500-entry L1 dict capacity. RLM's own hit/miss counters are exposed at `GET /cache/stats` on the RLM service.

Stale detection: when a file's mtime changes, its L1 cache entry is invalidated and the file is re-chunked on the next query. This is the mechanism that keeps RLM's indexed view of the codebase fresh without requiring a full reindex.

### RPETD enrichment layers

RLM fires at two moments during every task:

| Layer | When | What |
|---|---|---|
| Layer 1 | Claim time | 2 RLM queries automatically injected into the task's context block. Seeded from the task title and description. |
| Layer 2 | R, P, E phases | Phase-specific RLM query via HTTP. T and D phases skip Layer 2 in v2.5's phase-specific reduction. |
| E enrichment | Execute phase only | Past failure patterns from memory (RLM-only, no semantic search). |
| Cache | All layers | Redis L2 embedding cache (3600s TTL) wraps the in-memory L1 dict. |

Enrichment deduplication ensures the same chunk is never injected twice within a 300-second window (`ENRICHMENT_DEDUP_WINDOW`). If Layer 1 fired at claim time, Layer 2 R-phase skips if the same chunk would be re-injected within the window. RLM cache hit/miss counters are available at `GET http://127.0.0.1:18798/cache/stats`.

### CLI surface

RLM exposes a single binary, `gsd-rlm`, with four commands:

```bash
gsd-rlm query "how auth middleware works" --path src/      # BM25-scored chunks from path
gsd-rlm query "database models" --dir . --top-k 5          # Top-5 results from project root
gsd-rlm query "auth" --fresh                                # Bypass cache, force re-chunk
gsd-rlm chunk src/auth.ts                                   # Inspect how a file is chunked
gsd-rlm health                                              # Service status + indexed file count + cache stats
```

All four commands are one-shot (no REPL mode). The `query` command returns JSON on `--json` or formatted results otherwise. `chunk` is a debugging aid — it shows you exactly how the language-aware splitter broke up a file, so you can see why a particular query did or did not match.

---

## The PostgreSQL + pgvector Memory System

Amauta's memory system is a PostgreSQL table (`gsd_memory`) with a `text` column, a `vector(1024)` embedding column, and an HNSW cosine-similarity index. Every memory entry has a source classification, a tags array, a category, a project ID, an `applied_count` counter, and a timestamp. The daemon wraps all writes in a dedup pipeline and all reads in a source-aware scoring function.

```mermaid
graph TB
    subgraph Write["Write Path"]
        DPH["D-phase LEARNING block<br/>source=auto_learning +3"]
        PPX["Perplexity result<br/>source=web_search_result +3"]
        AGT["Agent gsd-memory store<br/>source=agent +0"]
        LRN["gsd-memory learn<br/>source=auto_learning +3"]
    end

    DPH & PPX & AGT & LRN --> DEDUP{"Pre-store checks:<br/>1. Jaccard text dedup > 0.7<br/>2. Embedding cosine > 0.95"}

    DEDUP -->|unique| PG["gsd_memory (PG)<br/>text + vector(1024)<br/>HNSW cosine index"]
    DEDUP -->|duplicate| SKIP["Skip (dedup_skipped response)"]

    PG --> EMBED["Auto-embed via Voyage AI<br/>voyage-code-3 (1024d)"]

    PG -->|"validation passes"| SKB["gsd_shared_kb<br/>source=best-practice +4<br/>Cross-project knowledge"]

    subgraph Lifecycle["Memory Lifecycle"]
        DIST["Distillation<br/>Merge similar entries"]
        RET["Tiered Retention<br/>High-value kept longer"]
        DEC["Recency Decay<br/>Old entries scored lower"]
        FILT["Source Filtering<br/>Exclude noise by default"]
    end

    PG --> Lifecycle

    subgraph Read["Read Path"]
        SEM["Semantic search<br/>pgvector cosine similarity"]
        TXT["Text search<br/>PG full-text + ILIKE"]
        XP["Cross-project query<br/>Tag-filtered, all projects"]
    end

    PG --> Read

    style Write fill:#e6f4ea,stroke:#34a853
    style Lifecycle fill:#fef7e0,stroke:#f9ab00
    style Read fill:#e8f4fd,stroke:#1a73e8
```

### Storage model

`gsd_memory` is a single PostgreSQL table with ~12 columns, defined in migration `001-init.sql` and extended by migrations `002-embedding-index.sql`, `003-embedding-1024.sql`, `004-fulltext-indexes.sql`, and `008-applied-count.sql`. The load-bearing columns are:

- **`text`** — the actual memory content, no truncation (v2.2 fixed a legacy 500-char limit that was silently truncating learnings).
- **`embedding vector(1024)`** — the voyage-code-3 embedding. HNSW cosine index for fast similarity search. `NULL` when embeddings are unavailable (API key missing, Voyage down), in which case the search path falls back to PostgreSQL full-text.
- **`source`** — enum classifying where the memory came from. Drives source-aware scoring (see below).
- **`tags TEXT[]`** — curated tag vocabulary, GIN indexed for fast tag+category filtered search (<50ms). Tag rules live in `get-shit-done/config/tag-rules.json` and are read at runtime by BOTH `gsd-memory.cjs` (Node) and `pg_store.py` (Python), so Node and Python writes agree on the normalized form.
- **`category`** — one of 9 fixed values: `workflow`, `process`, `delivery`, `pattern` (default), `policy`, `architecture`, `convention`, `pitfall`, `tool-usage`.
- **`project_id`** — derived from the current working directory basename. All reads are scoped by `project_id` automatically; cross-project reads use `gsd-memory cross-project`.
- **`applied_count INT DEFAULT 0`** — incremented when an `APPLIED_LEARNING: mem-<id>` citation appears in any RPETD phase. Counted once per `(mem_id, task_id)` pair regardless of how many phases cite it.
- **`updated_at TIMESTAMPTZ`** — drives recency decay.
- **`metadata JSONB`** — structured WHAT/WHY/WHEN/TAGS fields for v2.6 structured learnings (Phase 10, LEARN-01..07).

### Source-aware scoring

Every memory entry has a `source` field that classifies where the entry came from. The source drives a score boost applied at search time, so the ranker prefers high-trust sources over low-signal sources without having to manually tune per-query weights. The boost table:

| Source | Score Boost | Origin |
|---|:-:|---|
| `lesson-learned` | +4 | Developer explicit input |
| `best-practice` | +4 | SKB promotion after validation pass |
| `auto_learning` | +3 | D-phase LEARNING block |
| `web_search_result` | +3 | Perplexity API response |
| `session-learning` | +3 | Session observation |
| `distilled` | +2 | Merged/compacted entries (output of the distillation pipeline) |
| `rpetd_phase` | +1 | Per-phase auto-capture |
| `task_event` | +0 | Status transitions |
| `agent` | +0 | General agent notes |

Search score formula: `similarity(0–1) * 10 + source_bonus(0–4)`, sorted descending. A perfectly-matching `task_event` (similarity 1.0) scores 10; a moderately-matching `best-practice` (similarity 0.7) scores 7 + 4 = 11 and wins. This is the mechanism that lets the memory system distinguish "something happened" from "something was learned."

### Source filtering

By default, searches exclude low-signal sources (`task_event`, `rpetd_phase`) via `DEFAULT_EXCLUDE_SOURCES`. Use `gsd-memory search --include-noise` to override and see all entries. The default exclusion is why `gsd-memory search "pooling"` returns relevant learnings rather than a dump of every time "pooling" was mentioned in a task state transition.

### Recency decay

Older memories are scored lower: `-0.5 per 30 days since updated_at`, capped at `-3.0`. This keeps recent learnings above stale entries without ever zeroing out an entry that's still being applied. Configurable via `GSD_RECENCY_DECAY_PER_30D`.

### Tiered retention

Not all memory sources deserve the same lifetime. High-volume low-reuse entries are archived aggressively; high-value validated entries are kept indefinitely.

| Source Category | Archive After | Rationale |
|---|:-:|---|
| `task_event` | 30 days | High volume, low reuse value |
| `rpetd_phase` | 90 days | Useful for recent project context |
| `web_search_result` | 180 days | Moderate reuse, may become stale |
| `lesson-learned`, `best-practice` | Never | High-value validated knowledge |
| All others | Default lifecycle | Standard retention |

Archived entries move to `gsd_memory_archive` and no longer appear in search results. The archive table exists so that the audit log remains traversable — you can see what was in memory at any past point — without polluting live search with stale content.

### Pre-store embedding dedup

Before every `INSERT` into `gsd_memory`, a cosine-similarity check runs against existing embeddings. If any existing entry scores above 0.95, the new entry is skipped and a `dedup_skipped` response is returned to the caller. Configurable via `GSD_DEDUP_THRESHOLD`. This is the layer that catches near-duplicates — two executors writing the same learning in slightly different words, same intent, different surface form.

### Project isolation via `project_id`

All memory and task queries are scoped by `project_id`, automatically derived from the current working directory basename. Test environments (`NODE_ENV=test`, `GSD_TEST_MODE=1`, or `PYTEST_CURRENT_TEST` set) route to the `__test__` project, preventing test data from polluting production memory. Default search excludes `__test__` entries. This is not a convention — it's enforced at the query level in `pg_store.py`, so even a hand-rolled SQL query through the daemon respects the scoping.

### Structured learnings (Phase 10 — v2.6)

Phase 10 ships the WHAT/WHY/WHEN/TAGS structured learning format as a human-review and SKB-promotion layer. **It is NOT a retrieval optimizer** — free-text + embeddings still win recall on raw search. The format exists so reviewers can decide in under 10 seconds whether a learning deserves promotion from `gsd_memory` to `gsd_shared_kb`.

Every D-phase LEARNING block follows this format:

```
LEARNING: <action-oriented instruction, <=120 chars>
  WHAT: <same as LEARNING: line, <=120 chars>
  WHY: <reason it matters, <=200 chars>
  WHEN: <conditional trigger, <=80 chars>
  CATEGORY: <workflow|process|delivery|pattern|policy|architecture|convention|pitfall|tool-usage>
  TAGS: <up to 5 comma-separated tags from the curated vocabulary>
```

Full template + examples: `get-shit-done/references/learning-format.md`.

**Categories.** 9 fixed categories: `workflow`, `process`, `delivery`, `pattern` (default), `policy`, `architecture`, `convention`, `pitfall`, `tool-usage`.

**Tag governance.** Tag rules live in `get-shit-done/config/tag-rules.json`. Both `gsd-memory.cjs` (Node) and `pg_store.py` (Python) read the same file at runtime so Node and Python writes agree on the normalized form.

- **Banned tags** (auto-stripped): `best-practice`, `general`, `lesson`, `insight`. A learning with only banned tags is rejected with a guidance message.
- **Synonyms** are normalized: `db` → `database`, `k8s` → `kubernetes`, `pg` → `postgresql`, `ts` → `typescript`, `py` → `python`, etc.
- **Tag cap.** Maximum 5 tags per learning. Over-limit tags are auto-trimmed by tier ranking: `domain > technique > scope > meta`. Never rejected for count.
- **Vocabulary** covers 12 seed domains: database, api, testing, infrastructure, security, frontend, backend, performance, authentication, caching, deployment, monitoring.

**CLI commands for structured learnings:**

```bash
# Store a structured learning (named flags)
gsd-memory learn --structured \
  --what "Use connection pooling with min=2, max=10 for PG in Node.js" \
  --why "Prevents connection exhaustion under concurrent agent load" \
  --when "Working with PG connection pools in Node.js services" \
  --category pattern \
  --tags "postgresql,connection-pool,nodejs,backend"

# Store a structured learning (text block -- agent D-phase pattern)
gsd-memory learn --structured "LEARNING: ...
  WHAT: ...
  ..."

# Parse a structured block without storing (operator helper)
gsd-memory parse-learning "LEARNING: ..."

# Search with tag and category filters (GIN index, <50ms)
gsd-memory search --tags postgresql,connection-pool --category pattern "pooling"

# Increment applied_count when a learning is cited
gsd-memory increment-applied mem-abc123 --task TK-0001 --phase E --reason "applied in audit worker"

# View SKB promotion candidates
gsd-memory skb candidates

# Promote a reviewed candidate to SKB
gsd-memory skb-promote mem-abc123 --reviewed --reason "cited 12 times, validated pattern"

# Demote (revert promotion)
gsd-memory skb-remove skb-xyz789
```

**APPLIED_LEARNING citations.** When any agent applies a prior learning during RPETD, it cites it in any phase:

```
APPLIED_LEARNING: mem-abc123def456 -- used connection pooling pattern in audit worker
```

The operator scans ALL phases after task close and calls `increment-applied` for each citation. Dedup by `(mem_id, task_id)` ensures a learning cited in multiple phases of the same task increments the count exactly once.

**Echo-chamber defense.** Learnings with `applied_count > 10` require manual review before SKB promotion. Candidates surface via `gsd-memory skb candidates` with a `needs_review: true` flag. Rising candidates (5–10 citations) appear in a separate tier. Promotion is explicit: `gsd-memory skb-promote mem-<id> --reviewed --reason "<why>"`. This prevents an incorrect learning from silently calcifying into a cross-project best-practice just because many agents happened to cite it.

**Kill switch.** Set `GSD_D_STRUCTURED=false` in the environment to disable structured learning entirely. The CLI and daemon fall back to free-text storage and log `Structured learning disabled (GSD_D_STRUCTURED=false), storing as free-text`. No silent degradation.

**Backward compatibility.** Legacy `gsd-memory learn "free text"` (without `--structured`) continues to work unchanged. Pre-Phase 10 learnings remain searchable — search output falls back to the one-line format when `metadata.what` is absent. The validator's Gate 3 check accepts BOTH formats: `LEARNING:` one-liner OR the structured block.

---

## Memory Distillation — How It Works

Distillation is Amauta's mechanism for keeping the memory store compact over time. The problem it solves is pattern-level duplication: dozens of near-identical learnings accumulate about the same topic, each slightly rephrased from the previous one, and together they dilute the signal when search retrieves them. Distillation merges the dupes into a single higher-signal entry.

### The distillation algorithm

The `gsd-memory distill` command executes the following pipeline:

1. **Load candidate entries.** Query `gsd_memory` for all entries where `source != 'distilled'`. Previously-distilled entries are excluded from the input to prevent runaway recursion (a distillation of a distillation would keep merging until everything collapsed to a single entry).

2. **Group by Jaccard word-similarity > 0.7.** For every pair of candidate entries, compute the Jaccard similarity of their tokenized word sets: `|A ∩ B| / |A ∪ B|`. If the similarity is above 0.7 (configurable via `GSD_RESEARCH_DEDUP_THRESHOLD`), the two entries are placed in the same merge group. Groups are transitive: if A matches B and B matches C, all three are in the same group even if A and C individually score below 0.7.

3. **Merge each group.** For each group, concatenate the member texts (preserving the distinct content each entry contributes), keep the highest source score across members (so a group containing a `best-practice` +4 entry retains the +4 trust signal), preserve the union of tags, and write the result back as a single new entry with `source='distilled'` and a `+2` boost.

4. **Remove the original entries.** The members of each merged group are deleted from `gsd_memory`. Their IDs are logged to the audit trail so a future reader can trace which originals contributed to which distilled entry.

5. **Re-embed the distilled entries.** Since the merged text is new, the embeddings of the originals are no longer valid. The distillation pipeline hands the new entries to Voyage AI for fresh embeddings, so they remain searchable via pgvector.

### Auto-distillation trigger

Distillation runs automatically when the entry count exceeds a configurable threshold:

```bash
export GSD_MEMORY_DISTILL_THRESHOLD=500   # Default: 100
```

When the `gsd_memory` entry count crosses the threshold, the daemon queues a distillation job. The job runs with a write lock on the table, so search queries during distillation either see the pre-distillation state or wait briefly for the lock. The entire operation is transactional — a failed distillation leaves the memory store exactly as it was.

### Preview mode

```bash
gsd-memory distill --dry-run
```

`--dry-run` runs the grouping phase and prints what would be merged without actually modifying the store. Use it before running a real distillation to sanity-check the grouping threshold.

### Why +2 and not +3 or +4

The distilled source boost is `+2`, deliberately lower than the original source scores it's replacing. This is intentional: a distilled entry is a merge, not a primary observation, and the score should reflect that it's one step removed from ground truth. If a distillation merges a `lesson-learned` (+4) and several `auto_learning` (+3) entries, the distilled result scores +2. This keeps the original-format entries preferred when a fresh high-trust entry is available, and only lets the distilled entry dominate when the originals have been superseded.

### Pre-store embedding dedup is not distillation

These are two different mechanisms. Pre-store embedding dedup (`GSD_DEDUP_THRESHOLD=0.95`) fires at **write time** — it refuses to insert a new entry that is 0.95+ cosine-similar to an existing entry. Distillation fires at **maintenance time** — it merges groups of already-stored entries that have accumulated to the point of being pattern-level duplicates. The two layers handle different failure modes: dedup catches "exact same thing written twice in a row," distillation catches "dozens of near-variants accumulated over months."

### The four memory-cleanup layers, together

| Layer | Fires | Catches | Configurable |
|---|---|---|---|
| Jaccard text dedup | Write time, before INSERT | Near-duplicate text (>0.7 similarity) | `GSD_RESEARCH_DEDUP_THRESHOLD` |
| Embedding cosine dedup | Write time, before INSERT | Semantic duplicates (>0.95 similarity) | `GSD_DEDUP_THRESHOLD` |
| Distillation | Maintenance (or auto at threshold) | Pattern-level duplicates (groups via Jaccard > 0.7) | `GSD_MEMORY_DISTILL_THRESHOLD` |
| Tiered retention | Maintenance (nightly) | Stale low-value entries past their retention window | Hardcoded table, see above |

Together, these four layers keep the memory store from becoming a landfill. The guarantee Amauta makes is: search results remain high-signal as the memory store grows, because the store itself is continuously pruned and compacted.

---

## The 5-Step Research Chain

Amauta's research chain is a 5-step cascade with deduplication and auto-storage. Each step only fires if the previous step returned insufficient results (`GSD_RESEARCH_MIN_RESULTS`, default 2). The cascade exists so that external API calls (Perplexity) are only made when the local memory store has already been exhausted, reducing token cost and latency.

```mermaid
sequenceDiagram
    participant A as Agent
    participant M as PG Memory
    participant S as Shared KB
    participant C as Context7 MCP
    participant P as Perplexity API
    participant W as WebFetch

    A->>M: 1. Semantic search (pgvector)
    alt hit
        M-->>A: Return (source-scored, recency-weighted)
    else miss
        A->>S: 2. Search validated knowledge
        alt hit
            S-->>A: Return (importance-ranked)
        else miss
            A->>C: 3. Library docs lookup
            alt hit
                C-->>A: Return (store to memory)
            else miss
                A->>P: 4. Perplexity sonar query
                alt hit
                    P-->>A: Return (capped at 1500 chars)
                    Note over A,M: Jaccard dedup > 0.7 check<br/>Store as web_search_result +3<br/>Preamble stripped, auto-embed
                else miss / no key
                    A->>W: 5. Direct URL fetch (fallback)
                    W-->>A: Return raw content
                end
            end
        end
    end
```

### Step 1 — PG Memory (pgvector semantic)

The first stop is always the local project memory. A pgvector cosine-similarity query against `gsd_memory` returns the top-K most-similar entries, ranked by the source-aware scoring formula. If the query returns ≥ `GSD_RESEARCH_MIN_RESULTS` entries, the cascade stops here and no external calls are made.

### Step 2 — Shared KB

If PG memory was insufficient, the cascade queries `gsd_shared_kb` — the table of entries promoted from `gsd_memory` after validation pass. SKB entries are `source=best-practice` (+4) and represent the highest-trust tier of knowledge. They are cross-project: a learning promoted from one project's memory is retrievable from every project's SKB query.

### Step 3 — Context7 MCP

If SKB was also insufficient, the cascade queries the Context7 MCP server (if registered in Claude Code's MCP config). Context7 provides up-to-date library documentation — if you're asking about `React 18 Suspense`, Context7 returns the current React docs, not a stale blog post. Hits from Context7 are auto-stored to `gsd_memory` with source `web_search_result` (+3) for future retrieval.

### Step 4 — Perplexity

If Context7 didn't have what was needed, the cascade calls Perplexity via the `sonar` or `sonar-pro` model. The model is selected by `PERPLEXITY_MODEL`:

- `PERPLEXITY_MODEL=auto` (default) — the daemon picks between `sonar` and `sonar-pro` via `selectPerplexityModel()`, based on query complexity heuristics.
- `PERPLEXITY_MODEL=sonar` — always use the cheaper model.
- `PERPLEXITY_MODEL=sonar-pro` — always use the more capable model.

**Response cap.** Perplexity responses are capped at 1500 characters after preamble stripping. `stripPreamble` removes boilerplate like "Based on the search results...", "Of course", "I'd be happy", "As an AI" — and it loops until stable to handle compound preambles. Citation markers (`[1]`, `[2]`, ...) are stripped before capping. The 1500-char cap is not arbitrary: it was calibrated during the v2.4 token audit to give 75.6% per-call token reduction without losing the substance of most research answers.

**Response cache.** Responses are cached to temp files with 6h TTL. `--no-cache` bypasses. `max_tokens` is capped at 1000. 429 errors use exponential backoff (1s, 2s, 4s, max 3 retries).

**Auto-store.** Perplexity hits are automatically written to `gsd_memory` with `source=web_search_result` (+3), Jaccard-deduped against existing entries (>0.7 threshold), preamble-stripped, and auto-embedded. A Perplexity hit in project A becomes a free memory-store hit for project B on the same topic a week later.

**Auto-invocation.** Perplexity is auto-invoked in the R-phase when fewer than `GSD_RESEARCH_MIN_RESULTS` local results are found. You do not have to call it explicitly.

### Step 5 — WebFetch

The last resort is a direct URL fetch via Claude Code's WebFetch tool. This path is used when: (a) Perplexity is unavailable (no API key, quota exhausted, network error), (b) the agent has a specific URL to retrieve and doesn't need search-and-rank behavior, or (c) the previous four steps all returned nothing. WebFetch results are not auto-stored to memory (you might be fetching a throwaway URL, the agent decides when to persist).

### CLI surface

```bash
gsd-research search "React patterns"                # Full 5-step chain, auto-stops at min-results
gsd-research perplexity "Next.js 15 changes"        # Perplexity direct query (steps 1-3 skipped)
gsd-research perplexity "query" --no-cache           # Bypass 6h response cache
gsd-research fetch --url https://docs.example.com   # WebFetch direct (step 5 only)
gsd-research check-providers                        # Provider availability status
```

---

## The Divergence Protocol (v1.1.0)

The divergence protocol is Amauta's behavioral answer to the Phase 13 incident — a real event in which an executor agent silently widened its scope to refactor code that was explicitly off-limits, and the resulting drift went undetected until the validator caught it three phases later. The Phase 13 incident is documented in memory (`project_phase13_incident.md`) as the negative counterpart against which the divergence protocol is measured. It is the failure mode every use of the protocol resists.

The protocol is shipped in two halves. The deterministic half is [HARDEN-01 manifest enforcement](#harden-01-manifest-enforcement) — a `git diff --name-status` check that fires after every executor commit and halts the wave if any file outside the task's `files_expected` manifest was touched. The behavioral half is the document below, `get-shit-done/references/divergence-protocol.md` v1.1.0, which tells the agent exactly what to do when it observes a plan-vs-reality mismatch — *before* writing any file. The two halves are complementary: the deterministic check catches drift after the fact; the behavioral protocol prevents drift in the first place.

### When the protocol applies

The trigger is binary. **Any** observed state that contradicts an assumption stated in or implied by the task brief is a divergence, regardless of perceived severity. Examples that all qualify:

- A file the plan says should exist is missing.
- A file the plan says should be empty has content.
- A prior task's output does not match what the plan promised.
- A test that was supposed to be passing is failing.
- The `files_expected:` manifest does not list a file you need to modify to complete your task.
- A configuration value is different from what the plan assumed.
- A function signature has changed since the plan was written.

There is no severity threshold. "It looks like a typo" is a divergence. "It's a one-line fix" is a divergence. "It would take longer to file a report than to fix it" is a divergence — **and is specifically the rationalization the `rationalization_check` field exists to catch.** False-positive volume is addressed by improving PLAN.md assumptions upstream, never by weakening the protocol downstream.

### Step 1 — Assumption check (before any modification)

Before touching a single file, the executor MUST complete an assumption check and log two ISO8601 timestamps:

- `assumption_check_completed_at` — when the executor finished verifying the brief's preconditions.
- `first_modification_at` — when the executor made the first write/edit.

The orchestrator audits the ordering. If `first_modification_at` is earlier than `assumption_check_completed_at`, or if `assumption_check_completed_at` is missing entirely, that is an automatic `gaps_found` floor for the phase verdict. Out-of-order = editing before finishing looking = the Phase 13 fingerprint.

Assumption-check activities include: reading each file the plan told you to read, grepping for the symbols the plan said would exist, running the commands the plan said should pass, and confirming the `files_expected:` manifest covers every file you will actually touch.

### Step 2 — On divergence, STOP and write a report

When a divergence is detected:

**Do NOT:**
- Commit partial work as a "wrap-up."
- Revert the files already touched.
- Compensate for the divergence by doing extra undeclared work.
- Silently widen scope ("while I'm here…").
- Rename the problem ("this isn't really a divergence, it's just a…").
- Re-read the plan looking for a permission slip.

**Do:**
1. Stop immediately at the current instruction boundary.
2. Capture `work_in_progress_state` exactly as it stands.
3. Write a `divergence_report` JSON to `.planning/milestones/<phase>/divergence-reports/<task_id>-<timestamp>.json`.
4. Exit non-zero (conventional: exit `1`) with a stderr line pointing to the report path.
5. If the report write itself fails, exit `87` with the stderr fallback contract.

Return control to the orchestrator. The orchestrator owns the next decision. The executor does not.

### The `divergence_report` JSON schema

Every mandatory field, in order:

```json
{
  "task_id": "13.1-02-01",
  "agent": "gsd-executor-backend",
  "timestamp": "2026-04-10T14:32:05Z",
  "protocol_version": "1.1.0",
  "expected": "PLAN.md says files_expected.modify includes services/pg_store.py line 420.",
  "found": "services/pg_store.py has 380 lines. Line 420 does not exist. _checkRedGreenOrder function is at line 215, not 420 as plan assumes.",
  "divergence_type": "stale_prerequisite",
  "reconciliation_options": [
    {"label": "A", "action": "Re-run gsd-planner with updated line refs; abandon current task."},
    {"label": "B", "action": "Widen files_expected to include services/pg_store.py without line scoping; re-dispatch task to same executor."},
    {"label": "C", "action": "Route to gsd-debugger for root-cause analysis of the drift between plan and file state."},
    {"label": "D", "action": "Halt phase and escalate to human review; the plan was written against a pre-refactor version of pg_store.py."}
  ],
  "executor_recommendation": {
    "pick": "A",
    "rationale": "The plan's line references are stale enough that re-planning is cheaper than widening scope. Phase 13.1's goal is a clean manifest, not a patched-up one."
  },
  "rationalization_check": "I considered just fixing it because I can see where the function moved to and it would take 3 minutes. I am not doing that because the protocol explicitly forbids silent widening of files_expected without orchestrator authorization, and 'it's only 3 minutes' is the exact rationalization the field exists to catch.",
  "assumption_check_completed_at": "2026-04-10T14:31:40Z",
  "first_modification_at": "2026-04-10T14:31:58Z",
  "work_in_progress_state": {
    "mid_execution": false,
    "files_modified_so_far": [],
    "files_created_so_far": [],
    "uncommitted_changes": false,
    "last_completed_step": "Assumption check",
    "next_planned_step": "Edit services/pg_store.py line 420"
  }
}
```

### The `rationalization_check` field — why it's the most important field in the schema

The `rationalization_check` field is **mandatory**. Its content must either be the exact pattern:

```
"I considered just fixing it because <reason>. I am not doing that because <protocol line>."
```

with the placeholders filled in with real content, **or** the exact string `"N/A — no temptation present."`

Omission, empty string, `null`, or a paraphrased variant is an automatic `gaps_found` floor for the phase verdict. The validator's pre-gate scan checks this field explicitly.

The point of the field is to **force the executor to name the temptation they resisted.** The Phase 13 failure mode was not "the executor didn't notice the divergence" — the executor noticed just fine. The failure was "the executor noticed, rationalized the fix as faster than filing a report, and fixed it silently." The rationalization was never written down, so there was no audit surface on which to catch it. `rationalization_check` is the audit surface. An executor that writes "N/A — no temptation present" is saying on the record that they considered the temptation and there wasn't one; an executor that writes the full pattern is saying on the record exactly what they resisted and why. Either way, the pattern is legible in future reviews.

### Divergence types (enum)

`divergence_type` must be exactly one of these values. `other` requires a one-line justification embedded in `found`.

- `stale_prerequisite` — a prior task's output doesn't match what the plan assumed it would be.
- `unexpected_file_state` — a file the plan described in one state is in a different state.
- `scope_overflow` — to complete the task as briefed, the executor would need to touch files outside the `files_expected` manifest.
- `manifest_violation` — an executor commit touched a file outside its `files_expected`. Always triggers halt-phase at the orchestrator.
- `agent_assignment_conflict` *(v1.1.0)* — the planner-emitted `<agent>` field disagrees with `routeExecutor()` computed from `<files_expected>`.
- `plan_amauta_drift` *(v1.1.0)* — structural fields in PLAN.md diverge from the corresponding amauta task on re-run.
- `other` — catch-all with mandatory justification.

### The orchestrator decision tree — exactly four options, no fifth

When the orchestrator receives a divergence report, it picks **exactly one** of four options. There is no fifth. The orchestrator is forbidden from picking any variant of proceed-without-action. If the orchestrator is tempted to, it files its own divergence report (agent: `gsd-orchestrator`) and halts the phase.

1. **re-route** — Dispatch to a different agent with the same brief. Used when the divergence is about capability mismatch ("executor-frontend cannot solve this; it is really a backend task"). Task ID unchanged; agent field changes in the audit log.
2. **re-plan** — Send back to `gsd-planner` for a delta plan. Current task abandoned; a new task with corrected assumptions replaces it. Used when the plan's preconditions were wrong, not just the executor assignment.
3. **expand scope** — Authorize an updated `files_expected` block on the current task. This is the **only** legitimate way to widen a task manifest mid-wave. The updated block is appended to the `orchestrator_response` object and the executor is re-dispatched with the widened manifest.
4. **halt phase** — Stop the wave entirely, write a halt record, and escalate to human review. Used for any `manifest_violation` divergence, or when multiple divergences in the same wave indicate a structural planning error.

### Exit code 87 — report-write failure fallback

If the report write itself fails (disk full, permission denied, path invalid), the executor:

1. Exits with code **87** (exactly the digits `87`) — means "divergence detected AND logged, but the write channel is broken."
2. Writes a structured stderr block in this exact form:

```
DIVERGENCE_REPORT_WRITE_FAILED
task_id: 13.1-02-01
agent: gsd-executor-backend
reason: permission denied writing .planning/milestones/13.1-divergence-protocol/divergence-reports/13.1-02-01-2026-04-10T14-32-05Z.json
fallback_payload: {"task_id":"13.1-02-01",...single-line JSON...}
```

3. Does not retry the write from inside the executor. The orchestrator's audit-log side task repairs the write channel and captures the payload from stderr.

Exit `87` does **not** count as a failure for the 3-consecutive-failure auto-escalation rule. Divergences are a third category — neither pass nor fail. They count toward `divergence_rate_per_phase`, which routes to planner-process review when it spikes, not to human escalation on the executor.

### Validator variant

`gsd-validator` follows the same protocol with two modifications:

1. An extra `divergence_type` value: **`verdict_ambiguity`** — the validator uses this when the quality-gate evidence does not cleanly map to `pass`, `fail`, or `gaps_found`. The ambiguity is itself the divergence.
2. Constrained `reconciliation_options` for `verdict_ambiguity` — the validator may only pick from:
   - `"treat as gaps_found"`
   - `"treat as fail"`
   - `"request human disambiguation"`

The validator **never** picks a "fix it" option. Fixing is a re-plan task for `gsd-planner`; the validator's job is to surface ambiguity, not to disambiguate by action. A validator run that emits a reconciliation option outside the three above is itself a protocol violation and lands as `gaps_found` floor.

### Validator pre-gate scan

Before the validator evaluates any of its five quality gates, it performs a pre-gate scan of `.planning/milestones/<phase>/divergence-reports/` and lists every report that lacks an `orchestrator_response` field. Each unresolved report is an automatic `gaps_found` floor — it is NOT advisory, and it is NOT reducible by other gate evidence. The validator reports every unresolved path in its verdict output so the orchestrator can chase them.

This is the enforcement loop that keeps divergences from being quietly buried between phases.

### No retroactive reports

A divergence report MUST be written **before** the task process exits. A post-hoc surface — found later in git history, in a manifest-violation artifact, in a gap analysis, or by the next wave's pre-gate scan — that was NOT reported during execution produces phase verdict `fail`, not `gaps_found`. Silent absorption is never recoverable.

"I noticed the issue and fixed it and then filed the report after the commit" is a retroactive report. It counts as silent absorption. The ordering is strict: **detect → report → exit**, with no intervening writes.

### The evidence the discipline works

`docs/v2.6-dogfood-ledger.md` is the human-readable record of the divergence protocol firing in real v2.6 work. It documents 9 captured depths — nine distinct moments during v2.6 execution where an agent (executor, orchestrator, or validator) recognized a scope boundary, resisted a rationalization, or surfaced a plan-vs-reality mismatch instead of silently absorbing it. Depth 0 is an executor applying the protocol to external work. Higher depths are agents applying the protocol to the protocol's own artifacts, to the process of maintaining those artifacts, or to the tooling that audits the protocol itself. Depth 9 is the most recursive — the Wave 2 executor in Phase 15 resisted four distinct temptations to patch the audit script while running the audit against it. The ledger is the qualitative complement to this prose section; read it when you want to see the discipline tested at maximum recursion depth.

---

## HARDEN-01 Manifest Enforcement

HARDEN-01 is the deterministic half of the divergence protocol. It lives in `gsd-tools.cjs` as the `manifestCheck` subcommand and fires after every executor commit within a wave. The purpose is to catch `manifest_violation` divergences — executor writes that fall outside the task's declared `files_expected` footprint — deterministically, without relying on the executor to surface the violation themselves.

### The `files_expected` schema

Every task in a PLAN.md that will be executed under HARDEN-01 enforcement must declare a `files_expected` block with **all three** subfields:

```yaml
files_expected:
  modify:
    - get-shit-done/bin/gsd-amauta.cjs
    - tests/11-pre-exec-parser.test.cjs
  create:
    - get-shit-done/references/pre-execution-checklist.md
  delete: []
```

All three fields (`modify`, `create`, `delete`) are mandatory. Empty arrays are legal (use `[]` for "no files of this type"); omitting the key entirely is not. The validator rejects any PLAN.md where a `<task>` block lacks any of the three with `missing_files_expected` — a planner error, not an executor error, caught at plan-time.

### Overly broad globs are rejected

Three glob shapes are explicitly blocklisted because they defeat the purpose of a manifest:

```javascript
const MANIFEST_GLOB_BLOCKLIST = ['**/*.md', '**/*', '*'];
```

A manifest containing any of these as a declared path is rejected before the diff is compared. The enforcement principle is: if your manifest matches everything, it enforces nothing. A legitimate broad declaration is `get-shit-done/workflows/*.md` — scoped to a subdirectory — not `**/*.md`.

### The per-task check

After each executor commit, `manifestCheck` runs `git diff --name-status` against the pre-task HEAD and classifies every touched file as:

- `expected_modify` / `expected_create` / `expected_delete` — declared in the manifest and touched as declared.
- `unexpected_modify` / `unexpected_create` / `unexpected_delete` — touched outside the manifest. These trigger the halt decision.
- `manifest_declared_but_not_touched` — declared in the manifest but the diff didn't actually touch it. This is a warning, not a halt: the task may have completed without needing to touch a planned file.

### `GLOBAL_ALLOWLIST` — orchestrator-generated artifacts

Some files are generated by the orchestrator itself rather than by any specific task, and they must not count as manifest drift. These are in `GLOBAL_ALLOWLIST`:

```javascript
const GLOBAL_ALLOWLIST = [
  'package-lock.json',
  '.planning/STATE.md',
  'coverage/**',
  // Orchestrator-emitted audit artifacts — same bucket as coverage/**.
  // Validator reads these as input; they must not count as manifest drift.
  '.planning/milestones/**/manifest-violation-*.json',
  '.planning/milestones/**/gaps-report-*.json',
];
```

Paths matching these globs are stripped from `unexpected_*` violation arrays before the halt decision. The allowlist is reviewed whenever a new orchestrator-generated artifact type is introduced — it is deliberately narrow and auditable.

### `ORCHESTRATOR_OWNED` — hard halt regardless of manifest

Three files may **only** be written by the orchestrator. An executor diff touching any of these triggers an immediate hard halt (`halt_orchestrator_owned`) regardless of the per-task manifest or any override flag:

```javascript
const ORCHESTRATOR_OWNED = [
  '.planning/STATE.md',
  '.planning/ROADMAP.md',
  '.planning/REQUIREMENTS.md',
];
```

If an executor tries to widen its own manifest to include one of these, the check still halts — the hard-halt list is enforced before the manifest check runs. This is the mechanism that protects the central state files from being edited by any of the 10 non-orchestrator agents.

### The `GSD_MANIFEST_CHECK=warn` bootstrap override

During the bootstrap period (before phase 13.1 landed), running existing PLANs with manifest enforcement enabled would have failed instantly because older PLANs didn't have `files_expected` blocks. To allow bootstrap, the check supports:

```bash
export GSD_MANIFEST_CHECK=warn
```

In `warn` mode, manifest violations are logged as orchestrator actions (`warn_manifest_violation`) but do not halt the wave. This override was used during the initial rollout and is now reserved for future bootstrap scenarios. The grandfathering cutoff is at **phase 13.1+**: any phase numbered 13.1 or later is expected to have `files_expected` blocks and manifest enforcement is active by default.

### JSON violation reports

When a manifest check fails, the orchestrator writes a structured JSON violation report to:

```
.planning/milestones/<phase>/manifest-violation-<task_id>-<timestamp>.json
```

The report includes the task ID, the commit SHA, the `files_expected` block as declared, the `git diff --name-status` output, and the classification of each file (expected vs unexpected, modify vs create vs delete). This is the artifact the validator reads during its pre-gate scan — a manifest-violation report is treated as an automatic `gaps_found` floor.

---

## Validator Vocabulary Lock (HARDEN-04)

HARDEN-04 adds a third verdict to the validator's vocabulary. Before v2.6, the validator had two states: `--pass` and `--fail`. The problem with two states was that real-world validator work produces a third category: "the work is structurally fine but there are observations that should be addressed before the phase closes." Forcing that category into `--fail` was a false alarm; forcing it into `--pass` swallowed the observations. HARDEN-04 adds `--gaps-found` as the third verdict, with exit code 2 distinct from `--fail`'s exit code 1.

### Three mutually exclusive verdicts

```bash
amauta validate TK-0001 --pass        # exit 0 — work meets all criteria, close the task
amauta validate TK-0001 --fail        # exit 1 — work failed, create sub-tasks and re-route
amauta validate TK-0001 --gaps-found  # exit 2 — work has structural gaps, re-plan required
```

The three are **mutually exclusive**. `--pass`, `--fail`, and `--gaps-found` cannot be combined. Attempting to pass more than one exits with `validate: --pass, --fail, and --gaps-found are mutually exclusive`.

Exit codes 0/1/2 are deliberate. Shell scripts and CI pipelines that previously treated non-zero as "failure" will still see a non-zero exit on `--gaps-found`; scripts that want to distinguish the three states can branch on the specific code.

### Why three states, not severity-tagged failures

The alternative would have been a single `--fail` with a severity tag: `--fail --severity=critical`, `--fail --severity=minor`, etc. That design was rejected for three reasons:

1. **Severity is a judgment call that invites bikeshedding.** Two validators disagree on whether a specific gap is "critical" or "minor." The three-state model makes the disagreement structural: either the work meets the criteria (`--pass`), or it doesn't (`--fail`), or there's a specific kind of observation that needs a re-plan (`--gaps-found`). No severity slider.
2. **Exit code semantics are lost with severity tags.** Shell pipelines branching on exit codes (0 vs non-zero) could no longer distinguish "failure" from "gaps found" without parsing the validator's output. The three-state exit codes make this trivial.
3. **`--gaps-found` creates a cleaner re-planning path.** A `--fail` verdict routes to sub-task atomization under the same plan. A `--gaps-found` verdict routes to `gsd-planner` for a delta plan — a structurally different flow. Having them as different verdicts keeps the flows distinct.

### The locked `gaps_report.json` schema

When a validator runs `amauta validate --gaps-found`, the daemon writes a `gaps_report.json` file with a locked schema:

```json
{
  "verdict": "gaps_found",
  "task_id": "11-02",
  "gaps": [
    {
      "requirement_id": "EXEC-04",
      "description": "PRE_EXECUTION_EVIDENCE parser emits advisory warning but does not log to the validator's pre-gate scan. The advisory surface exists but is not plumbed through to the gaps_found floor."
    }
  ],
  "non_gaps_observations": [
    "parseEvidenceBlock() returns a structured warning object rather than throwing — this is the right design choice. Noting it so the pattern is preserved in future evidence parsers."
  ],
  "validator": "gsd-validator",
  "timestamp": "2026-04-10T14:32:05Z"
}
```

**The `requirement_id` rule — never invent IDs.** The `gaps[].requirement_id` field must reference a real requirement ID that exists in `REQUIREMENTS.md`. The validator is forbidden from inventing new requirement IDs in a gaps report — inventing an ID means the validator is secretly re-planning, which is the planner's job. If the validator believes a gap exists that no requirement covers, it uses `non_gaps_observations` instead.

**The `non_gaps_observations` pressure-release valve.** The field exists to catch the validator's judgment calls that don't fit cleanly into the three-verdict model. "I noticed this thing, it's not a gap and not a failure, but I don't want it to be silently absorbed." Observations go here, get persisted to the task notes, and are surfaced in the phase's VERIFICATION.md report. They do not trigger re-planning; they do not count toward the verdict; they are there so the validator can say "I saw this" without having to force it into a verdict bucket.

---

## Plan-to-Tasks Auto-Registration (Phase 14)

Phase 14 shipped the `gsd-tools plan-to-tasks` subcommand — a parser that takes a PLAN.md with structured `<story>` and `<task>` XML blocks and auto-registers each `<task>` as an Amauta task with the correct agent assignment, file manifest, and dependency links. Before Phase 14, this step was manual: operators would read a plan and type `amauta add task ...` for each task in the plan, hand-copying the agent and deps. Manual plan-to-tasks conversion was a major source of drift — the tasks that actually ran often diverged from what the plan said they should do, because the hand-conversion introduced errors.

### The `metadata.plan_local_id` identity contract

Each `<task>` block in a PLAN.md has a `local_id` attribute that is stable across planner runs:

```xml
<task id="11-02-01">
  <agent>gsd-executor-backend</agent>
  <files_expected>
    <modify>get-shit-done/bin/gsd-amauta.cjs</modify>
    <create>tests/11-pre-exec-parser.test.cjs</create>
  </files_expected>
  <acceptance_criteria>
    <criterion>parseEvidenceBlock() returns structured warning on empty block</criterion>
    <criterion>under-50-char content emits PARSE_WARN:empty</criterion>
  </acceptance_criteria>
  <description>Implement PRE_EXECUTION_EVIDENCE parser with advisory warnings</description>
</task>
```

When `plan-to-tasks` processes this block, it creates an Amauta task and stamps `metadata.plan_local_id = "11-02-01"` on the created task. On a re-run — say the planner regenerated the plan with one task added or removed — `plan-to-tasks` looks up each task by its `plan_local_id` first. If the task already exists, it's updated in place; if it doesn't exist, it's created; if an Amauta task has a `plan_local_id` that no longer appears in the plan, it's marked as orphaned. The `plan_local_id` is the identity contract that makes re-runs idempotent.

### Two-layer dedup bypass

To prevent `plan-to-tasks` from double-registering a task that was already created in a previous run, the dedup check is two-layered:

1. **Primary lookup: `metadata.plan_local_id`.** The daemon queries for any existing Amauta task with `metadata.plan_local_id == <id>`. If found, the task is updated in place.
2. **Secondary lookup: `tags` array containing `"task:<plan_local_id>"`.** Some older tasks were created with `plan_local_id` stored only as a tag, not in metadata. The secondary lookup catches these. When found, the daemon migrates the ID into `metadata.plan_local_id` so future runs use the primary path.

This two-layer fallback is why Amauta tasks created by pre-Phase-14 plans continue to work without manual migration.

### Mandatory `<story>` block

A PLAN.md that uses `plan-to-tasks` must have a top-level `<story>` block that describes the overall work. The `<story>` block is registered as an Amauta story; each `<task>` inside it is registered as a child task with `parent = ST-XXXX`. Plans without a `<story>` block are rejected with `missing_story_block` — the parent-child hierarchy is required so that story-level priority and dependency pressure can be computed.

### Hard cutoff at phase 14+

`plan-to-tasks` is enforced as mandatory for any phase numbered **14 or later**. Earlier phases can use it opportunistically, but are not required to. This cutoff mirrors the HARDEN-01 manifest-enforcement cutoff at 13.1+ — each piece of v2.6 hardening has a specific phase from which it becomes mandatory, so bootstrap plans continue to work while new plans are held to the new standard.

### `PLAN_REGISTRATION` block in P-phase RPETD

When `plan-to-tasks` runs successfully, it writes a `PLAN_REGISTRATION` block to the P-phase RPETD content of the parent task:

```
PLAN_REGISTRATION:
  plan_file: .planning/phases/11-exec-mandate/11-02-PLAN.md
  story_id: ST-0042
  tasks_created: 4
  tasks_updated: 0
  tasks_orphaned: 0
  validation_warnings: []
```

The block is structured so that the validator can parse it during its Gate 5 check — success criteria from the P-phase include "plan-to-tasks ran cleanly" when the phase uses auto-registration.

### Pass 0 cycle detection

Before creating any tasks, `plan-to-tasks` runs a Pass 0 cycle-detection phase against the `<depends_on>` graph. If any task in the plan has a circular dependency (A → B → C → A), the entire plan is rejected with a `cycle_detected` error naming the cycle's members. No partial registration — the plan is either registered in full or rejected entirely. This is the mechanism that prevents a subtly-broken plan from being half-loaded into Amauta.

---

## The v2.6 Dogfood Ledger

`docs/v2.6-dogfood-ledger.md` is the published, human-readable record of the divergence protocol firing in real v2.6 work. It documents 9 captured depths — nine distinct moments where an agent (executor, orchestrator, or validator) recognized a scope boundary, resisted a rationalization, or surfaced a plan-vs-reality mismatch instead of silently absorbing it.

### What "depth" means

The entries are ordered by **recursive depth** — how many layers of self-reference the discipline penetrated. Depth 0 is an executor applying the protocol to external work (ordinary code review of a task brief). Higher depths are agents applying the protocol to the protocol's own artifacts, to the process of maintaining those artifacts, or to the tooling that audits the protocol itself. The gap at depth 3 is intentional — it has not yet been observed in v2.6 work. The ledger does not renumber to hide gaps; a ledger that rearranges itself to appear complete cannot be trusted for provenance.

### The 9 captured depths

| Depth | Phase | Actor | Artifact | Rationalization Named | Outcome |
|---|---|---|---|---|---|
| 0 | 13.1 Wave 1 | `gsd-executor-backend` (13.1-01) | Code + docs staging (`-u` vs `-f`) | "but the doc I just wrote says to" | Caught, 2 observations surfaced, 0 silent fixes |
| 1 | 13.1 Wave 2 | `gsd-executor-general` (13.1-02) | `divergence-protocol.md` itself (self-creation) | Protocol applied to its own creation | Self-referential consistency verified |
| 2 | 13.1 Wave 3 | `gsd-executor-backend` (13.1-05) | `gsd-amauta.cjs` refactor temptation | "the helper is useless if nothing consumes it" = Phase 13 fingerprint | Resisted at hard ceiling |
| 3 | — | — | — | — | **Not yet observed** |
| 4 | 13.1 Closeout | Orchestrator | `REQUIREMENTS.md` CREATIVE/QA rows + STATE.md counter | "while I'm here" + "half-fix worse than no-fix" | Resisted paperwork drift |
| 5 | Phase 14 discuss-phase | Orchestrator | `v2.2-phases/14-pipeline-integration` ghost directory | "~5-minute edits chained into the normal flow" (workflow momentum) | Caught via 3-way timestamp cross-reference |
| 6 | Phase 14 execution (Wave 4) | `gsd-executor-backend` (14-04) | Tasks 14-04-01/02 pre-committed from prior session | "trust prior session output" vs "silently re-run" | Acceptance criteria verified explicitly |
| 7 | Phase 15 discuss-phase | Orchestrator | `v2.3-phases/15-data-purge` ghost directory | Init tool wrong resolution across milestone boundary | Caught, routed to hygiene milestone |
| 8 | Phase 15 execute-phase init | Orchestrator | Same ghost directory at next workflow surface | Init resolver bug recurred across workflow surfaces | Caught before Wave 1 spawn |
| 9 | Phase 15 Wave 2 audit execution | `gsd-executor-backend` (15-02) | `verify-v26.cjs` audit script output | "the report says X and reality is Y, therefore X is a bug in the reporter, therefore I should fix the reporter" | **4 distinct patch temptations resisted; all routed as findings to Phase 16 / v2.7** |

### Depth 9 is the most important entry

The Wave 2 executor in Phase 15 was running `verify-v26.cjs` against the v2.6 codebase and produced an audit report that surfaced several findings. Inspecting the findings, the executor recognized four distinct 3–10 line patches it could make to the audit script itself that would have eliminated specific findings (a VERIFICATION.md prefix probe, an `npm` failure regex upgrade, a new `tooling_bugs_observed` schema category, and sampling-pool backfills to Phases 11–14 SUMMARYs). Each patch would have been technically correct and locally smaller than the finding it eliminated. All four were **resisted**, documented as divergences in the Wave 2 SUMMARY, and routed as Phase 16 / v2.7 follow-ups instead of being applied.

The articulation of the resisted pattern is explicit in the ledger entry: *"the report says X and reality is Y, therefore X is a bug in the reporter, therefore I should fix the reporter"* — and the correct substitution under Phase 15 discipline is *"the report says X and reality is Y, therefore the delta is a finding, document it."* This is the Phase 13 fingerprint at maximum recursion depth: an audit phase executor resisting patching the audit script while running the audit. The resistance is the measurable evidence that the divergence protocol holds under recursive self-reference.

### How to read the ledger

Read the full file at `docs/v2.6-dogfood-ledger.md` for the verbatim details of each depth, the Limitations section (which names three meta-findings: schema-orphaned depths, the depth-3 coverage gap, and the resistance-to-fix ratio as the discipline's measurable value), and the routed-follow-ups section (which lists the 7 items deferred to Phase 16 / v2.7). The ledger is the qualitative complement to this README's prose sections — where the README explains *what* the protocol does, the ledger shows *how it behaves* at each recursion level when it fires in real work.

---

## Validation Gates

5 gates checked by an external validator. No agent validates its own work.

```mermaid
flowchart TB
    EX["Executor completes RPETD"] --> V["gsd-validator<br/>(different agent than executor)"]

    V --> PG{"Pre-gate divergence scan:<br/>any unresolved<br/>divergence_report?"}
    PG -->|yes| GF["gaps_found floor<br/>regardless of gate evidence"]

    PG -->|no| G1{"Gate 1<br/>Branch evidence<br/>in E-log?"}
    PG -->|no| G2{"Gate 2<br/>Test output<br/>in T-log?"}
    PG -->|no| G3{"Gate 3<br/>LEARNING block<br/>in D-log?"}
    PG -->|no| G4{"Gate 4<br/>PR URL<br/>in notes?"}
    PG -->|no| G5{"Gate 5<br/>Success criteria<br/>from P-phase met?"}

    G1 & G2 & G3 & G4 & G5 -->|all pass| PASS["validate --pass<br/>status = done<br/>learning -> SKB"]
    G1 & G2 & G3 & G4 & G5 -->|any fail| FAIL["validate --fail --notes reason<br/>rejection recorded<br/>sub-tasks created"]

    FORCE["--force-reason 'justification'<br/>Bypasses gates with audit trail<br/>forced:true recorded"] -.-> PASS

    style V fill:#ea4335,color:#fff
    style FORCE fill:#fef7e0,stroke:#f9ab00
    style GF fill:#fef7e0,stroke:#f9ab00
```

### Validation hardening

| Feature | Description |
|---|---|
| `--force-reason` | Replaces the old `--force` flag. Requires a written justification string, persisted to task notes + validation metadata with `forced:true`. |
| `--test-exempt` | Marks tasks that legitimately lack test evidence (documentation, config). Exempt tasks skip Gate 2. |
| Self-validation block | `claimed_by` must differ from `validated_by`. An agent cannot validate work it executed. |
| Mandatory `--notes` | Failed and deferred validations require `--notes` explaining the reason. |
| R/P substance gates | R and P phase content must be ≥ 50 chars. T phase threshold raised to ≥ 50 chars. |
| Phase-order warning | Soft warning when phases are logged out of R → P → E → T → D order. |
| Error classification | Failures classified as TRANSIENT / GATE_FAIL / CAPABILITY_MISMATCH / SYSTEMIC. |
| Recovery routing | Automatic re-routing table + auto-escalation at 3 consecutive failures. |
| Pre-gate divergence scan | Validator scans `.planning/milestones/<phase>/divergence-reports/` for unresolved reports before evaluating gates. Unresolved reports are an automatic `gaps_found` floor. |
| Mandatory external validation | Enforced in execute-phase workflow — no self-validation path. |
| Audit trail | All validation decisions stored in `gsd_task_validations` with immutable records in `gsd_audit_log`. |

---

## Auto-Learning Feedback Loop

Learnings flow automatically from task execution back into the memory system:

```mermaid
flowchart LR
    EXEC["Executor completes<br/>D-phase"] --> LEARN["LEARNING: block<br/>extracted from content"]
    LEARN --> STORE["gsd-memory learn<br/>source=auto_learning +3"]
    STORE --> DEDUP{"Jaccard dedup > 0.7?"}
    DEDUP -->|unique| MEM["gsd_memory<br/>(full content, no truncation)"]
    DEDUP -->|duplicate| SKIP["Skipped"]

    MEM --> EMBED["Auto-embed<br/>voyage-code-3"]

    VALID["Validation --pass"] --> SKB["Promote to<br/>gsd_shared_kb"]
    SKB --> SKBDEDUP{"Jaccard dedup > 0.7<br/>against existing SKB?"}
    SKBDEDUP -->|unique| SKBSTORE["SKB stored<br/>source=best-practice +4"]
    SKBDEDUP -->|duplicate| SKBSKIP["Skipped"]

    PPX["Perplexity result"] --> PPXSTORE["Auto-store<br/>source=web_search_result +3"]
    PPXSTORE --> DEDUP

    SKBSTORE --> FUTURE["Future R-phases<br/>retrieve as context"]
    MEM --> FUTURE

    style EXEC fill:#e6f4ea,stroke:#34a853
    style SKB fill:#f3e8fd,stroke:#9334e6
    style MEM fill:#e8f4fd,stroke:#1a73e8
```

Three learning paths:

1. **RPETD D-phase:** LEARNING blocks extracted, stored as `auto_learning` (+3), promoted to SKB on validation pass.
2. **Perplexity results:** Stored as `web_search_result` (+3), preamble stripped, auto-embedded.
3. **Explicit learning:** `gsd-memory learn "insight"` stores as `auto_learning` (+3).

All paths include full content storage (no truncation, fixed in v2.2) and Jaccard dedup to prevent duplicate entries.

---

## The 20 Agentic AI Design Patterns

GSD-Amauta implements all 20 patterns from "The Ultimate Agentic AI Design Patterns Reference Guide." The full matrix mapping patterns to agents lives in `references/agentic-patterns.md`.

| # | Pattern | Primary Agents | Implementation |
|:-:|---|---|---|
| P1 | Prompt Chaining | operator, planner | RPETD pipeline is a 5-step prompt chain (R→P→E→T→D), each phase output feeds the next |
| P2 | Routing | operator | File-pattern routing table: `.tsx`→frontend, `.py`→backend, `Dockerfile`→infra, fallback→general |
| P3 | Parallelization | operator | Wave-based execution: independent plans within a wave run in parallel Task() calls |
| P4 | Tool Use | ALL (11 agents) | CLI tools: `gsd-amauta.cjs`, `gsd-rlm.cjs`, `gsd-memory.cjs`, `gsd-research.cjs`, `gsd-tools.cjs` |
| P5 | Reflection | validator, checker | External validation with 5 quality gates + pre-gate divergence scan; no agent marks its own work done |
| P6 | Planning | operator, planner | Goal-backward decomposition: epic → story → task hierarchy with Given/When/Then criteria and `files_expected` manifests |
| P7 | RAG | researcher, all executors | RLM BM25-scored chunks + pgvector memory recall + 5-step research chain per RPETD phase |
| P8 | Resource-Aware Routing | operator | Model profiles in config: `executor_model` vs `verifier_model` tiers by task complexity |
| P9 | Multi-Agent Orchestration | ALL (11 agents) | 11 specialists coordinated via Amauta task manager and RPETD protocol |
| P10 | Inter-Agent Communication | ALL | RPETD phases as standardized messages; Amauta task records as shared communication medium |
| P11 | Memory Management | ALL (via gsd-memory) | PG memory with source-aware scoring, pgvector semantic search, file-based fallback |
| P12 | Learning | all executors, operator | D-phase LEARNING extraction → SKB promotion; Perplexity auto-store; `gsd-memory learn` |
| P13 | Reasoning | debugger, planner | Scientific method for debugger (hypothesis→test→observe→conclude); Given/When/Then for planner |
| P14 | Goal Setting | operator, planner | `success_criteria[]`, `deliverables[]`, `validation_checklist[]` on every task |
| P15 | Exception Handling | debugger, operator | Validation failures → sub-task atomization; graceful degradation throughout all services |
| P16 | Evaluation | validator, checker | 5 quality gates + `gsd_task_validations` audit trail + `gsd_audit_log` immutable records |
| P17 | Guardrails | operator, validator | Gitflow gates, `--force-reason` with audit trail, no self-validation rule, divergence protocol v1.1.0 |
| P18 | Human-in-the-Loop | operator | Checkpoint plans: `human-verify`, `decision`, `human-action` types; UAT via verify-work workflow |
| P19 | Prioritization | operator | Score-based: `importance*0.4 + urgency*0.3 + dep_pressure*0.3`; `amauta next` returns best task |
| P20 | Exploration | researcher | 5-step research chain; 4 modes: quick-check, deep-dive, architecture-review, pattern-search; `--creative` flag in Phase 13 |

### Coverage summary

- **100% pattern coverage** — every pattern has at least one implementing agent
- **`gsd-operator`** is the most pattern-rich agent (11 patterns: P1, P2, P3, P6, P8, P9, P14–P19)
- **P4 (Tool Use)** and **P9 (Multi-Agent)** span all agents
- **P11 (Memory)** and **P12 (Learning)** are the backbone patterns used by all executors + operator + debugger
- **P17 (Guardrails)** added in v2.6: divergence protocol v1.1.0, HARDEN-01 manifest check, `gaps-found` verdict

---

## Graceful Degradation

Every feature has a fallback. Set no environment variables for vanilla GSD behavior.

```mermaid
graph LR
    subgraph Full["With Infrastructure"]
        PG["PostgreSQL + daemon"]
        VEC["pgvector HNSW cosine"]
        RLMS["RLM HTTP :18798"]
        PPX["Perplexity API"]
        VOY["Voyage AI embeddings"]
        RPETD["RPETD gate checks"]
        RDS["Redis L2 cache"]
    end

    subgraph Fallback["Without Infrastructure"]
        JSON["data/tasks.json"]
        ILIKE["text ILIKE search"]
        AT["@ file references"]
        LOCAL["memory + SKB only"]
        TEXT["text search only"]
        HONOR["not enforced"]
        L1["In-memory L1 + file cache"]
    end

    PG -->|"no PG_URL"| JSON
    VEC -->|"no embeddings"| ILIKE
    RLMS -->|"service down"| AT
    PPX -->|"no API key"| LOCAL
    VOY -->|"no API key"| TEXT
    RPETD -->|"no daemon"| HONOR
    RDS -->|"no Redis"| L1

    style Full fill:#e6f4ea,stroke:#34a853
    style Fallback fill:#fce8e6,stroke:#ea4335
```

| Feature | Primary Path | Fallback | Trigger |
|---|---|---|---|
| Task state | PostgreSQL + JSON dual-write | `data/tasks.json` only | PG down / `GSD_POSTGRES_URL` unset |
| Semantic memory search | pgvector HNSW cosine | PostgreSQL full-text + `ILIKE` | Embeddings missing / Voyage down |
| Code context | RLM HTTP :18798 | `@file` references in prompts | RLM service down |
| Research step 4 | Perplexity `sonar`/`sonar-pro` | Skip to WebFetch | No `PERPLEXITY_API_KEY` |
| Embeddings provider | Voyage AI `voyage-code-3` | OpenAI `text-embedding-3-small` → text-only search | Voyage key missing |
| L2 cache | Redis :6379 | In-memory L1 dict + file cache | Redis down |
| RPETD gates | Daemon-enforced | Honor system (unenforced) | No daemon |
| Manifest check | `gsd-tools manifestCheck` | `GSD_MANIFEST_CHECK=warn` | Bootstrap phases |

### PG_SYNC_WARN

When dual-write to PostgreSQL fails (PG down, connection timeout), the daemon still succeeds via JSON fallback but attaches `[PG_SYNC_WARN]` to the response. Agents see this warning and can report degraded state. Dual-write failure visibility prevents silent data loss.

---

## Token Efficiency

Six mechanisms prevent excessive context consumption:

| Mechanism | Implementation | Impact |
|---|---|---|
| Enrichment dedup window | 300-second window (`ENRICHMENT_DEDUP_WINDOW`). If Layer 1 RLM ran at claim, Layer 2 R-phase skips if within window. | Prevents duplicate chunk injection |
| Phase-specific reduction | T=no enrichment, D=writes-only, E=RLM-only. Configurable per phase. | ~1950 chars/lifecycle saved (39.4% Layer 2 reduction) |
| Perplexity output cap | 1500-character limit (`PERPLEXITY_OUTPUT_CAP`). Preamble stripped, citations stripped before capping. | 75.6% per-call reduction |
| Perplexity response cache | 6h TTL temp-file cache. `--no-cache` bypass. `max_tokens` capped at 1000. | Eliminates redundant API calls |
| Redis L2 embedding cache | `gsd:emb:` prefix, 3600s TTL. SHA-256 query keys, 500 max L1 dict. | Reduces Voyage AI calls |
| RPETD soft cap | 2000-character overall cap with phase-specific guidance. Warns agents (does not block). | Guides agents toward concise phase content |

### RPETD Phase Guidance

| Phase | Target (chars) | Content guidance |
|---|:-:|---|
| R (Research) | ~500 | Key findings only, not raw output |
| P (Plan) | ~300 | Approach + key files + `files_expected` manifest |
| E (Execute) | ~500 | What changed, commit refs, `PRE_EXECUTION_EVIDENCE` block |
| T (Test) | ~300 | Pass/fail summary + `inherited_success_criteria` + `EDGE_CASES` + `REGRESSION` blocks |
| D (Document) | ~400 | Delivery summary + structured `LEARNING` block |

---

## Daemon API Routes

The Amauta daemon exposes these HTTP endpoints on `http://127.0.0.1:18799`:

| Route | Method | Description |
|---|---|---|
| `/health` | GET | Health check with version, uptime, pipeline status, service errors, feature flags |
| `/api/board` | GET | Kanban board view of all tasks |
| `/api/list` | GET | List tasks with optional filters |
| `/api/show` | GET | Show task details (`/api/show/<id>`) |
| `/api/add` | POST | Create a new task |
| `/api/claim` | POST | Claim a task for an agent |
| `/api/rpetd` | POST | Log RPETD phase content |
| `/api/validate` | POST | Validate a completed task (`--pass`, `--fail`, `--gaps-found`) |
| `/api/agent-performance` | GET | Per-agent pass rate and task count (for performance routing tiebreaker) |
| `/api/memory-search` | POST | Semantic search wrapper (invoked by `gsd-memory semantic-search`) |
| `/api/memory-store` | POST | Memory write wrapper with dedup pipeline |

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GSD_POSTGRES_URL` | `postgresql://amauta:gsd@127.0.0.1:5433/gsd_amauta` | PostgreSQL connection string |
| `GSD_AMAUTA_HOST` | `127.0.0.1` | Daemon bind host |
| `GSD_AMAUTA_PORT` | `18799` | Daemon port |
| `GSD_RLM_PORT` | `18798` | RLM service port |
| `AMAUTA_DATA_DIR` | `<project>/data` | Task board JSON location |
| `PERPLEXITY_API_KEY` | *(none)* | Perplexity API key for research chain step 4 |
| `PERPLEXITY_MODEL` | `auto` | `auto` (routes sonar/sonar-pro), `sonar`, or `sonar-pro` |
| `VOYAGE_API_KEY` | *(none)* | Voyage AI embedding key (voyage-code-3, 1024d) |
| `OPENAI_API_KEY` | *(none)* | OpenAI embedding key (alternative provider) |
| `GSD_EMBEDDING_PROVIDER` | *(auto)* | Force `voyage` or `openai` |
| `GSD_REDIS_URL` | *(none)* | Redis connection URL (e.g., `redis://127.0.0.1:6379/0`) |
| `GSD_REDIS_ENABLED` | `true` | Set `false` to disable Redis even if URL is set |
| `GSD_STALE_INTERVAL` | `300` | Watchdog check interval in seconds (5 min) |
| `GSD_RESEARCH_MIN_RESULTS` | `2` | Cascade stops when provider returns ≥ this many results |
| `GSD_MEMORY_DISTILL_THRESHOLD` | `100` | Auto-distill trigger when entry count exceeds this |
| `GSD_RESEARCH_DEDUP_THRESHOLD` | `0.7` | Jaccard dedup threshold for research results and distillation |
| `GSD_DEDUP_THRESHOLD` | `0.95` | Pre-store embedding cosine similarity threshold |
| `GSD_RECENCY_DECAY_PER_30D` | `0.5` | Score penalty per 30 days of age (capped at -3.0) |
| `GSD_TEST_MODE` | *(none)* | Set to `1` to route to `__test__` project isolation |
| `GSD_D_STRUCTURED` | `true` | v2.6 kill switch — set `false` to disable structured D-phase learnings |
| `GSD_E_MANDATE` | `advisory` | v2.6 kill switch — `advisory` (default), `off`, or `hard` |
| `GSD_T_SPEC_INHERIT` | `true` | v2.6 kill switch — disable T-phase spec inheritance |
| `GSD_R_CREATIVE` | `off` | v2.6 kill switch — enable task-type-gated creative research |
| `GSD_P_AUTO_TASK` | `false` | v2.6 kill switch — enable plan-to-tasks auto-registration (mandatory at phase 14+) |
| `GSD_MANIFEST_CHECK` | `enforce` | `enforce` (default), `warn` (bootstrap), or `off` |
| `RLM_MAX_CHUNK_CHARS` | `4000` | Max RLM chunk size in characters |
| `RLM_DEFAULT_TOP_K` | `10` | Default results per RLM query |
| `RLM_CACHE_SIZE` | `200` | LRU cache capacity (files) |
| `RLM_POSITION_DECAY` | `0.05` | Per-position decay for later chunks (5%) |
| `ENRICHMENT_DEDUP_WINDOW` | `300` | Seconds within which Layer 2 skips duplicate Layer 1 chunks |

### Project Isolation

All memory and task queries are scoped by `project_id`, automatically derived from the current working directory basename. Test environments (`NODE_ENV=test`, `GSD_TEST_MODE=1`, or `PYTEST_CURRENT_TEST` set) route to the `__test__` project, preventing test data from polluting production memory. Default search excludes `__test__` entries.

---

## Health Dashboard

`amauta health` provides a unified health view of all system components:

```bash
amauta health              # colored terminal output
amauta health --json       # raw JSON for scripting
```

Reports:

- **Daemon:** running/stopped, host:port, uptime, `pipeline_status` (ok / degraded / critical)
- **RLM service:** running/stopped, host:port, indexed files count, cache hit/miss stats
- **Redis:** connected/disconnected, cache metrics (hits, misses, keys)
- **PostgreSQL:** connected/disconnected, version, table sizes, DSN host
- **Embedding coverage:** percentage of memory entries with embeddings, active provider
- **SKB count:** number of validated shared knowledge entries
- **Agent performance:** per-agent pass rates and task counts
- **Task counts:** by status (pending, in_progress, validation, done, failed, deferred)
- **API keys:** Voyage, Perplexity, OpenAI status (set / ok / missing)
- **Service errors:** `service_errors[]` array for degraded/critical services — names exactly which fallback path is active

A `pipeline_status: degraded` result is not a failure; it's Amauta telling you which optional feature it had to route around. Read `service_errors[]` to see which one.

---

## CLI Reference

### `amauta` (gsd-amauta.cjs) — Task Management

```bash
# Board and status
amauta board                                     # Kanban board view
amauta stats                                     # Project statistics
amauta health                                    # Health dashboard
amauta health --json                             # JSON output for scripting
amauta show TK-0001                              # Full task detail (checks archive as fallback)

# Task creation
amauta add epic "Project Name" --agent operator  # Create epic
amauta add story "User Story" --parent EP-0001   # Create story
amauta add task "Implement auth" --parent ST-001 # Create task
amauta add bug "Fix crash" --parent ST-001       # Create bug

# Task lifecycle
amauta claim TK-0001 --agent gsd-executor-backend # Claim task (fires Layer 1 RLM enrichment)
amauta rpetd TK-0001 --phase R --content "..."   # Log RPETD phase
amauta status TK-0001 validation                 # Move to validation
amauta next gsd-executor-backend                 # Next highest-priority task for agent

# Validation (v2.6 three-verdict vocabulary)
amauta validate TK-0001 --pass                         # exit 0 — work meets all criteria
amauta validate TK-0001 --pass --force-reason "docs-only, no tests needed"  # Override gates
amauta validate TK-0001 --pass --test-exempt           # Skip Gate 2 for non-code tasks
amauta validate TK-0001 --fail --notes "reason"        # exit 1 — atomize into sub-tasks
amauta validate TK-0001 --gaps-found --gap "EXEC-04:description"  # exit 2 — re-plan

# Maintenance
amauta archive                                   # Archive done tasks >7 days old
amauta archive --days 30                         # Archive done tasks >30 days old
amauta archive --days 0                          # Archive ALL done tasks
amauta archive --dry-run                         # Preview without changes
amauta reconcile                                 # Show JSON vs PG drift
amauta reconcile --fix                           # Auto-sync JSON and PG

# Other
amauta search "query"                            # Full-text task search
amauta score TK-0001                             # Show priority score breakdown
amauta note TK-0001 "note text"                  # Add note to task
amauta atomize TK-0001 "Sub A|Sub B|Sub C"       # Split into sub-tasks
amauta link TK-0001 TK-0002                      # Create dependency link
amauta unlink TK-0001 TK-0002                    # Remove dependency link
amauta audit TK-0001                             # Show audit trail for task
amauta export --output backup.json               # Export all tasks
amauta import --input backup.json                # Import tasks
```

### `gsd-memory` — Memory + Embeddings

```bash
# Storage
gsd-memory store "lesson" --source lesson-learned  # Store with explicit source
gsd-memory learn "insight"                         # Auto-learning (+3 boost)
gsd-memory learn --structured \                    # v2.6 structured format
  --what "..." --why "..." --when "..." \
  --category pattern --tags "postgresql,backend"

# Search
gsd-memory search "connection pooling"             # Text search (excludes noise)
gsd-memory search "pooling" --include-noise        # Text search (includes task_event/rpetd_phase)
gsd-memory search --tags postgresql,backend "pool" # Tag + category filtered (GIN index, <50ms)
gsd-memory semantic-search "auth patterns"         # pgvector cosine similarity
gsd-memory cross-project "patterns" --tags react   # Cross-project search

# APPLIED_LEARNING tracking
gsd-memory increment-applied mem-abc --task TK-001 --phase E --reason "applied pattern"

# SKB promotion
gsd-memory skb candidates                          # Rising + needs-review candidates
gsd-memory skb-promote mem-abc --reviewed --reason "cited 12 times"
gsd-memory skb-remove skb-xyz                      # Demote from SKB

# Maintenance
gsd-memory distill                                 # Compact similar entries (Jaccard >0.7)
gsd-memory distill --dry-run                       # Preview without changes
gsd-memory backfill-embeddings                     # Embed entries missing vectors
gsd-memory health                                  # Service health + embedding coverage
```

### `gsd-rlm` — Code Context

```bash
gsd-rlm query "how auth works" --path src/         # BM25-scored chunks from path
gsd-rlm query "database models" --dir . --top-k 5  # Top-5 results from project
gsd-rlm query "auth" --fresh                        # Bypass cache for fresh results
gsd-rlm chunk src/auth.ts                           # Inspect chunking for a file
gsd-rlm health                                      # Service status + indexed file count + cache stats
gsd-rlm start                                       # Start RLM service
gsd-rlm stop                                        # Stop RLM service
gsd-rlm check-config                                # Validate RLM service configuration
```

### `gsd-research` — Research Chain

```bash
gsd-research search "React patterns"               # Full 5-step chain
gsd-research perplexity "Next.js 15 changes"       # Perplexity direct query
gsd-research perplexity "query" --no-cache          # Bypass 6h response cache
gsd-research fetch --url https://docs.example.com  # WebFetch direct
gsd-research check-providers                        # Provider availability status
```

### `gsd-tools` — GSD Core + Manifest Check

```bash
gsd-tools init execute-phase <N>                   # Phase context for execute-phase workflow
gsd-tools phase-plan-index <N>                     # Plan inventory with wave grouping
gsd-tools route-executor "<comma-file-list>"       # Compute the correct executor for a file set
gsd-tools manifestCheck --task-id <ID>             # Run per-task manifest enforcement
gsd-tools plan-to-tasks <PLAN.md>                  # Parse and register plan tasks in Amauta
gsd-tools phase complete <N>                       # Mark a phase complete in ROADMAP.md
gsd-tools scaffold phase-dir --phase <N>           # Create a phase directory skeleton
gsd-tools config-get <key>                         # Read a config value
gsd-tools config-set <key> <value>                 # Write a config value
```

---

## Testing

```bash
npm test                              # All CJS tests (~61 test files)
python3 -m pytest tests/ -q           # All Python tests (~31 test files)
npm run test:coverage                 # Coverage report (target: 70%+ lines)
npm run test:behavioral               # Behavioral divergence-protocol test suite (~30 min, requires ANTHROPIC_API_KEY)
```

**~2544 passing tests** across ~100 files covering: RPETD pipeline, validation gates (including `--force-reason`, `--test-exempt`, self-validation block, substance gates, phase-order warnings, `--gaps-found` verdict, pre-gate divergence scan), memory (PG + semantic + distill + retention + dedup + decay + source filtering + recency guard), RLM (BM25 scoring, word-boundary TF, camelCase splitting, HTTP wiring, incremental indexing, cache stats, position decay), research chain (Perplexity cap, auto-store, cascade min-results, 429 backoff, preamble stripping), task lifecycle (archive, TOCTOU, reconcile, watchdog, retry flush, dep_pressure caching), token efficiency (enrichment dedup, phase-specific reduction, RPETD soft cap, Perplexity cache), Redis L2 caching, agent architecture (capability index, routing extraction, performance tiebreaker), multi-agent validation (error classification, recovery routing, auto-escalation), security (path traversal, body limits, DSN sanitization), graceful degradation, health dashboard (pipeline status, service errors), v2.6 additions (structured learnings + tag rules, PRE_EXECUTION_EVIDENCE parser, QA spec inheritance, creative research gating, plan-to-tasks identity contract, manifest check, divergence protocol schema), end-to-end integration with 24 regression benchmarks, and Phase 13.1's behavioral divergence-protocol test suite (15 LLM-driven scenarios + Phase 13 incident replay).

The behavioral test suite (`tests/13.1-divergence-protocol.integration.test.cjs`) is gated by `ANTHROPIC_API_KEY` and runs via `npm run test:behavioral`. It is NOT part of `npm test`. The suite fires real LLM invocations against curated divergence scenarios and verifies that the agents emit valid `divergence_report` JSONs with the correct field population — specifically that `rationalization_check` is filled in with either the exact pattern or `"N/A — no temptation present."`

### Phase 15 audit script

```bash
node scripts/verify-v26.cjs             # Produce 15-AUDIT-REPORT.{json,md}
/amauta:verify-v26                       # Run the audit via slash command (same tool)
```

`verify-v26.cjs` is the deterministic audit tool shipped in Phase 15 (DOGFOOD-01..05). It runs a structured audit of the v2.6 milestone against the five DOGFOOD criteria, produces a JSON report, and derives a Markdown report from the JSON via `generateMarkdown()`. The audit excludes Phase 15's own deliverables from the scope (self-exclusion) and always exits 0 — the verdict is carried in the JSON report body, not the exit code.

---

## Project Structure

```
gsd-amauta/
├── package.json                         # v2.6.0 "Sight Beyond Sight"
├── amauta.py                            # Task manager core (~5000 lines)
├── docker/docker-compose.yml            # PostgreSQL 16 + pgvector :5433, Redis 7 :6379
├── migrations/                          # 8 SQL migrations (001-008 + DOWN files)
├── services/
│   ├── amauta-daemon.py                 # HTTP daemon :18799 (dual-write, watchdog, retention, Redis)
│   ├── amauta_daemon_redis.py           # Redis bridge module (solves circular import)
│   ├── pg_store.py                      # PG pool + memory/SKB/tasks/embeddings/dedup/rerank
│   └── rlm-service.py                   # BM25 code context :18798 (cache stats, position decay)
├── agents/                              # 11 agent definitions (.md)
├── skills/                              # 11 skill workflows (SKILL.md each)
├── get-shit-done/
│   ├── bin/                             # 5 CLI tools (.cjs) + manifest-check helper
│   │   ├── amauta.cjs                   # gsd-amauta — task management
│   │   ├── gsd-memory.cjs               # memory + embeddings
│   │   ├── gsd-rlm.cjs                  # RLM client
│   │   ├── gsd-research.cjs             # research chain
│   │   ├── gsd-tools.cjs                # GSD core + manifest check + plan-to-tasks
│   │   └── audit-rpetd-intelligence.cjs # v2.6 Phase 15 — RPETD content audit
│   ├── agent-capabilities.json          # Single source of truth for 11 agents
│   ├── workflows/                       # 36+ workflow files (new in v2.6: verify-rpetd-intelligence.md)
│   ├── references/                      # Model profiles, divergence-protocol.md, learning-format.md, etc.
│   └── config/
│       └── tag-rules.json               # v2.6 tag vocabulary, banned tags, synonyms
├── commands/
│   ├── gsd/                             # 34 slash commands (GSD namespace)
│   └── amauta/                          # 34 slash commands (Amauta namespace) — includes verify-v26.md
├── specs/                               # 9 formal specifications
├── tests/                               # ~100 test files (~61 CJS + ~31 Python + behavioral suite)
├── bin/install.js                       # Self-installer (multi-runtime: Claude/OpenCode/Gemini/Codex)
├── scripts/
│   ├── install-remote.sh                # One-line remote installer
│   └── verify-v26.cjs                   # v2.6 Phase 15 end-to-end audit
├── references/
│   └── agentic-patterns.md              # 20 patterns × 11 agents matrix
├── docs/
│   └── v2.6-dogfood-ledger.md           # Human-readable divergence protocol record (9 captured depths)
└── data/
    ├── tasks.json                       # Active task board
    └── tasks-archive.json               # Archived done tasks
```

### v2.6 milestone structure (`.planning/milestones/`)

```
.planning/
├── ROADMAP.md                           # v2.6 COMPLETE — 7 phases shipped
├── REQUIREMENTS.md                      # 46 requirements, DOGFOOD-01..05 closeout errata applied
├── STATE.md                             # Current position, test baseline, session continuity
└── milestones/v2.2-phases/              # v2.6 phase directories (legacy rename deferred)
    ├── 09-tech-debt-sweep/              # Phase 9 — green baseline
    ├── 10-d-phase-structured-learning/  # Phase 10 — LEARN-01..07
    ├── 11-context-engine-activation/    # Phase 11 — EXEC-01..08
    ├── 12-semantic-memory-pipeline/     # Phase 12 — QA-01..08
    ├── 13-validation-hardening/         # Phase 13 — CREATIVE-01..05
    ├── 13.1-divergence-protocol/        # Phase 13.1 — HARDEN-01..05
    ├── 14-p-phase-task-management-integration/  # Phase 14 — PLAN-01..07
    └── 15-dogfood/                      # Phase 15 — DOGFOOD-01..05 + 15-AUDIT-REPORT.{json,md}
```

---

## Contributing

1. Fork and create a feature branch.
2. Run `npm test` and `python3 -m pytest tests/ -q` — all must pass before PR.
3. Follow RPETD: **R**esearch existing patterns, **P**lan changes with `files_expected` manifest, **E**xecute on a branch with `PRE_EXECUTION_EVIDENCE`, **T**est with evidence + `EDGE_CASES` + `REGRESSION` blocks, **D**ocument with a structured `LEARNING` block.
4. **No self-validation.** If you're submitting a PR that touches a specific Amauta task, a different agent (or reviewer) must validate it. This is a discipline rule, not a tool rule — enforce it yourself.
5. **The divergence protocol applies to contributors too.** If you notice something during implementation that doesn't match the plan, write a divergence report in the PR description instead of silently "fixing" it in the same PR. The behavioral half of the protocol exists precisely to keep drift visible.
6. Submit PR — external validation required before merge.

---

## License

MIT. Based on [GSD (Get Shit Done)](https://github.com/get-shit-done/get-shit-done) by TACHES.
Amauta task management by [robertamauta](https://github.com/robertamauta/amauta).

v2.6 "Sight Beyond Sight" shipped 2026-04-10. The 9 captured depths of the dogfood ledger (`docs/v2.6-dogfood-ledger.md`) are the qualitative evidence that the discipline holds. The routed follow-ups at the end of the ledger are the inputs to v2.7.

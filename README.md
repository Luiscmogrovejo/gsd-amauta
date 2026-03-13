# GSD-Amauta

**A Claude Code plugin that merges [GSD](https://github.com/get-shit-done/get-shit-done) (Get Shit Done) with [Amauta](https://github.com/robertamauta/amauta) (multi-agent task management).**

Replaces GSD's file-only state with PostgreSQL persistent memory, pgvector semantic search, RLM context engine, RPETD pipeline enforcement, external validation, and Perplexity-first research. Everything degrades gracefully to vanilla GSD if infrastructure isn't available.

**583 tests | 11 agents | 5 CLI tools | 3 services | 20 agentic AI patterns**

---

## Table of Contents

- [How It Works](#how-it-works)
- [System Architecture](#system-architecture)
- [End-to-End Request Flow](#end-to-end-request-flow)
- [RPETD Pipeline](#rpetd-pipeline)
- [Agent Architecture](#agent-architecture)
- [Memory System](#memory-system)
- [Semantic Search (pgvector)](#semantic-search-pgvector)
- [RLM Context Engine](#rlm-context-engine)
- [Research Chain](#research-chain)
- [Task Lifecycle](#task-lifecycle)
- [Graceful Degradation](#graceful-degradation)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Services](#services)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## How It Works

GSD-Amauta is a Claude Code plugin that turns your AI coding sessions into a managed, persistent development pipeline. When you say "build me a feature," it:

1. **Breaks work into tasks** (epics, stories, tasks) tracked in PostgreSQL
2. **Routes each task** to a specialist agent (frontend, backend, infra, general)
3. **Enforces quality** with a 5-step pipeline (Research-Plan-Execute-Test-Document)
4. **Validates externally** — no agent marks its own work done
5. **Remembers everything** across sessions via PG memory with semantic search
6. **Learns from past projects** through cross-project knowledge transfer

Without infrastructure, it falls back to vanilla GSD file-based behavior.

---

## System Architecture

```
+----------------------------------------------------------------------+
|                        Claude Code Session                            |
|                                                                       |
|   /gsd:new-project   /gsd:execute-plan   /gsd:test-phase   ...      |
|        |                    |                    |                     |
|        v                    v                    v                     |
|   +-----------+   +------------------+   +----------------+           |
|   | Workflows |   | Agent Definitions|   | Slash Commands |           |
|   | (33+ .md) |   |  (11 agents)     |   |  (34 total)    |           |
|   +-----+-----+   +--------+--------+   +-------+--------+           |
|         |                   |                    |                     |
|         +-------------------+--------------------+                     |
|                             |                                          |
|   +--------------------------v-----------------------------+           |
|   |                Node.js CLI Tools Layer                 |           |
|   |                                                        |           |
|   |  gsd-amauta.cjs    gsd-memory.cjs     gsd-rlm.cjs    |           |
|   |  (task mgmt)       (PG memory +       (code-aware     |           |
|   |                     embeddings)        context)        |           |
|   |  gsd-research.cjs  gsd-tools.cjs                      |           |
|   |  (Perplexity)      (original GSD)                      |           |
|   +---------+----------------+-----------------+-----------+           |
|             |                |                 |                       |
+----------------------------------------------------------------------+
              |                |                 |
              v                v                 v
   +------------------+ +--------------+ +---------------+
   | Amauta Daemon    | | RLM Service  | | External APIs |
   | :18799 (HTTP)    | | :18798 (HTTP)| |               |
   |                  | |              | | Perplexity    |
   | +----------+    | | Code-aware   | | OpenAI emb.   |
   | |amauta.py |    | | chunking     | | Context7      |
   | |(3920 ln) |    | | TF-IDF rank  | +---------------+
   | +----------+    | | LRU cache    |
   | +----------+    | +--------------+
   | |pg_store  |    |
   | |(.py)     |    |
   | +----+-----+    |
   +------+----------+
          |
          v
   +--------------------+
   | PostgreSQL 16      |
   | + pgvector 0.8     |
   | :5433 (Docker)     |
   |                    |
   | gsd_memory         |  text + vector(1024) embeddings
   | gsd_shared_kb      |  validated knowledge
   | gsd_tasks          |  task state + RPETD
   | gsd_task_valid.    |  validation audit trail
   |                    |
   | 22 indexes         |  incl. HNSW for cosine similarity
   +--------------------+
```

---

## End-to-End Request Flow

How a user request flows through the entire system:

```
  USER: "Add dark mode to the settings page"
         |
         v
  +------------------+
  | gsd-operator     |  Master orchestrator receives request
  | (P1,P2,P6,P9)   |  Decomposes into tasks, routes to agents
  +--------+---------+
           |
           | 1. Create task in Amauta
           v
  +------------------+     +------------------+
  | gsd-amauta.cjs   |---->| Amauta Daemon    |---> PostgreSQL
  | add task "..."    |     | POST /api/add    |     gsd_tasks
  +--------+---------+     +------------------+
           |
           | 2. Route to specialist executor
           v
  +------------------+
  | gsd-executor-    |  Executor claims task, begins RPETD
  | frontend         |
  +--------+---------+
           |
           |  R: Research (query memory, SKB, Perplexity)
           |  P: Plan (Given/When/Then criteria)
           |  E: Execute (write code, commit to branch)
           |  T: Test (run tests, capture evidence)
           |  D: Document (LEARNING block, lessons)
           |
           | 3. Each RPETD phase logged
           v
  +------------------+     +------------------+
  | gsd-amauta.cjs   |---->| Amauta Daemon    |---> PostgreSQL
  | rpetd TK-XXXX    |     | POST /api/rpetd  |     + gsd_memory
  | --phase R/P/E/T/D|     +------------------+     (auto-learn)
  +--------+---------+
           |
           | 4. Status -> validation
           v
  +------------------+
  | gsd-validator    |  External validator (NOT the executor)
  | (P4,P17)         |  Checks: branch evidence, test output,
  +--------+---------+  LEARNING block, success criteria
           |
           | PASS: task -> done, learnings -> memory + SKB
           | FAIL: sub-tasks created, re-route to executor
           v
  +------------------+
  | DONE             |  Knowledge persists for future sessions
  +------------------+
```

---

## RPETD Pipeline

Every task follows the Research-Plan-Execute-Test-Document pipeline with validation gates:

```
  TASK CLAIMED
       |
       v
  +----+----+     Memory --> SKB --> Context7 --> Perplexity
  |    R    |     Research phase: query knowledge chain
  | Research|     Output: context, patterns, prior learnings
  +----+----+
       |
       v
  +----+----+     Given/When/Then acceptance criteria
  |    P    |     Plan phase: implementation strategy
  |  Plan   |     Output: step-by-step plan with test strategy
  +----+----+
       |
       v
  +----+----+     Feature branch (feat/, fix/, chore/)
  |    E    |     Execute phase: write code, commit
  | Execute |     GATE 1: Branch evidence required
  +----+----+
       |
       v
  +----+----+     Run tests, capture output
  |    T    |     Test phase: evidence collection
  |  Test   |     GATE 2: Test evidence (13 regex patterns)
  +----+----+
       |
       v
  +----+----+     LEARNING: block required
  |    D    |     Document phase: capture lessons
  | Document|     GATE 3: Learning block required
  +----+----+     Auto-store to memory + promote to SKB
       |
       v
  +----+----+
  |VALIDATE |---> External validator agent (no self-validation)
  |  GATES  |     Checks all 3 gates + success criteria
  +----+----+
       |
    PASS / FAIL
       |         |
       v         v
    [DONE]    [REJECTED --> fix sub-tasks --> re-validate]
```

---

## Agent Architecture

11 agents with file-pattern routing for executors:

```
                          +-------------+
                          |  Operator   |   P1,P2,P6,P8,P9,
                          | (orchestrate|   P14,P15,P17,P18,P19
                          |  dispatch)  |
                          +------+------+
                                 |
          +----------+-----------+-----------+----------+
          |          |           |           |          |
          v          v           v           v          v
   +----------+ +--------+ +----------+ +--------+ +--------+
   | Planner  | |Research| | Checker  | |Validatr| |Debugger|
   | (plan,   | |(memory,| | (pre/    | |(extern | |(root   |
   |  scope,  | | SKB,   | |  post    | | valid.,| | cause, |
   |  G/W/T)  | | Perplx)| |  check)  | | gates) | | bisect)|
   +----------+ +--------+ +----------+ +--------+ +--------+
       P6,P14     P5,P10      P4,P17     P4,P13,P17  P5,P7,P20
                                 |
          +----------+-----------+-----------+
          |          |           |           |
          v          v           v           v
   +----------+ +----------+ +----------+ +----------+
   | Executor | | Executor | | Executor | | Executor |
   | Frontend | | Backend  | |  Infra   | | General  |
   | (React,  | | (API,    | | (Docker, | | (any     |
   |  Vue,CSS)| |  DB,py)  | |  CI/CD)  | |  task)   |
   +----------+ +----------+ +----------+ +----------+
     P3,P11       P3,P11       P3,P11       P3,P11

   File pattern routing:
     *.tsx, *.jsx, *.css, *.scss, *.vue  --> executor-frontend
     *.py, *.sql, *.go, *.rs, *.java    --> executor-backend
     Dockerfile, *.yml, terraform, k8s   --> executor-infra
     everything else                      --> executor-general
```

**Pattern Legend:**
P1 Prompt Chaining, P2 Routing, P3 Parallelization, P4 Verification,
P5 Tool Use, P6 Planning, P7 Reflection, P8 Resource-Aware Routing,
P9 Multi-Agent Orchestration, P10 RAG, P11 Code Generation,
P13 Self-Monitoring, P14 Goal Setting, P15 Exception Handling,
P17 Guardrails, P18 Human-in-the-Loop, P19 Prioritization, P20 Debugging

See `references/agentic-patterns.md` for the complete 20-pattern matrix.

---

## Memory System

PostgreSQL-backed persistent memory with source-aware scoring:

```
  +---------------------------+
  | Agent writes code/learns  |
  +------------+--------------+
               |
               v
  +---------------------------+     +-------------------+
  | auto_learning (+3 boost)  |---->| gsd_memory (PG)   |
  | RPETD phase (+1 boost)    |     |                   |
  | web_search_result (+3)    |     | text, source,     |
  +---------------------------+     | agent_id, tags,   |
               |                    | project_id,       |
               |                    | embedding(1024),  |  <-- pgvector
  +---------------------------+     | metadata, ts      |
  | Validation passes         |     +--------+----------+
  +------------+--------------+              |
               |                             |  count > threshold?
               v                             v
  +---------------------------+     +-------------------+
  | SKB promotion             |     | Auto-distill      |
  | best-practice (+4 boost)  |     | Jaccard > 0.7     |
  +---------------------------+     | merge duplicates   |
               |                    +-------------------+
               v
  +---------------------------+     +-------------------+
  | gsd_shared_kb (PG)        |     | Cross-project     |
  | title, content, category  |     | search at new-    |
  | importance (1-10), tags   |     | project init      |
  +---------------------------+     | tag-filtered      |
                                    +-------------------+
```

### Memory Source Scoring

| Source | Boost | When Created |
|--------|-------|-------------|
| `lesson-learned` | +4 | Manual lessons from developers |
| `best-practice` | +4 | SKB promotions after validation |
| `auto_learning` | +3 | D-phase LEARNING block extraction |
| `web_search_result` | +3 | Perplexity API results |
| `session-learning` | +3 | Session observations |
| `distilled` | +2 | Merged/compacted entries |
| `rpetd_phase` | +1 | Per-phase auto-capture |
| `task_event` | +0 | Status changes |
| `agent` | +0 | General agent notes |

---

## Semantic Search (pgvector)

Memories are stored with 1024-dimension embeddings for cosine similarity search via pgvector's HNSW index. Two embedding providers are supported:

- **Voyage AI `voyage-code-3`** (recommended) — Anthropic partner, optimized for code retrieval. Set `VOYAGE_API_KEY`.
- **OpenAI `text-embedding-3-small`** (alternative) — Set `OPENAI_API_KEY`.

Auto-detects: prefers Voyage if both keys are set. Override with `GSD_EMBEDDING_PROVIDER=voyage|openai`.

```
  QUERY: "How do we handle database connection pooling?"
         |
         v
  +------------------+
  | Generate query   |  Voyage AI voyage-code-3 (preferred)
  | embedding (1024d)|  or OpenAI text-embedding-3-small
  | input_type=query |  (skipped if no API key)
  +--------+---------+
           |
           v
  +------------------+     +------------------+
  | Cosine similarity|---->| gsd_memory       |
  | via HNSW index   |     | WHERE embedding  |
  | ORDER BY <=>     |     | IS NOT NULL      |
  +--------+---------+     +------------------+
           |
           | Results scored:
           | similarity(0-1) * 10 + source_bonus(0-4)
           v
  +------------------+
  | Top-K results    |  Includes semantic_similarity score
  | with source boost|  Falls back to text search if no embeddings
  +------------------+

  CLI Commands:
    gsd-memory.cjs semantic-search "connection pooling"
    gsd-memory.cjs backfill-embeddings --batch-size 50
    gsd-memory.cjs embedding-stats
```

**Graceful degradation:** Without an embedding API key, memory store/search uses text-only full-text search + ILIKE fallback. Semantic search falls back to the same text pipeline.

---

## RLM Context Engine

Based on the MIT CSAIL Retrieval-Augmented Language Model paper (arXiv:2512.24601v1). Agents query code chunks instead of loading full files into prompts.

```
  Agent needs context: "How does auth work?"
         |
         v
  +------------------+
  | gsd-rlm.cjs     |  query "auth" --path src/
  | query command    |
  +--------+---------+
           |
           v
  +------------------+     +------------------+
  | RLM Service      |     | File System      |
  | :18798           |     |                  |
  |                  |     | Walk target path |
  | 1. Chunk files   |<----|  (*.ts, *.py,    |
  |    code-aware    |     |   *.js, *.sql,   |
  |    (fn/class     |     |   *.md, etc.)    |
  |     boundaries)  |     +------------------+
  |                  |
  | 2. TF-IDF rank   |  Score chunks against query
  |    against query |
  |                  |
  | 3. Return top-K  |  Only relevant chunks, not full files
  |    chunks (8KB   |
  |    max each)     |
  |                  |
  | 4. LRU cache     |  Up to 200 files cached
  +------------------+

  Config: rlm_enabled=true (default), rlm_fallback_to_full_files=true
```

---

## Research Chain

Multi-provider research with automatic deduplication:

```
  Query: "React server component patterns"
         |
         v
  +--------+    hit?    +-------+
  | Memory |--yes------>| DONE  |    Source-aware scoring
  |  (PG)  |            +-------+    applied to all results
  +---+----+
      | no
      v
  +--------+    hit?    +-------+
  |  SKB   |--yes------>| DONE  |    Validated knowledge
  |  (PG)  |            +-------+    from past projects
  +---+----+
      | no
      v
  +--------+
  |Context7|    MCP tool — agent invokes directly
  |  docs  |    Library documentation lookup
  +---+----+
      | no
      v
  +----------+  hit?    +-------+
  |Perplexity|--yes---->| DONE  |    Auto-store to PG memory
  |  (API)   |          +-------+    with dedup (Jaccard 0.7)
  +---+------+
      | no
      v
  +--------+
  |WebFetch|    HTTP fallback (requires --url)
  | (HTTP) |
  +--------+
```

---

## Task Lifecycle

```
  /gsd:new-project
       |
       v
  [Epic created in Amauta]
       |
       +---> [Story per roadmap phase]
       |          |
       v          +---> [Tasks per plan item]
                            |
  TASK STATES:              v
                       +---------+
                       | pending |
                       +----+----+
                            |
                       claim (agent)
                            |
                            v
                    +---------------+
                    | in-progress   |
                    | RPETD logging |
                    +-------+-------+
                            |
                     status validation
                            |
                            v
                    +---------------+
                    | validation    |
                    +-------+-------+
                            |
                    validate --pass
                    (external agent)
                            |
                            v
                       +---------+
                       |  done   |
                       +---------+

  Priority scoring:
    score = importance * 0.4 + urgency * 0.3 + dep_pressure * 0.3

  Hierarchy: Epic --> Story --> Task/Bug
  Types: epic, story, task, bug
  Statuses: pending, in-progress, validation, done, failed, deferred
```

---

## Graceful Degradation

Every feature works without infrastructure — falling back to vanilla GSD behavior:

```
  Feature              | With infra         | Without infra
  ---------------------|--------------------|-----------------------
  Task management      | PG + daemon        | data/tasks.json
  Memory search        | PG full-text +     | .planning/memory/*.md
                       |   pgvector cosine  |
  Memory store         | PG + embedding     | .planning/memory/YYYY-MM-DD.md
  Semantic search      | pgvector HNSW      | text fallback (ILIKE)
  Learning capture     | PG auto_learning   | STATE.md ## Learnings
  RLM context          | HTTP service       | @ file references
  Research             | Perplexity API     | Memory + SKB only
  SKB                  | PG table           | (not available)
  Validation gates     | Daemon + PG        | (not available)
  Cross-project search | PG cross-query     | File keyword search
  Embeddings           | Voyage/OpenAI API  | text search (no cost)
```

**Activation:** Features activate by setting environment variables:
- `GSD_POSTGRES_URL` enables PG memory, SKB, validation
- `PERPLEXITY_API_KEY` enables Perplexity research
- `VOYAGE_API_KEY` enables pgvector semantic search (preferred, Anthropic partner)
- `OPENAI_API_KEY` enables pgvector semantic search (alternative)

---

## Installation

### Prerequisites

- **Node.js** 18+
- **Python** 3.9+ (with pip)
- **Docker** (for PostgreSQL)
- **Claude Code** CLI

### Quick Start

```bash
# Clone
git clone https://github.com/robertamauta/gsd-amauta.git ~/.claude/gsd-amauta
cd ~/.claude/gsd-amauta

# Install (sets up Docker PG, Python deps, daemon, RLM)
npm install
```

The installer handles:
1. Standard GSD installation (agents, workflows, commands, hooks)
2. Docker PostgreSQL 16 with pgvector on port 5433
3. Python psycopg2-binary dependency
4. Amauta daemon startup on port 18799
5. RLM context service startup on port 18798
6. HNSW index migration for semantic search

### Post-Install

Add to your shell profile (`~/.zshrc`, `~/.bashrc`):

```bash
# Required for PG memory
export GSD_POSTGRES_URL="postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta"

# Optional: Perplexity research
export PERPLEXITY_API_KEY="your-key-here"

# Optional: Semantic search (pgvector embeddings)
# Optional: Semantic search — pick one (Voyage recommended)
export VOYAGE_API_KEY="your-key-here"     # Anthropic partner, voyage-code-3
# export OPENAI_API_KEY="your-key-here"   # Alternative: text-embedding-3-small
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GSD_POSTGRES_URL` | `postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta` | PostgreSQL DSN |
| `GSD_AMAUTA_HOST` | `127.0.0.1` | Daemon host |
| `GSD_AMAUTA_PORT` | `18799` | Daemon port |
| `AMAUTA_DATA_DIR` | `<project>/data` | Task board JSON location |
| `PERPLEXITY_API_KEY` | _(none)_ | Perplexity API key for research |
| `PERPLEXITY_MODEL` | `sonar` | Perplexity model |
| `VOYAGE_API_KEY` | _(none)_ | Voyage AI key for embeddings (recommended) |
| `OPENAI_API_KEY` | _(none)_ | OpenAI API key for embeddings (alternative) |
| `GSD_EMBEDDING_PROVIDER` | _(auto)_ | Force `voyage` or `openai` provider |
| `GSD_MEMORY_DISTILL_THRESHOLD` | `100` | Auto-distill trigger count |
| `GSD_RESEARCH_DEDUP_THRESHOLD` | `0.7` | Research dedup similarity |
| `RLM_MAX_CHUNK_CHARS` | `8000` | Max chunk size for RLM |

### Config File

Edit `.planning/config.json` or `get-shit-done/templates/config.json`:

```json
{
  "amauta": {
    "daemon_port": 18799,
    "pg_enabled": true,
    "daemon_enabled": true,
    "rlm_enabled": true,
    "rlm_fallback_to_full_files": true,
    "research_chain": ["memory", "skb", "context7", "perplexity", "webfetch"]
  }
}
```

---

## Usage

### Task Management

```bash
node gsd-amauta.cjs board                          # View task board
node gsd-amauta.cjs stats                          # Project statistics
node gsd-amauta.cjs show TK-0001                   # Task details
node gsd-amauta.cjs next executor-backend           # Next task for agent
node gsd-amauta.cjs claim TK-0001 --agent executor-backend
node gsd-amauta.cjs rpetd TK-0001 --phase R --content "Research findings..."
node gsd-amauta.cjs validate TK-0001 --pass --force
```

### Memory

```bash
node gsd-memory.cjs search "connection pooling"     # Source-aware text search
node gsd-memory.cjs semantic-search "how auth works" # pgvector cosine similarity
node gsd-memory.cjs store "lesson" --source lesson-learned
node gsd-memory.cjs learn "auto-learning entry"      # +3 boost shortcut
node gsd-memory.cjs cross-project "patterns" --tags postgresql,react
node gsd-memory.cjs infer-tags .                     # Detect project tech
node gsd-memory.cjs distill --dry-run                # Compact duplicates
node gsd-memory.cjs backfill-embeddings              # Generate embeddings
node gsd-memory.cjs embedding-stats                  # Coverage report
```

### RLM Context

```bash
node gsd-rlm.cjs query "how does auth work" --path src/
node gsd-rlm.cjs chunk src/auth.ts                  # Code-aware chunking
node gsd-rlm.cjs health
```

### Research

```bash
node gsd-research.cjs search "React server components"   # Full chain
node gsd-research.cjs perplexity "Next.js 15 features"   # Direct
node gsd-research.cjs check-providers                     # Status
```

---

## Services

| Service | Port | Start | Stop |
|---------|------|-------|------|
| PostgreSQL | 5433 | `docker compose -f docker/docker-compose.yml up -d` | `docker compose ... down` |
| Amauta Daemon | 18799 | `python3 services/amauta-daemon.py start` | `... stop` |
| RLM Service | 18798 | `python3 services/rlm-service.py start` | `... stop` |

Health checks:
```bash
curl http://127.0.0.1:18799/health | python3 -m json.tool  # daemon + PG
curl http://127.0.0.1:18798/health | python3 -m json.tool  # RLM
docker ps --filter name=gsd-postgres                         # container
```

---

## Testing

```bash
npm test                                          # All 583 tests (19 suites)

# Individual suites
node --test tests/gsd-amauta.test.cjs            # CLI tests (17)
node --test tests/e2e-lifecycle.test.cjs          # E2E lifecycle (22)
node --test tests/degradation.test.cjs            # Degradation (11)
node --test tests/agent-frontmatter.test.cjs      # Agent validation (42)
node --test tests/codex-config.test.cjs           # Codex config (34)
```

**583 tests** across 19 test files, covering:
- Task CRUD, RPETD phases, validation lifecycle
- Memory storage, search, cross-project, distill
- Agent frontmatter (skills, hooks, anti-heredoc, spawn consistency)
- Codex/Gemini config generation
- CLI command parsing, config management
- Graceful degradation (file fallback)
- Phase/milestone/roadmap operations

---

## Project Structure

```
gsd-amauta/
  amauta.py                      # Task manager CLI (3920 lines)
  package.json                   # Project config
  README.md                      # This file
  CHANGELOG.md                   # All changes from vanilla GSD
  MIGRATION.md                   # Migration guide from vanilla GSD
  docker/
    docker-compose.yml           # PostgreSQL 16 + pgvector
  migrations/
    001-init.sql                 # Schema: 4 tables, 21 indexes, 3 triggers
    002-embedding-index.sql      # HNSW index for pgvector cosine search
  services/
    amauta-daemon.py             # HTTP daemon (:18799) — 700+ lines
    pg_store.py                  # PG pool + memory/SKB/embedding ops — 730+ lines
    rlm-service.py               # RLM context engine (:18798) — 800+ lines
  agents/                        # 11 agent definitions (.md)
    gsd-operator.md              # Master orchestrator (297 lines, 11 patterns)
    gsd-planner.md               # Planning specialist
    gsd-researcher.md            # Research specialist (4 modes)
    gsd-executor-frontend.md     # Frontend execution
    gsd-executor-backend.md      # Backend execution
    gsd-executor-infra.md        # Infrastructure execution
    gsd-executor-general.md      # General execution
    gsd-checker.md               # Quality checker (pre/post)
    gsd-validator.md             # External validator
    gsd-debugger.md              # Debug specialist
    gsd-roadmapper.md            # Roadmap creation (kept from vanilla GSD)
  get-shit-done/
    bin/
      gsd-amauta.cjs             # Task management CLI (1064 lines)
      gsd-memory.cjs             # Memory + SKB + embeddings CLI (1300+ lines)
      gsd-rlm.cjs                # RLM context CLI (600 lines)
      gsd-research.cjs           # Research chain CLI (641 lines)
      gsd-tools.cjs              # Original GSD CLI (592 lines)
    workflows/                   # 33+ workflow definitions
    templates/                   # Config templates
    references/                  # Reference files
  references/
    agentic-patterns.md          # 20 patterns mapped to 11 agents
  commands/gsd/                  # 34 slash commands
  tests/                         # 583 tests (19 files)
  bin/
    install.js                   # Self-installer (2752 lines)
  scripts/
    run-tests.cjs                # Cross-platform test runner
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Daemon won't start | `lsof -ti :18799 \| xargs kill -9` then restart |
| PG connection fails | `docker ps --filter name=gsd-postgres`, restart if down |
| Memory empty | Check `gsd-memory.cjs health`, verify `pg_available: true` |
| Validation blocked | Tag task `no-gitflow`, use `--force` flag |
| RLM returns nothing | Check `gsd-rlm.cjs health`, verify files exist in query path |
| Semantic search slow | Run `backfill-embeddings` to populate vectors |
| No embeddings | Set `VOYAGE_API_KEY` or `OPENAI_API_KEY`, then `backfill-embeddings` |
| Perplexity errors | Verify `PERPLEXITY_API_KEY` is set and valid |
| Port conflict | Change ports via `GSD_AMAUTA_PORT` / edit docker-compose.yml |
| Tests fail on data | Re-run: `npm test` (test runner handles ordering) |

---

## License

Based on [GSD (Get Shit Done)](https://github.com/get-shit-done/get-shit-done) with [Amauta](https://github.com/robertamauta/amauta) task management system integration.

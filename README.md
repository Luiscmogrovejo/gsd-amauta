# GSD-Amauta

**A Claude Code plugin that merges GSD (Get Shit Done) with Amauta (multi-agent task management).**

Replaces GSD's file-only state with PostgreSQL persistent memory, RLM context engine, RPETD pipeline enforcement, external validation, and Perplexity-first research. Everything degrades gracefully to vanilla GSD if infrastructure isn't available.

---

## System Architecture

```
+-------------------------------------------------------------------+
|                        Claude Code Session                         |
|                                                                    |
|   /gsd:new-project   /gsd:execute-plan   /gsd:test-phase  ...    |
|        |                    |                    |                  |
|        v                    v                    v                  |
|   +----------+   +------------------+   +----------------+         |
|   | Workflows|   | Agent Definitions|   | Slash Commands |         |
|   |  (.md)   |   |  (11 agents)    |   |  (34 total)    |         |
|   +----+-----+   +--------+--------+   +-------+--------+         |
|        |                   |                    |                   |
|        +-------------------+--------------------+                   |
|                            |                                        |
|   +------------------------v---------------------------+            |
|   |              Node.js CLI Tools Layer               |            |
|   |                                                    |            |
|   |  gsd-amauta.cjs   gsd-memory.cjs   gsd-rlm.cjs  |            |
|   |  (task mgmt)      (PG memory)      (context)     |            |
|   |                                                    |            |
|   |  gsd-research.cjs  gsd-tools.cjs                 |            |
|   |  (Perplexity)      (original GSD)                 |            |
|   +---------+----------------+---------------+---------+            |
|             |                |               |                      |
+-------------------------------------------------------------------+
              |                |               |
              v                v               v
   +------------------+ +------------+ +--------------+
   | Amauta Daemon    | | RLM Service| | Perplexity   |
   | :18799 (HTTP)    | | :18798     | | API (HTTPS)  |
   |                  | |            | +--------------+
   | +----------+     | | Chunking   |
   | |amauta.py |     | | TF-IDF     |
   | |(3920 ln) |     | | LRU Cache  |
   | +----------+     | +------------+
   | +----------+     |
   | |pg_store  |     |
   | |(.py)     |     |
   | +----+-----+     |
   +------+-----------+
          |
          v
   +------------------+
   | PostgreSQL 16    |
   | + pgvector       |
   | :5433 (Docker)   |
   |                  |
   | gsd_memory       |
   | gsd_shared_kb    |
   | gsd_task_valid.  |
   | gsd_agents       |
   +------------------+
```

## RPETD Pipeline Flow

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
  |    E    |     Execute phase: write code
  | Execute |     Gate 1: Branch evidence required
  +----+----+
       |
       v
  +----+----+     Run tests, capture output
  |    T    |     Test phase: evidence collection
  |  Test   |     Gate 3: Test evidence (13 regex patterns)
  +----+----+
       |
       v
  +----+----+     LEARNING: block required
  |    D    |     Document phase: capture lessons
  | Document|     Gate 2: Learning block required
  +----+----+     Gate 4: Auto-promote to SKB
       |
       v
  +----+----+
  |VALIDATE |---> External validator (no self-validation)
  |  GATES  |     Branch + Test + Learning gates
  +----+----+
       |
    PASS / FAIL
       |         |
       v         v
    [DONE]    [REJECTED --> fix --> re-validate]
```

## Research Chain Flow

```
  Query arrives
       |
       v
  +--------+    hit?    +-------+    hit?    +----------+
  | Memory |--yes------>| STOP  |            |          |
  |  (PG)  |            +-------+            |          |
  +---+----+                                 |          |
      | no                                   |          |
      v                                      |          |
  +--------+    hit?    +-------+            |          |
  |  SKB   |--yes------>| STOP  |            |          |
  |  (PG)  |            +-------+            |  source  |
  +---+----+                                 |  aware   |
      | no                                   | scoring  |
      v                                      |          |
  +--------+                                 | lesson   |
  |Context7|    (MCP tool - agent uses       | learned  |
  |  docs  |     directly if available)      |   +4     |
  +---+----+                                 |          |
      | no                                   | web srch |
      v                                      |   +3     |
  +----------+  hit?    +-------+            |          |
  |Perplexity|--yes---->| STOP  |            | auto     |
  |  (API)   |          +-------+            | learn +3 |
  +---+------+     |                         |          |
      | no         +-- auto-store to PG      | distill  |
      v                 (with dedup)         |   +2     |
  +--------+                                 |          |
  |WebFetch|    (requires --url)             | rpetd    |
  | (HTTP) |                                 |   +1     |
  +--------+                                 +----------+
```

## Agent Architecture

```
                          +-------------+
                          |  Operator   |
                          | (orchestrate|
                          |  dispatch)  |
                          +------+------+
                                 |
          +----------+-----------+-----------+----------+
          |          |           |           |          |
          v          v           v           v          v
   +----------+ +--------+ +----------+ +--------+ +--------+
   | Planner  | |Research| | Checker  | |Validatr| |Debugger|
   | (plan,   | |(4modes)| | (pre/    | |(extern)| |(root   |
   |  scope)  | |        | |  post)   | |        | | cause) |
   +----------+ +--------+ +----------+ +--------+ +--------+
                                 |
          +----------+-----------+-----------+
          |          |           |           |
          v          v           v           v
   +----------+ +----------+ +----------+ +----------+
   | Executor | | Executor | | Executor | | Executor |
   | Frontend | | Backend  | |  Infra   | | General  |
   | (React,  | | (API,    | | (Docker, | | (any     |
   |  CSS)    | |  DB)     | |  CI/CD)  | |  task)   |
   +----------+ +----------+ +----------+ +----------+

   File pattern routing:
     *.tsx, *.css  --> executor-frontend
     *.py, *.sql   --> executor-backend
     Dockerfile    --> executor-infra
     everything    --> executor-general
```

## Memory System Flow

```
  +---------------------------+
  | Agent writes code/learns  |
  +------------+--------------+
               |
               v
  +---------------------------+     +-------------------+
  | auto_learning (+3 boost)  |---->| gsd_memory (PG)   |
  | RPETD phase (+1 boost)    |     |                   |
  +---------------------------+     | text, source,     |
               |                    | agent_id, tags,   |
               |                    | project_id,       |
  +---------------------------+     | metadata, ts      |
  | Validation passes         |     +--------+----------+
  +------------+--------------+              |
               |                             |  count > threshold?
               v                             v
  +---------------------------+     +-------------------+
  | SKB promotion (+4 boost)  |     | Auto-distill      |
  | best-practice source      |     | Jaccard > 0.7     |
  +---------------------------+     | merge duplicates   |
               |                    +-------------------+
               v
  +---------------------------+     +-------------------+
  | gsd_shared_kb (PG)        |     | Cross-project     |
  | title, content, category  |     | search at new-    |
  | importance, tags          |     | project init      |
  +---------------------------+     | tag-filtered      |
                                    +-------------------+
```

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
```

## Graceful Degradation

```
  Feature              | With infra      | Without infra
  ---------------------|-----------------|-------------------
  Task management      | PG + daemon     | data/tasks.json
  Memory search        | PG full-text    | .planning/memory/*.md
  Memory store         | PG table        | .planning/memory/YYYY-MM-DD.md
  Learning capture     | PG auto_learn   | STATE.md ## Learnings
  RLM context          | HTTP service    | @ file references
  Research             | Perplexity API  | Memory + SKB only
  SKB                  | PG table        | (not available)
  Validation gates     | Daemon + PG     | (not available)
  Cross-project search | PG cross-query  | File keyword search
```

## Prerequisites

- **Node.js** 18+
- **Python** 3.9+ (with pip)
- **Docker** (for PostgreSQL)
- **Claude Code** CLI

## Installation

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
| `GSD_MEMORY_DISTILL_THRESHOLD` | `100` | Auto-distill trigger count |
| `GSD_RESEARCH_DEDUP_THRESHOLD` | `0.7` | Research dedup similarity |
| `RLM_MAX_CHUNK_CHARS` | `8000` | Max chunk size for RLM |

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
node gsd-memory.cjs search "connection pooling"     # Source-aware search
node gsd-memory.cjs store "lesson" --source lesson-learned
node gsd-memory.cjs learn "auto-learning entry"      # +3 boost
node gsd-memory.cjs cross-project "patterns" --tags postgresql,react
node gsd-memory.cjs infer-tags .                     # Detect project tech
node gsd-memory.cjs distill --dry-run                # Compact duplicates
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

### Memory Source Scoring

| Source | Boost | When |
|--------|-------|------|
| `lesson-learned` | +4 | Manual lessons |
| `best-practice` | +4 | SKB promotions |
| `auto_learning` | +3 | D-phase LEARNING extraction |
| `web_search_result` | +3 | Perplexity results |
| `session-learning` | +3 | Session observations |
| `distilled` | +2 | Merged/compacted entries |
| `rpetd_phase` | +1 | Per-phase auto-capture |
| `task_event` | +0 | Status changes |
| `agent` | +0 | General notes |

## Services

| Service | Port | Start | Stop |
|---------|------|-------|------|
| PostgreSQL | 5433 | `docker compose -f docker/docker-compose.yml up -d` | `docker compose ... down` |
| Amauta Daemon | 18799 | `python3 services/amauta-daemon.py start` | `... stop` |
| RLM Service | 18798 | `python3 services/rlm-service.py start` | `... stop` |

Health checks:
```bash
curl http://127.0.0.1:18799/health | python3 -m json.tool
curl http://127.0.0.1:18798/health | python3 -m json.tool
```

## 20 Agentic AI Design Patterns

All 20 patterns from the spec are mapped to specific agents. See `references/agentic-patterns.md` for the full matrix.

## Testing

```bash
npm test                                          # All tests

# Individual suites
node --test tests/gsd-amauta.test.cjs            # CLI tests (17)
node --test tests/e2e-lifecycle.test.cjs          # E2E lifecycle (22)
node --test tests/degradation.test.cjs            # Degradation (11)
```

**50 tests total**, covering CRUD, RPETD phases, validation, memory fallback, tag inference, and cross-project search.

## Project Structure

```
gsd-amauta/
  amauta.py                    # Task manager CLI (3920 lines)
  package.json                 # Project config
  README.md                    # This file
  CHANGELOG.md                 # All changes from vanilla GSD
  MIGRATION.md                 # Migration guide
  docker/
    docker-compose.yml         # PostgreSQL + pgvector
  migrations/
    001-init.sql               # Schema (4 tables, 15 indexes)
  services/
    amauta-daemon.py           # HTTP daemon (:18799)
    pg_store.py                # PG connection pool + queries
    rlm-service.py             # RLM context engine (:18798)
  agents/                      # 11 agent definitions (.md)
  get-shit-done/
    bin/
      gsd-amauta.cjs           # Task management CLI
      gsd-memory.cjs           # Memory + SKB CLI
      gsd-rlm.cjs              # RLM context CLI
      gsd-research.cjs         # Research chain CLI
      gsd-tools.cjs            # Original GSD CLI
    workflows/                 # 33+ workflow definitions
    templates/                 # Config templates
    references/                # 13 reference files
  references/
    agentic-patterns.md        # 20 patterns mapped
  commands/gsd/                # 34 slash commands
  tests/                       # 50 tests (3 suites)
  bin/
    install.js                 # Self-installer
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Daemon won't start | `lsof -ti :18799 \| xargs kill -9` then restart |
| PG connection fails | `docker ps --filter name=gsd-postgres`, restart if down |
| Memory empty | Check `gsd-memory.cjs health`, verify `pg_available: true` |
| Validation blocked | Tag task `no-gitflow`, use `--force` |
| RLM returns nothing | Check `gsd-rlm.cjs health`, verify files exist in query path |

## License

Based on [GSD (Get Shit Done)](https://github.com/get-shit-done/get-shit-done) with Amauta task management system integration.

# GSD-Amauta

**Quality-enforced AI development for Claude Code.**

GSD-Amauta extends the [GSD](https://github.com/get-shit-done/get-shit-done) (Get Shit Done) framework with persistent PostgreSQL memory, pgvector semantic search, a BM25 code context engine, 11 specialist agents, a 5-phase RPETD pipeline with external validation gates, and a 5-step research chain. Everything degrades gracefully to vanilla GSD when infrastructure is unavailable.

```
v2.4.0 -- 2000+ tests (408 Python + 1618 CJS) -- 11 agents -- 5 CLI tools -- 3 services -- 9 specs -- 20 AI patterns
```

---

## What Amauta Adds Over GSD

| Capability | Vanilla GSD | GSD-Amauta |
|-----------|-------------|------------|
| Task state | Markdown files, no locking | PostgreSQL + JSON with TOCTOU-safe concurrent access |
| Memory | `STATE.md`, grows forever | PG memory + pgvector semantic search + distillation + tiered retention |
| Code context | Full file injection into prompts | BM25-scored RLM chunk retrieval (10-50x context reduction) |
| Quality gate | Honor system | 5-phase RPETD pipeline with structured evidence |
| Validation | Self-marking (agents mark own work done) | External validation -- no agent validates its own work |
| Research | WebFetch only | 5-step chain: Memory -> SKB -> Context7 -> Perplexity -> WebFetch |
| Learning | Manual notes | Auto-capture from every task, cross-project transfer, SKB promotion |
| Agents | Generic prompts | 11 specialists with file-pattern routing + performance tiebreaker |
| Memory writes | Blind append, duplicates accumulate | Idempotent writes with Jaccard dedup + embedding similarity check |
| Memory lifecycle | No cleanup | Distillation, recency decay, tiered retention, source filtering |
| Token efficiency | No optimization | Enrichment dedup window, Perplexity cap, RPETD soft cap |
| Project isolation | None | `__test__` routing, `project_id` scoping on all queries |

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
        TOOLS["gsd-tools.cjs<br/>GSD Core"]
    end

    subgraph Services["Background Services"]
        DAEMON["Amauta Daemon<br/>:18799 HTTP"]
        RLM_SVC["RLM Service<br/>:18798 HTTP"]
    end

    subgraph Storage["PostgreSQL 16 + pgvector"]
        GM["gsd_memory<br/>text + vector(1024)"]
        GS["gsd_shared_kb<br/>validated knowledge"]
        GT["gsd_tasks<br/>task state + RPETD log"]
        GV["gsd_task_validations<br/>audit trail"]
        GA["gsd_audit_log<br/>immutable events"]
        GP["gsd_agent_performance<br/>routing metrics"]
    end

    subgraph APIs["External APIs"]
        VOY["Voyage AI<br/>Embeddings"]
        PPX["Perplexity<br/>Research"]
        C7["Context7 MCP<br/>Docs"]
    end

    AMAUTA --> DAEMON
    MEM --> DAEMON
    RLM_CLI --> RLM_SVC
    RES --> PPX
    RES --> C7
    DAEMON --> Storage
    DAEMON --> VOY
    RLM_SVC -.->|"BM25 scoring<br/>LRU cache"| RLM_SVC
```

---

## RPETD Pipeline

Every task is forced through five phases. Validation gates block progress at each stage.

```mermaid
flowchart LR
    CLAIM["Task Claimed"] --> R

    subgraph R["R -- Research"]
        R1["Query PG memory (semantic)"]
        R2["Query Shared KB"]
        R3["Auto-invoke research chain<br/>if less than 2 local results"]
    end

    R --> P

    subgraph P["P -- Plan"]
        P1["Given / When / Then criteria"]
        P2["Step-by-step approach"]
        P3["Success criteria + deliverables"]
    end

    P --> E

    subgraph E["E -- Execute"]
        E1["Feature branch created"]
        E2["Code committed"]
        E3["GATE 1: branch evidence"]
    end

    E --> T

    subgraph T["T -- Test"]
        T1["Run test suite"]
        T2["Capture raw output"]
        T3["GATE 2: test evidence"]
    end

    T --> D

    subgraph D["D -- Document"]
        D1["LEARNING block written"]
        D2["Auto-store to PG memory"]
        D3["GATE 3: LEARNING keyword"]
    end

    D --> V["External Validation<br/>GATE 4: PR URL<br/>GATE 5: success criteria"]

    V -->|PASS| DONE["Done + SKB promotion"]
    V -->|FAIL| FIX["Sub-tasks created<br/>Re-route to executor"]
    FIX --> CLAIM

    style R fill:#e8f4fd,stroke:#1a73e8
    style P fill:#fef7e0,stroke:#f9ab00
    style E fill:#e6f4ea,stroke:#34a853
    style T fill:#fce8e6,stroke:#ea4335
    style D fill:#f3e8fd,stroke:#9334e6
```

Each phase is enriched with RLM code context (BM25-scored chunks), semantic memory recall (pgvector), and past failure/test strategy injection at E/T phases.

---

## Agent Architecture

11 specialists, each with a defined role, tool set, and file-pattern routing:

```mermaid
graph TB
    OP["gsd-operator<br/>Master Orchestrator<br/>P1 P2 P6 P8 P9 P14-P19"]

    OP --> PL["gsd-planner<br/>Given/When/Then specs<br/>P6 P14"]
    OP --> RS["gsd-researcher<br/>Memory + SKB + Perplexity<br/>P5 P10"]
    OP --> CK["gsd-checker<br/>Pre/post quality<br/>P4 P17"]
    OP --> VA["gsd-validator<br/>External validation<br/>P4 P13 P17"]
    OP --> DB["gsd-debugger<br/>Root cause + bisect<br/>P5 P7 P20"]
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

Executors have full tool access (Read, Write, Edit, Bash, Grep, Glob). Read-only agents (researcher, checker, validator) cannot modify files.

Performance-based routing uses a tiebreaker: when multiple agents match a task's file patterns, the agent with the best historical success rate for that domain is selected.

---

## Memory System

PostgreSQL-backed persistent memory with pgvector semantic search, source-aware scoring, and automatic lifecycle management:

```mermaid
graph TB
    subgraph Write["Write Path"]
        DPH["D-phase LEARNING block<br/>source=auto_learning +3"]
        PPX["Perplexity result<br/>source=web_search_result +3"]
        AGT["Agent gsd-memory store<br/>source=agent +0"]
        LRN["gsd-memory learn<br/>source=auto_learning +3"]
    end

    DPH & PPX & AGT & LRN --> DEDUP{"Jaccard dedup > 0.7?<br/>Embedding similarity check"}

    DEDUP -->|unique| PG["gsd_memory (PG)<br/>text + vector(1024)<br/>HNSW cosine index"]
    DEDUP -->|duplicate| SKIP["Skip storage"]

    PG --> EMBED["Auto-embed via Voyage AI<br/>voyage-code-3 (1024d)"]

    PG -->|"validation passes"| SKB["gsd_shared_kb<br/>source=best-practice +4<br/>Cross-project knowledge"]

    subgraph Lifecycle["Memory Lifecycle"]
        DIST["Distillation<br/>Merge similar entries"]
        RET["Tiered Retention<br/>High-value kept longer"]
        DEC["Recency Decay<br/>Old entries scored lower"]
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

### Source Scoring

| Source | Score Boost | Origin |
|--------|:-----------:|--------|
| `lesson-learned` | +4 | Developer explicit input |
| `best-practice` | +4 | SKB promotion after validation |
| `auto_learning` | +3 | D-phase LEARNING block |
| `web_search_result` | +3 | Perplexity API response |
| `session-learning` | +3 | Session observation |
| `distilled` | +2 | Merged/compacted entries |
| `rpetd_phase` | +1 | Per-phase auto-capture |
| `task_event` | +0 | Status transitions |
| `agent` | +0 | General agent notes |

Search score formula: `similarity(0-1) x 10 + source_bonus(0-4)`, sorted descending.

---

## RLM Context Engine

Based on MIT CSAIL (arXiv:2512.24601v1). Agents retrieve relevant code chunks instead of having entire files injected into prompts. No API keys required -- pure local retrieval.

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

### RPETD Enrichment Layers

| Layer | When | What |
|-------|------|------|
| Layer 1 | `claim` time | 2 RLM queries injected into task context |
| Layer 2 | Each RPETD phase | Phase-specific RLM query via HTTP |
| E/T enrichment | Execute + Test | Past failure patterns + test strategies from memory |

Enrichment deduplication ensures the same chunk is never injected twice within a window.

---

## Research Chain

5-step cascade with deduplication and auto-storage. Each step only fires if previous steps returned insufficient results.

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
                    P-->>A: Return
                    Note over A,M: Jaccard dedup > 0.7 check<br/>Store as web_search_result +3<br/>Auto-embed
                else miss / no key
                    A->>W: 5. Direct URL fetch (fallback)
                    W-->>A: Return raw content
                end
            end
        end
    end
```

Auto-invoked in the R-phase when fewer than 2 local results are found.

---

## Task Manager

State machine with hierarchy, priority scoring, and archival:

```mermaid
stateDiagram-v2
    [*] --> pending: add task

    pending --> in_progress: claim (agent assigned)

    state in_progress {
        [*] --> R_phase
        R_phase --> P_phase
        P_phase --> E_phase
        E_phase --> T_phase
        T_phase --> D_phase
        D_phase --> [*]
    }

    in_progress --> validation: status validation
    validation --> done: validate --pass
    validation --> pending: validate --fail (sub-tasks created)
    in_progress --> failed: unrecoverable
    in_progress --> deferred: blocked / deprioritized

    done --> archived: archive (30d+)

    note right of validation
        External validator only.
        claimed_by != validated_by
    end note
```

**Task hierarchy:** Epic (EP-XXXX) -> Story (ST-XXXX) -> Task (TK-XXXX) / Bug (BG-XXXX)

**Priority scoring:** `score = importance x 0.4 + urgency x 0.3 + dep_pressure x 0.3`

**Routing:** `amauta next <agent-name>` returns the highest-priority pending task for that agent.

**Concurrency:** TOCTOU-safe file access with retry flush, stale watchdog, and reconciliation between PG and JSON.

---

## Validation Gates

5 gates checked by an external validator. No agent validates its own work.

```mermaid
flowchart TB
    EX["Executor completes RPETD"] --> V["gsd-validator<br/>(different agent than executor)"]

    V --> G1{"Gate 1<br/>Branch evidence<br/>in E-log?"}
    V --> G2{"Gate 2<br/>Test output<br/>in T-log?"}
    V --> G3{"Gate 3<br/>LEARNING block<br/>in D-log?"}
    V --> G4{"Gate 4<br/>PR URL<br/>in notes?"}
    V --> G5{"Gate 5<br/>Success criteria<br/>from P-phase met?"}

    G1 & G2 & G3 & G4 & G5 -->|all pass| PASS["validate --pass<br/>status = done<br/>learning -> SKB"]
    G1 & G2 & G3 & G4 & G5 -->|any fail| FAIL["validate --fail --notes reason<br/>rejection recorded<br/>sub-tasks created"]

    FORCE["--force-reason 'justification'<br/>Bypasses gates with audit trail<br/>forced:true recorded"] -.-> PASS

    style V fill:#ea4335,color:#fff
    style FORCE fill:#fef7e0,stroke:#f9ab00
```

Self-validation blocked: `claimed_by` must differ from `validated_by`. All decisions recorded in `gsd_task_validations` with immutable audit trail.

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
    end

    subgraph Fallback["Without Infrastructure"]
        JSON["data/tasks.json"]
        ILIKE["text ILIKE search"]
        AT["@ file references"]
        LOCAL["memory + SKB only"]
        TEXT["text search only"]
        HONOR["not enforced"]
    end

    PG -->|"no PG_URL"| JSON
    VEC -->|"no embeddings"| ILIKE
    RLMS -->|"service down"| AT
    PPX -->|"no API key"| LOCAL
    VOY -->|"no API key"| TEXT
    RPETD -->|"no daemon"| HONOR

    style Full fill:#e6f4ea,stroke:#34a853
    style Fallback fill:#fce8e6,stroke:#ea4335
```

**Activation variables:**

| Variable | Enables |
|----------|---------|
| `GSD_POSTGRES_URL` | PG memory, tasks, SKB, validation, audit |
| `VOYAGE_API_KEY` | Semantic search via Voyage AI voyage-code-3 |
| `OPENAI_API_KEY` | Semantic search via OpenAI text-embedding-3-small (alternative) |
| `PERPLEXITY_API_KEY` | Perplexity research chain step |

---

## Installation

### Option 1: One-Line Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Luiscmogrovejo/gsd-amauta/master/scripts/install-remote.sh | bash
```

This downloads and installs everything — no `git clone` needed. Your team just runs this one command.

### Option 2: Clone + Install

```bash
git clone https://github.com/Luiscmogrovejo/gsd-amauta.git ~/.claude/gsd-amauta
cd ~/.claude/gsd-amauta
npm install
```

### What the Installer Does

1. Installs 11 agents, 34 slash commands, 11 skills, 3 hooks to `~/.claude/`
2. Detects infrastructure: local PostgreSQL → Docker PG → SQLite fallback
3. Starts Amauta daemon (`:18799`) + RLM service (`:18798`)
4. Runs database migrations (7 SQL files)
5. Registers MCP server in Claude Code settings
6. Copies Python backend (amauta.py, daemon, pg_store, rlm-service)

### Prerequisites

- **Node.js** 18+ and **Python** 3.9+
- **Claude Code** CLI
- **Docker** (optional — for PostgreSQL; SQLite fallback works without it)

### Post-Install (Optional API Keys)

```bash
# Add to ~/.zshrc or ~/.bashrc

# Optional: Perplexity for research chain
export PERPLEXITY_API_KEY="your-key-here"

# Optional: Voyage AI for semantic search embeddings
export VOYAGE_API_KEY="your-key-here"
```

Without API keys, Amauta still works — semantic search falls back to text matching, research uses local memory only.

### Verify

```bash
curl -s http://127.0.0.1:18799/health | python3 -m json.tool  # Daemon
curl -s http://127.0.0.1:18798/health | python3 -m json.tool  # RLM
python3 -m pytest tests/ -q                                     # Tests
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GSD_POSTGRES_URL` | `postgresql://amauta:gsd@127.0.0.1:5433/gsd_amauta` | PostgreSQL connection |
| `GSD_AMAUTA_HOST` | `127.0.0.1` | Daemon bind host |
| `GSD_AMAUTA_PORT` | `18799` | Daemon port |
| `GSD_RLM_PORT` | `18798` | RLM service port |
| `AMAUTA_DATA_DIR` | `<project>/data` | Task board JSON location |
| `PERPLEXITY_API_KEY` | _(none)_ | Perplexity API key |
| `PERPLEXITY_MODEL` | `sonar` | Perplexity model |
| `VOYAGE_API_KEY` | _(none)_ | Voyage AI embedding key |
| `OPENAI_API_KEY` | _(none)_ | OpenAI embedding key (alternative) |
| `GSD_EMBEDDING_PROVIDER` | _(auto)_ | Force `voyage` or `openai` |
| `GSD_MEMORY_DISTILL_THRESHOLD` | `100` | Auto-distill trigger count |
| `GSD_RESEARCH_DEDUP_THRESHOLD` | `0.7` | Jaccard dedup threshold |
| `RLM_MAX_CHUNK_CHARS` | `8000` | Max RLM chunk size |
| `RLM_DEFAULT_TOP_K` | `10` | Default results per RLM query |
| `RLM_CACHE_SIZE` | `200` | LRU cache capacity (files) |

---

## CLI Reference

### amauta (gsd-amauta.cjs) -- Task Management

```bash
amauta board                                     # Kanban board view
amauta stats                                     # Project statistics
amauta show TK-0001                              # Full task detail
amauta next executor-backend                     # Next task for agent
amauta add epic "Project Name" --agent operator  # Create epic
amauta add task "Implement auth" --parent ST-001 # Create task
amauta claim TK-0001 --agent executor-backend    # Claim task
amauta rpetd TK-0001 --phase R --content "..."   # Log RPETD phase
amauta status TK-0001 validation                 # Move to validation
amauta validate TK-0001 --pass                   # External validation
amauta validate TK-0001 --fail --notes "reason"  # Rejection
```

### gsd-memory.cjs -- Memory + Embeddings

```bash
gsd-memory.cjs store "lesson" --source lesson-learned  # Store entry
gsd-memory.cjs learn "insight"                          # Auto-learning +3
gsd-memory.cjs search "connection pooling"              # Text search
gsd-memory.cjs semantic-search "auth patterns"          # pgvector cosine
gsd-memory.cjs cross-project "patterns" --tags react    # Cross-project
gsd-memory.cjs distill                                  # Compact similar
gsd-memory.cjs backfill-embeddings                      # Embed existing
gsd-memory.cjs health                                   # Service health
```

### gsd-rlm.cjs -- Code Context

```bash
gsd-rlm.cjs query "how auth works" --path src/  # BM25-scored chunks
gsd-rlm.cjs chunk src/auth.ts                    # Inspect chunking
gsd-rlm.cjs health                               # Service status
```

### gsd-research.cjs -- Research Chain

```bash
gsd-research.cjs search "React patterns"         # Full 5-step chain
gsd-research.cjs perplexity "Next.js 15"         # Perplexity direct
gsd-research.cjs fetch --url https://...         # WebFetch direct
gsd-research.cjs check-providers                 # Provider status
```

---

## Project Structure

```
gsd-amauta/
├── package.json
├── amauta.py                    # Task manager core (4158 lines)
├── docker/docker-compose.yml    # PostgreSQL 16 + pgvector :5433
├── migrations/                  # 5 SQL migrations
├── services/
│   ├── amauta-daemon.py         # HTTP daemon :18799
│   ├── pg_store.py              # PG pool + memory/SKB/tasks/embeddings
│   └── rlm-service.py           # BM25 code context :18798
├── agents/                      # 11 agent definitions (.md)
├── skills/                      # 11 skill workflows (SKILL.md each)
├── get-shit-done/
│   ├── bin/                     # 5 CLI tools (.cjs)
│   ├── workflows/               # 36 workflow files
│   └── references/              # Model profiles
├── commands/gsd/                # 34 slash commands
├── specs/                       # 9 formal specifications
├── tests/                       # 67 test files (39 CJS + 28 Python)
├── bin/install.js               # Self-installer (2897 lines)
└── references/agentic-patterns.md  # 20 patterns x 11 agents matrix
```

---

## Testing

```bash
npm test                          # All CJS tests (1618 tests, 39 files)
python3 -m pytest tests/ -q       # All Python tests (408 tests, 28 files)
npm run test:coverage             # Coverage report (target: 70%+ lines)
```

**2000+ tests** across 67 files covering: RPETD pipeline, validation gates, memory (PG + semantic + distill + retention), RLM (BM25 scoring, HTTP wiring, incremental indexing), research chain, task lifecycle (archive, TOCTOU, reconcile), agent architecture, security (path traversal, body limits, DSN sanitization), graceful degradation, and end-to-end integration.

---

## Contributing

1. Fork and create a feature branch
2. Run `npm test` and `python3 -m pytest tests/ -q` -- all must pass
3. Follow RPETD: Research existing patterns, Plan changes, Execute on a branch, Test with evidence, Document with a LEARNING block
4. Submit PR -- external validation required before merge

---

## License

MIT. Based on [GSD (Get Shit Done)](https://github.com/get-shit-done/get-shit-done) by TACHES.
Amauta task management by [robertamauta](https://github.com/robertamauta/amauta).

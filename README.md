# GSD-Amauta

**Quality-enforced AI development for Claude Code.**

GSD-Amauta extends the [GSD](https://github.com/get-shit-done/get-shit-done) framework with persistent PostgreSQL memory, pgvector semantic search, a BM25 code context engine, 11 specialist agents, a 5-phase RPETD pipeline with external validation gates, a 5-step research chain, and a Redis L2 caching layer. Everything degrades gracefully to vanilla GSD when infrastructure is unavailable.

```
v2.5.0 "Smarter Brain" -- ~2479 tests (31 Python + 61 CJS files) -- 11 agents -- 5 CLI tools -- 4 services -- 9 specs -- 20 AI patterns
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
| Token efficiency | No optimization | Enrichment dedup window, Perplexity cap, RPETD soft cap, phase-specific reduction |
| Caching | None | Redis L2 embedding cache, Perplexity response cache, RLM hit/miss stats |
| Error recovery | None | Error classification (4 types), recovery routing table, auto-escalation |
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
        REDIS["Redis 7<br/>L2 Cache"]
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
    DAEMON --> REDIS
    RLM_SVC -.->|"BM25 scoring<br/>LRU cache"| RLM_SVC
    REDIS -.->|"L2 embedding cache<br/>3600s TTL"| DAEMON
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

### Enrichment per Phase (v2.5 Phase-Specific Reduction)

| Phase | RLM Layer | Memory Enrichment | Soft Cap | v2.5 Change |
|-------|-----------|-------------------|----------|-------------|
| Claim | Layer 1: 2 code-context queries injected into task | -- | -- | -- |
| R | Layer 2: phase-specific RLM query via HTTP | Semantic search (pgvector) + Shared KB | ~500 chars | -- |
| P | Layer 2 | -- | ~300 chars | -- |
| E | RLM-only (Layer 2) | Past failure patterns from memory | ~500 chars | Memory enrichment removed |
| T | None | -- | ~300 chars | All enrichment removed |
| D | Writes-only | -- | ~400 chars | Read enrichment removed |

Phase-specific reduction saves ~1950 chars per full RPETD lifecycle (39.4% Layer 2 reduction, 24% total lifecycle reduction).

Enrichment deduplication ensures the same chunk is never injected twice within a 300-second window (`ENRICHMENT_DEDUP_WINDOW`).

---

## Agent Architecture

11 specialists, each with a defined role, tool set, and file-pattern routing:

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

| Agent | Role | Tool Access | Key Patterns |
|-------|------|-------------|-------------|
| operator | Orchestration, routing, planning | Read-only | P1, P2, P3, P6, P8, P9, P14-P19 |
| planner | Given/When/Then specs | Read-only | P1, P6, P13, P14 |
| researcher | Memory + SKB + Perplexity | Read-only | P4, P7, P13, P20 |
| checker | Pre/post quality checks | Read-only | P5, P10, P16 |
| validator | External validation | Read-only | P5, P10, P16, P17 |
| debugger | Root cause, bisect, scientific method | Full (Read/Write/Edit/Bash) | P4, P5, P7, P11, P13, P15 |
| roadmapper | ROADMAP.md, milestones | Full | -- |
| executor-frontend | `.tsx`, `.jsx`, `.css`, `.vue` | Full | P4, P7, P11, P12 |
| executor-backend | `.py`, `.sql`, `.go`, `.rs` | Full | P4, P7, P11, P12 |
| executor-infra | `Dockerfile`, `*.yml`, `k8s/` | Full | P4, P7, P11, P12 |
| executor-general | Everything else, fallback | Full | P4, P7, P11, P12 |

### Performance Routing

When multiple agents match a task's file patterns, the agent with the best historical pass rate is selected as a tiebreaker. Agents with pass rate below 70% on 5+ completed tasks trigger automatic fallback to `executor-general`.

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

### Distillation System

The `gsd-memory distill` command compacts similar memory entries to reduce noise:

1. Load all entries where `source != 'distilled'` (exclude previously distilled entries from input)
2. Group entries by Jaccard word-similarity > 0.7
3. Merge each group: concatenate text, keep the best source score, preserve tags
4. Store merged entries with `source='distilled'` (+2 boost)
5. Remove original entries that were merged

Auto-distill triggers when entry count exceeds the configurable threshold (default: 500, env `GSD_MEMORY_DISTILL_THRESHOLD`). Use `--dry-run` to preview without changes.

### Pre-Store Embedding Dedup

Before every INSERT into `gsd_memory`, a cosine similarity check runs against existing embeddings. If any existing entry scores above 0.95, the new entry is skipped and a `dedup_skipped` response is returned. Configurable via `GSD_DEDUP_THRESHOLD`.

### Source Filtering

By default, searches exclude low-signal sources (`task_event`, `rpetd_phase`) via `DEFAULT_EXCLUDE_SOURCES`. Use `--include-noise` to override and see all entries.

### Recency Decay

Older memories are scored lower: -0.5 per 30 days since last update, capped at -3.0. This ensures recent learnings surface above stale entries. Configurable via `GSD_RECENCY_DECAY_PER_30D`.

### Tiered Retention

| Source Category | Archive After | Rationale |
|----------------|:------------:|-----------|
| `task_event` | 30 days | High volume, low reuse value |
| `rpetd_phase` | 90 days | Useful for recent project context |
| `web_search_result` | 180 days | Moderate reuse, may become stale |
| `lesson-learned`, `best-practice` | Never | High-value validated knowledge |
| All others | Default lifecycle | Standard retention |

Archived entries move to `gsd_memory_archive` and no longer appear in search results.

### Structured Learnings (Phase 10 -- v2.6)

Phase 10 ships the WHAT/WHY/WHEN/TAGS structured learning format as a human-review and SKB-promotion layer. It is NOT a retrieval optimizer -- free-text + embeddings still win recall. The format exists so reviewers can decide in under 10 seconds whether a learning deserves promotion.

**Learning Format.** Every D-phase LEARNING block follows:

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

**Tag Governance.** Tag rules live in `get-shit-done/config/tag-rules.json`. Read by BOTH `gsd-memory.cjs` (Node) and `pg_store.py` (Python) at runtime.

- **Banned tags** (auto-stripped): `best-practice`, `general`, `lesson`, `insight`. A learning with only banned tags is rejected with a guidance message.
- **Synonyms** are normalized: `db` -> `database`, `k8s` -> `kubernetes`, `pg` -> `postgresql`, `ts` -> `typescript`, `py` -> `python`, etc.
- **Tag cap:** Maximum 5 tags per learning. Over-limit tags are auto-trimmed by tier ranking: `domain > technique > scope > meta`. Never rejected for count.
- **Vocabulary** covers 12 seed domains: database, api, testing, infrastructure, security, frontend, backend, performance, authentication, caching, deployment, monitoring.

**CLI Commands:**

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

# Increment applied_count when a learning is cited (dedup by (mem_id, task_id))
gsd-memory increment-applied mem-abc123def456 --task TK-0001 --phase E --reason "applied in audit worker"

# View SKB promotion candidates (rising tier 5-10, needs_review >10)
gsd-memory skb candidates

# Promote a reviewed candidate to SKB
gsd-memory skb-promote mem-abc123def456 --reviewed --reason "cited 12 times, validated pattern"

# Demote (revert promotion)
gsd-memory skb-remove skb-xyz789
```

**APPLIED_LEARNING Citations.** When any agent applies a prior learning during RPETD, it cites it in any phase (R, P, E, T, or D):

```
APPLIED_LEARNING: mem-abc123def456 -- used connection pooling pattern in audit worker
```

The operator (`agents/gsd-operator.md`) scans ALL phases after task close and calls `increment-applied` for each citation. Dedup by `(mem_id, task_id)` ensures a learning cited in multiple phases of the same task increments the count ONCE.

**Echo-Chamber Defense.** Learnings with `applied_count > 10` require manual review before SKB promotion. Candidates surface via `gsd-memory skb candidates` with a `needs_review: true` flag. Rising candidates (5-10 citations) appear in a separate tier. Promotion is explicit: `gsd-memory skb-promote mem-<id> --reviewed --reason "<why>"`.

**Kill Switch.** Set `GSD_D_STRUCTURED=false` in the environment to disable structured learning entirely. The CLI and daemon fall back to free-text storage and log `Structured learning disabled (GSD_D_STRUCTURED=false), storing as free-text`. No silent degradation.

**Shared CLI Variables (LEARN-07).** The previously duplicated `CLI=/RLM=/MEM=/RESEARCH=` variable declarations across 11 agents + 6 workflow files now live in a single reference file: `get-shit-done/references/cli-variables.md`. Agents Read this file at runtime (NOT `@` include -- that syntax doesn't work in agent .md files) and paste the shell block. Each agent file has a one-line fallback comment per variable for graceful degradation.

**Backward Compatibility.** Legacy `gsd-memory learn "free text"` (without `--structured`) continues to work unchanged. Pre-Phase 10 learnings remain searchable -- search output falls back to the one-line format when `metadata.what` is absent. The validator's Gate 2 check accepts BOTH formats: `LEARNING:` one-liner OR the structured block.

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

### BM25 Scoring

The RLM service uses BM25 (Best Matching 25) instead of raw TF-IDF for more accurate code retrieval:

| Parameter | Value | Purpose |
|-----------|:-----:|---------|
| k1 | 1.5 | Term frequency saturation |
| b | 0.6 | Document length normalization weight (tuned from 0.75 for code chunk variance) |
| Label boost | 1.5x | Function/class name matches ranked higher (capped at 3.0*idf) |
| Position penalty | -5% | Per-position decay for later chunks (configurable via `RLM_POSITION_DECAY`) |
| Default chunk size | 4000 chars | Max chars per chunk (was 8000, configurable via `RLM_MAX_CHUNK_CHARS`) |
| TF tokenization | word-boundary | Accurate term frequency (replaces substring `.count()`) |

### camelCase / snake_case Splitting

Identifiers are split before tokenization for better matching:
- `getUserProfile` becomes `get`, `user`, `profile`
- `parse_json_response` becomes `parse`, `json`, `response`

This allows a query for "user profile" to match a function named `getUserProfile`.

### RPETD Enrichment Layers

| Layer | When | What |
|-------|------|------|
| Layer 1 | `claim` time | 2 RLM queries injected into task context |
| Layer 2 | R, P, E phases | Phase-specific RLM query via HTTP (T/D phases skip Layer 2 in v2.5) |
| E enrichment | Execute only | Past failure patterns from memory (RLM-only) |
| Cache | All layers | Redis L2 embedding cache (3600s TTL) wraps in-memory L1 dict |

Enrichment deduplication ensures the same chunk is never injected twice within a 300-second window. RLM cache hit/miss counters available at `/cache/stats`.

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

### Perplexity Output Cap

Perplexity responses are capped at 1500 characters after preamble stripping (`stripPreamble` removes boilerplate like "Based on the search results...", "Of course", "I'd be happy", "As an AI"). Preamble stripping loops until stable to handle compound preambles. Citation markers (`[1]`, `[2]`, etc.) are stripped from responses. This prevents large API responses from consuming excessive context tokens (75.6% per-call reduction from v2.4).

Responses are cached in temp-files with 6h TTL (`--no-cache` to bypass). `PERPLEXITY_MODEL=auto` routes queries to sonar or sonar-pro based on complexity via `selectPerplexityModel()`. Max tokens reduced from 4096 to 1000. 429 errors use exponential backoff (1s, 2s, 4s, max 3 retries).

Auto-invoked in the R-phase when fewer than 2 local results are found (`GSD_RESEARCH_MIN_RESULTS`).

---

## Task Manager

State machine with hierarchy, priority scoring, archival, and concurrency safety:

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

    done --> archived: archive (done > N days)

    note right of validation
        External validator only.
        claimed_by != validated_by
    end note
```

**Task hierarchy:** Epic (EP-XXXX) -> Story (ST-XXXX) -> Task (TK-XXXX) / Bug (BG-XXXX)

**Priority scoring:** `score = importance x 0.4 + urgency x 0.3 + dep_pressure x 0.3`

**Routing:** `amauta next <agent-name>` returns the highest-priority pending task for that agent.

### Archive

The `archive` command moves completed tasks out of the active board:

- **Default threshold:** done tasks older than 7 days
- **Custom threshold:** `--days N` (use `--days 0` for all done tasks)
- **Preview mode:** `--dry-run` shows what would be archived without modifying files
- **Idempotent:** running twice moves nothing on the second run
- **Parent cleanup:** archived IDs are removed from remaining parents' `children` arrays (FIX-09)
- **Storage:** archived tasks move to `data/tasks-archive.json`

### Reconcile

The `reconcile` command detects drift between JSON file state and PostgreSQL:

- Reports tasks present in JSON but missing from PG (and vice versa)
- Cross-references `tasks-archive.json` to avoid false "extra in PG" reports (FIX-05)
- `--fix` flag auto-syncs: inserts missing tasks into PG, removes orphaned PG entries
- Validates field-level consistency across all 39 synced fields (migration 007)

### Concurrency Safety

| Feature | Mechanism |
|---------|-----------|
| File locking | TOCTOU-safe reentrant lock with `fcntl.flock` |
| Retry flush | Failed writes queued and retried every 60 seconds |
| Stale watchdog | Tasks `in_progress` for > 48 hours auto-revert to `pending` |
| Test-exempt | `--test-exempt` flag prevents watchdog from reverting long-running tasks |
| Dual-write | Every mutation writes to both JSON and PG; `[PG_SYNC_WARN]` on PG failure |

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

### Validation Hardening

| Feature | Description |
|---------|-------------|
| `--force-reason` | Replaces the old `--force` flag. Requires a written justification string, persisted to task notes + validation metadata with `forced:true`. |
| `--test-exempt` | Marks tasks that legitimately lack test evidence (documentation, config). Exempt tasks skip Gate 2. |
| Self-validation block | `claimed_by` must differ from `validated_by`. An agent cannot validate work it executed. |
| Mandatory `--notes` | Failed and deferred validations require `--notes` explaining the reason. |
| R/P substance gates | R and P phase content must be >= 50 chars. T phase threshold raised to >= 50 chars. |
| Phase-order warning | Soft warning when phases are logged out of R -> P -> E -> T -> D order. |
| Error classification | Failures classified as TRANSIENT, GATE_FAIL, CAPABILITY_MISMATCH, or SYSTEMIC. |
| Recovery routing | Automatic re-routing table + auto-escalation at 3 consecutive failures. |
| Mandatory external validation | Enforced in execute-phase workflow -- no self-validation path. |
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
    SKBDEDUP -->|duplicate| SKBSKIP["Skipped (FIX-10)"]

    PPX["Perplexity result"] --> PPXSTORE["Auto-store<br/>source=web_search_result +3"]
    PPXSTORE --> DEDUP

    SKBSTORE --> FUTURE["Future R-phases<br/>retrieve as context"]
    MEM --> FUTURE

    style EXEC fill:#e6f4ea,stroke:#34a853
    style SKB fill:#f3e8fd,stroke:#9334e6
    style MEM fill:#e8f4fd,stroke:#1a73e8
```

Three learning paths:
1. **RPETD D-phase:** LEARNING blocks extracted, stored as `auto_learning` (+3), promoted to SKB on validation pass
2. **Perplexity results:** Stored as `web_search_result` (+3), preamble stripped, auto-embedded
3. **Explicit learning:** `gsd-memory learn "insight"` stores as `auto_learning` (+3)

All paths include full content storage (no truncation, fixed in v2.2) and Jaccard dedup to prevent duplicate entries.

---

## Token Efficiency

Six mechanisms prevent excessive context consumption:

| Mechanism | Implementation | Impact |
|-----------|---------------|--------|
| Enrichment dedup window | 300-second window (`ENRICHMENT_DEDUP_WINDOW`). If Layer 1 RLM ran at claim, Layer 2 R-phase skips if within window. | Prevents duplicate chunk injection |
| Phase-specific reduction | T=no enrichment, D=writes-only, E=RLM-only. Configurable per phase. | ~1950 chars/lifecycle saved (39.4% Layer 2 reduction) |
| Perplexity output cap | 1500-character limit (`PERPLEXITY_OUTPUT_CAP`). Preamble stripped, citations stripped before capping. | 75.6% per-call reduction |
| Perplexity response cache | 6h TTL temp-file cache. `--no-cache` bypass. `max_tokens` capped at 1000. | Eliminates redundant API calls |
| Redis L2 embedding cache | `gsd:emb:` prefix, 3600s TTL. SHA-256 query keys, 500 max L1 dict. | Reduces Voyage AI calls |
| RPETD soft cap | 2000-character overall cap with phase-specific guidance. Warns agents (does not block). | Guides agents toward concise phase content |

### RPETD Phase Guidance

| Phase | Target (chars) | Content guidance |
|-------|:--------------:|-----------------|
| R (Research) | ~500 | Key findings only, not raw output |
| P (Plan) | ~300 | Approach + key files |
| E (Execute) | ~500 | What changed, commit refs |
| T (Test) | ~300 | Pass/fail summary, NOT full output |
| D (Document) | ~400 | Delivery summary + LEARNING block |

---

## 20 Agentic AI Design Patterns

GSD-Amauta implements all 20 patterns from "The Ultimate Agentic AI Design Patterns Reference Guide":

| # | Pattern | Primary Agents | Implementation |
|:-:|---------|---------------|----------------|
| P1 | Prompt Chaining | operator, planner | RPETD pipeline is a 5-step prompt chain (R->P->E->T->D), each phase output feeds the next |
| P2 | Routing | operator | File-pattern routing table: `.tsx`->frontend, `.py`->backend, `Dockerfile`->infra, fallback->general |
| P3 | Parallelization | operator | Wave-based execution: independent plans within a wave run in parallel Task() calls |
| P4 | Tool Use | ALL (11 agents) | CLI tools: `gsd-amauta.cjs`, `gsd-rlm.cjs`, `gsd-memory.cjs`, `gsd-research.cjs`, `gsd-tools.cjs` |
| P5 | Reflection | validator, checker | External validation with 5 quality gates; no agent marks its own work done |
| P6 | Planning | operator, planner | Goal-backward decomposition: epic -> story -> task hierarchy with Given/When/Then criteria |
| P7 | RAG | researcher, all executors | RLM BM25-scored chunks + pgvector memory recall + research chain per RPETD phase |
| P8 | Resource-Aware Routing | operator | Model profiles in config: `executor_model` vs `verifier_model` tiers by task complexity |
| P9 | Multi-Agent Orchestration | ALL (11 agents) | 11 specialists coordinated via amauta task manager and RPETD protocol |
| P10 | Inter-Agent Communication | ALL | RPETD phases as standardized messages; task records as shared communication medium |
| P11 | Memory Management | ALL (via gsd-memory) | PG memory with source-aware scoring, pgvector semantic search, file-based fallback |
| P12 | Learning | all executors, operator | D-phase LEARNING extraction -> SKB promotion; Perplexity auto-store; `gsd-memory learn` |
| P13 | Reasoning | debugger, planner | Scientific method for debugger (hypothesis->test->observe->conclude); Given/When/Then for planner |
| P14 | Goal Setting | operator, planner | `success_criteria[]`, `deliverables[]`, `validation_checklist[]` on every task |
| P15 | Exception Handling | debugger, operator | Validation failures -> sub-task atomization; graceful degradation throughout all services |
| P16 | Evaluation | validator, checker | 5 quality gates + `gsd_task_validations` audit trail + `gsd_audit_log` immutable records |
| P17 | Guardrails | operator, validator | Gitflow gates, `--force-reason` with audit trail, no self-validation rule |
| P18 | Human-in-the-Loop | operator | Checkpoint plans: `human-verify`, `decision`, `human-action` types; UAT via verify-work workflow |
| P19 | Prioritization | operator | Score-based: `importance x 0.4 + urgency x 0.3 + dep_pressure x 0.3`; `amauta next` returns best task |
| P20 | Exploration | researcher | 5-step research chain; 4 modes: quick-check, deep-dive, architecture-review, pattern-search |

### Coverage Summary

- **100% pattern coverage** -- every pattern has at least one implementing agent
- **operator** is the most pattern-rich agent (11 patterns: P1, P2, P3, P6, P8, P9, P14-P19)
- **P4 (Tool Use)** and **P9 (Multi-Agent)** span all agents
- **P11 (Memory)** and **P12 (Learning)** are the backbone patterns used by all executors + operator + debugger

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

### PG_SYNC_WARN

When dual-write to PostgreSQL fails (PG down, connection timeout), the daemon still succeeds via JSON fallback but attaches `[PG_SYNC_WARN]` to the response. Agents see this warning and can report degraded state. Dual-write failure visibility prevents silent data loss.

---

## Installation

### Option 1: One-Line Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Luiscmogrovejo/gsd-amauta/master/scripts/install-remote.sh | bash
```

This downloads and installs everything -- no `git clone` needed. Your team just runs this one command.

### Option 2: Clone + Install

```bash
git clone https://github.com/Luiscmogrovejo/gsd-amauta.git ~/.claude/gsd-amauta
cd ~/.claude/gsd-amauta
npm install
```

### What the Installer Does

1. Installs 11 agents, 34 slash commands, 11 skills, 3 hooks to `~/.claude/`
2. Detects infrastructure: local PostgreSQL -> Docker PG -> SQLite fallback
3. Starts Amauta daemon (`:18799`) + RLM service (`:18798`) + Redis (`:6379`, optional)
4. Runs database migrations (7 SQL files)
5. Registers MCP server in Claude Code settings
6. Copies Python backend (amauta.py, daemon, Redis bridge, pg_store, rlm-service)

### Prerequisites

- **Node.js** 18+ and **Python** 3.9+
- **Claude Code** CLI
- **Docker** (optional -- for PostgreSQL; SQLite fallback works without it)

### Post-Install (Optional API Keys)

```bash
# Add to ~/.zshrc or ~/.bashrc

# Optional: Perplexity for research chain
export PERPLEXITY_API_KEY="your-key-here"

# Optional: Voyage AI for semantic search embeddings
export VOYAGE_API_KEY="your-key-here"
```

Without API keys, Amauta still works -- semantic search falls back to text matching, research uses local memory only.

### Verify

```bash
curl -s http://127.0.0.1:18799/health | python3 -m json.tool  # Daemon
curl -s http://127.0.0.1:18798/health | python3 -m json.tool  # RLM
python3 -m pytest tests/ -q                                     # Tests
```

---

## Daemon API Routes

The Amauta daemon exposes these HTTP endpoints on `http://127.0.0.1:18799`:

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Health check with version, uptime, and feature flags |
| `/api/board` | GET | Kanban board view of all tasks |
| `/api/list` | GET | List tasks with optional filters |
| `/api/show` | GET | Show task details (`/api/show/<id>`) |
| `/api/add` | POST | Create a new task |
| `/api/claim` | POST | Claim a task for an agent |
| `/api/rpetd` | POST | Log RPETD phase content |
| `/api/validate` | POST | Validate a completed task |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GSD_POSTGRES_URL` | `postgresql://amauta:gsd@127.0.0.1:5433/gsd_amauta` | PostgreSQL connection string |
| `GSD_AMAUTA_HOST` | `127.0.0.1` | Daemon bind host |
| `GSD_AMAUTA_PORT` | `18799` | Daemon port |
| `GSD_RLM_PORT` | `18798` | RLM service port |
| `AMAUTA_DATA_DIR` | `<project>/data` | Task board JSON location |
| `PERPLEXITY_API_KEY` | _(none)_ | Perplexity API key for research chain |
| `PERPLEXITY_MODEL` | `auto` | Perplexity model: `auto` (routes sonar/sonar-pro by complexity), `sonar`, `sonar-pro` |
| `VOYAGE_API_KEY` | _(none)_ | Voyage AI embedding key |
| `OPENAI_API_KEY` | _(none)_ | OpenAI embedding key (alternative provider) |
| `GSD_EMBEDDING_PROVIDER` | _(auto)_ | Force `voyage` or `openai` |
| `GSD_REDIS_URL` | _(none)_ | Redis connection URL for L2 cache (e.g., `redis://127.0.0.1:6379/0`) |
| `GSD_REDIS_ENABLED` | `true` | Set `false` to disable Redis even if URL is set |
| `GSD_STALE_INTERVAL` | `300` | Watchdog check interval in seconds (5 min) |
| `GSD_RESEARCH_MIN_RESULTS` | `2` | Cascade stops only when provider returns >= this many results |
| `GSD_MEMORY_DISTILL_THRESHOLD` | `100` | Auto-distill trigger when entry count exceeds this |
| `GSD_RESEARCH_DEDUP_THRESHOLD` | `0.7` | Jaccard dedup threshold for research results |
| `GSD_DEDUP_THRESHOLD` | `0.95` | Pre-store embedding cosine similarity threshold |
| `GSD_RECENCY_DECAY_PER_30D` | `0.5` | Score penalty per 30 days of age (capped at -3.0) |
| `GSD_TEST_MODE` | _(none)_ | Set to `1` to route to `__test__` project isolation |
| `RLM_MAX_CHUNK_CHARS` | `4000` | Max RLM chunk size in characters |
| `RLM_DEFAULT_TOP_K` | `10` | Default results per RLM query |
| `RLM_CACHE_SIZE` | `200` | LRU cache capacity (files) |
| `RLM_POSITION_DECAY` | `0.05` | Per-position decay for later chunks (5%) |

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
- **Daemon:** running/stopped, host:port, uptime, `pipeline_status` (healthy/degraded/critical)
- **RLM service:** running/stopped, host:port, indexed files count, cache hit/miss stats
- **Redis:** connected/disconnected, cache metrics (hits, misses, keys)
- **PostgreSQL:** connected/disconnected, version, table sizes
- **Embedding coverage:** percentage of memory entries with embeddings, active provider
- **SKB count:** number of validated shared knowledge entries
- **Agent performance:** per-agent pass rates and task counts
- **Task counts:** by status (pending, in_progress, validation, done, failed, deferred)
- **Service errors:** `service_errors[]` array for degraded/critical services

---

## CLI Reference

### amauta (gsd-amauta.cjs) -- Task Management

```bash
# Board and status
amauta board                                     # Kanban board view
amauta stats                                     # Project statistics
amauta health                                    # Health dashboard (daemon, RLM, Redis, PG, agents, tasks)
amauta health --json                             # JSON output for scripting
amauta show TK-0001                              # Full task detail (checks archive as fallback)

# Task creation
amauta add epic "Project Name" --agent operator  # Create epic
amauta add story "User Story" --parent EP-0001   # Create story
amauta add task "Implement auth" --parent ST-001 # Create task
amauta add bug "Fix crash" --parent ST-001       # Create bug

# Task lifecycle
amauta claim TK-0001 --agent executor-backend    # Claim task
amauta rpetd TK-0001 --phase R --content "..."   # Log RPETD phase
amauta status TK-0001 validation                 # Move to validation
amauta next executor-backend                     # Next highest-priority task for agent

# Validation
amauta validate TK-0001 --pass                   # External validation (pass)
amauta validate TK-0001 --pass --force-reason "docs-only, no tests needed"  # Override gates
amauta validate TK-0001 --pass --test-exempt     # Skip Gate 2 for non-code tasks
amauta validate TK-0001 --fail --notes "reason"  # Rejection with mandatory note

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

### gsd-memory.cjs -- Memory + Embeddings

```bash
# Storage
gsd-memory store "lesson" --source lesson-learned  # Store with explicit source
gsd-memory learn "insight"                          # Auto-learning (+3 boost)

# Search
gsd-memory search "connection pooling"              # Text search (excludes noise)
gsd-memory search "pooling" --include-noise         # Text search (includes task_event/rpetd_phase)
gsd-memory semantic-search "auth patterns"          # pgvector cosine similarity
gsd-memory cross-project "patterns" --tags react    # Cross-project search

# Maintenance
gsd-memory distill                                  # Compact similar entries (Jaccard >0.7)
gsd-memory distill --dry-run                        # Preview distillation without changes
gsd-memory backfill-embeddings                      # Embed entries missing vectors
gsd-memory health                                   # Service health + embedding coverage
```

### gsd-rlm.cjs -- Code Context

```bash
gsd-rlm query "how auth works" --path src/          # BM25-scored chunks from path
gsd-rlm query "database models" --dir . --top-k 5   # Top-5 results from project
gsd-rlm query "auth" --fresh                         # Bypass cache for fresh results
gsd-rlm chunk src/auth.ts                            # Inspect chunking for a file
gsd-rlm health                                       # Service status + indexed file count + cache stats
```

### gsd-research.cjs -- Research Chain

```bash
gsd-research search "React patterns"                # Full 5-step chain
gsd-research perplexity "Next.js 15 changes"        # Perplexity direct query
gsd-research perplexity "query" --no-cache           # Bypass 6h response cache
gsd-research fetch --url https://docs.example.com   # WebFetch direct
gsd-research check-providers                        # Provider availability status
```

---

## Testing

```bash
npm test                          # All CJS tests (61 test files)
python3 -m pytest tests/ -q       # All Python tests (31 test files)
npm run test:coverage             # Coverage report (target: 70%+ lines)
```

**~2479 tests** across 92 files covering: RPETD pipeline, validation gates (including `--force-reason`, `--test-exempt`, self-validation block, substance gates, phase-order warnings), memory (PG + semantic + distill + retention + dedup + decay + source filtering + recency guard), RLM (BM25 scoring, word-boundary TF, camelCase splitting, HTTP wiring, incremental indexing, cache stats), research chain (Perplexity cap, auto-store, cascade min-results, 429 backoff, preamble stripping), task lifecycle (archive, TOCTOU, reconcile, watchdog, retry flush, dep_pressure caching), token efficiency (enrichment dedup, phase-specific reduction, RPETD soft cap, Perplexity cache), Redis L2 caching, agent architecture (capability index, routing extraction), multi-agent validation (error classification, recovery routing, auto-escalation), security (path traversal, body limits, DSN sanitization), graceful degradation, health dashboard (pipeline status, service errors), and end-to-end integration with 24 regression benchmarks.

---

## Project Structure

```
gsd-amauta/
├── package.json
├── amauta.py                    # Task manager core (~5000 lines)
├── docker/docker-compose.yml    # PostgreSQL 16 + pgvector :5433, Redis 7 :6379
├── migrations/                  # 7 SQL migrations (001-007 + DOWN files)
├── services/
│   ├── amauta-daemon.py         # HTTP daemon :18799 (dual-write, watchdog, retention, Redis)
│   ├── amauta_daemon_redis.py   # Redis bridge module (solves circular import)
│   ├── pg_store.py              # PG pool + memory/SKB/tasks/embeddings/dedup/rerank
│   └── rlm-service.py           # BM25 code context :18798 (cache stats, position decay)
├── agents/                      # 11 agent definitions (.md)
├── skills/                      # 11 skill workflows (SKILL.md each)
├── get-shit-done/
│   ├── bin/                     # 5 CLI tools (.cjs)
│   ├── agent-capabilities.json  # Single source of truth for 11 agents
│   ├── workflows/               # 36 workflow files
│   └── references/              # Model profiles
├── commands/gsd/                # 34 slash commands
├── specs/                       # 9 formal specifications
├── tests/                       # 92 test files (61 CJS + 31 Python)
├── bin/install.js               # Self-installer
├── references/agentic-patterns.md  # 20 patterns x 11 agents matrix
└── data/
    ├── tasks.json               # Active task board
    └── tasks-archive.json       # Archived done tasks
```

---

## Current Known Gaps / Roadmap

### v2.4 (Bulletproof) -- Done

All v2.4 items completed and shipped.

### v2.5 (Smarter Brain) -- Done

8 phases, 49 requirements, ~479 new tests. Key results:
- 39.4% Layer 2 enrichment reduction, 24% total lifecycle, 75.6% Perplexity per-call
- Redis L2 caching layer with graceful fallback
- BM25 MIT paper audit: word-boundary TF, tuned b/position-decay/label-boost
- Agent capability index, error classification, recovery routing
- Voyage AI reranking wired into semantic search (voyage-rerank-2.5)
- LLM distillation via Claude CLI (no API key needed in Claude Code sessions)

### v2.6+ (Deferred)

- One-command setup: `npx gsd-amauta init`
- Docker auto-start: detect Docker, start PG container if no local PG
- Layer 3 agent-initiated context (`rlm_client.py`)
- LLM-based memory summarization (replace concatenation merging)
- RLM synonym expansion for semantic code queries

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

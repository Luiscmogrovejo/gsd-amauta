# GSD-Amauta

**A Claude Code plugin that merges [GSD](https://github.com/get-shit-done/get-shit-done) (Get Shit Done) with [Amauta](https://github.com/robertamauta/amauta) multi-agent task management.**

PostgreSQL persistent memory · pgvector semantic search · RLM context engine · RPETD pipeline enforcement · External validation · Perplexity-first research · 20 agentic AI design patterns

Everything degrades gracefully to vanilla GSD when infrastructure is unavailable.

```
705 tests · 11 agents · 11 skills · 5 CLI tools · 3 services · 7 specs · 20 agentic AI patterns
```

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [End-to-End Request Flow](#3-end-to-end-request-flow)
4. [RPETD Pipeline](#4-rpetd-pipeline)
5. [Agent Architecture](#5-agent-architecture)
6. [Memory System](#6-memory-system)
7. [Semantic Search (pgvector)](#7-semantic-search-pgvector)
8. [RLM Context Engine](#8-rlm-context-engine)
9. [Research Chain](#9-research-chain)
10. [Task Lifecycle](#10-task-lifecycle)
11. [Validation Pipeline](#11-validation-pipeline)
12. [Graceful Degradation](#12-graceful-degradation)
13. [Installation](#13-installation)
14. [Configuration](#14-configuration)
15. [CLI Reference](#15-cli-reference)
16. [Services](#16-services)
17. [Testing](#17-testing)
18. [Project Structure](#18-project-structure)
19. [Agentic AI Patterns](#19-agentic-ai-patterns)
20. [Troubleshooting](#20-troubleshooting)

---

## 1. Overview

GSD-Amauta turns Claude Code into a **managed software engineering pipeline**. When you start a project, a specialist operator agent decomposes work into tasks tracked in PostgreSQL. Each task is claimed by the right specialist executor (frontend, backend, infra, or general), forced through a five-step quality pipeline (Research → Plan → Execute → Test → Document), and validated by a separate external agent — no agent marks its own work done.

All context, learnings, and decisions persist across sessions in PostgreSQL with vector embeddings for semantic retrieval. The RLM context engine means agents query relevant code chunks rather than having entire files dumped into prompts.

**What it adds over vanilla GSD:**

| Capability | Vanilla GSD | GSD-Amauta |
|-----------|-------------|------------|
| Task state | Files only | PostgreSQL + files |
| Memory | STATE.md | PG memory + semantic search |
| Context | Full file injection | RLM chunk retrieval |
| Quality gate | Honour system | RPETD enforcement |
| Validation | Self-marking | External agent required |
| Research | WebFetch only | Memory → SKB → Context7 → Perplexity → WebFetch |
| Learning | Manual | Auto-capture + cross-project transfer |
| Agents | Generic | 11 specialists with file-pattern routing |

---

## 2. System Architecture

```
╔══════════════════════════════════════════════════════════════════════╗
║                        CLAUDE CODE SESSION                           ║
║                                                                      ║
║  /amauta:new-project   /amauta:execute-plan   /amauta:test-phase   ...      ║
║        │                    │                    │                   ║
║        ▼                    ▼                    ▼                   ║
║  ┌──────────┐    ┌──────────────────┐    ┌─────────────────┐       ║
║  │Workflows │    │Agent Definitions │    │ Slash Commands  │       ║
║  │(33+ .md) │    │  (11 agents)     │    │  (34 total)     │       ║
║  └────┬─────┘    └────────┬─────────┘    └────────┬────────┘       ║
║       │                   │                        │                 ║
║       └───────────────────┴────────────────────────┘                ║
║                                │                                     ║
║       ┌────────────────────────▼──────────────────────────┐        ║
║       │              Node.js CLI Tools Layer               │        ║
║       │                                                    │        ║
║       │  gsd-amauta.cjs    gsd-memory.cjs   gsd-rlm.cjs  │        ║
║       │  (task mgmt)       (PG memory +     (code-aware   │        ║
║       │                     embeddings)      context)      │        ║
║       │  gsd-research.cjs  gsd-tools.cjs                  │        ║
║       │  (Perplexity)      (GSD core)                      │        ║
║       └──────┬─────────────────┬──────────────────┬────────┘        ║
║              │                 │                  │                  ║
╚══════════════╪═════════════════╪══════════════════╪══════════════════╝
               │                 │                  │
               ▼                 ▼                  ▼
   ┌─────────────────┐  ┌──────────────┐  ┌───────────────────┐
   │  Amauta Daemon  │  │ RLM Service  │  │   External APIs   │
   │  :18799 (HTTP)  │  │ :18798 (HTTP)│  │                   │
   │                 │  │              │  │  Voyage AI        │
   │  ┌───────────┐  │  │  Code-aware  │  │  (embeddings)     │
   │  │ amauta.py │  │  │  chunking    │  │                   │
   │  │ (3920 ln) │  │  │  TF-IDF rank │  │  Perplexity       │
   │  └───────────┘  │  │  LRU cache   │  │  (research)       │
   │  ┌───────────┐  │  └──────────────┘  │                   │
   │  │ pg_store  │  │                    │  Context7 MCP     │
   │  │   .py     │  │                    │  (docs)           │
   │  └─────┬─────┘  │                    └───────────────────┘
   └─────────┼────────┘
             │
             ▼
   ┌──────────────────────┐
   │   PostgreSQL 16      │
   │   + pgvector 0.8     │
   │   :5433 (Docker)     │
   │                      │
   │  gsd_memory          │  ← text + vector(1024) embeddings
   │  gsd_shared_kb       │  ← validated cross-project knowledge
   │  gsd_tasks           │  ← task state + RPETD work log
   │  gsd_task_valid.     │  ← validation audit trail
   │                      │
   │  4 tables            │
   │  21 indexes          │  incl. HNSW for cosine similarity
   │  3 auto-triggers     │
   └──────────────────────┘
```

---

## 3. End-to-End Request Flow

How a single user request flows through the complete system:

```
  USER: "Add dark mode to the settings page"
        │
        ▼
  ┌─────────────────────────────────────────┐
  │           gsd-operator                  │
  │  Master orchestrator receives request   │
  │                                         │
  │  1. Query RLM for existing UI patterns  │
  │  2. Search memory for past dark-mode    │
  │     implementation lessons             │
  │  3. Decompose into tasks               │
  └──────────────────┬──────────────────────┘
                     │
         ┌───────────▼──────────┐
         │  Create in Amauta   │
         │                     │
         │  EP-XXXX  Epic      │
         │  └─ ST-XXXX Story   │
         │     └─ TK-XXXX Task │
         └───────────┬──────────┘
                     │ HTTP POST /api/add
                     ▼
         ┌──────────────────────┐
         │   Amauta Daemon      │  → amauta.py → tasks.json + PG
         │   :18799             │
         └───────────┬──────────┘
                     │
                     │  Route by file pattern:
                     │  *.tsx, *.css → executor-frontend
                     │  *.py, *.sql  → executor-backend
                     │  Dockerfile   → executor-infra
                     │  everything   → executor-general
                     │
                     ▼
         ┌──────────────────────┐
         │  gsd-executor-       │  Specialist executor claims task
         │  frontend            │  Begins RPETD pipeline
         └──────────────────────┘
                     │
          ┌──────────┴─────────────────────────────────────────────┐
          │                   RPETD Pipeline                        │
          │                                                         │
          │  R: Research ──→ memory + SKB + Perplexity             │
          │  P: Plan     ──→ Given/When/Then criteria               │
          │  E: Execute  ──→ feature branch + commits              │
          │  T: Test     ──→ run suite + capture output            │
          │  D: Document ──→ LEARNING block + auto-store           │
          │                                                         │
          │  Each phase logged via:                                 │
          │  gsd-amauta.cjs rpetd TK-XXXX --phase R/P/E/T/D       │
          └──────────┬──────────────────────────────────────────────┘
                     │
                     ▼
         ┌──────────────────────┐
         │   gsd-validator      │  EXTERNAL validator (not executor)
         │                      │
         │  Checks:             │
         │  ✓ Branch evidence   │  (E-phase gate)
         │  ✓ Test output       │  (T-phase gate)
         │  ✓ LEARNING block    │  (D-phase gate)
         │  ✓ Success criteria  │  (from P-phase)
         └──────────┬───────────┘
                    │
              PASS ─┤─ FAIL
                    │         │
                    ▼         ▼
              ┌─────────┐  ┌────────────────────────┐
              │  DONE   │  │ Sub-tasks created      │
              │         │  │ Re-routed to executor  │
              │ lessons │  │ Re-validated           │
              │ → SKB   │  └────────────────────────┘
              └─────────┘
```

---

## 4. RPETD Pipeline

Every task is forced through five phases. Validation gates block progress:

```
  TASK CLAIMED
       │
       ▼
  ┌────────────────────────────────────────────────────────┐
  │  R — RESEARCH                                          │
  │                                                        │
  │  Query chain:                                          │
  │  gsd_memory (PG) ──→ gsd_shared_kb ──→ Context7      │
  │                          │                             │
  │                          └──→ Perplexity ──→ WebFetch  │
  │                                                        │
  │  Output: prior learnings, patterns, documentation     │
  └────────────────────────┬───────────────────────────────┘
                           │
                           ▼
  ┌────────────────────────────────────────────────────────┐
  │  P — PLAN                                              │
  │                                                        │
  │  Given: <system state>                                 │
  │  When:  <action taken>                                 │
  │  Then:  <expected outcome>                             │
  │                                                        │
  │  Output: step-by-step plan, test strategy,            │
  │          success criteria, deliverables               │
  └────────────────────────┬───────────────────────────────┘
                           │
                           ▼
  ┌────────────────────────────────────────────────────────┐
  │  E — EXECUTE                                   GATE 1 │
  │                                                        │
  │  Branch required:                                      │
  │    feat/TK-XXXX-description                           │
  │    fix/BG-XXXX-description                            │
  │    chore/description                                   │
  │                                                        │
  │  ▶ GATE: branch evidence must appear in E-phase log  │
  │    (regex: feat/|fix/|chore/|branch|commit|push)      │
  │                                                        │
  │  Output: working code, committed to branch            │
  └────────────────────────┬───────────────────────────────┘
                           │
                           ▼
  ┌────────────────────────────────────────────────────────┐
  │  T — TEST                                      GATE 2 │
  │                                                        │
  │  Run test suite, capture raw output                    │
  │                                                        │
  │  ▶ GATE: test evidence must match one of:            │
  │    passed|failed|PASS|FAIL|✓|✗|ok|not ok             │
  │    tests:|test:|suite:|assertions:|expect|assert      │
  │    coverage|[0-9]+ passing|[0-9]+ failing            │
  │                                                        │
  │  Output: test results pasted verbatim into T-log     │
  └────────────────────────┬───────────────────────────────┘
                           │
                           ▼
  ┌────────────────────────────────────────────────────────┐
  │  D — DOCUMENT                                  GATE 3 │
  │                                                        │
  │  LEARNING block format:                               │
  │  ┌──────────────────────────────────────────────────┐ │
  │  │ LEARNING: <key insight>                          │ │
  │  │ Context: <when this applies>                     │ │
  │  │ Impact: <why it matters>                         │ │
  │  └──────────────────────────────────────────────────┘ │
  │                                                        │
  │  ▶ GATE: LEARNING: keyword must appear in D-phase log│
  │                                                        │
  │  Auto-actions:                                        │
  │  • Store to gsd_memory (source=auto_learning, +3)    │
  │  • Promote to gsd_shared_kb if validation passes     │
  └────────────────────────┬───────────────────────────────┘
                           │
                           ▼
  ┌────────────────────────────────────────────────────────┐
  │  VALIDATION                                            │
  │                                                        │
  │  External gsd-validator checks ALL FOUR gates:        │
  │    Gate 1: branch evidence in E-log?   ✓ / ✗         │
  │    Gate 2: LEARNING in D-log (or any)? ✓ / ✗         │
  │    Gate 3: test evidence in T-log?     ✓ / ✗         │
  │    Gate 4: PR URL in D/E/notes?        ✓ / ✗         │
  │    Success criteria met?               ✓ / ✗         │
  │                                                        │
  │  PASS ──→ status=done, learnings promoted to SKB     │
  │  FAIL ──→ rejection_reason stored, sub-tasks created  │
  │                                                        │
  │  Override: --force (bypasses gate checks)             │
  │  Tag: no-gitflow (skips branch gate only)             │
  └────────────────────────────────────────────────────────┘
```

---

## 5. Agent Architecture

11 specialists, each with a defined role, tool set, and agentic AI patterns:

```
                    ┌────────────────────────────┐
                    │        gsd-operator         │
                    │   Master Orchestrator       │
                    │                             │
                    │  Patterns: P1 P2 P6 P8 P9  │
                    │           P14 P15 P17-P19  │
                    │                             │
                    │  Tools: Bash Read Write     │
                    │         Edit Task Glob Grep │
                    └──────────────┬──────────────┘
                                   │
           ┌───────────────────────┼──────────────────────┐
           │           │           │           │           │
           ▼           ▼           ▼           ▼           ▼
  ┌──────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ gsd-planner  │ │gsd-      │ │gsd-      │ │gsd-      │ │gsd-      │
  │              │ │researcher│ │checker   │ │validator │ │debugger  │
  │ Given/When/  │ │          │ │          │ │          │ │          │
  │ Then plans   │ │ Memory   │ │ Pre/post │ │ External │ │ Root     │
  │ scope, risks │ │ SKB      │ │ quality  │ │ validate │ │ cause    │
  │              │ │ Perplx   │ │ checks   │ │ gates    │ │ bisect   │
  │ P6 P14       │ │ WebFetch │ │          │ │          │ │          │
  │              │ │          │ │ P4 P17   │ │ P4 P13   │ │ P5 P7    │
  │              │ │ P5 P10   │ │          │ │ P17      │ │ P20      │
  └──────────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘

  ┌────────────────────────────────────────────────────────────────────┐
  │                    gsd-roadmapper                                  │
  │          ROADMAP.md · milestone planning · STATE.md               │
  └────────────────────────────────────────────────────────────────────┘

                           │  File pattern routing
                           ▼
       ┌────────────┬──────────────┬────────────┬──────────────┐
       │            │              │            │              │
       ▼            ▼              ▼            ▼              │
  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐         │
  │executor │  │executor │  │executor │  │executor │         │
  │frontend │  │backend  │  │infra    │  │general  │         │
  │         │  │         │  │         │  │         │         │
  │*.tsx    │  │*.py     │  │Docker   │  │anything │         │
  │*.jsx    │  │*.sql    │  │*.yml    │  │else     │         │
  │*.css    │  │*.go     │  │terraform│  │         │         │
  │*.scss   │  │*.rs     │  │k8s/     │  │         │         │
  │*.vue    │  │*.java   │  │CI/CD    │  │         │         │
  │         │  │         │  │         │  │         │         │
  │P3 P11   │  │P3 P11   │  │P3 P11   │  │P3 P11   │         │
  └─────────┘  └─────────┘  └─────────┘  └─────────┘         │
                                                               │
  All executors: Read Write Edit Bash Grep Glob               │
  Read-only (researcher, checker, validator): no Write/Edit   │
  ─────────────────────────────────────────────────────────────┘
```

**Pattern Legend** (from `references/agentic-patterns.md`):

| P# | Pattern | Primary Agents |
|----|---------|----------------|
| P1 | Prompt Chaining | operator |
| P2 | Routing | operator |
| P3 | Parallelization | executors |
| P4 | Verification | checker, validator |
| P5 | Tool Use | researcher, debugger |
| P6 | Planning | planner, operator |
| P7 | Reflection | debugger |
| P8 | Resource-Aware Routing | operator |
| P9 | Multi-Agent Orchestration | operator |
| P10 | RAG | researcher |
| P11 | Code Generation | executors |
| P13 | Self-Monitoring | validator |
| P14 | Goal Setting | planner, operator |
| P15 | Exception Handling | operator |
| P17 | Guardrails | checker, validator |
| P18 | Human-in-the-Loop | operator |
| P19 | Prioritization | operator |
| P20 | Debugging | debugger |

---

## 6. Memory System

PostgreSQL-backed persistent memory with source-aware scoring across sessions and projects:

```
  ┌─────────────────────────────────────────────────────┐
  │                   WRITE PATH                        │
  │                                                     │
  │  Agent completes work / captures insight            │
  │         │                                           │
  │         ├──→ RPETD D-phase LEARNING block           │
  │         │         → source=auto_learning  score +3  │
  │         │                                           │
  │         ├──→ Perplexity search result               │
  │         │         → source=web_search_result score +3│
  │         │                                           │
  │         ├──→ Manual gsd-memory.cjs store            │
  │         │         → source=agent         score +0  │
  │         │                                           │
  │         └──→ gsd-memory.cjs learn                  │
  │                   → source=auto_learning  score +3  │
  └────────────────────┬────────────────────────────────┘
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │                 gsd_memory (PG)                     │
  │                                                     │
  │  id          VARCHAR(64) PRIMARY KEY                │
  │  text        TEXT                                   │
  │  source      VARCHAR(64)   ← score source          │
  │  agent_id    VARCHAR(64)                            │
  │  tags        JSONB         ← tech tags, project    │
  │  project_id  VARCHAR(128)                           │
  │  embedding   vector(1024)  ← pgvector HNSW         │
  │  created_at  TIMESTAMPTZ                            │
  │                                                     │
  │  Count > threshold?  → Auto-distill (Jaccard 0.7)  │
  └────────────────────┬────────────────────────────────┘
                       │
               validation passes
                       │
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │                 gsd_shared_kb (PG)                  │
  │                                                     │
  │  Promoted from gsd_memory on validation pass        │
  │  source=best-practice   score +4                    │
  │                                                     │
  │  title, content, category, tags                     │
  │  importance (1-10), source_task                     │
  │  Categories: workflow, process, delivery,           │
  │    pattern, policy, architecture, convention,       │
  │    pitfall, tool-usage                              │
  └────────────────────┬────────────────────────────────┘
                       │
                       │  At new-project init
                       ▼
  ┌─────────────────────────────────────────────────────┐
  │            Cross-Project Transfer                   │
  │                                                     │
  │  gsd-memory.cjs cross-project "query"              │
  │  --tags postgresql,react  (tech filter)            │
  │                                                     │
  │  Returns lessons from ALL past projects             │
  │  matching the query and tech stack                  │
  └─────────────────────────────────────────────────────┘
```

### Source Score Table

| Source | Score Boost | Created By |
|--------|:-----------:|-----------|
| `lesson-learned` | +4 | Developer explicit input |
| `best-practice` | +4 | SKB promotion after validation |
| `auto_learning` | +3 | D-phase LEARNING block |
| `web_search_result` | +3 | Perplexity API response |
| `session-learning` | +3 | Session observation capture |
| `distilled` | +2 | Merged/compacted entries |
| `rpetd_phase` | +1 | Per-phase auto-capture |
| `task_event` | +0 | Status transitions |
| `agent` | +0 | General agent notes |

---

## 7. Semantic Search (pgvector)

1024-dimension vector embeddings stored alongside text, searched with HNSW cosine similarity:

```
  WRITE — gsd-memory.cjs store / learn
       │
       ▼
  ┌────────────────────────────────────────────────────────┐
  │  Provider Detection                                    │
  │                                                        │
  │  GSD_EMBEDDING_PROVIDER=voyage|openai (explicit)      │
  │        │ not set                                       │
  │        ▼                                               │
  │  VOYAGE_API_KEY set?  ──yes──→ voyage-code-3          │
  │        │ no                    (code-optimized, 1024d) │
  │        ▼                                               │
  │  OPENAI_API_KEY set?  ──yes──→ text-embedding-3-small │
  │        │ no                    (general, 1024d)        │
  │        ▼                                               │
  │  Neither set  ──────────────→ skip embedding          │
  └──────────────────────┬─────────────────────────────────┘
                         │
          embedding generated (input_type="document")
                         │
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │   INSERT INTO gsd_memory                               │
  │   (text, source, tags, embedding)                      │
  │   VALUES (%s, %s, %s, %s::vector)                      │
  └────────────────────────────────────────────────────────┘

  ─────────────────────────────────────────────────────────

  READ — gsd-memory.cjs semantic-search "query"
       │
       ▼
  ┌────────────────────────────────────────────────────────┐
  │  Generate query embedding (input_type="query")        │
  │  Same provider detection as write path                │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │  SELECT *, 1-(embedding<=>query_vec) AS similarity    │
  │  FROM gsd_memory                                       │
  │  WHERE embedding IS NOT NULL                           │
  │  ORDER BY embedding <=> query_vec     ← HNSW index    │
  │  LIMIT 20                                              │
  │                                                        │
  │  HNSW: m=16, ef_construction=128, cosine distance     │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │  Score = similarity(0→1) × 10 + source_bonus(0→4)    │
  │  Sort by score descending                             │
  │  Return top results with semantic_similarity field    │
  └────────────────────────────────────────────────────────┘

  Fallback: if no embeddings stored or no API key
  → uses PostgreSQL full-text search + ILIKE (still works)
```

---

## 8. RLM Context Engine

Based on MIT CSAIL arXiv:2512.24601v1. Agents retrieve relevant code chunks instead of having entire files injected into prompts. **No API keys required — pure local retrieval.**

```
  Agent query: "How does auth middleware work?"
       │
       ▼
  ┌────────────────────────────────────────────────────────┐
  │  gsd-rlm.cjs query "auth middleware" --path src/      │
  │                                                        │
  │  POST /query → RLM Service :18798                     │
  └──────────────────────┬─────────────────────────────────┘
                         │
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │                  RLM Service                           │
  │                                                        │
  │  1. SCAN  Walk target path, collect eligible files    │
  │           Skip: node_modules, .git, __pycache__,      │
  │                 dist, build, .next, coverage          │
  │                                                        │
  │  2. CHUNK  Language-aware code splitting              │
  │                                                        │
  │    Python  ─→ class/function/decorator boundaries     │
  │    JS/TS   ─→ function/class/export boundaries        │
  │    SQL     ─→ statement boundaries (;)                │
  │    Markdown─→ heading boundaries (#, ##, ###)         │
  │    Generic ─→ paragraph breaks + blank lines          │
  │                                                        │
  │    Max chunk: 8000 chars (RLM_MAX_CHUNK_CHARS)        │
  │    Oversized chunks split at paragraph breaks         │
  │                                                        │
  │  3. CACHE  LRU cache keyed by (filepath, mtime)      │
  │            Up to 200 files (RLM_CACHE_SIZE)           │
  │            Stale entries auto-evicted on access       │
  │                                                        │
  │  4. SCORE  TF-IDF relevance against query terms       │
  │                                                        │
  │    term_freq   = count(term in chunk) / chunk_words   │
  │    idf         = log(total_docs / docs_with_term)     │
  │    tf_idf      = term_freq × idf                      │
  │    chunk_score = Σ tf_idf across query terms          │
  │                                                        │
  │  5. RETURN  Top-K chunks (default: 10)               │
  │             Each: file path, line range, text, score  │
  └────────────────────────────────────────────────────────┘
                         │
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │  Agent receives only relevant code chunks             │
  │  Not: entire file contents                            │
  │                                                        │
  │  Typical context reduction: 10x–50x                  │
  │  Enabled by default (config.json rlm_enabled: true)  │
  │  Fallback: @ file references if service down         │
  └────────────────────────────────────────────────────────┘
```

---

## 9. Research Chain

Multi-provider research with deduplication and auto-storage:

```
  Query: "React server component caching patterns"
         │
         ▼
  ┌────────────────────────────────────────────────────────┐
  │  Step 1: PG Memory Search                             │
  │                                                        │
  │  gsd-memory.cjs semantic-search "..." (or text)      │
  │  Source-aware scoring applied                         │
  │                                                        │
  │  Hit?  ──yes──→  RETURN results (highest score first) │
  └──────────────────────┬─────────────────────────────────┘
                         │ miss
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │  Step 2: Shared Knowledge Base                        │
  │                                                        │
  │  Search gsd_shared_kb (validated cross-project)      │
  │  Category filter: architecture, pattern, tool-usage  │
  │                                                        │
  │  Hit?  ──yes──→  RETURN (importance-ranked)          │
  └──────────────────────┬─────────────────────────────────┘
                         │ miss
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │  Step 3: Context7 (MCP)                               │
  │                                                        │
  │  Agent invokes Context7 MCP tool directly             │
  │  Library documentation, API references                │
  │                                                        │
  │  Hit?  ──yes──→  RETURN (store to memory as session) │
  └──────────────────────┬─────────────────────────────────┘
                         │ miss
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │  Step 4: Perplexity API                               │
  │                                                        │
  │  gsd-research.cjs perplexity "..."                   │
  │  Model: sonar (PERPLEXITY_API_KEY required)          │
  │                                                        │
  │  On result:                                           │
  │  • Dedup check: Jaccard similarity > 0.7?            │
  │    If duplicate → skip storage                        │
  │  • Store to gsd_memory (source=web_search_result +3) │
  │  • Auto-embed if API key available                   │
  │                                                        │
  │  Hit?  ──yes──→  RETURN                              │
  └──────────────────────┬─────────────────────────────────┘
                         │ miss / no key
                         ▼
  ┌────────────────────────────────────────────────────────┐
  │  Step 5: WebFetch (HTTP fallback)                     │
  │                                                        │
  │  Direct URL fetch (requires --url)                   │
  │  gsd-research.cjs fetch --url https://...            │
  └────────────────────────────────────────────────────────┘
```

---

## 10. Task Lifecycle

```
  /amauta:new-project
         │
         ▼
  ┌──────────────────────────────────────────────┐
  │           Project Initialization             │
  │                                              │
  │  1. Cross-project search (past learnings)   │
  │  2. Create Epic in Amauta                   │
  │  3. One Story per ROADMAP.md phase          │
  │  4. Tasks atomized from plan items          │
  └──────────────────┬───────────────────────────┘
                     │
                     ▼
  ┌──────────────────────────────────────────────┐
  │                Task States                   │
  │                                              │
  │  pending ──claim──→ in-progress              │
  │                           │                  │
  │                     RPETD phases            │
  │                           │                  │
  │                    status validation         │
  │                           │                  │
  │                    ┌──────▼──────┐          │
  │                    │ validation  │          │
  │                    └──────┬──────┘          │
  │                           │                  │
  │              validate ────┤                  │
  │              --pass/--fail│                  │
  │                    ┌──────┴───────┐         │
  │                   PASS          FAIL         │
  │                    │              │           │
  │                    ▼              ▼           │
  │                  done         fix tasks      │
  │                                → re-validate │
  │                                              │
  │  Additional: failed, deferred               │
  └──────────────────────────────────────────────┘

  Task hierarchy:
    Epic (EP-XXXX)
    └── Story (ST-XXXX)
        ├── Task (TK-XXXX)
        └── Bug  (BG-XXXX)

  Priority scoring:
    score = importance×0.4 + urgency×0.3 + dep_pressure×0.3

  Routing: gsd-amauta.cjs next <agent-name>
    Returns highest-priority pending task for that agent
```

---

## 11. Validation Pipeline

The external validation model — no agent validates its own work:

```
  ┌──────────────────────────────────────────────────────────┐
  │                   Executor completes work                │
  │                                                          │
  │  amauta status TK-XXXX validation                        │
  └────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
  ┌──────────────────────────────────────────────────────────┐
  │                   gsd-validator                          │
  │              (DIFFERENT agent than executor)             │
  │                                                          │
  │  1. Read task details and all RPETD phases              │
  │  2. Check Gate 1: branch evidence in E-log?             │
  │  3. Check Gate 2: LEARNING block in D-log (or any)?    │
  │  4. Check Gate 3: test output in T-log?                 │
  │  5. Check Gate 4: PR URL in D/E/notes? (code tasks)   │
  │  6. Verify success criteria from P-phase                │
  │  7. Check dependencies are done                         │
  └────────────────────────┬─────────────────────────────────┘
                           │
                 ┌─────────┴──────────┐
                 │                    │
                PASS                FAIL
                 │                    │
                 ▼                    ▼
  ┌──────────────────────┐  ┌────────────────────────────┐
  │  validate --pass     │  │  validate --fail           │
  │                      │  │  --notes "reason"          │
  │  • status → done     │  │                            │
  │  • RPETD complete    │  │  • status back to pending  │
  │  • D-phase learning  │  │  • rejection recorded in   │
  │    → gsd_memory      │  │    gsd_task_validations    │
  │  • SKB promotion     │  │  • fix sub-tasks created   │
  │    (best-practice+4) │  │  • re-route to executor    │
  └──────────────────────┘  └────────────────────────────┘

  Audit trail: gsd_task_validations table
    task_id, validator_id, status, evidence, reason, ts

  Force override: --force (bypasses gate checks)
  No-gitflow tag: skips branch evidence requirement
```

---

## 12. Graceful Degradation

Every feature has a fallback — set no environment variables for vanilla GSD behavior:

```
  Feature              │ With infrastructure        │ Without
  ─────────────────────┼────────────────────────────┼──────────────────────────
  Task management      │ PostgreSQL + daemon         │ data/tasks.json
  Memory search        │ PG full-text + pgvector     │ .planning/memory/*.md
  Memory store         │ PG + auto-embedding         │ .planning/memory/YYYY-MM.md
  Semantic search      │ pgvector HNSW cosine        │ text ILIKE fallback
  Cross-project        │ PG cross-query, tag filter  │ file keyword grep
  RLM context          │ HTTP service :18798         │ @ file references
  Research             │ Perplexity → auto-store     │ memory + SKB only
  Perplexity           │ live API call               │ skipped silently
  SKB                  │ gsd_shared_kb PG table      │ not available
  Validation gates     │ RPETD gate checks           │ not enforced
  Embeddings           │ Voyage AI or OpenAI         │ text search only
  Learning capture     │ PG auto_learning +3         │ STATE.md ## Learnings
  ─────────────────────┼────────────────────────────┼──────────────────────────
  Activation           │ Set env variables           │ Don't set anything
```

**Activation variables:**
- `GSD_POSTGRES_URL` → PG memory, tasks, SKB, validation
- `VOYAGE_API_KEY` → semantic search via Voyage AI voyage-code-3 (preferred)
- `OPENAI_API_KEY` → semantic search via OpenAI text-embedding-3-small (alternative)
- `PERPLEXITY_API_KEY` → Perplexity research chain step
- `GSD_EMBEDDING_PROVIDER=voyage|openai` → force specific provider

---

## 13. Installation

### Prerequisites

- **Node.js** 18+
- **Python** 3.9+ with pip
- **Docker** (for PostgreSQL)
- **Claude Code** CLI

### Quick Start

```bash
# Clone to Claude Code user directory
git clone https://github.com/robertamauta/gsd-amauta.git ~/.claude/gsd-amauta
cd ~/.claude/gsd-amauta

# Install — sets up PG, daemon, RLM, agents, workflows, commands
npm install
```

The installer (`bin/install.js`) handles:
1. GSD agents, workflows, slash commands, hooks — installed to `~/.claude/`
2. Docker PostgreSQL 16 + pgvector on port 5433
3. Python `psycopg2-binary` dependency
4. Amauta HTTP daemon startup on port 18799
5. RLM context service startup on port 18798
6. Database migrations (001 schema, 002 HNSW index, 003 dimension fix, 004 FTS indexes, 005 agent performance)
7. Codex and Gemini CLI config generation

### Post-Install

Add to `~/.zshrc` or `~/.bashrc`:

```bash
# Required: PostgreSQL connection
export GSD_POSTGRES_URL="postgresql://amauta:gsd@127.0.0.1:5433/gsd_amauta"

# Optional: Perplexity research
export PERPLEXITY_API_KEY="your-key-here"

# Optional: Semantic search embeddings (choose one)
export VOYAGE_API_KEY="your-key-here"     # Recommended — Anthropic partner
# export OPENAI_API_KEY="your-key-here"   # Alternative
```

### Verify Installation

```bash
# Services
curl http://127.0.0.1:18799/health | python3 -m json.tool
curl http://127.0.0.1:18798/health | python3 -m json.tool
docker ps --filter name=gsd-postgres

# CLI tools
node ~/.claude/gsd-amauta/get-shit-done/bin/amauta.cjs stats
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-memory.cjs health
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-rlm.cjs health
node ~/.claude/gsd-amauta/get-shit-done/bin/gsd-research.cjs check-providers

# Tests
npm test   # 705 tests expected
```

---

## 14. Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GSD_POSTGRES_URL` | `postgresql://amauta:gsd@127.0.0.1:5433/gsd_amauta` | PostgreSQL connection string |
| `GSD_AMAUTA_HOST` | `127.0.0.1` | Daemon bind host |
| `GSD_AMAUTA_PORT` | `18799` | Daemon port |
| `GSD_RLM_PORT` | `18798` | RLM service port |
| `AMAUTA_DATA_DIR` | `<project>/data` | Task board JSON location |
| `PERPLEXITY_API_KEY` | _(none)_ | Perplexity API key |
| `PERPLEXITY_MODEL` | `sonar` | Perplexity model name |
| `VOYAGE_API_KEY` | _(none)_ | Voyage AI key (recommended for embeddings) |
| `OPENAI_API_KEY` | _(none)_ | OpenAI key (alternative for embeddings) |
| `GSD_EMBEDDING_PROVIDER` | _(auto)_ | Force `voyage` or `openai` |
| `GSD_MEMORY_DISTILL_THRESHOLD` | `100` | Auto-distill trigger count |
| `GSD_RESEARCH_DEDUP_THRESHOLD` | `0.7` | Jaccard dedup threshold |
| `RLM_MAX_CHUNK_CHARS` | `8000` | Max RLM chunk size |
| `RLM_DEFAULT_TOP_K` | `10` | Default results per RLM query |
| `RLM_CACHE_SIZE` | `200` | LRU cache capacity (files) |

### Config File

`.planning/config.json` or `get-shit-done/templates/config.json`:

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

## 15. CLI Reference

### Task Management — `amauta` (gsd-amauta.cjs)

```bash
# Board and navigation
amauta board                                     # Kanban board view
amauta stats                                     # Project statistics
amauta show TK-0001                              # Full task detail
amauta next executor-backend                     # Next task for agent
amauta list --status pending                     # Filter task list

# Task creation
amauta add epic "Project Name" --agent operator
amauta add story "Phase 1" --parent EP-0001
amauta add task "Implement auth" --parent ST-0001

# Task lifecycle
amauta claim TK-0001 --agent executor-backend
amauta rpetd TK-0001 --phase R --content "Research findings..."
amauta rpetd TK-0001 --phase E --content "Branch: feat/TK-0001..."
amauta status TK-0001 validation
amauta validate TK-0001 --pass --validator gsd-validator
amauta validate TK-0001 --fail --notes "Missing test evidence"

# Flags
# --force    Bypass validation gate checks
# --json     JSON output for scripting
```

### Memory — `gsd-memory.cjs`

```bash
# Storage
gsd-memory.cjs store "lesson text" --source lesson-learned
gsd-memory.cjs learn "auto_learning entry"      # +3 boost shortcut
gsd-memory.cjs count                            # Total stored
gsd-memory.cjs list --limit 20                  # Recent entries
gsd-memory.cjs delete mem-abc123                # Remove entry

# Search
gsd-memory.cjs search "connection pooling"      # Source-aware text search
gsd-memory.cjs semantic-search "auth patterns"  # pgvector cosine similarity
gsd-memory.cjs cross-project "patterns" --tags postgresql,react

# Embeddings
gsd-memory.cjs embedding-stats                  # Coverage + provider info
gsd-memory.cjs backfill-embeddings              # Embed existing entries
gsd-memory.cjs backfill-embeddings --batch-size 100

# Maintenance
gsd-memory.cjs distill --dry-run                # Preview dedup
gsd-memory.cjs distill                          # Compact similar entries
gsd-memory.cjs infer-tags .                     # Detect tech stack
gsd-memory.cjs health                           # Service health
```

### RLM Context — `gsd-rlm.cjs`

```bash
gsd-rlm.cjs query "how auth works" --path src/  # Search + retrieve chunks
gsd-rlm.cjs chunk src/auth.ts                    # Inspect chunking output
gsd-rlm.cjs search "middleware" --path src/      # Search only
gsd-rlm.cjs health                               # Service status
```

### Research — `gsd-research.cjs`

```bash
gsd-research.cjs search "React patterns"         # Full chain (all providers)
gsd-research.cjs perplexity "Next.js 15"         # Perplexity direct
gsd-research.cjs fetch --url https://...         # WebFetch direct
gsd-research.cjs check-providers                 # Provider status
```

---

## 16. Services

Three background services, each localhost-only:

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL | 5433 | Task state, memory, SKB, validation audit |
| Amauta Daemon | 18799 | HTTP wrapper around amauta.py + pg_store |
| RLM Service | 18798 | Code-aware chunking + TF-IDF retrieval |

```bash
# Start all
docker compose -f docker/docker-compose.yml up -d
python3 services/amauta-daemon.py start
python3 services/rlm-service.py start

# Stop all
python3 services/amauta-daemon.py stop
python3 services/rlm-service.py stop
docker compose -f docker/docker-compose.yml down

# Status
python3 services/amauta-daemon.py status
python3 services/rlm-service.py status
docker ps --filter name=gsd-postgres
```

### Daemon API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Daemon health + PG status |
| GET | `/api/board` | Kanban board JSON |
| GET | `/api/list` | Task list with filters |
| GET | `/api/show` | Task details |
| GET | `/api/stats` | Project statistics |
| POST | `/api/add` | Create task/story/epic |
| POST | `/api/claim` | Claim task for agent |
| POST | `/api/rpetd` | Log RPETD phase |
| POST | `/api/status` | Change task status |
| POST | `/api/validate` | Pass/fail validation |
| POST | `/api/memory/store` | Store memory entry |
| POST | `/api/memory/search` | Text-based search |
| POST | `/api/memory/semantic-search` | pgvector cosine search |
| GET | `/api/memory/embedding-stats` | Embedding coverage |
| POST | `/api/memory/backfill-embeddings` | Generate missing embeddings |

---

## 17. Testing

```bash
npm test                                          # All 705 tests

# Individual suites
node --test tests/agent-frontmatter.test.cjs     # Agent validation (42 tests)
node --test tests/codex-config.test.cjs          # Codex config (34 tests)
node --test tests/core.test.cjs                  # Core library (98 tests)
node --test tests/commands.test.cjs              # Command parsing (105 tests)
node --test tests/degradation.test.cjs           # Graceful degradation (11 tests)
node --test tests/e2e-lifecycle.test.cjs         # E2E lifecycle (22 tests)
node --test tests/gsd-amauta.test.cjs            # CLI unit tests (17 tests)
```

**705 tests across 22 files**, covering:

- Agent frontmatter: skills, hooks, anti-heredoc, spawn consistency, 11-agent roster
- CLI commands: all argument parsing, error paths, routing branches
- Core library: config load, model resolution, phase finding, milestone parsing
- Codex/Gemini: config generation, merging, idempotency
- E2E lifecycle: epic → story → task → claim → RPETD → validate → done
- Memory: store, search, cross-project, distill, infer-tags
- Degradation: file fallback for every PG-backed operation
- Frontmatter: extract, set, merge, validate, round-trip

---

## 18. Project Structure

```
gsd-amauta/
├── amauta.py                         # Task manager CLI (4158 lines)
├── package.json
├── README.md
├── CHANGELOG.md                      # All changes from vanilla GSD
├── MIGRATION.md                      # Upgrade guide from vanilla GSD
├── SECURITY.md
│
├── docker/
│   └── docker-compose.yml            # PostgreSQL 16 + pgvector :5433
│
├── migrations/
│   ├── 001-init.sql                  # 5 tables, 24 indexes, 3 triggers
│   ├── 002-embedding-index.sql       # HNSW index (idempotent)
│   ├── 003-embedding-1024.sql        # Dim migration 1536→1024 (idempotent)
│   ├── 004-fulltext-indexes.sql      # GIN FTS indexes + compound indexes
│   └── 005-agent-performance.sql     # Agent performance tracking (auto-learning)
│
├── services/
│   ├── amauta-daemon.py              # HTTP daemon :18799 (795 lines)
│   ├── pg_store.py                   # PG pool + memory/SKB/task mirror/embedding/perf (1026 lines)
│   └── rlm-service.py                # RLM context engine :18798 (808 lines)
│
├── agents/                           # 11 agent definitions
│   ├── gsd-operator.md               # Master orchestrator
│   ├── gsd-planner.md                # Planning specialist
│   ├── gsd-researcher.md             # Research (memory/SKB/Perplexity)
│   ├── gsd-executor-frontend.md      # *.tsx, *.jsx, *.css, *.vue
│   ├── gsd-executor-backend.md       # *.py, *.sql, *.go, *.rs
│   ├── gsd-executor-infra.md         # Docker, CI/CD, k8s
│   ├── gsd-executor-general.md       # Everything else
│   ├── gsd-checker.md                # Pre/post quality checks
│   ├── gsd-validator.md              # External validation
│   ├── gsd-debugger.md               # Root cause + bisect
│   └── gsd-roadmapper.md             # ROADMAP.md + milestones
│
├── get-shit-done/
│   ├── bin/
│   │   ├── amauta.cjs               # Thin wrapper → gsd-amauta.cjs
│   │   ├── gsd-amauta.cjs            # Task management CLI (1278 lines)
│   │   ├── gsd-memory.cjs            # Memory + embeddings CLI (1356 lines)
│   │   ├── gsd-rlm.cjs               # RLM context CLI (630 lines)
│   │   ├── gsd-research.cjs          # Research chain CLI (641 lines)
│   │   ├── gsd-tools.cjs             # Original GSD CLI
│   │   └── lib/
│   │       ├── core.cjs              # Model profiles, config, phase utils
│   │       └── init.cjs              # Session init, model resolution
│   ├── workflows/                    # 36 workflow .md files
│   ├── templates/                    # config.json, context.md
│   └── references/
│       └── model-profiles.md         # 11-agent model assignments
│
├── references/
│   └── agentic-patterns.md           # 20 patterns × 11 agents matrix
│
├── skills/                           # 11 skill workflows (SKILL.md each)
│   ├── gsd-operator-workflow/
│   ├── gsd-executor-backend-workflow/
│   └── ... (11 total, matching agents)
│
├── specs/                            # 7 formal pipeline specifications
│   ├── 01-rpetd-pipeline.spec.md
│   ├── 02-memory-pipeline.spec.md
│   ├── 03-rlm-context-engine.spec.md
│   ├── 04-research-chain.spec.md
│   ├── 05-task-lifecycle.spec.md
│   ├── 06-agent-architecture.spec.md
│   └── 07-auto-learning-feedback.spec.md
│
├── commands/gsd/                     # 33 slash commands
│   ├── new-project.md
│   ├── execute-plan.md
│   ├── test-phase.md
│   └── ...
│
├── tests/                            # 705 tests (22 files)
├── bin/
│   └── install.js                    # Self-installer (2897 lines)
└── scripts/
    └── run-tests.cjs                 # Cross-platform test runner
```

---

## 19. Agentic AI Patterns

GSD-Amauta implements 20 agentic AI design patterns from `references/agentic-patterns.md`:

```
  Pattern                  │ Agents                    │ Implementation
  ─────────────────────────┼───────────────────────────┼──────────────────────────
  P1  Prompt Chaining      │ operator                  │ Sequential workflow steps
  P2  Routing              │ operator                  │ File-pattern agent dispatch
  P3  Parallelization      │ all executors             │ Concurrent task execution
  P4  Verification         │ checker, validator        │ Pre/post quality gates
  P5  Tool Use             │ researcher, debugger      │ WebFetch, Bash, MCP tools
  P6  Planning             │ planner, operator         │ Given/When/Then specs
  P7  Reflection           │ debugger                  │ Root cause analysis loop
  P8  Resource-Aware       │ operator                  │ File-pattern routing
  P9  Multi-Agent Orch.    │ operator                  │ Task tool spawning
  P10 RAG                  │ researcher                │ Memory+SKB retrieval
  P11 Code Generation      │ all executors             │ Spec-driven implementation
  P12 Iterative Refinement │ executor+validator loop   │ Reject→fix→re-validate
  P13 Self-Monitoring      │ validator                 │ Gate checks + audit trail
  P14 Goal Setting         │ planner, operator         │ Success criteria capture
  P15 Exception Handling   │ operator                  │ Failed task escalation
  P16 Memory Management    │ memory system             │ PG + SKB + embeddings
  P17 Guardrails           │ checker, validator        │ No self-validation rule
  P18 Human-in-the-Loop    │ operator                  │ Approval gates
  P19 Prioritization       │ operator                  │ Score-based task ordering
  P20 Debugging            │ debugger                  │ Bisect + patch + verify
```

---

## 20. Troubleshooting

| Problem | Solution |
|---------|----------|
| Daemon won't start | `lsof -ti :18799 \| xargs kill -9` then `python3 services/amauta-daemon.py start` |
| PG connection fails | `docker ps --filter name=gsd-postgres` — restart if not running |
| Port 5433 in use | Edit `docker/docker-compose.yml` to use a different host port |
| Memory empty | `gsd-memory.cjs health` — verify `pg_available: true` in output |
| Validation blocked | Tag task `no-gitflow` or use `--force` flag |
| RLM returns nothing | `gsd-rlm.cjs health` — verify files exist in the query path |
| Semantic search slow | Run `gsd-memory.cjs backfill-embeddings` to populate vectors |
| No embeddings | Set `VOYAGE_API_KEY` (or `OPENAI_API_KEY`), then `backfill-embeddings` |
| Perplexity errors | Verify `PERPLEXITY_API_KEY` is set and valid |
| E2E tests flaky | Re-run `npm test` — E2E shares PG state, second run stabilizes |
| Agent not found | Verify agent .md exists in `~/.claude/agents/` after `npm install` |
| Codex/Gemini config | Run `node bin/install.js --codex` or `--gemini` to regenerate |

---

## License

Based on [GSD (Get Shit Done)](https://github.com/get-shit-done/get-shit-done) by TÂCHES.
Amauta task management by [robertamauta](https://github.com/robertamauta/amauta).
MIT License.

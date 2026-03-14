# SPEC-09: Context Passing Architecture

**Version:** 1.0  
**Status:** Active  
**Owner:** gsd-operator  
**Tests:** `tests/pipeline-offline.test.cjs`, `tests/comprehensive-e2e.test.cjs`, `tests/e2e-advanced.test.cjs`

---

## Purpose

Specifies how context is passed between agents, across task lifecycle phases, and across sessions. The Amauta system uses a three-layer context architecture that ensures agents always have relevant, current information without relying on fragile session state.

---

## SPEC-09-CTX-1: Three-Layer Context Architecture

```
Layer 1: Claim-time enrichment  (task metadata injection at claim)
Layer 2: Per-phase enrichment   (RPETD phase-specific context injection)
Layer 3: Agent-initiated        (RLM queries + memory searches by agent)
```

These layers are **additive** — each adds richer context without replacing prior layers.

---

## SPEC-09-CTX-2: Layer 1 — Claim-Time Context

**Trigger:** `amauta claim <task_id> --agent <agent_id>`  
**Function:** `_enrich_task_context(item, items)` → `amauta.py:1661`  
**Output:** JSON blob appended to task notes as `[CONTEXT ENRICHMENT]`

### What Layer 1 injects:

| Category | Source | Content |
|----------|--------|---------|
| Parent context | `tasks.json` | Parent epic/story RPETD D-phase, last notes |
| Sibling context | `tasks.json` | Current sprint tasks by same agent |
| Past failures | `tasks.json` | Prior validation notes on same task |
| Related experiences | `amauta_memory` (PG) | Memories with score ≥ 2 for task topic |
| Prior learnings | `amauta_memory` (PG) | `auto_learning`, `lesson-learned`, `web_search_result` sources |
| Domain knowledge | `agent_shared_knowledge` | Workflow guides, bug fixes, policies |
| Agent performance | `gsd_agent_performance` | Pass rate, common failure gates, improvement tips |

### Agent Performance Injection Format:
```
AGENT PERFORMANCE HISTORY for gsd-executor-backend:
  Pass rate: 8/10 (80%)
  Recent failures: LEARNING_BLOCK (2x), BRANCH_EVIDENCE (1x)
  Tip: Always write LEARNING: before completing D-phase
```

### Context Compression:
- Each memory/SKB entry truncated to 300 chars
- Max 5 memories, 3 SKB entries, 2 prior learnings per enrichment
- Total enrichment capped to prevent context window overflow

---

## SPEC-09-CTX-3: Layer 2 — Per-Phase RPETD Enrichment

**Trigger:** `amauta rpetd <task_id> --phase <R|P|E|T|D> --content "<content>"`  
**Function:** `_rpetd_phase_enrich(phase, item, agent_content)` → `amauta.py:1437`  
**Output:** Context appended to the phase log in `tasks.json`

### Phase-Specific Context:

| Phase | RLM | PG Memory | SKB | Action |
|-------|-----|-----------|-----|--------|
| **R** | Architecture analysis against domain docs | Related task experiences | Global KB entries | Research enrichment |
| **P** | Plan review vs architecture docs | — | Workflow planning guides | Plan validation |
| **E** | Execution review (branch/commit format) | Past execution failures | — | Code quality hints |
| **T** | Criteria validation checklist | Past validation patterns | — | Test gate prep |
| **D** | Delivery quality check | — | Web search auto-promotion | Learning capture + SKB promote |

### D-Phase Auto-Actions:
1. Extracts web_search results from R/P/D phase content
2. Writes each finding to `amauta_memory` as `source=web_search_result`
3. If task has LEARNING block, calls `_auto_write_learning()` 
4. Promotes validated patterns to `gsd_shared_kb` with importance=6

---

## SPEC-09-CTX-4: Layer 3 — Agent-Initiated Context

**Mechanism:** Agents invoke CLI tools directly:

```bash
# RLM: find relevant code
$RLM query "authentication flow" --dir . --top-k 5 --compact

# Memory: find past learnings
$MEM search "JWT refresh tokens"

# Research chain: current information
$RESEARCH search "React 18 concurrent features best practices"
```

**Research chain (5 steps, cascading):**
1. **Memory** — `$MEM search <query>` — past learnings from PostgreSQL
2. **SKB** — `$MEM skb-search <query>` — curated global knowledge base
3. **Context7** — MCP server for documentation lookup (via Claude Code)
4. **Perplexity** — `PERPLEXITY_API_KEY` — real-time web search for current events
5. **WebFetch** — direct URL fetch as final fallback

---

## SPEC-09-CTX-5: RLM Context Engine

**Service:** `services/rlm-service.py` on `localhost:18798`  
**CLI wrapper:** `get-shit-done/bin/gsd-rlm.cjs`  
**Algorithm:** TF-IDF relevance scoring with label boost

### Chunking Strategy:
| File Type | Chunking Method | Chunk Size |
|-----------|-----------------|-----------|
| Python `.py` | Class/function boundaries | Up to 8000 chars |
| JS/TS `.js/.ts` | Function/class/export | Up to 8000 chars |
| SQL `.sql` | Statement boundaries | Up to 8000 chars |
| Markdown `.md` | Heading boundaries | Up to 8000 chars |
| Other | Blank-line paragraphs | Up to 8000 chars |

### Scoring Formula:
```
chunk_score = tf_idf_score + label_boost
label_boost = 2x if query token matches function/class name in chunk
position_penalty = -0.1 × chunk_position (later chunks score lower)
final_score = chunk_score × (1 - position_penalty)
```

### Caching:
- LRU cache keyed by `(filepath, mtime)` — up to 200 entries
- Cache invalidation on file modification (mtime change)
- `GET /cache/clear` endpoint for forced invalidation

---

## SPEC-09-CTX-6: Memory Source Scoring

**Priority order for source-aware retrieval:**

| Source | Score Boost | Description |
|--------|-------------|-------------|
| `auto_learning` | +3 | System-generated validated learning |
| `web_search_result` | +3 | Perplexity/WebFetch findings |
| `lesson-learned` | +3 | Explicit agent-tagged lesson |
| `session-learning` | +3 | D-phase LEARNING block |
| `best-practice` | +2 | Promoted best practice |
| `manual` | +1 | Human-entered memory |
| `agent` | +0 | Generic agent memory |
| `rpetd_phase` | +0 | Phase log (unless contains LEARNING) |

High-signal sources (boost ≥ 3) are surfaced first in Layer 1 enrichment to give agents the most valuable context.

---

## SPEC-09-CTX-7: Cross-Session Memory Persistence

All memories written during task execution persist across sessions:

```
Task Execution Session
      ↓
  D-phase LEARNING: → amauta_memory (source=session-learning)
  Validated task → auto_write_learning → amauta_memory (source=auto_learning)
  Web search hit → _mem_log_event → amauta_memory (source=web_search_result)
      ↓
Next Task Session
      ↓
  claim → _enrich_task_context → PG memory query → inject into notes
```

This ensures knowledge from completed tasks informs future task execution, creating a continuous improvement loop.

---

## SPEC-09-CTX-8: Cross-Project Memory

`PGStore.memory_cross_project_search()` allows querying memories across all projects filtered by tech tags. Used during new project initialization to import relevant patterns from other projects in the same PostgreSQL instance.

**Endpoint:** `GET /api/memory/cross-project?query=<q>&tags=<t1,t2>`

---

## SPEC-09-CTX-9: Semantic Search with Voyage AI

When `VOYAGE_API_KEY` is set, memories are stored with 1024-dimensional embeddings from `voyage-code-3` (optimized for code). This enables semantic similarity search that goes beyond keyword matching.

**Embedding pipeline:**
1. Memory text → Voyage AI API (`input_type=document`) → 1024-dim vector
2. Stored in `gsd_memory.embedding` (pgvector `vector(1024)`)
3. Search: query → Voyage AI (`input_type=query`) → cosine similarity via HNSW index

**Fallback:** Full-text PostgreSQL search + ILIKE when Voyage API is unavailable.

---

## SPEC-09-CTX-10: Token Efficiency Techniques

The Amauta system uses several techniques to maximize context quality while minimizing token usage:

| Technique | Implementation | Benefit |
|-----------|---------------|---------|
| Content truncation | 300-char limit per memory | Reduces noise |
| Top-k filtering | `--top-k 5` default | Only surface most relevant |
| Source scoring | Boost high-signal sources | Signal over noise |
| Dedup detection | `_dedup_check()` SequenceMatcher | No redundant tasks |
| Cooldown gate | 20-min window | No spin loops |
| Compact mode | `--compact` flag on RLM | Abbreviated output |
| Phase-specific context | R/P/E/T/D each get relevant data | No irrelevant context |

---

## Acceptance Tests

All tests in `tests/pipeline-offline.test.cjs`, `tests/comprehensive-e2e.test.cjs`, and `tests/e2e-advanced.test.cjs` (Sections 3, 5, 8, 9) must pass.

**Critical scenarios:**
- CTX-T1: Claim enriches with parent task context
- CTX-T2: R-phase enrichment includes RLM code analysis
- CTX-T3: D-phase auto-extracts web search findings to memory
- CTX-T4: Next task claim injects prior learnings from PG
- CTX-T5: Agent performance history injected at claim time
- CTX-T6: Memory search returns ranked results (high-signal first)
- CTX-T7: Research chain falls back gracefully without API keys
- CTX-T8: RLM cache invalidates on file modification

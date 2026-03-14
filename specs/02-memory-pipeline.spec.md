# SPEC-02: Memory Pipeline

## Overview
PostgreSQL-backed persistent memory with source-aware scoring, semantic search via pgvector, file-based fallback, and cross-project knowledge transfer.

## Requirements

### MEM-1: Storage Backends
- **Daemon mode**: HTTP to amauta-daemon.py -> pg_store.py -> gsd_memory PG table
- **File mode**: `.planning/memory/<YYYY-MM>.md` with markdown entries
- Mode detection: `tryDaemon()` returns null on ECONNREFUSED -> file fallback

### MEM-2: Source-Aware Scoring
Every memory entry has a `source` field that determines search ranking boost:
| Source | Boost | Created By |
|--------|-------|------------|
| lesson-learned | +4 | Developer explicit input |
| best-practice | +4 | SKB promotion after validation |
| auto_learning | +3 | D-phase LEARNING block |
| web_search_result | +3 | Perplexity API response |
| session-learning | +3 | Session observation / D-phase delivery |
| distilled | +2 | Merged/compacted entries |
| rpetd_phase | +1 | Per-phase auto-capture |
| task_event | +0 | Status transitions |
| agent | +0 | General agent notes |

### MEM-3: Semantic Search (pgvector)
- Embedding provider auto-detection: VOYAGE_API_KEY (preferred) -> OPENAI_API_KEY (fallback)
- Model: voyage-code-3 (1024d) or text-embedding-3-small (1024d)
- Index: HNSW with m=16, ef_construction=128, cosine distance
- Fallback: PostgreSQL full-text search + ILIKE when no API key set
- Query embeddings use input_type="query"; storage uses input_type="document"

### MEM-4: Auto-Distill
- Triggered after store/learn when entry count exceeds threshold (default: 100)
- Jaccard similarity > 0.7 identifies duplicates
- Merged entries get source=distilled (+2)
- Works in both daemon mode (PG count) and file mode (fileCount)

### MEM-5: Cross-Project Search
- `amauta-memory cross-project "query" --tags react,postgresql`
- Searches across ALL project_ids in PG (not just current)
- Tag filtering narrows by tech stack
- File mode: degrades to local file search only (with warning)

### MEM-6: SKB (Shared Knowledge Base)
- Promoted from gsd_memory on validation pass (source=best-practice, +4)
- Categories: workflow, process, delivery, pattern, policy, architecture, convention, pitfall, tool-usage
- Requires PG (no file fallback) - exits with clear error when unavailable
- Uses tryDaemon() for graceful error handling

### MEM-7: File Mode Fallback
- `fileStore()`: appends to `.planning/memory/<YYYY-MM-DD>.md`
- `fileLearn()`: appends to `.planning/STATE.md` under `## Learnings`
- `fileSearch()`: grep across `.planning/memory/*.md` files
- `fileCount()`: counts entries across all memory markdown files
- `fileList()`: reads and formats recent entries from files
- All file operations create directories with `{ recursive: true }`

## Test Coverage
- `tests/pipeline-offline.test.cjs`: store, learn, search, count, list, SKB graceful fail
- `tests/validation-gates.test.cjs`: autoLearnFromRpetd file fallback, promoteToSKB file fallback

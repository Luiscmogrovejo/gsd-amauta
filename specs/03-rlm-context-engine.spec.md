# SPEC-03: RLM Context Engine

## Overview
Repository-Level Model (based on MIT CSAIL arXiv:2512.24601v1). Agents retrieve relevant code chunks instead of having entire files injected. No API keys required -- pure local retrieval.

## Requirements

### RLM-1: Service Architecture
- Python HTTP service on localhost:18798 (configurable via GSD_RLM_PORT)
- Auto-started by gsd-rlm.cjs when not running (with ENOENT error handler for missing python3)
- LRU cache keyed by (filepath, mtime), up to 200 files (RLM_CACHE_SIZE)

### RLM-2: Code-Aware Chunking
Files are split by language-specific boundaries:
- **Python**: class/function/decorator boundaries
- **JS/TS**: function/class/export boundaries
- **SQL**: statement boundaries (;)
- **Markdown**: heading boundaries (#, ##, ###)
- **Generic**: paragraph breaks + blank lines
- Max chunk: 8000 chars (RLM_MAX_CHUNK_CHARS); oversized split at paragraph breaks

### RLM-3: TF-IDF Scoring
- term_freq = count(term in chunk) / chunk_words
- idf = log(total_docs / docs_with_term)
- tf_idf = term_freq x idf
- chunk_score = sum of tf_idf across query terms
- Top-K chunks returned (default: 10, configurable via RLM_DEFAULT_TOP_K)

### RLM-4: Query Integration
- `gsd-rlm.cjs query "topic" --dir <path> --top-k N --compact`
- Returns: file path, line range, text, score per chunk
- Used by all 11 agents (via $RLM variable) and 4+ key workflows

### RLM-5: Graceful Degradation
- Config check: `isRlmEnabled()` reads `amauta.rlm_enabled` from config.json
- Service down: `shouldFallbackToFiles()` returns true -> suggest @ file references
- Fallback: `fallbackSuggestReferences()` suggests relevant file paths without content
- 3-tier: RLM service -> file reference suggestions -> error message

### RLM-6: Agent Integration
All 11 agents define `RLM="node ~/.claude/get-shit-done/bin/gsd-rlm.cjs"` and query before work:
- Executors: query for existing patterns in the target domain
- Planner: query for architecture context
- Researcher: query for existing code knowledge
- Checker: verify referenced files exist
- Debugger: query for failure patterns

## Test Coverage
- `tests/pipeline-offline.test.cjs`: CLI wrapper correctness
- Service health and chunking tested via `gsd-rlm.cjs health` and `gsd-rlm.cjs chunk`

# Phase 2 Audit Sign-Off: Memory & Embeddings

**Date:** 2026-04-06
**Auditor:** executor-backend
**Phase:** 2 of 8

## MEM-03: Voyage AI input_type Usage

**Status:** CORRECT -- no changes needed

All `generate_embedding()` call sites in `services/pg_store.py` use the correct asymmetric encoding:
- Storage paths: `input_type="document"` (verified at line 1172 -- `memory_store_with_embedding`)
- Search paths: `input_type="query"` (verified at line 1229 -- `memory_semantic_search`)
- Backfill paths: `input_type="document"` (verified at line 1370 -- `memory_backfill_embeddings`)

Each call site has a `# MEM-03 AUDIT (2026-04-06)` comment confirming the correct encoding type.

Verification command:
```
grep -n "MEM-03 AUDIT\|generate_embedding" services/pg_store.py | grep -v "def generate_embedding"
```
Expected: 6 lines (3 audit comments + 3 call sites).

**Known gap (Phase 4):** `amauta.py` writes memories via `_mem_log_event()` direct SQL INSERT
without generating embeddings. ~80-90% of RPETD memories have no embedding and are invisible
to semantic search. Fix deferred to MEM-04 (Phase 4: embedding cache + write path unification).

---

## MEM-04: Query Embedding Cache

**Status:** DEFERRED to Phase 4 (confirmed)

No cache exists. Every `memory_semantic_search()` call triggers a fresh Voyage API call.
The `generate_embedding` function in `pg_store.py` (line 1059) makes a direct HTTP request
to the Voyage API on every invocation with no in-process caching.

Phase 4 will add:
- Python: `cachetools.TTLCache` with 1-hour TTL
- Node.js: `Map<string, {embedding, expiry}>` with 1-hour TTL
- Cache key: `sha256(text + provider + model)`

Rationale for deferral: Phase 2 scope is audit-and-document only. Embedding cache
requires cross-language implementation (both `pg_store.py` and `gsd-memory.cjs`) and
needs to be designed alongside write-path unification (amauta.py direct SQL fix).
Bundling these into Phase 4 avoids partial solutions.

---

## MEM-10: HNSW Index Configuration

**Status:** CORRECT -- no changes needed

Current config from `migrations/002-embedding-index.sql` and `migrations/003-embedding-1024.sql`:
- `m = 16` (pgvector default, balanced recall vs. memory)
- `ef_construction = 128` (build quality balanced with index time)
- `ef_search = 40` (pgvector default; >99% recall at <10K rows)
- Distance: cosine (`vector_cosine_ops`)
- Dimensions: 1024 (`voyage-code-3` standard output)

Per Supabase benchmarks: HNSW at 1024d achieves ~2,200 QPS at >99% recall with these params.
IVFFlat only makes sense at 100K+ rows (requires `lists = sqrt(rows)` tuning).
Current GSD scale (~2,000-5,000 rows) is well served by HNSW at default params.

Migration 003 recreates the HNSW index idempotently after the dimension change from
`vector(1536)` (OpenAI legacy) to `vector(1024)` (Voyage + OpenAI standardized).

**Future consideration:** If corpus grows beyond 50K rows, increase ef_search from 40 to 100
via `SET hnsw.ef_search = 100;` at query time. No schema migration required.

---

## Two-Write-Path Gap (Documented for Phase 4)

`amauta.py` has two memory write paths:
1. `daemon_http_write` (via HTTP POST to `/memory/store`) -- goes through `memory_store_with_embedding()`,
   generates embedding correctly.
2. `_mem_log_event()` direct SQL INSERT (for RPETD phase logs, task events) -- bypasses the HTTP
   daemon entirely, inserts rows without calling `generate_embedding()`.

Path 2 accounts for the majority of RPETD memory entries, leaving them without embeddings
and invisible to `memory_semantic_search()`. This is a known architectural gap tracked under
MEM-04 and will be resolved in Phase 4.

---

*Audit complete. All findings verified against source code. No blocking issues for Phase 2 sign-off.*

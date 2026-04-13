-- GSD-Amauta Migration 013: Code embedding column + HNSW index (RLM-03)
-- Phase 27: The Retrieval Rewrite (v2.9 Nervous System)
-- Adds embedding_code vector(1024) to rlm_chunks for Voyage Code 3 / Qodo-Embed embeddings.
-- CRITICAL: This HNSW index is completely SEPARATE from semantic_cache's idx_semantic_cache_embedding_hnsw.
--   - semantic_cache uses: text embeddings (general-purpose model, vector_cosine_ops)
--   - rlm_chunks uses: code embeddings (Voyage Code 3, different model/space)
--   - Sharing indexes across different embedding models causes incorrect similarity results.
-- Matryoshka dimensionality: store full 1024-dim, query at 256-dim for fast lookup.
-- NULL allowed: rows without embeddings fall back to BM25-only retrieval (graceful degradation).
-- Prerequisite: migration 012-rlm-chunks.sql applied.
-- This migration is idempotent: safe to re-run.

BEGIN;

-- RLM-03: Add code embedding column to rlm_chunks.
-- NULL allowed: rows without embeddings fall back to BM25-only retrieval (graceful degradation).
-- When no embedding model is available, hybrid search skips the vector leg without crashing.
ALTER TABLE rlm_chunks
    ADD COLUMN IF NOT EXISTS embedding_code vector(1024);

-- RLM-03: HNSW index for cosine similarity search on code embeddings.
-- SEPARATE opclass and index from semantic_cache — different model, different vector space.
-- m=16, ef_construction=200: higher ef_construction than semantic_cache (128) because
--   code embedding recall is more precision-sensitive.
-- Index name prefixed 'rlm_' to make SEPARATE isolation explicit.
CREATE INDEX IF NOT EXISTS idx_rlm_chunks_embedding_hnsw
    ON rlm_chunks
    USING hnsw (embedding_code vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);

-- Index for filtering NULL embeddings (BM25-only fallback path)
CREATE INDEX IF NOT EXISTS idx_rlm_chunks_has_embedding
    ON rlm_chunks ((embedding_code IS NOT NULL))
    WHERE embedding_code IS NOT NULL;

COMMENT ON COLUMN rlm_chunks.embedding_code IS
    'Phase 27 RLM-03: 1024-dim code embedding from Voyage Code 3 (primary) or Qodo-Embed-1-1.5B (fallback). '
    'NULL = BM25-only chunk (non-code file or embedding model unavailable). '
    'Query at 256-dim via Matryoshka truncation for fast lookup. '
    'SEPARATE vector space from semantic_cache embeddings — do not compare cross-table.';

COMMIT;

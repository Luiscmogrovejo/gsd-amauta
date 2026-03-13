-- GSD-Amauta Migration v3: Standardize embedding dimension to 1024
-- Both Voyage AI (voyage-code-3) and OpenAI (text-embedding-3-small) support 1024 dims.
-- Previous schema used vector(1536) for OpenAI-only; this migration standardizes.
--
-- Run manually if upgrading:
--   psql postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta < migrations/003-embedding-1024.sql
--
-- IMPORTANT: This migration clears existing embeddings because dimension changed.
-- Run `gsd-memory.cjs backfill-embeddings` after migration to re-embed.

-- Step 1: Drop HNSW index (dimension-dependent)
DROP INDEX IF EXISTS idx_gsd_memory_embedding_hnsw;

-- Step 2: Clear existing embeddings (wrong dimension — 1536 != 1024)
UPDATE gsd_memory SET embedding = NULL WHERE embedding IS NOT NULL;

-- Step 3: Alter column from vector(1536) to vector(1024)
ALTER TABLE gsd_memory ALTER COLUMN embedding TYPE vector(1024);

-- Step 4: Recreate HNSW index for 1024-dim vectors
CREATE INDEX IF NOT EXISTS idx_gsd_memory_embedding_hnsw
    ON gsd_memory
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 128);

-- GSD-Amauta Migration v3: Standardize embedding dimension to 1024
-- Both Voyage AI (voyage-code-3) and OpenAI (text-embedding-3-small) support 1024 dims.
-- Previous schema used vector(1536) for OpenAI-only; this migration standardizes.
--
-- Run manually if upgrading:
--   psql postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta < migrations/003-embedding-1024.sql
--
-- IMPORTANT: On first run, this clears existing 1536-dim embeddings.
-- Run `gsd-memory.cjs backfill-embeddings` after migration to re-embed.
-- Safe to re-run (idempotent) — skips if column is already vector(1024).

DO $$
DECLARE
    col_type text;
BEGIN
    -- Check current column type
    SELECT format_type(atttypid, atttypmod) INTO col_type
    FROM pg_attribute
    WHERE attrelid = 'gsd_memory'::regclass AND attname = 'embedding';

    -- Only migrate if column is NOT already vector(1024)
    IF col_type IS DISTINCT FROM 'vector(1024)' THEN
        -- Step 1: Drop HNSW index (dimension-dependent)
        DROP INDEX IF EXISTS idx_gsd_memory_embedding_hnsw;

        -- Step 2: Clear existing embeddings (wrong dimension)
        UPDATE gsd_memory SET embedding = NULL WHERE embedding IS NOT NULL;

        -- Step 3: Alter column to vector(1024)
        ALTER TABLE gsd_memory ALTER COLUMN embedding TYPE vector(1024);

        RAISE NOTICE 'Migration 003: Column altered from % to vector(1024)', col_type;
    ELSE
        RAISE NOTICE 'Migration 003: Column already vector(1024), skipping';
    END IF;
END $$;

-- Step 4: Recreate HNSW index (idempotent)
CREATE INDEX IF NOT EXISTS idx_gsd_memory_embedding_hnsw
    ON gsd_memory
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 128);

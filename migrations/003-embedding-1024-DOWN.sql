-- DOWN migration for 003-embedding-1024.sql
-- NOTE: Cannot restore original 1536-dim embeddings (data was nulled in UP migration)
-- This only reverts the column type back to vector(1536)
DROP INDEX IF EXISTS idx_gsd_memory_embedding_hnsw;
ALTER TABLE gsd_memory ALTER COLUMN embedding TYPE vector(1536);
UPDATE gsd_memory SET embedding = NULL;

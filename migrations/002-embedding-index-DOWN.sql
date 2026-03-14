-- DOWN migration for 002-embedding-index.sql
DROP INDEX IF EXISTS idx_gsd_memory_embedding_hnsw;

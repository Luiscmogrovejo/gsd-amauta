-- GSD-Amauta Migration v2: HNSW index for pgvector semantic search
-- Run manually if upgrading from v1:
--   psql postgresql://gsd:gsd@127.0.0.1:5433/gsd_amauta < migrations/002-embedding-index.sql

-- HNSW index for cosine distance on memory embeddings
-- ef_construction=128 gives good recall; m=16 is pgvector default
-- Only indexes non-null embeddings automatically
CREATE INDEX IF NOT EXISTS idx_gsd_memory_embedding_hnsw
    ON gsd_memory
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 128);

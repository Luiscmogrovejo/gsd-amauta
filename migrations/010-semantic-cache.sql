BEGIN;

CREATE TABLE IF NOT EXISTS semantic_cache (
  id              SERIAL PRIMARY KEY,
  query_text      TEXT NOT NULL,
  query_embedding vector(1024) NOT NULL,
  response        TEXT NOT NULL,
  response_tokens INTEGER DEFAULT 0,
  source_file_hashes JSONB DEFAULT '{}',
  valid           BOOLEAN DEFAULT TRUE,
  provider        VARCHAR(64) DEFAULT 'perplexity',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_semantic_cache_embedding_hnsw
  ON semantic_cache
  USING hnsw (query_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

CREATE INDEX IF NOT EXISTS idx_semantic_cache_valid
  ON semantic_cache (valid)
  WHERE valid = TRUE;

CREATE INDEX IF NOT EXISTS idx_semantic_cache_created
  ON semantic_cache (created_at DESC);

COMMENT ON TABLE semantic_cache IS
  'Phase 24 SEMANTIC-01: pgvector cosine similarity cache for research-chain LLM calls. Entries invalidated when source file hashes change (SEMANTIC-02).';

COMMIT;

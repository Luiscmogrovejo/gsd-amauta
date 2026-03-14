-- DOWN migration for 004-fulltext-indexes.sql
DROP INDEX IF EXISTS idx_gsd_memory_text_fts;
DROP INDEX IF EXISTS idx_gsd_memory_tags_gin;
DROP INDEX IF EXISTS idx_gsd_memory_compound_agent_source;
DROP INDEX IF EXISTS idx_gsd_skb_text_fts;

-- DOWN migration for 004-fulltext-indexes.sql
DROP INDEX IF EXISTS idx_gsd_memory_fts;
DROP INDEX IF EXISTS idx_gsd_skb_fts;
DROP INDEX IF EXISTS idx_gsd_task_validations_task_created;
DROP INDEX IF EXISTS idx_gsd_tasks_project_status;

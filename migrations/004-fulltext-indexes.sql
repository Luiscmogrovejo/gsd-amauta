-- Migration 004: Add GIN full-text search indexes
-- Previously, every memory/SKB search did on-the-fly tsvector generation with
-- sequential scans. These GIN indexes enable fast full-text search on large tables.

-- Full-text index on gsd_memory.text for fast memory search
CREATE INDEX IF NOT EXISTS idx_gsd_memory_fts
    ON gsd_memory USING GIN (to_tsvector('english', text));

-- Full-text index on gsd_shared_kb (title + content) for fast SKB search
CREATE INDEX IF NOT EXISTS idx_gsd_skb_fts
    ON gsd_shared_kb USING GIN (to_tsvector('english', title || ' ' || COALESCE(content, '')));

-- Compound index on gsd_task_validations for history lookups
-- validation_history() does: WHERE task_id = ? ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_gsd_task_validations_task_created
    ON gsd_task_validations (task_id, created_at DESC);

-- Compound index on gsd_tasks for the most common query pattern
-- (pending tasks in a project, ordered by priority)
CREATE INDEX IF NOT EXISTS idx_gsd_tasks_project_status
    ON gsd_tasks (project_id, status);

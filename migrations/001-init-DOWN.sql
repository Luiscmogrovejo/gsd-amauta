-- DOWN migration for 001-init.sql
-- WARNING: This will DROP all Amauta tables and data!
DROP TRIGGER IF EXISTS trg_amauta_memory_insert ON amauta_memory;
DROP TRIGGER IF EXISTS trg_agent_shared_knowledge_insert ON agent_shared_knowledge;
DROP TRIGGER IF EXISTS trg_gsd_memory_updated ON gsd_memory;
DROP TRIGGER IF EXISTS trg_gsd_skb_updated ON gsd_shared_kb;
DROP TRIGGER IF EXISTS trg_gsd_tasks_updated ON gsd_tasks;
DROP FUNCTION IF EXISTS amauta_memory_insert();
DROP FUNCTION IF EXISTS agent_shared_knowledge_insert();
DROP FUNCTION IF EXISTS set_updated_at();
DROP VIEW IF EXISTS amauta_memory;
DROP VIEW IF EXISTS agent_shared_knowledge;
DROP TABLE IF EXISTS gitflow_log;
DROP TABLE IF EXISTS gsd_task_validations;
DROP TABLE IF EXISTS gsd_tasks;
DROP TABLE IF EXISTS gsd_shared_kb;
DROP TABLE IF EXISTS gsd_memory;

-- DOWN migration for 006-audit-log.sql
DROP INDEX IF EXISTS idx_audit_task;
DROP INDEX IF EXISTS idx_audit_type;
DROP INDEX IF EXISTS idx_audit_created;
DROP TABLE IF EXISTS gsd_audit_log;

-- DOWN migration for 005-agent-performance.sql
DROP INDEX IF EXISTS idx_gsd_agent_perf_agent;
DROP INDEX IF EXISTS idx_gsd_agent_perf_task;
DROP INDEX IF EXISTS idx_gsd_agent_perf_outcome;
DROP TABLE IF EXISTS gsd_agent_performance;

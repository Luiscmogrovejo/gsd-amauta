-- DOWN migration for 005-agent-performance.sql
DROP INDEX IF EXISTS idx_agent_perf_agent;
DROP INDEX IF EXISTS idx_agent_perf_agent_outcome;
DROP INDEX IF EXISTS idx_agent_perf_created;
DROP TABLE IF EXISTS gsd_agent_performance;

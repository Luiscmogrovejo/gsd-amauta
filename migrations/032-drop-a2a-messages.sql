-- GSD-Amauta Migration 032: drop a2a_messages (Phase 89 plan 89-05, ORC-02)
--
-- The bespoke A2A request/response protocol is removed: its four service modules
-- (client, per-agent-pair breaker, capability registry and that registry's CLI),
-- the `gsd-amauta a2a` and `gsd-tools a2a` verbs and the exchange-audit endpoint
-- are all gone, and the blackboard (agent_findings / agent_messages, migrations
-- 014/015/020/021/023/027) is the single agent-to-agent channel on BOTH backends.
-- No production code path ever sent an A2A message.
--
-- WHY MIGRATION 024 STAYS ON DISK. Deleting an applied migration breaks two
-- things in services/migrate_runner.py: `schema_migrations` reconciliation (a
-- recorded row whose file no longer exists), and `detect_applied_by_schema`,
-- which walks `discover_migrations()` and can only classify files it can see. A
-- rebuild therefore CREATES the table in 024 and DROPS it here. That is correct
-- and cheap: 024 is one CREATE TABLE plus one index on an empty table.
--
-- THE SENTINEL PAIR. 024 and 032 share one sentinel,
-- ("norelation", "a2a_messages") -- "the table is absent". After 032 the only
-- observable consistent with "024 has run" is the POST-032 state, so the pair is
-- read together: a database that still CARRIES the table reads both as pending
-- and converges (024's CREATE TABLE IF NOT EXISTS is a no-op, then this file
-- drops it); a database that does not carry it reads both as applied, which is
-- the same end state. See MIGRATION_SENTINELS in services/migrate_runner.py.
--
-- CASCADE drops idx_a2a_messages_to_agent_status with the table, as
-- 024-a2a-messages-DOWN.sql did. There is no data to preserve: the table was
-- never written by a production path, and Phase 89 decision 1 is future
-- correctness over old data.

BEGIN;

DROP TABLE IF EXISTS a2a_messages CASCADE;

COMMIT;

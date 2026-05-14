-- GSD-Amauta Migration 024 DOWN: Remove a2a_messages table (Phase 55 A2A-01)
-- Mirrors Phase 50 021-party-sessions-DOWN.sql + Phase 48 022-module-installs-DOWN.sql convention.
-- CASCADE drops the index automatically.

BEGIN;

DROP TABLE IF EXISTS a2a_messages CASCADE;

COMMIT;

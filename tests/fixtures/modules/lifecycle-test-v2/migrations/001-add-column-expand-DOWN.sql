-- DOWN: undo expand migration
BEGIN;
ALTER TABLE IF EXISTS lifecycle_test_payloads DROP COLUMN IF EXISTS body;
COMMIT;
